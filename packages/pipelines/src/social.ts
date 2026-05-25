import { prisma, Prompts } from "@ca/shared";
import { claude, generateImage } from "@ca/providers";
import { bumpCost, loadBrandContext, setStatus, unusedTopicFor, markTopicUsed } from "./util.js";
import { routeApproval } from "./route.js";

interface SocialBatch {
  posts: Array<{ channel: "linkedin" | "x" | "instagram"; body: string; imagePrompt: string | null }>;
}

// One parent ContentItem holds the topic and a meta.posts[] array; we don't
// create N items per batch. When approved, publish.ts fans out to Buffer.

export async function runSocialPipeline(contentItemId: string): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  const { business, brandBlock } = await loadBrandContext(item.businessId);

  // 1. Topic
  await setStatus(contentItemId, "researching");
  let topic = item.title;
  if (!topic) {
    const t = await unusedTopicFor(item.businessId);
    if (!t) throw new Error("social: no unused topic available");
    topic = t.title;
    await markTopicUsed(t.id);
    await prisma.contentItem.update({ where: { id: contentItemId }, data: { title: topic } });
  }

  const meta = (item.meta ?? {}) as { count?: number; channels?: string[]; scheduledAt?: string; bufferProfileIds?: Record<string, string[]> };
  const count = meta.count ?? 3;
  const channels = meta.channels ?? ["linkedin", "x", "instagram"];

  // 2. Draft batch
  await setStatus(contentItemId, "drafting");
  const res = await claude<SocialBatch>({
    model: "writing",
    json: true,
    maxTokens: 2048,
    system: Prompts.SOCIAL_BATCH_SYSTEM,
    user: Prompts.socialBatchUser(brandBlock, topic, count, channels),
  });
  await bumpCost(contentItemId, res.costUsd);
  if (!res.json) throw new Error("social: missing JSON");

  // 3. Images (only for posts that asked for one; cheap mode)
  await setStatus(contentItemId, "generating_media");
  const enriched = await Promise.all(
    res.json.posts.map(async (p, i) => {
      if (!p.imagePrompt) return { ...p };
      try {
        const img = await generateImage({
          prompt: p.imagePrompt,
          quality: "low",
          businessSlug: business.slug,
          filenameHint: `social-${item.id}-${i}`,
        });
        await prisma.asset.create({
          data: { businessId: business.id, contentItemId, kind: "image", path: img.relPath, provider: "openai_image", prompt: p.imagePrompt, costUsd: img.costUsd },
        });
        await bumpCost(contentItemId, img.costUsd);
        return { ...p, imagePath: img.relPath };
      } catch {
        return { ...p };
      }
    }),
  );

  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: {
      bodyMd: enriched.map((p) => `### ${p.channel}\n${p.body}`).join("\n\n---\n\n"),
      meta: { ...meta, posts: enriched },
    },
  });

  // 4. Route
  await setStatus(contentItemId, "self_critique");
  await routeApproval(contentItemId);
}
