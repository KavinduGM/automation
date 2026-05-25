import { prisma, Prompts, logger, type Prisma } from "@ca/shared";
import { claude, generateImage } from "@ca/providers";
import { bumpCost, loadBrandContext, makeSlug, markTopicUsed, setStatus, unusedTopicFor } from "./util.js";
import { routeApproval } from "./route.js";

// Full blog pipeline: research → outline → draft → media → self-critique → route.
// Each step persists progress so a worker restart resumes cleanly.

export interface BlogOutline {
  title: string;
  slug: string;
  excerpt: string;
  tags: string[];
  sections: Array<{ h2: string; bullets: string[] }>;
  imagePrompts: string[];
}

export async function runBlogPipeline(contentItemId: string): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (item.type !== "blog") throw new Error("runBlogPipeline: not a blog item");

  const { business, brandBlock } = await loadBrandContext(item.businessId);

  // 1. Get a topic
  await setStatus(contentItemId, "researching");
  let topicTitle = item.title;
  if (!topicTitle) {
    const t = await unusedTopicFor(item.businessId);
    if (!t) throw new Error("No unused topic candidate available — wait for next research cycle");
    topicTitle = t.title;
    await markTopicUsed(t.id);
    await prisma.contentItem.update({
      where: { id: contentItemId },
      data: { title: topicTitle, topicCandidateId: t.id },
    });
  }

  // 2. Outline
  await setStatus(contentItemId, "drafting");
  const outlineRes = await claude<BlogOutline>({
    model: "writing",
    json: true,
    maxTokens: 2048,
    system: Prompts.BLOG_OUTLINE_SYSTEM,
    user: Prompts.blogOutlineUser(topicTitle, brandBlock),
  });
  if (!outlineRes.json) throw new Error("blog: outline JSON missing");
  await bumpCost(contentItemId, outlineRes.costUsd);

  const outline = outlineRes.json;
  const slug = makeSlug(outline.slug || outline.title);

  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: {
      title: outline.title,
      slug,
      meta: {
        ...(item.meta as object),
        outline: outline as unknown as Prisma.InputJsonValue,
        excerpt: outline.excerpt,
        tags: outline.tags,
      } as Prisma.InputJsonValue,
    },
  });

  // 3. Full draft
  const draftRes = await claude<string>({
    model: "writing",
    maxTokens: 8000,
    system: Prompts.BLOG_DRAFT_SYSTEM,
    user: Prompts.blogDraftUser(outline, brandBlock),
  });
  await bumpCost(contentItemId, draftRes.costUsd);
  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: { bodyMd: draftRes.text },
  });

  // 4. Images (hero + inline)
  await setStatus(contentItemId, "generating_media");
  const imagePrompts = (outline.imagePrompts ?? []).slice(0, 3);
  for (const [i, prompt] of imagePrompts.entries()) {
    try {
      const img = await generateImage({
        prompt,
        quality: i === 0 ? "high" : "medium", // hero is high, inline medium
        businessSlug: business.slug,
        filenameHint: `${slug}-${i + 1}`,
      });
      await prisma.asset.create({
        data: {
          businessId: business.id,
          contentItemId,
          kind: "image",
          path: img.relPath,
          provider: "openai_image",
          prompt,
          costUsd: img.costUsd,
        },
      });
      await bumpCost(contentItemId, img.costUsd);
    } catch (err) {
      logger.error({ err, prompt }, "blog.image_failed");
    }
  }

  // 5. Self-critique (only when approvalMode = ai_review; route decides)
  await setStatus(contentItemId, "self_critique");
  await routeApproval(contentItemId);
}
