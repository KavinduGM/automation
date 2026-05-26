import { prisma, Prompts, logger, brandServicesBlock, brandSiteFor, type Prisma } from "@ca/shared";
import { claude, generateImage } from "@ca/providers";
import { bumpCost, loadBrandContext, makeSlug, markTopicUsed, setStatus, unusedTopicFor } from "./util.js";
import { routeApproval } from "./route.js";
import type { SeoBundle } from "./seo.js";

// Full blog pipeline: research → outline (with SEO + image markers + CTA) → draft → media → critique → route.
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
  primaryServiceSlug: string;
  authorMode: "founder" | "team";
  sections: Array<{ h2: string; bullets: string[] }>;
  imagePrompts: Array<{ prompt: string; alt: string; placement: "hero" | "section"; afterSectionIdx?: number }>;
  ctaMidArticle: { afterSectionIdx: number; title: string; href: string };
  ctaPreFaq: { title: string; href: string };
  internalLinks: Array<{ anchor: string; path: string }>;
  externalCitations: Array<{ source: string; context: string }>;
  faq: Array<{ q: string; a: string }>;
}

// Site-level author config keyed by business slug. For now hardcoded for
// the only business onboarded; move to brand-catalog or DB later.
const AUTHORS_BY_BUSINESS: Record<string, { founder: { name: string; url: string }; team: { name: string; url: string } }> = {
  "groovymark-webx": {
    founder: { name: "Kavindu Gamlath", url: "https://webx.groovymark.com/about" },
    team:    { name: "WebX Engineering Team", url: "https://webx.groovymark.com/about" },
  },
};
const DEFAULT_AUTHORS = {
  founder: { name: "Editorial Team", url: "" },
  team:    { name: "Editorial Team", url: "" },
};

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

  // 2. Outline (carries SEO fields, image plan, CTA hints, FAQ, service tie-in)
  await setStatus(contentItemId, "drafting");
  const servicesBlock = brandServicesBlock(business.slug);
  if (!servicesBlock) {
    logger.warn({ businessSlug: business.slug }, "blog: no brand_catalog entry — service tie-in will be vague");
  }

  const outlineRes = await claude<BlogOutline>({
    model: "writing",
    json: true,
    maxTokens: 4096,
    system: Prompts.BLOG_OUTLINE_SYSTEM,
    user: Prompts.blogOutlineUser(topicTitle, brandBlock, servicesBlock),
  });
  if (!outlineRes.json) throw new Error("blog: outline JSON missing");
  await bumpCost(contentItemId, outlineRes.costUsd);

  const outline = outlineRes.json;
  const slug = makeSlug(outline.slug || outline.title);
  const authors = AUTHORS_BY_BUSINESS[business.slug] ?? DEFAULT_AUTHORS;
  const author = authors[outline.authorMode] ?? authors.team;

  const seo: SeoBundle = {
    metaTitle: outline.metaTitle ?? null,
    metaDescription: outline.metaDescription ?? null,
    excerpt: outline.excerpt ?? null,
    focusKeyword: outline.focusKeyword ?? null,
    keywords: outline.keywords ?? [],
    ogImageAlt: outline.imagePrompts?.[0]?.alt ?? null,
    faq: outline.faq ?? [],
    internalLinkSuggestions: outline.internalLinks ?? [],
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
        authorName: author.name,
        authorUrl: author.url,
        seo: seo as unknown as Prisma.InputJsonValue,
        faq: outline.faq as unknown as Prisma.InputJsonValue,
      } as Prisma.InputJsonValue,
    },
  });

  // 3. Full draft with image markers + CTA markers + FAQ section.
  //    A 1500-2200-word post + 5-FAQ + image/CTA markers averages 10-12k
  //    output tokens; 8k was clipping ~one-in-three. 14k buys headroom for
  //    long titles + long FAQ answers without runaway cost (each extra 1k
  //    output tokens at sonnet pricing is ~$0.015).
  const draftRes = await claude<string>({
    model: "writing",
    maxTokens: 14000,
    system: Prompts.BLOG_DRAFT_SYSTEM,
    user: Prompts.blogDraftUser(outline, brandBlock, servicesBlock),
  });
  await bumpCost(contentItemId, draftRes.costUsd);

  // Post-process: belt-and-suspenders strip of any em/en dashes Claude let
  // through. Substitute with comma+space which is almost always semantically
  // closest. (Trailing/leading whitespace handled.)
  const cleanedBody = scrubDashes(draftRes.text);
  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: { bodyMd: cleanedBody },
  });

  // 4. Images — generate each one and store with the index encoded in `ord`
  //    so the publish layer can map [[IMAGE_N]] markers → real URLs.
  await setStatus(contentItemId, "generating_media");
  const imagePrompts = (outline.imagePrompts ?? []).slice(0, 5);
  for (const [i, ip] of imagePrompts.entries()) {
    try {
      const img = await generateImage({
        prompt: ip.prompt,
        quality: ip.placement === "hero" ? "high" : "medium",
        businessSlug: business.slug,
        filenameHint: `${slug}-${i}`,
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
          ord: i, // 0 = hero / OG image, 1..N = inline markers
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

// Replace every em/en dash with safer punctuation. Em dash in prose almost
// always reads as a comma; in compounds it should never appear (hyphens are
// fine inside compound words). This is a belt-and-suspenders pass — the
// prompt already forbids dashes, but Claude slips them in ~10% of the time.
function scrubDashes(text: string): string {
  return text
    // " — " or "—" between words → ", " (most natural rewrite)
    .replace(/\s*[—–]\s*/g, ", ")
    // any remaining bare em/en dash → comma
    .replace(/[—–]/g, ",")
    // collapse accidental ",,"
    .replace(/,{2,}/g, ",")
    // collapse ", ." or ", :"
    .replace(/,\s*([.;:!?])/g, "$1");
}

// Re-export so the WebX site (in this monorepo) and other callers can use
// the catalog. brandSiteFor is also pulled in via @ca/shared.
export { brandSiteFor };
