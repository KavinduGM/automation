import { prisma, Prompts } from "@ca/shared";
import { claude } from "@ca/providers";
import { bumpCost, loadBrandContext, makeSlug, markTopicUsed, setStatus, unusedTopicFor } from "./util.js";
import { routeApproval } from "./route.js";

export async function runResourcePipeline(contentItemId: string): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  const { brandBlock } = await loadBrandContext(item.businessId);

  await setStatus(contentItemId, "researching");
  const meta = (item.meta ?? {}) as { kind?: string };
  const kind = meta.kind ?? "guide";

  let topic = item.title;
  if (!topic) {
    const t = await unusedTopicFor(item.businessId);
    if (!t) throw new Error("resource: no unused topic");
    topic = t.title;
    await markTopicUsed(t.id);
  }

  await setStatus(contentItemId, "drafting");
  const draft = await claude<string>({
    model: "writing",
    maxTokens: 6000,
    system: Prompts.RESOURCE_SYSTEM,
    user: Prompts.resourceUser(brandBlock, kind, topic),
  });
  await bumpCost(contentItemId, draft.costUsd);

  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: { title: topic, slug: makeSlug(topic), bodyMd: draft.text, meta: { ...meta, kind } },
  });

  await setStatus(contentItemId, "self_critique");
  await routeApproval(contentItemId);
}
