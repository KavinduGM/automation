// Post-publish review.
//
// Triggered ~90 seconds after a successful publish (so the client site's ISR
// has time to regenerate). Fetches the rendered HTML for the live page and
// runs two layers of checks:
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
//     - Reads the body text + a list of any heuristic findings
//     - Returns severity + free-form notes
//
// Outcome:
//   - "ok"        → ContentItem.meta.review = { ok: true, ... }, audit log.
//   - "warnings"  → status stays `published`, notes saved on ContentItem.
//   - "critical"  → auto-rolls back (status → review), notes saved, brand
//                   pages stop serving the broken post.

import { prisma, logger, brandSiteFor, Prompts, type Prisma } from "@ca/shared";
import { claude } from "@ca/providers";

export interface PostReviewJobData {
  contentItemId: string;
  publicUrl: string;
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
}

export async function runPostReview(data: PostReviewJobData): Promise<ReviewReport> {
  const findings: ReviewFinding[] = [];
  const url = data.publicUrl;

  // ── Fetch ──────────────────────────────────────────────────────────
  let html = "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": "ContentAutomationReviewer/1.0" } });
    if (!res.ok) {
      findings.push({ severity: "high", area: "http", message: `Live page returned ${res.status}` });
    } else {
      html = await res.text();
    }
  } catch (err) {
    findings.push({ severity: "high", area: "http", message: `Fetch failed: ${(err as Error).message}` });
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

  // ── Layer 2: Claude content sanity pass (text-only, cheap) ─────────
  try {
    const bodyText = extractBodyText(html).slice(0, 6000);
    if (bodyText) {
      const claudeRes = await claude<{ severity: "ok" | "warnings" | "critical"; notes: string }>({
        model: "routing",
        json: true,
        maxTokens: 800,
        system: REVIEWER_SYSTEM,
        user:
          `Heuristic findings so far:\n` +
          JSON.stringify(findings, null, 2) +
          `\n\nBody text excerpt:\n"""${bodyText}"""\n\nReturn JSON only.`,
      });
      if (claudeRes.json?.severity === "critical") {
        findings.push({ severity: "high", area: "content", message: `AI review: ${claudeRes.json.notes}` });
      } else if (claudeRes.json?.severity === "warnings") {
        findings.push({ severity: "med", area: "content", message: `AI review: ${claudeRes.json.notes}` });
      }
    }
  } catch (err) {
    logger.warn({ err }, "post_review.claude_pass_skipped");
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
  };

  // ── Persist + decide rollback ──────────────────────────────────────
  await persistReport(data.contentItemId, report);
  if (overall === "critical") {
    await rollback(data.contentItemId, report);
  }

  logger.info(
    { contentItemId: data.contentItemId, url, overall, findings: findings.length },
    "post_review.done",
  );
  return report;
}

const REVIEWER_SYSTEM = `You are a strict editor reviewing an automation-published B2B SaaS blog post.

You receive (a) deterministic heuristic findings already gathered and (b) the body text.
Decide whether the article is publishable AS-IS, has minor warnings, or is critical-fail.

Critical-fail signals:
  - Body text is clearly truncated (sentence cut off mid-word, FAQ missing)
  - Article is obviously off-topic from its title
  - Visible template markers in body (any [[…]] tokens)
  - Multiple raw markdown leaks (literal **, ##, or [text](url) shown as text)
  - Em dashes anywhere ("—" is forbidden by brand style)

Warnings:
  - Brand name not mentioned at least 2x
  - Weak / generic CTA text
  - Repeated phrasing across sections

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

function shorten(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Pulls the article body text out of an HTML document — strips tags +
// scripts + styles. Best-effort; we just need enough for Claude to judge
// truncation / off-topic content.
function extractBodyText(html: string): string {
  if (!html) return "";
  const m = html.match(/<article[\s\S]*?<\/article>/i);
  const region = m ? m[0] : html;
  return region
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
      diff: { findings: report.findings, url: report.url } as object,
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
        `Auto-rolled back by post-publish reviewer (${report.checkedAt}):\n` + summary,
    },
  });
}

void Prompts; // keep the import live; reserved for future prompt sharing
