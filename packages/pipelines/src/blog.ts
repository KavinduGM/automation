import { prisma, Prompts, logger, type Prisma } from "@ca/shared";
import { claude, generateImage } from "@ca/providers";
import { bumpCost, loadBrandContext, makeSlug, markTopicUsed, setStatus, unusedTopicFor } from "./util.js";
import { routeApproval } from "./route.js";
import type { SeoBundle } from "./seo.js";

// Full blog pipeline: research → outline (with SEO) → draft → media → critique → route.
// Each step persists progress so a worker restart resumes cleanly.

export interface BlogOutline {
  title: string;
  slug: string;
  metaTitle: string;
  metaDescription: string;
  excerpt: string;
  focusKeyword: string;
  keywords: string[];
  tags: string[];
  sections: Array<{ h2: string; bullets: string[] }>;
  imagePrompts: Array<{ prompt: string; alt: string }>;
  internalLinkSuggestions: Array<{ anchor: string; path: string }>;
  faq: Array<{ q: string; a: string }>;
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

  // 2. Outline (carries SEO fields)
  await setStatus(contentItemId, "drafting");
  const outlineRes = await claude<BlogOutline>({
    model: "writing",
    json: true,
    // Schema is rich (sections + bullets + faq + imagePrompts + internal links
    // + 7 SEO fields). 4096 keeps us safe even when Claude is verbose with
    // the FAQ answers.
    maxTokens: 4096,
    system: Prompts.BLOG_OUTLINE_SYSTEM,
    user: Prompts.blogOutlineUser(topicTitle, brandBlock),
  });
  if (!outlineRes.json) throw new Error("blog: outline JSON missing");
  await bumpCost(contentItemId, outlineRes.costUsd);

  const outline = outlineRes.json;
  const slug = makeSlug(outline.slug || outline.title);

  const seo: SeoBundle = {
    metaTitle: outline.metaTitle ?? null,
    metaDescription: outline.metaDescription ?? null,
    excerpt: outline.excerpt ?? null,
    focusKeyword: outline.focusKeyword ?? null,
    keywords: outline.keywords ?? [],
    ogImageAlt: outline.imagePrompts?.[0]?.alt ?? null,
    faq: outline.faq ?? [],
    internalLinkSuggestions: outline.internalLinkSuggestions ?? [],
  };

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
        seo: seo as unknown as Prisma.InputJsonValue,
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

  // 4. Images (hero + inline) — capture alt text per image
  await setStatus(contentItemId, "generating_media");
  const imagePrompts = (outline.imagePrompts ?? []).slice(0, 3);
  for (const [i, ip] of imagePrompts.entries()) {
    try {
      const img = await generateImage({
        prompt: ip.prompt,
        quality: i === 0 ? "high" : "medium",
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
          prompt: ip.prompt,
          altText: ip.alt ?? null,
          ord: i, // 0 = hero/OG image
          costUsd: img.costUsd,
        },
      });
      await bumpCost(contentItemId, img.costUsd);
    } catch (err) {
      logger.error({ err, prompt: ip.prompt }, "blog.image_failed");
    }
  }

  // 5. Self-critique → route
  await setStatus(contentItemId, "self_critique");
  await routeApproval(contentItemId);
}
