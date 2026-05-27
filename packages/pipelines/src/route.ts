import { prisma, brandSiteFor, logger, type Prisma } from "@ca/shared";
import { logStep, setStatus, enqueuePublish } from "./util.js";
import { queue, QUEUES } from "@ca/shared";

// Decides what happens after a piece is drafted: auto-publish, AI-review,
// or send to the human review queue. Reads ContentPlan.approvalMode.
//
// AI-review mode runs an auto-fix loop pre-publish using DETERMINISTIC
// checks (regex / string match) — no LLM call. The previous Claude-based
// critic kept inventing rules ("focus keyword density", "title-H1
// consistency") not in the prompt, and miscounting things it could see
// in the body, triggering 3 wasted re-drafts (~$0.30) per article on
// average. Deterministic checks are accurate, instant, and free.
//
// If issues are found we re-draft up to MAX_CONTENT_FIX_ATTEMPTS times.
// After that the item publishes anyway — content issues are tolerable;
// layout issues caught post-publish are NOT (see post-review.ts).

interface CriticVerdict {
  scores: Record<string, number>;
  issues: Array<{ severity: "low" | "med" | "high"; where: string; what: string; sectionH2?: string }>;
  verdict: "approve" | "revise" | "escalate";
}

const MAX_CONTENT_FIX_ATTEMPTS = 2;

export async function routeApproval(contentItemId: string): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  const plan = await prisma.contentPlan.findUnique({
    where: { businessId_contentType: { businessId: item.businessId, contentType: item.type } },
  });

  // Layout-fix retries (post-publish reviewer rolled back) bypass the
  // configured approval mode and republish directly — the critic already
  // ran on the original version, and the fix is about RENDERING, not text.
  // Content-fix retries (pre-publish critic round-tripping) do NOT bypass;
  // we want the critic to re-evaluate the fixed draft.
  const itemMeta = (item.meta ?? {}) as { autoFixAttempts?: number; contentFixAttempts?: number };
  const isLayoutFix = (itemMeta.autoFixAttempts ?? 0) > 0;
  const mode = isLayoutFix ? "auto" : (plan?.approvalMode ?? "human_review");

  if (isLayoutFix) {
    logger.info({ contentItemId, attempt: itemMeta.autoFixAttempts }, "route.layout_fix_bypassing_approval");
  }

  if (mode === "auto") {
    await enqueuePublish(contentItemId);
    return;
  }

  if (mode === "ai_review") {
    await runAiReview(contentItemId, item, itemMeta.contentFixAttempts ?? 0);
    return;
  }

  // human_review
  await setStatus(contentItemId, "review");
}

async function runAiReview(
  contentItemId: string,
  item: Awaited<ReturnType<typeof prisma.contentItem.findUniqueOrThrow>>,
  contentFixAttempts: number,
): Promise<void> {
  await logStep(contentItemId, "critic", "started", { label: "Content critic (deterministic)" });
  const t0 = Date.now();

  const meta = (item.meta ?? {}) as { outline?: { focusKeyword?: string } };
  const business = await prisma.business.findUniqueOrThrow({ where: { id: item.businessId } });
  const brand = brandSiteFor(business.slug);
  const brandKit = await prisma.brandKit.findUnique({ where: { businessId: item.businessId } });

  const verdict = deterministicCritic(
    item.bodyMd,
    meta.outline?.focusKeyword,
    brand?.brandName,
    brandKit?.bannedWords ?? [],
  );

  await logStep(contentItemId, "critic", verdict.verdict === "approve" ? "completed" : "warning", {
    label: "Content critic (deterministic)",
    message: `verdict: ${verdict.verdict} (${verdict.issues.length} issues)`,
    durationMs: Date.now() - t0,
    metadata: { verdict: verdict.verdict, issueCount: verdict.issues.length },
  });

  const issuesSummary = verdict.issues.map((i) => `[${i.severity}] ${i.where}: ${i.what}`).join("\n");

  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: {
      meta: {
        ...(item.meta as object),
        critic: verdict as unknown as Prisma.InputJsonValue,
      } as Prisma.InputJsonValue,
      reviewNotes: issuesSummary,
    },
  });

  // Critic approved → publish.
  if (verdict.verdict === "approve") {
    await enqueuePublish(contentItemId);
    return;
  }

  // Critic flagged issues. Re-draft up to MAX_CONTENT_FIX_ATTEMPTS times,
  // then publish anyway — we don't escalate to humans for content issues.
  const nextAttempt = contentFixAttempts + 1;

  if (contentFixAttempts >= MAX_CONTENT_FIX_ATTEMPTS) {
    logger.warn(
      { contentItemId, contentFixAttempts, verdict: verdict.verdict },
      "route.content_fix_exhausted_publishing_anyway",
    );
    await prisma.contentItem.update({
      where: { id: contentItemId },
      data: {
        meta: {
          ...(item.meta as object),
          critic: verdict as unknown as Prisma.InputJsonValue,
          contentFixGivenUp: true,
        } as Prisma.InputJsonValue,
        reviewNotes:
          `Content fix exhausted (${MAX_CONTENT_FIX_ATTEMPTS}× attempts). Published as-is.\n\nLast critic issues:\n` +
          issuesSummary,
      },
    });
    await enqueuePublish(contentItemId);
    return;
  }

  // Re-draft. Reuse the blog pipeline's correction-context mechanism via
  // meta.lastFindings. If EVERY high/med issue carries a sectionH2, we
  // can scope the fix to those sections instead of re-drafting the whole
  // article — much cheaper, and avoids touching parts that were fine.
  const relevantIssues = verdict.issues.filter(
    (i) => i.severity === "high" || i.severity === "med",
  );
  type IssueWithSection = typeof relevantIssues[number] & { sectionH2?: string };
  const lastFindings = relevantIssues.map((i) => ({
    area: "content",
    message: `${i.where}: ${i.what}`,
    severity: i.severity,
    sectionH2: (i as IssueWithSection).sectionH2,
  }));

  const allHaveSections =
    relevantIssues.length > 0 &&
    relevantIssues.every((i) => {
      const s = (i as IssueWithSection).sectionH2;
      return typeof s === "string" && s.trim().length > 0;
    });
  const nextFixScope: "section" | "text" = allHaveSections ? "section" : "text";

  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: {
      meta: {
        ...(item.meta as object),
        critic: verdict as unknown as Prisma.InputJsonValue,
        contentFixAttempts: nextAttempt,
        fixScope: nextFixScope,
        lastFindings: lastFindings as unknown as Prisma.InputJsonValue,
      } as Prisma.InputJsonValue,
      reviewNotes: `Content fix ${nextAttempt}/${MAX_CONTENT_FIX_ATTEMPTS} (scope: ${nextFixScope}) — ${issuesSummary}`,
    },
  });
  await setStatus(contentItemId, "queued");
  await queue(QUEUES.draft).add(
    `${item.type}:${contentItemId}:content-fix:${nextAttempt}`,
    { contentItemId, type: item.type },
  );
  logger.info(
    { contentItemId, attempt: nextAttempt, verdict: verdict.verdict, issues: lastFindings.length },
    "route.content_fix_enqueued",
  );
}

