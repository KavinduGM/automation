// Post-publish LAYOUT review.
//
// This pass is intentionally layout-only — text content quality is the AI
// critic's job pre-publish ([packages/pipelines/src/route.ts]). Here we
// fetch the rendered HTML for the live page and assert that the page LOOKS
// right: images render, CTAs are present, FAQ JSON-LD wired up, no broken
// markers leaked through the renderer.
//
// Checks (all deterministic, no Claude call):
//   - HTTP 200, valid HTML returned
//   - Every <img> resolves (HEAD ≤ 400)
//   - Body contains an <h1>
//   - At least one /services/ and one /contact internal link
//   - InlineCTABanner-like CTA marker rendered
//   - BlogPosting JSON-LD present
//   - No leaked [[IMAGE_N]] or [[CTA: …]] markers visible
//
// Outcome:
//   - "ok"       → ContentItem.meta.postReview = { ok: true, ... }, audit log.
//   - "warnings" → stays published, notes saved (cosmetic only).
//   - "critical" → UNPUBLISH immediately + auto-fix retry. After
//                  MAX_AUTO_FIX_ATTEMPTS still-broken cycles, stay
//                  unpublished and escalate to the human review queue
//                  (status → review, meta.layoutFixExhausted = true).
//                  Layout issues are never left live — they damage brand.
//
// 404 retry: if the live URL returns 4xx (almost always a stale ISR cache
// from a previously-failed publish), the reviewer re-enqueues itself with a
// short delay before giving up. Three tries total.

import { prisma, logger, queue, QUEUES, brandSiteFor, type Prisma } from "@ca/shared";
import { revalidateForContent } from "@ca/providers";
import { logStep } from "./util.js";

// How many layout-fix attempts to allow before escalating to admin.
const MAX_AUTO_FIX_ATTEMPTS = 2;

export interface PostReviewJobData {
  contentItemId: string;
  publicUrl: string;
  attempt?: number;
}

export interface ReviewFinding {
  severity: "low" | "med" | "high";
  area:
    | "http"
    | "image"
    | "link"
    | "cta"
    | "marker_leak"
    | "structured_data"
    | "content";
  message: string;
}

export interface ReviewReport {
  ok: boolean;
  overall: "ok" | "warnings" | "critical";
  findings: ReviewFinding[];
  checkedAt: string;
  url: string;
  attempt: number;
}

const MAX_HTTP_RETRIES = 2;       // 2 retries × 90s delay each = up to 3 minutes of extra wait
const RETRY_DELAY_MS   = 90_000;

