import { prisma, Prompts, logger, type Prisma } from "@ca/shared";
import { claude } from "@ca/providers";
import { bumpCost, loadBrandContext, setStatus, enqueuePublish } from "./util.js";
import { queue, QUEUES } from "@ca/shared";

// Decides what happens after a piece is drafted: auto-publish, AI-review,
// or send to the human review queue. Reads ContentPlan.approvalMode.
//
// AI-review mode runs an auto-fix loop pre-publish: if the critic flags
// issues, we re-draft and re-check up to MAX_CONTENT_FIX_ATTEMPTS times.
// After that, the item publishes anyway (content issues are tolerable;
// layout issues caught post-publish are NOT — see post-review.ts).

interface CriticVerdict {
  scores: Record<string, number>;
  issues: Array<{ severity: "low" | "med" | "high"; where: string; what: string }>;
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
  const { brandBlock } = await loadBrandContext(item.businessId);
  const res = await claude<CriticVerdict>({
    model: "routing",
    json: true,
    maxTokens: 1024,
    system: Prompts.CRITIC_SYSTEM,
    user: Prompts.criticUser(brandBlock, item.type, item.bodyMd),
  });
  await bumpCost(contentItemId, res.costUsd);
  const verdict = res.json;

  if (!verdict) {
    logger.warn({ contentItemId }, "route.critic_missing_json → publishing without further review");
    await prisma.contentItem.update({
      where: { id: contentItemId },
      data: {
        reviewNotes: "AI critic returned no JSON — published without verdict.",
        meta: {
          ...(item.meta as object),
          critic: { error: "no_json" } as unknown as Prisma.InputJsonValue,
        } as Prisma.InputJsonValue,
      },
    });
    await enqueuePublish(contentItemId);
    return;
  }

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
