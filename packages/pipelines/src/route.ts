import { prisma, Prompts, logger } from "@ca/shared";
import { claude } from "@ca/providers";
import { bumpCost, loadBrandContext, setStatus } from "./util.js";
import { queue, QUEUES } from "@ca/shared";

// Decides what happens after a piece is drafted: auto-publish, AI-review,
// or send to the human review queue. Reads ContentPlan.approvalMode.

interface CriticVerdict {
  scores: Record<string, number>;
  issues: Array<{ severity: "low" | "med" | "high"; where: string; what: string }>;
  verdict: "approve" | "revise" | "escalate";
}

export async function routeApproval(contentItemId: string): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  const plan = await prisma.contentPlan.findUnique({
    where: { businessId_contentType: { businessId: item.businessId, contentType: item.type } },
  });
  const mode = plan?.approvalMode ?? "human_review";

  if (mode === "auto") {
    await setStatus(contentItemId, "approved");
    await queue(QUEUES.publish).add("publish", { contentItemId });
    return;
  }

  if (mode === "ai_review") {
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
      logger.warn({ contentItemId }, "route.critic_missing_json → human_review");
      await setStatus(contentItemId, "review", { reviewNotes: "AI critic returned no JSON" });
      return;
    }
    await prisma.contentItem.update({
      where: { id: contentItemId },
      data: {
        meta: { ...(item.meta as object), critic: verdict as unknown as object },
        reviewNotes: verdict.issues.map((i) => `[${i.severity}] ${i.where}: ${i.what}`).join("\n"),
      },
    });
    if (verdict.verdict === "approve") {
      await setStatus(contentItemId, "approved");
      await queue(QUEUES.publish).add("publish", { contentItemId });
    } else {
      await setStatus(contentItemId, "review");
    }
    return;
  }

  // human_review
  await setStatus(contentItemId, "review");
}
