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

  // Hard-locked structure: 6 sections, 4 images, 5 FAQ, 4 internal links.
  // If Claude returns anything off-spec, retry ONCE with a stricter reminder
  // before continuing — beyond that we accept what we got rather than
  // burning more tokens; the auto-review safety net will catch real breakage.
  let outline: BlogOutline;
  let outlineRes = await claude<BlogOutline>({
    model: "writing",
    json: true,
    maxTokens: 4096,
    system: Prompts.BLOG_OUTLINE_SYSTEM,
    user: Prompts.blogOutlineUser(topicTitle, brandBlock, servicesBlock),
  });
  if (!outlineRes.json) throw new Error("blog: outline JSON missing");
  await bumpCost(contentItemId, outlineRes.costUsd);

  const issues = validateOutlineStructure(outlineRes.json);
  if (issues.length > 0) {
    logger.warn({ contentItemId, issues }, "blog.outline_structure_off_spec_retrying");
    outlineRes = await claude<BlogOutline>({
      model: "writing",
      json: true,
      maxTokens: 4096,
      system: Prompts.BLOG_OUTLINE_SYSTEM,
      user:
        Prompts.blogOutlineUser(topicTitle, brandBlock, servicesBlock) +
        `\n\nYour previous attempt violated the structural contract:\n` +
        issues.map((i) => `  - ${i}`).join("\n") +
        `\n\nFix exactly those counts. Return JSON only.`,
    });
    if (!outlineRes.json) throw new Error("blog: outline JSON missing on retry");
    await bumpCost(contentItemId, outlineRes.costUsd);
  }
  outline = outlineRes.json;
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
  //
  // Auto-fix mode: if this is a retry after a post-publish rollback, the
  // previous high-severity findings are stored on the item. We feed them
  // to Claude so it knows what to correct.
  const itemMeta = (item.meta ?? {}) as { autoFixAttempts?: number; lastFindings?: Array<{ area: string; message: string }> };
  const autoFixAttempt = itemMeta.autoFixAttempts ?? 0;
  const correctionContext = autoFixAttempt > 0 && itemMeta.lastFindings?.length
    ? buildCorrectionContext(autoFixAttempt, itemMeta.lastFindings)
    : "";

  const draftRes = await claude<string>({
    model: "writing",
    maxTokens: 14000,
    system: Prompts.BLOG_DRAFT_SYSTEM + correctionContext,
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

// Checks the outline JSON against the hard-locked structure contract.
// Returns a list of human-readable issues (empty = on-spec).
function validateOutlineStructure(o: BlogOutline): string[] {
  const issues: string[] = [];
  if (o.sections?.length !== 6) issues.push(`sections must be 6, got ${o.sections?.length ?? 0}`);
  if (o.imagePrompts?.length !== 4) issues.push(`imagePrompts must be 4, got ${o.imagePrompts?.length ?? 0}`);
  if (o.imagePrompts?.[0]?.placement !== "hero") issues.push(`imagePrompts[0] must be placement=hero`);
  for (const [i, expectedIdx] of [[1, 1], [2, 3], [3, 5]] as const) {
    const ip = o.imagePrompts?.[i];
    if (ip?.placement !== "section") issues.push(`imagePrompts[${i}] must be placement=section`);
    if (ip?.afterSectionIdx !== expectedIdx) issues.push(`imagePrompts[${i}].afterSectionIdx must be ${expectedIdx}, got ${ip?.afterSectionIdx ?? "?"}`);
  }
  if (o.internalLinks?.length !== 4) issues.push(`internalLinks must be 4, got ${o.internalLinks?.length ?? 0}`);
  if (o.faq?.length !== 5) issues.push(`faq must be 5 items, got ${o.faq?.length ?? 0}`);
  if (o.ctaMidArticle?.afterSectionIdx !== 3) issues.push(`ctaMidArticle.afterSectionIdx must be 3`);
  if (!o.ctaPreFaq?.title || !o.ctaPreFaq?.href) issues.push(`ctaPreFaq.title and .href required`);
  if (!o.primaryServiceSlug) issues.push(`primaryServiceSlug required`);
  return issues;
}

// Builds the "you got rolled back last time, here's why" appendix to the
// system prompt during auto-fix retries. Concrete > abstract: we tell
// Claude exactly which heuristics failed so it knows what to change.
function buildCorrectionContext(
  attempt: number,
  findings: Array<{ area: string; message: string }>,
): string {
  const list = findings.map((f) => `- [${f.area}] ${f.message}`).join("\n");
  return `\n\n# AUTO-FIX RETRY (attempt ${attempt})\n` +
    `Your previous draft of this article was auto-rolled back by the post-publish reviewer with these findings:\n\n` +
    list + `\n\n` +
    `Rewrite the article so EVERY one of those findings is resolved. Specifically:\n` +
    `- If "marker_leak" appears, you LEFT a literal [[...]] token in the body. Re-check every line.\n` +
    `- If "truncated" / "incomplete" appears, your previous draft cut off mid-sentence. Make sure every section finishes.\n` +
    `- If "brand mention" appears, name the brand 3+ times across the body.\n` +
    `- If "/services/" or "/contact" link missing, include them as real markdown links.\n` +
    `- If "em dash" appears, use commas/periods instead.\n`;
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