export async function runPostReview(data: PostReviewJobData): Promise<ReviewReport | { rescheduled: true }> {
  const findings: ReviewFinding[] = [];
  const url = data.publicUrl;
  const attempt = data.attempt ?? 0;
  await logStep(data.contentItemId, "post_review", "started", {
    label: `Layout review (attempt ${attempt + 1})`,
    metadata: { url, attempt },
  });
  const reviewT0 = Date.now();

  // ── Fetch — cache-bust so we never trust a previously-cached 404 ─────
  // The query param flows through Next.js dynamic routing untouched (the
  // route only reads `params.slug`), but defeats the route-segment ISR
  // cache so we always see the freshest server-rendered HTML.
  const fetchUrl = bustCache(url);
  let html = "";
  let httpStatus = 0;
  try {
    const res = await fetch(fetchUrl, {
      headers: {
        "User-Agent": "ContentAutomationReviewer/1.0",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });
    httpStatus = res.status;
    if (res.ok) {
      html = await res.text();
    }
  } catch (err) {
    findings.push({ severity: "high", area: "http", message: `Fetch failed: ${(err as Error).message}` });
  }

  // ── 4xx retry — almost always stale ISR cache after a previous failed publish.
  if (!html && httpStatus >= 400 && httpStatus < 500 && attempt < MAX_HTTP_RETRIES) {
    logger.warn(
      { contentItemId: data.contentItemId, url, httpStatus, attempt },
      "post_review.retrying_on_4xx",
    );
    await queue(QUEUES.post_review).add(
      `review:${data.contentItemId}:${attempt + 1}`,
      { contentItemId: data.contentItemId, publicUrl: url, attempt: attempt + 1 },
      { delay: RETRY_DELAY_MS, removeOnComplete: 500, removeOnFail: 100 },
    );
    return { rescheduled: true };
  }

  if (!html && httpStatus !== 0) {
    // Final failure after retries.
    findings.push({ severity: "high", area: "http", message: `Live page returned ${httpStatus} after ${attempt + 1} attempts` });
  }

  if (html) {
    // ── Marker leak (template tokens that didn't render) ─────────────
    if (/\[\[IMAGE_\d+\]\]/.test(html)) {
      findings.push({ severity: "high", area: "marker_leak", message: "Unrendered [[IMAGE_N]] marker visible on the live page" });
    }
    if (/\[\[CTA:\s*[^\]]+\]\]/.test(html)) {
      findings.push({ severity: "high", area: "marker_leak", message: "Unrendered [[CTA: …]] marker visible on the live page" });
    }

    // ── Headings ─────────────────────────────────────────────────────
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
    if (!h1) findings.push({ severity: "high", area: "content", message: "No <h1> found on the page" });

    // ── Images ───────────────────────────────────────────────────────
    const imgSrcs = Array.from(html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi))
      .map((m) => m[1])
      .filter((s): s is string => Boolean(s));
    if (imgSrcs.length === 0) {
      findings.push({ severity: "med", area: "image", message: "Article has zero <img> tags" });
    } else {
      // HEAD-check up to 6 images in parallel; tolerate one redirect.
      const results = await Promise.all(
        imgSrcs.slice(0, 6).map(async (src) => {
          try {
            const u = absoluteUrl(src, url);
            const r = await fetch(u, { method: "HEAD", redirect: "follow" });
            return { src, ok: r.ok, status: r.status };
          } catch (err) {
            return { src, ok: false, status: 0, err: (err as Error).message };
          }
        }),
      );
      for (const r of results) {
        if (!r.ok) {
          findings.push({
            severity: "high",
            area: "image",
            message: `Image returned ${r.status || "error"}: ${shorten(r.src)}`,
          });
        }
      }
    }

    // ── Internal links ───────────────────────────────────────────────
    const hrefs = Array.from(html.matchAll(/href=["']([^"']+)["']/gi))
      .map((m) => m[1])
      .filter((s): s is string => Boolean(s));
    const hasService = hrefs.some((h) => h.startsWith("/services/"));
    const hasContact = hrefs.some((h) => h.startsWith("/contact") || h.endsWith("/contact"));
    if (!hasService) findings.push({ severity: "med", area: "link", message: "No /services/<slug> internal link found" });
    if (!hasContact) findings.push({ severity: "med", area: "link", message: "No /contact internal link found" });

    // ── CTA presence (gradient banner ships with from-brand-700 class) ──
    if (!/from-brand-700/.test(html)) {
      findings.push({ severity: "med", area: "cta", message: "No InlineCTABanner detected in rendered HTML" });
    }

    // ── JSON-LD ──────────────────────────────────────────────────────
    if (!/"@type"\s*:\s*"BlogPosting"/.test(html)) {
      findings.push({ severity: "med", area: "structured_data", message: "BlogPosting JSON-LD missing" });
    }
  }

  // Brand-mention, truncation, em-dash, and off-topic checks moved to the
  // pre-publish AI critic in route.ts — those are content concerns and
  // should be caught/fixed BEFORE we ever go live. Post-publish review is
  // layout-only.

  const high = findings.filter((f) => f.severity === "high").length;
  const med = findings.filter((f) => f.severity === "med").length;
  const overall: ReviewReport["overall"] = high > 0 ? "critical" : med > 0 ? "warnings" : "ok";
  const report: ReviewReport = {
    ok: overall === "ok",
    overall,
    findings,
    checkedAt: new Date().toISOString(),
    url,
    attempt: attempt + 1,
  };

  // ── Persist + decide rollback ──────────────────────────────────────
  await persistReport(data.contentItemId, report);
  if (overall === "critical") {
    await rollback(data.contentItemId, report);
  }

  const eventStatus = overall === "ok" ? "completed" : overall === "warnings" ? "warning" : "failed";
  await logStep(data.contentItemId, "post_review", eventStatus, {
    label: `Layout review: ${overall}`,
    message: findings.length > 0 ? findings.slice(0, 3).map((f) => `[${f.area}] ${f.message}`).join("; ") : undefined,
    durationMs: Date.now() - reviewT0,
    metadata: { overall, totalFindings: findings.length, high, med, attempt: attempt + 1 },
  });

  logger.info(
    { contentItemId: data.contentItemId, url, overall, findings: findings.length, attempt: attempt + 1 },
    "post_review.done",
  );
  return report;
}

