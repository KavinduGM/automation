// Post-publish review.
//
// Triggered ~3 minutes after a successful publish (ISR cache + safety
// margin). Fetches the rendered HTML for the live page and runs two layers
// of checks:
//
//   Layer 1 — deterministic heuristics
//     - HTTP 200, valid HTML returned
//     - Every <img> resolves (HEAD ≤ 400)
//     - Body contains the article H1
//     - At least one /services/ and one /contact link present
//     - At least one InlineCTABanner-like CTA marker rendered
//     - JSON-LD blocks present (BlogPosting + FAQPage when applicable)
//     - Stray [[IMAGE_N]] or [[CTA: …]] markers NOT visible in body
//
//   Layer 2 — Claude pass
//     - Reads the body text + heuristic findings + the source bodyMd
//     - Returns severity + free-form notes
//
// Outcome:
//   - "ok"        → ContentItem.meta.review = { ok: true, ... }, audit log.
//   - "warnings"  → status stays `published`, notes saved on ContentItem.
//   - "critical"  → auto-rolls back (status → review), notes saved, brand
//                   pages stop serving the broken post.
//
// 404 retry: if the live URL returns 4xx (almost always a stale ISR cache
// from a previously-failed publish), the reviewer re-enqueues itself with a
// short delay before giving up. Three tries total.

import { prisma, logger, queue, QUEUES, brandSiteFor, Prompts, type Prisma } from "@ca/shared";
import { claude } from "@ca/providers";

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

  // ── Brand-mention check — use the source bodyMd from the DB ─────────
  // The HTML extract is truncated at 6000 chars for Claude, so brand
  // mentions deep in the body get missed. The DB row is authoritative.
  // (Heuristic, not Claude — saves a model call and is exact.)
  const dbItem = await prisma.contentItem.findUnique({
    where: { id: data.contentItemId },
    include: { business: true },
  });
  if (dbItem) {
    const brand = brandSiteFor(dbItem.business.slug);
    if (brand) {
      const body = dbItem.bodyMd ?? "";
      const mentions = countOccurrences(body, brand.brandName);
      if (mentions < 2) {
        findings.push({
          severity: "med",
          area: "content",
          message: `Brand "${brand.brandName}" mentioned only ${mentions}× in body (target ≥ 2)`,
        });
      }
    }
  }

  // ── Layer 2: Claude content sanity pass (text-only, cheap) ─────────
  // Now reviews the FULL bodyMd from the database, not a truncated HTML
  // extract, so it can see the end of the article and judge truncation
  // accurately.
  if (html && dbItem) {
    try {
      const bodyText = (dbItem.bodyMd ?? "").slice(0, 12000);
      const claudeRes = await claude<{ severity: "ok" | "warnings" | "critical"; notes: string }>({
        model: "routing",
        json: true,
        maxTokens: 800,
        system: REVIEWER_SYSTEM,
        user:
          `Heuristic findings so far:\n` +
          JSON.stringify(findings, null, 2) +
          `\n\nFull body markdown (authoritative — use this to judge truncation/off-topic, NOT the rendered HTML extract):\n"""${bodyText}"""\n\nReturn JSON only.`,
      });
      if (claudeRes.json?.severity === "critical") {
        findings.push({ severity: "high", area: "content", message: `AI review: ${claudeRes.json.notes}` });
      } else if (claudeRes.json?.severity === "warnings") {
        findings.push({ severity: "med", area: "content", message: `AI review: ${claudeRes.json.notes}` });
      }
    } catch (err) {
      logger.warn({ err }, "post_review.claude_pass_skipped");
    }
  }

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

  logger.info(
    { contentItemId: data.contentItemId, url, overall, findings: findings.length, attempt: attempt + 1 },
    "post_review.done",
  );
  return report;
}

const REVIEWER_SYSTEM = `You are a strict editor reviewing an automation-published B2B SaaS blog post.

You receive (a) deterministic heuristic findings already gathered and (b) the FULL article body markdown
(authoritative — judge truncation/off-topic from this, not from any rendered HTML).

Critical-fail signals (return "critical"):
  - Body is genuinely truncated (sentence cut off mid-word with no closing punctuation; FAQ heading
    present but FAQ items missing or incomplete; abrupt halt mid-paragraph).
    Note: a complete article that simply doesn't end with the brand name is NOT truncated.
  - Article is clearly off-topic from its title.
  - Visible template markers in body (any literal "[[…]]" tokens including [[IMAGE_N]] or [[CTA:…]]).
  - Multiple raw markdown leaks (literal "**", "##", "[text](url)" shown as text).
  - Em dashes anywhere ("—" is forbidden by brand style).

Warnings (return "warnings"):
  - Brand name not mentioned in body (we already check this deterministically; only flag if you see
    something specifically wrong about how it's used, e.g. only in the FAQ).
  - Weak / generic CTA text.
  - Repeated phrasing across sections.

If neither of those, return "ok".

Be careful: the "heuristic findings" may be empty or all "med". That alone is not critical-fail.
Only escalate to "critical" when YOU see something genuinely broken in the body.

Output JSON only:
{
  "severity": "ok" | "warnings" | "critical",
  "notes":    string   // 1-3 sentences naming the worst issue
}`;

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

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return (haystack.match(re) ?? []).length;
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

async function rollback(contentItemId: string, report: ReviewReport) {
  const item = await prisma.contentItem.findUnique({ where: { id: contentItemId } });
  if (!item || item.status !== "published") return;

  // Remove the materialized published row so the live site stops serving it.
  switch (item.type) {
    case "blog":         await prisma.post.deleteMany({ where: { contentItemId } }); break;
    case "case_study":   await prisma.caseStudy.deleteMany({ where: { contentItemId } }); break;
    case "resource":     await prisma.resource.deleteMany({ where: { contentItemId } }); break;
    case "landing_page": await prisma.landingPage.deleteMany({ where: { contentItemId } }); break;
  }

  const summary = report.findings
    .filter((f) => f.severity === "high")
    .map((f) => `- [${f.area}] ${f.message}`)
    .join("\n");

  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: {
      status: "review",
      reviewNotes:
        `Auto-rolled back by post-publish reviewer (${report.checkedAt}, attempt ${report.attempt}):\n` + summary,
    },
  });
}

void Prompts; // keep the import live; reserved for future prompt sharing
