import { prisma, Prompts, type Prisma } from "@ca/shared";
import { claude } from "@ca/providers";
import { bumpCost, loadBrandContext, makeSlug, markTopicUsed, setStatus, unusedTopicFor } from "./util.js";
import { routeApproval } from "./route.js";
import type { SeoBundle } from "./seo.js";

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

  // SEO finalization (Haiku, cheap)
  const seoRes = await claude<SeoBundle>({
    model: "routing",
    json: true,
    maxTokens: 1024,
    system: Prompts.RESOURCE_SEO_SYSTEM,
    user: Prompts.resourceSeoUser(brandBlock, kind, draft.text),
  });
  await bumpCost(contentItemId, seoRes.costUsd);
  const seo: SeoBundle = seoRes.json ?? {
    metaTitle: topic, metaDescription: null, excerpt: null,
    focusKeyword: topic, keywords: [], ogImageAlt: null,
  };

  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: {
      title: topic,
      slug: makeSlug(topic),
      bodyMd: draft.text,
      meta: {
        ...meta,
        kind,
        seo: seo as unknown as Prisma.InputJsonValue,
        excerpt: seo.excerpt,
      } as Prisma.InputJsonValue,
    },
  });

  await setStatus(contentItemId, "self_critique");
  await routeApproval(contentItemId);
}