// Build the canonical public URL for a content item on its business's site.
// Only blogs/case-studies/resources/landing-pages have public URLs we can review.
export function publicUrlFor(item: {
  type: string;
  slug: string | null;
  businessId: string;
}, businessSlug: string): string | null {
  const site = brandSiteFor(businessSlug);
  if (!site || !item.slug) return null;
  switch (item.type) {
    case "blog":         return `${site.domain}/blog/${item.slug}`;
    case "case_study":   return `${site.domain}/case-studies/${item.slug}`;
    case "resource":     return `${site.domain}/resources/${item.slug}`;
    case "landing_page": return `${site.domain}/lp/${item.slug}`;
    default:             return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function absoluteUrl(src: string, base: string): string {
  if (/^https?:\/\//.test(src)) return src;
  try {
    return new URL(src, base).toString();
  } catch {
    return src;
  }
}

function bustCache(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("_ts", String(Date.now()));
    return u.toString();
  } catch {
    return url + (url.includes("?") ? "&" : "?") + "_ts=" + Date.now();
  }
}

function shorten(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function persistReport(contentItemId: string, report: ReviewReport) {
  const item = await prisma.contentItem.findUnique({ where: { id: contentItemId } });
  if (!item) return;
  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: {
      meta: {
        ...(item.meta as object),
        postReview: report as unknown as Prisma.InputJsonValue,
      } as Prisma.InputJsonValue,
    },
  });
  await prisma.auditLog.create({
    data: {
      businessId: item.businessId,
      action: `post_review:${report.overall}`,
      target: `ContentItem:${contentItemId}`,
      diff: { findings: report.findings, url: report.url, attempt: report.attempt } as object,
    },
  });
}

// Classify a finding as image-related or text-related so the blog pipeline
// can do the cheapest fix possible: regen text only when the issue is in
// text, regen images only when the issue is in images.
//   - image area + the marker_leak case for [[IMAGE_N]] → image issue
//   - everything else (content, link, cta, structured_data, http, [[CTA:…]]) → text issue
function classifyFinding(f: ReviewFinding): "image" | "text" {
  if (f.area === "image") return "image";
  if (f.area === "marker_leak" && /\[\[IMAGE_/.test(f.message)) return "image";
  return "text";
}

export type FixScope = "text" | "images" | "both";

function deriveFixScope(highFindings: ReviewFinding[]): FixScope {
  let hasImage = false;
  let hasText = false;
  for (const f of highFindings) {
    if (classifyFinding(f) === "image") hasImage = true;
    else hasText = true;
  }
  if (hasImage && hasText) return "both";
  if (hasImage) return "images";
  return "text";
}

async function rollback(contentItemId: string, report: ReviewReport) {
  const item = await prisma.contentItem.findUnique({ where: { id: contentItemId } });
  if (!item || item.status !== "published") return;

  // Layout issues damage the brand — always take the page down first.
  await deleteMaterialized(item);

  // Count how many layout-fix attempts have already happened on this item.
  // (Field is still named autoFixAttempts for backwards compat with any in-flight rows.)
  const meta = (item.meta ?? {}) as { autoFixAttempts?: number };
  const previousAttempts = meta.autoFixAttempts ?? 0;
  const nextAttempt = previousAttempts + 1;

  const highFindings = report.findings.filter((f) => f.severity === "high");
  const summary = highFindings.map((f) => `- [${f.area}] ${f.message}`).join("\n");

  // ── Escalation path ──────────────────────────────────────────────────
  // After MAX_AUTO_FIX_ATTEMPTS we've already burned 2 fix cycles and the
  // page is still broken. Keep it unpublished, flag for admin review.
  // (Old behavior was "leave published as-is"; that's only acceptable for
  // CONTENT issues, never layout.)
  if (previousAttempts >= MAX_AUTO_FIX_ATTEMPTS) {
    await prisma.contentItem.update({
      where: { id: contentItemId },
      data: {
        status: "review",
        reviewNotes:
          `Layout fix exhausted (${MAX_AUTO_FIX_ATTEMPTS}× attempts). Page is UNPUBLISHED until you approve.\n\nLatest findings (${report.checkedAt}):\n` + summary,
        meta: {
          ...(item.meta as object),
          layoutFixExhausted: true,
          lastFindings: highFindings as unknown as Prisma.InputJsonValue,
        } as Prisma.InputJsonValue,
      },
    });
    logger.warn(
      { contentItemId, previousAttempts, type: item.type },
      "post_review.layout_escalated_to_admin",
    );
    return;
  }

  // ── Auto-fix path (attempts 1 and 2) ─────────────────────────────────
  // Only blogs auto-fix today; other types fall through to human review.
  if (item.type !== "blog") {
    await prisma.contentItem.update({
      where: { id: contentItemId },
      data: {
        status: "review",
        reviewNotes:
          `Auto-rolled back by layout reviewer (${report.checkedAt}, attempt ${report.attempt}):\n` + summary,
        meta: {
          ...(item.meta as object),
          lastFindings: highFindings as unknown as Prisma.InputJsonValue,
        } as Prisma.InputJsonValue,
      },
    });
    logger.warn({ contentItemId, type: item.type }, "post_review.escalated_to_human_non_blog");
    return;
  }

  // Blog auto-fix: classify findings to drive cheapest possible regen.
  const fixScope = deriveFixScope(highFindings);

  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: {
      status: "queued",
      reviewNotes:
        `Layout fix ${nextAttempt}/${MAX_AUTO_FIX_ATTEMPTS} (scope: ${fixScope}) — ${report.checkedAt}\n` + summary,
      meta: {
        ...(item.meta as object),
        autoFixAttempts: nextAttempt,
        fixScope,
        lastFindings: highFindings as unknown as Prisma.InputJsonValue,
      } as Prisma.InputJsonValue,
    },
  });
  await queue(QUEUES.draft).add(
    `${item.type}:${contentItemId}:autofix:${nextAttempt}`,
    { contentItemId, type: item.type },
  );
  logger.info(
    { contentItemId, attempt: nextAttempt, fixScope, findings: highFindings.length },
    "post_review.auto_fix_enqueued",
  );
}

// Take down the materialized row and flush the client site's ISR cache so
// neither the detail page nor any /blog index card outlives the takedown.
async function deleteMaterialized(item: {
  id: string;
  type: string;
  businessId: string;
  slug: string | null;
}) {
  switch (item.type) {
    case "blog":         await prisma.post.deleteMany({ where: { contentItemId: item.id } }); break;
    case "case_study":   await prisma.caseStudy.deleteMany({ where: { contentItemId: item.id } }); break;
    case "resource":     await prisma.resource.deleteMany({ where: { contentItemId: item.id } }); break;
    case "landing_page": await prisma.landingPage.deleteMany({ where: { contentItemId: item.id } }); break;
  }
  if (item.type === "blog" || item.type === "case_study" || item.type === "resource" || item.type === "landing_page") {
    void revalidateForContent({
      businessId: item.businessId,
      type: item.type as "blog" | "case_study" | "resource" | "landing_page",
      slug: item.slug,
    }).catch((err) => logger.warn({ err, contentItemId: item.id }, "rollback.revalidate_failed"));
  }
}