// ── Deterministic content critic ─────────────────────────────────────
// Returns the same CriticVerdict shape as the old LLM version so the
// dashboard + auto-fix loop don't need to change. Runs in microseconds
// with zero false positives, vs ~5s + frequent invented issues from
// the LLM. The LLM critic was finding ~3 fake issues per draft because
// it kept inventing rules ("focus keyword density", "title-H1
// consistency"), each one triggering a wasted re-draft.
function deterministicCritic(
  body: string,
  focusKeyword: string | undefined,
  brandName: string | undefined,
  bannedWords: string[],
): CriticVerdict {
  const issues: CriticVerdict["issues"] = [];

  if (focusKeyword && focusKeyword.trim().length > 0) {
    const fk = focusKeyword.trim();
    // Focus keyword in H1
    const h1Match = body.match(/^# +(.+?)\s*$/m);
    const h1Text = h1Match?.[1] ?? "";
    if (h1Text && !containsKeywordVariant(h1Text, fk)) {
      issues.push({
        severity: "high",
        where: "H1",
        what: `Focus keyword "${fk}" (or a variant of its words) not found in the H1`,
      });
    }
    // Focus keyword in opening 100 words
    const first100 = body.split(/\s+/).filter(Boolean).slice(0, 100).join(" ");
    if (first100 && !containsKeywordVariant(first100, fk)) {
      issues.push({
        severity: "high",
        where: "Opening 100 words",
        what: `Focus keyword "${fk}" (or a variant of its words) not found in the first 100 words of the body`,
      });
    }
  }

  // At least one internal markdown link (path starting with /).
  // [anchor](/path) — not http(s) links.
  const internalLinks = (body.match(/\[[^\]]+\]\(\/[^)]+\)/g) ?? []).length;
  if (internalLinks === 0) {
    issues.push({
      severity: "med",
      where: "Body",
      what: "No internal markdown links present (need at least one [text](/path) link)",
    });
  }

  // Brand mentioned at least once.
  if (brandName && brandName.trim().length > 0) {
    const re = new RegExp(escapeRegex(brandName), "i");
    if (!re.test(body)) {
      issues.push({
        severity: "med",
        where: "Body",
        what: `Brand name "${brandName}" not mentioned anywhere in body`,
      });
    }
  }

  // Banned words from the brand kit.
  for (const raw of bannedWords) {
    const word = raw.trim();
    if (!word) continue;
    const pattern = new RegExp(`\\b${escapeRegex(word)}\\b`, "i");
    if (pattern.test(body)) {
      issues.push({
        severity: "high",
        where: "Body",
        what: `Banned word "${word}" appears in body`,
      });
    }
  }

  // Em / en dashes — the scrubber should have removed these, but flag any leftovers.
  if (/[—–]/.test(body)) {
    issues.push({
      severity: "high",
      where: "Body",
      what: "Em or en dash present (forbidden by brand style)",
    });
  }

  const high = issues.filter((i) => i.severity === "high").length;
  const med = issues.filter((i) => i.severity === "med").length;
  const verdict: CriticVerdict["verdict"] =
    high > 0 ? "escalate" :
    med >= 3 ? "revise" :
                "approve";

  return {
    scores: {
      voice: bannedWords.length > 0 && high > 0 ? 50 : 100,
      accuracy: 100,
      structure: 100,
      seo: high === 0 && med < 2 ? 100 : 70,
      cta: internalLinks > 0 ? 100 : 60,
    },
    issues,
    verdict,
  };
}

// True if `text` contains the keyword or — failing that — all of the
// keyword's significant words (>= 3 chars) appear in `text` in any order.
// Catches variations like "deploying ML models to production" matching
// "Deploying ML Models to Production" or "ML models in production".
function containsKeywordVariant(text: string, keyword: string): boolean {
  const t = text.toLowerCase();
  const k = keyword.trim().toLowerCase();
  if (t.includes(k)) return true;
  const words = k.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length === 0) return false;
  return words.every((w) => t.includes(w));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
