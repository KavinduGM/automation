import { prisma, Prompts, logger, brandServicesBlock, brandSiteFor, env, type Prisma } from "@ca/shared";
import { claude, generateImage, grokBatchedBriefs, sendEmail } from "@ca/providers";
import { bumpCost, loadBrandContext, logStep, makeSlug, markTopicUsed, setStatus, unusedTopicFor } from "./util.js";
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
  // The narrative archetype the article is written in. Drives framing,
  // not structure (all archetypes use the same 6-section spine). The
  // rotation logic in daily_brief surfaces which archetypes haven't
  // been used lately so Claude can spread variety across the catalog.
  articleType:
    | "problem_solving"   // "Why X breaks in production and how to fix it"
    | "tutorial"           // "How to build/integrate Y" — step-by-step
    | "industry_analysis"  // "The state of Z in 2026"
    | "comparison"         // "X vs Y: which fits your stack"
    | "mistake_driven"     // "10 mistakes we see in X"
    | "behind_the_scenes"  // "Our approach to W (with examples)"
    | "trend_analysis"     // "What's changing in T right now"
    | "guide";             // "Complete reference guide to V"
  // Short question/hook headline rendered on the brand cover image.
  // 4-7 words. Cover composition truncates anything longer, so the full
  // article title was getting cropped on display ("SCALABLE WEB" → "ICALABLE WEB").
  // Examples: "READY TO DEPLOY ML MODELS?", "STRUGGLING WITH B2B SCALE?"
  coverHeadline: string;
  // Topic-driven scene description (background + props + lighting mood) so
  // every cover doesn't look identical. The composition is locked (device
  // on right, headline on left, "Blog" badge) so the brand series stays
  // coherent — only the surrounding environment varies. ~6-15 words.
  // Examples:
  //   "creator studio with blurred camera, tripod and ring light in background"
  //   "engineer's dual-monitor workstation, plants and notebook in soft focus"
  //   "minimalist designer desk with sketches and stylus visible"
  //   "boardroom-style table with leather notebook and city window backdrop"
  coverScene: string;
  sections: Array<{ h2: string; bullets: string[] }>;
  imagePrompts: Array<{
    prompt: string;                       // body images: full image prompt; hero: short subject hint (e.g. "a CRM analytics dashboard")
    alt: string;                          // alt text for accessibility + SEO
    placement: "hero" | "section";
    afterSectionIdx?: number;
    style?: "photo" | "diagram";          // body images only; ignored for hero. Diagrams may include short labels in the image.
    // REQUIRED when style === "diagram": exact text labels to render inside
    // the image, in left-to-right (or top-to-bottom) order. gpt-image-1
    // renders specified text far more reliably than freeform "label your
    // shapes" — that's where the gibberish ("Senime B") came from.
    // 2-5 labels, each 1-3 words. Empty for photos.
    labels?: string[];
  }>;
  ctaMidArticle: { afterSectionIdx: number; title: string; href: string };
  ctaPreFaq: { title: string; href: string };
  internalLinks: Array<{ anchor: string; path: string }>;
  externalCitations: Array<{ source: string; context: string }>;
  faq: Array<{ q: string; a: string }>;
}

// Site-level author roster keyed by business slug. The outline picks
// authorMode (founder vs team); for "team" articles we deterministically
// round-robin among the listed team members so the byline isn't always
// the same person. Deterministic so the same contentItemId always picks
// the same author (useful for re-publishes and tests).
//
// For now hardcoded; move to brand-catalog or BrandKit JSON later.
interface AuthorEntry {
  name: string;
  role: string;
  url: string;
}
interface AuthorRoster {
  founder: AuthorEntry;
  team: AuthorEntry[];
}
const AUTHORS_BY_BUSINESS: Record<string, AuthorRoster> = {
  "groovymark-webx": {
    founder: { name: "Kavindu Gamlath", role: "Founder & CEO", url: "https://webx.groovymark.com/about" },
    team: [
      { name: "Rangaa Cooray", role: "CTO & Senior Software Engineer", url: "https://webx.groovymark.com/about" },
      { name: "Elijah",        role: "Senior AI Systems Engineer",     url: "https://webx.groovymark.com/about" },
      { name: "Amanda",        role: "Full Stack Developer",           url: "https://webx.groovymark.com/about" },
      { name: "Vishwa",        role: "Senior Full Stack Developer",    url: "https://webx.groovymark.com/about" },
    ],
  },
};
const DEFAULT_AUTHORS: AuthorRoster = {
  founder: { name: "Editorial Team", role: "", url: "" },
  team:    [{ name: "Editorial Team", role: "", url: "" }],
};

// Pick the right byline. Founder articles always go to the named
// founder; team articles round-robin by a simple hash of the
// contentItemId so the same item always re-picks the same person but
// across a batch of articles the roster spreads evenly.
function pickAuthor(roster: AuthorRoster, mode: "founder" | "team", contentItemId: string): AuthorEntry {
  if (mode === "founder") return roster.founder;
  const team = roster.team.length > 0 ? roster.team : [roster.founder];
  // Stable hash of the id → integer index.
  let hash = 0;
  for (let i = 0; i < contentItemId.length; i += 1) {
    hash = ((hash << 5) - hash + contentItemId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % team.length;
  return team[idx]!;
}

export async function runBlogPipeline(contentItemId: string): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (item.type !== "blog") throw new Error("runBlogPipeline: not a blog item");

  const { business, brandBlock } = await loadBrandContext(item.businessId);

  // Auto-fix scope drives which steps to run. First run is always "both".
  //   - "text"   → regen outline + draft, KEEP existing images (cheap text fix)
  //   - "images" → skip outline + draft, only regen images (saves Claude $)
  //   - "both"   → full pipeline
  //
  // Two counters can put us in a fix retry:
  //   - contentFixAttempts → AI critic flagged content issues pre-publish
  //   - autoFixAttempts    → post-publish layout reviewer rolled back
  const itemMeta = (item.meta ?? {}) as {
    autoFixAttempts?: number;
    contentFixAttempts?: number;
    lastFindings?: Array<{ area: string; message: string; sectionH2?: string; severity?: string }>;
    fixScope?: "text" | "images" | "both" | "section";
    outline?: BlogOutline;
  };
  const layoutAttempt = itemMeta.autoFixAttempts ?? 0;
  const contentAttempt = itemMeta.contentFixAttempts ?? 0;
  const totalFixAttempt = layoutAttempt + contentAttempt;
  const fixScope: "text" | "images" | "both" | "section" =
    totalFixAttempt > 0 ? (itemMeta.fixScope ?? "both") : "both";

  // Image-only fast path: reuse existing outline + body, just regen images.
  // Only the layout-fix loop can ask for images-scope (the critic doesn't
  // read images), so this branch is safe to keep gated on fixScope alone.
  if (fixScope === "images") {
    await regenImagesOnly(contentItemId, business, itemMeta.outline);
    await setStatus(contentItemId, "self_critique");
    await routeApproval(contentItemId);
    return;
  }

  // Section-only fast path: critic flagged specific H2 sections with
  // sectionH2 set on each finding. Rewrite ONLY those sections, splice
  // back into bodyMd. Skip outline + skip image regen entirely. ~80%
  // cheaper than full re-draft for localized issues.
  if (fixScope === "section" && itemMeta.lastFindings?.length) {
    const ok = await regenSectionsOnly(contentItemId, item.bodyMd, itemMeta);
    if (ok) {
      await setStatus(contentItemId, "self_critique");
      await routeApproval(contentItemId);
      return;
    }
    // Section regen couldn't find the sections cleanly — fall through to
    // the full text re-draft path rather than skipping the fix entirely.
    logger.warn({ contentItemId }, "blog.section_regen_fell_through_to_full_text");
  }

  // 1. Get a topic
  await setStatus(contentItemId, "researching");
  let topicTitle = item.title;
  let topicCandidateId = item.topicCandidateId;
  if (!topicTitle) {
    const t = await unusedTopicFor(item.businessId);
    if (!t) {
      await logStep(contentItemId, "topic", "failed", { label: "Pick topic", message: "No unused topic candidate available" });
      throw new Error("No unused topic candidate available — wait for next research cycle");
    }
    topicTitle = t.title;
    topicCandidateId = t.id;
    await markTopicUsed(t.id);
    await prisma.contentItem.update({
      where: { id: contentItemId },
      data: { title: topicTitle, topicCandidateId: t.id },
    });
    await logStep(contentItemId, "topic", "completed", { label: "Topic selected", message: topicTitle, metadata: { source: t.source, score: t.score } });
  } else {
    await logStep(contentItemId, "topic", "completed", { label: "Topic provided", message: topicTitle });
  }

  // Pull the original topic candidate so we can use any research brief
  // attached to it (daily_brief topics carry grokBrief on raw, and may
  // have freshResearchEnabled set by an admin if they're time-sensitive).
  const topicCandidate = topicCandidateId
    ? await prisma.topicCandidate.findUnique({ where: { id: topicCandidateId } })
    : null;
  const researchContext = await buildResearchContext(topicCandidate, topicTitle);

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
  // Outline is structural JSON, not creative writing — Haiku handles it
  // well at ~25% the cost of Sonnet. The validator + one-shot retry
  // catches anything off-spec.
  // System prompt is cached so a worker drafting multiple articles per
  // window only pays full price on the first call.
  const outlineSystem = [{ text: Prompts.BLOG_OUTLINE_SYSTEM, cache: true }];
  await logStep(contentItemId, "outline", "started", { label: "Outline + SEO metadata (Haiku)" });
  const outlineT0 = Date.now();
  let outlineRes = await claude<BlogOutline>({
    model: "routing",
    json: true,
    maxTokens: 4096,
    system: outlineSystem,
    user: Prompts.blogOutlineUser(topicTitle, brandBlock, servicesBlock, researchContext),
  });
  if (!outlineRes.json) {
    await logStep(contentItemId, "outline", "failed", { label: "Outline", message: "JSON missing" });
    throw new Error("blog: outline JSON missing");
  }
  await bumpCost(contentItemId, outlineRes.costUsd);

  const issues = validateOutlineStructure(outlineRes.json);
  if (issues.length > 0) {
    await logStep(contentItemId, "outline_retry", "started", { label: "Outline retry (off-spec)", message: issues.slice(0, 3).join("; ") });
    logger.warn({ contentItemId, issues }, "blog.outline_structure_off_spec_retrying");
    outlineRes = await claude<BlogOutline>({
      model: "routing",
      json: true,
      maxTokens: 4096,
      system: outlineSystem,
      user:
        Prompts.blogOutlineUser(topicTitle, brandBlock, servicesBlock, researchContext) +
        `\n\nYour previous attempt violated the structural contract:\n` +
        issues.map((i) => `  - ${i}`).join("\n") +
        `\n\nFix exactly those counts. Return JSON only.`,
    });
    if (!outlineRes.json) {
      await logStep(contentItemId, "outline_retry", "failed", { label: "Outline retry", message: "JSON missing on retry" });
      throw new Error("blog: outline JSON missing on retry");
    }
    await bumpCost(contentItemId, outlineRes.costUsd);
    await logStep(contentItemId, "outline_retry", "completed", { label: "Outline retry" });
  }
  await logStep(contentItemId, "outline", "completed", {
    label: "Outline + SEO metadata",
    durationMs: Date.now() - outlineT0,
    metadata: { costUsd: outlineRes.costUsd, slug: outlineRes.json.slug, focusKeyword: outlineRes.json.focusKeyword },
  });
  outline = outlineRes.json;
  const slug = makeSlug(outline.slug || outline.title);
  const roster = AUTHORS_BY_BUSINESS[business.slug] ?? DEFAULT_AUTHORS;
  const author = pickAuthor(roster, outline.authorMode, contentItemId);

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
        authorRole: author.role,
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
  const correctionContext = totalFixAttempt > 0 && itemMeta.lastFindings?.length
    ? buildCorrectionContext(totalFixAttempt, itemMeta.lastFindings)
    : "";

  // Cache the stable BLOG_DRAFT_SYSTEM; keep the per-article correction
  // context uncached since it's unique to each retry.
  const draftSystem = correctionContext
    ? [
        { text: Prompts.BLOG_DRAFT_SYSTEM, cache: true },
        { text: correctionContext, cache: false },
      ]
    : [{ text: Prompts.BLOG_DRAFT_SYSTEM, cache: true }];
  await logStep(contentItemId, "draft", "started", { label: "Article body (Sonnet)" });
  const draftT0 = Date.now();
  const draftRes = await claude<string>({
    model: "writing",
    maxTokens: 14000,
    system: draftSystem,
    user: Prompts.blogDraftUser(outline, brandBlock, servicesBlock),
  });
  await bumpCost(contentItemId, draftRes.costUsd);
  await logStep(contentItemId, "draft", "completed", {
    label: "Article body",
    durationMs: Date.now() - draftT0,
    metadata: { costUsd: draftRes.costUsd, chars: draftRes.text.length },
  });

  // Post-process: belt-and-suspenders strip of any em/en dashes + AI tells
  // Claude let through. Substitute with comma+space which is almost always
  // semantically closest.
  const cleanedBody = scrubAiTells(scrubDashes(draftRes.text));
  const scrubbed = draftRes.text.length - cleanedBody.length;
  await logStep(contentItemId, "style_scrub", "completed", {
    label: "Em-dash + AI-tells scrub",
    metadata: { charsRemoved: scrubbed },
  });
  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: { bodyMd: cleanedBody },
  });

  // 4. Images — generate each one and store with the index encoded in `ord`
  //    so the publish layer can map [[IMAGE_N]] markers → real URLs.
  //    Skipped on text-only auto-fixes; existing assets carry over.
  if (fixScope === "text") {
    await logStep(contentItemId, "images", "skipped", { label: "Images (text-only fix)" });
    logger.info(
      { contentItemId, layoutAttempt, contentAttempt },
      "blog.skipping_images_text_only_fix",
    );
  } else {
    await runImageGeneration(contentItemId, business.id, business.slug, slug, outline.imagePrompts ?? [], outline.title, outline.coverHeadline, outline.coverScene);
  }

  // 5. Self-critique → route
  await setStatus(contentItemId, "self_critique");
  await logStep(contentItemId, "route_approval", "started", { label: "Approval routing" });
  await routeApproval(contentItemId);
  await logStep(contentItemId, "route_approval", "completed", { label: "Approval routing" });
}

// Section-level content fix. Parses the existing bodyMd into H2 sections,
// finds the ones flagged by the critic (matched by sectionH2 substring),
// asks Claude to rewrite ONLY those sections with the finding as
// correction context, and splices the new sections back into the body.
// Returns true if at least one section was successfully rewritten;
// false signals the caller to fall back to a full text re-draft.
async function regenSectionsOnly(
  contentItemId: string,
  bodyMd: string,
  meta: {
    lastFindings?: Array<{ message: string; sectionH2?: string; severity?: string }>;
    contentFixAttempts?: number;
  },
): Promise<boolean> {
  await setStatus(contentItemId, "drafting");
  const findings = (meta.lastFindings ?? []).filter((f) => f.sectionH2);
  if (findings.length === 0) return false;

  // Split body into segments keyed by H2 text. Preserves the H1 + intro
  // (before the first ##) and any trailing FAQ section that uses ###.
  const sections = splitByH2(bodyMd);
  if (sections.h2Sections.length === 0) return false;

  // Group findings by their H2 (multiple findings may target the same section).
  const issuesBySection = new Map<string, Array<{ message: string; severity?: string }>>();
  for (const f of findings) {
    const key = normalizeH2(f.sectionH2 ?? "");
    if (!key) continue;
    if (!issuesBySection.has(key)) issuesBySection.set(key, []);
    issuesBySection.get(key)!.push({ message: f.message, severity: f.severity });
  }

  let regeneratedAny = false;
  for (const sec of sections.h2Sections) {
    const matches = issuesBySection.get(normalizeH2(sec.heading));
    if (!matches || matches.length === 0) continue;

    const issuesBlock = matches.map((m) => `- [${m.severity ?? "med"}] ${m.message}`).join("\n");
    const sectionMd = `## ${sec.heading}\n\n${sec.body}`;

    try {
      const res = await claude<string>({
        model: "writing",
        maxTokens: 2500,
        system:
          `You are rewriting ONE H2 section of a B2B blog article. ` +
          `Preserve the H2 heading exactly. Keep the same length and structure (paragraph count + H3s if any). ` +
          `Apply ALL brand style rules from the parent draft (no em dashes, no AI tells, contractions OK, varied sentence length). ` +
          `Keep any [[IMAGE_N]] or [[CTA: ...]] markers that were in the original section, in the same positions. ` +
          `Return the rewritten section in pure Markdown — heading first, then body. No prose before or after.`,
        user:
          `# Critic flagged the following issues in this section:\n${issuesBlock}\n\n` +
          `# Original section:\n\n${sectionMd}\n\n` +
          `Rewrite to resolve every flagged issue. Return Markdown only.`,
      });
      await bumpCost(contentItemId, res.costUsd);
      const rewritten = scrubAiTells(scrubDashes(res.text)).trim();
      if (!rewritten || !rewritten.toLowerCase().startsWith("## ")) {
        logger.warn({ contentItemId, heading: sec.heading }, "blog.section_regen_returned_invalid");
        continue;
      }
      sec.regenerated = rewritten;
      regeneratedAny = true;
    } catch (err) {
      logger.warn({ err, contentItemId, heading: sec.heading }, "blog.section_regen_call_failed");
    }
  }

  if (!regeneratedAny) return false;

  // Stitch the body back together: leading content + (possibly rewritten) sections + trailing.
  const stitched = [
    sections.leading,
    ...sections.h2Sections.map((s) => s.regenerated ?? `## ${s.heading}\n\n${s.body}`),
    sections.trailing,
  ]
    .filter((p) => p.trim().length > 0)
    .join("\n\n");

  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: { bodyMd: stitched },
  });

  logger.info(
    { contentItemId, sectionsTouched: sections.h2Sections.filter((s) => s.regenerated).length, totalSections: sections.h2Sections.length },
    "blog.section_regen_done",
  );
  return true;
}

// Splits a blog body into the H1+intro before the first H2, the H2-bounded
// sections, and any trailing content after the last H2 (FAQ block etc).
// Heading text is captured WITHOUT the "## " prefix.
function splitByH2(body: string): {
  leading: string;
  h2Sections: Array<{ heading: string; body: string; regenerated?: string }>;
  trailing: string;
} {
  const lines = body.split("\n");
  const blocks: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }];
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      blocks.push({ heading: m[1] ?? "", lines: [] });
    } else {
      blocks[blocks.length - 1]!.lines.push(line);
    }
  }
  const leading = (blocks[0]?.lines ?? []).join("\n").trim();
  const h2Blocks = blocks.slice(1).filter((b) => b.heading !== null);
  // Detect trailing FAQ-style content: if a section's heading is exactly
  // "Frequently asked questions" (case-insensitive), treat it as trailing
  // so the rewriter doesn't touch ### Q&A pairs.
  let trailingIdx = -1;
  for (let i = h2Blocks.length - 1; i >= 0; i -= 1) {
    const h = h2Blocks[i]!.heading!;
    if (/^frequently asked questions$/i.test(h.trim()) || /^faq$/i.test(h.trim())) {
      trailingIdx = i;
      break;
    }
  }
  const h2Sections = (trailingIdx >= 0 ? h2Blocks.slice(0, trailingIdx) : h2Blocks).map((b) => ({
    heading: b.heading ?? "",
    body: b.lines.join("\n").trim(),
  }));
  const trailing =
    trailingIdx >= 0
      ? h2Blocks
          .slice(trailingIdx)
          .map((b) => `## ${b.heading}\n\n${b.lines.join("\n").trim()}`)
          .join("\n\n")
      : "";
  return { leading, h2Sections, trailing };
}

function normalizeH2(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Image-only auto-fix: keep existing outline + body. Two modes:
//   1. Targeted (preferred) — meta.imageErrors lists which `ord`s failed
//      last time. Only delete + regenerate THOSE; successful images stay.
//      This is the common case when admin retries after fixing OpenAI credits.
//   2. Full — no imageErrors stored. Wipe all image assets and regen all
//      from the saved outline (legacy items or layout-review rollbacks).
//
// If the saved outline is missing (legacy items), this falls through to a
// no-op + warning so we don't crash; routeApproval still runs.
async function regenImagesOnly(
  contentItemId: string,
  business: { id: string; slug: string },
  savedOutline: BlogOutline | undefined,
): Promise<void> {
  await setStatus(contentItemId, "generating_media");
  if (!savedOutline?.imagePrompts?.length) {
    logger.warn({ contentItemId }, "blog.regen_images_only_missing_outline");
    return;
  }
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  const slug = item.slug ?? makeSlug(item.title);
  const meta = (item.meta ?? {}) as { imageErrors?: Array<{ ord: number }> };
  const failedOrds = (meta.imageErrors ?? []).map((e) => e.ord).filter((o) => Number.isFinite(o));

  if (failedOrds.length > 0) {
    // Targeted retry — only the previously-failed images. Keep the rest.
    logger.info({ contentItemId, failedOrds }, "blog.regen_images_targeted");
    await prisma.asset.deleteMany({
      where: { contentItemId, kind: "image", ord: { in: failedOrds } },
    });
    await runImageGeneration(
      contentItemId,
      business.id,
      business.slug,
      slug,
      savedOutline.imagePrompts,
      savedOutline.title,
      savedOutline.coverHeadline,
      savedOutline.coverScene,
      failedOrds,
    );
    return;
  }

  // Full image regen — no per-image error info, wipe all and try fresh.
  await prisma.asset.deleteMany({ where: { contentItemId, kind: "image" } });
  await runImageGeneration(contentItemId, business.id, business.slug, slug, savedOutline.imagePrompts, savedOutline.title, savedOutline.coverHeadline, savedOutline.coverScene);
}

// Build the brand-templated cover image prompt. Every cover image in the
// brand's catalog uses the same composition so articles look like a
// series, not a stock-photo collage. The article-specific piece is the
// "subject hint" (what's on the device screen) supplied by the outline.
//
// Composition is INSET to the center 70% of the frame so client sites
// displaying the 3:2 source in a 16:9 frame don't truncate the headline
// (we saw "SCALABLE WEB" get cropped to "ICALABLE WEB" in the live page).
function buildBrandCoverPrompt(
  style: NonNullable<ReturnType<typeof brandSiteFor>>["coverImageStyle"],
  fallbackTitle: string,
  coverSubject: string,
  coverHeadline?: string,
  coverScene?: string,
): string {
  if (!style) return `${coverSubject}. ${fallbackTitle}.`;
  // Prefer the short hook headline; fall back to the article title if outline
  // didn't supply one. Always upper-case for visual weight.
  const raw = (coverHeadline ?? fallbackTitle).trim();
  const headline = raw.toUpperCase();
  // Scene varies the BACKGROUND environment + props per article so the
  // series doesn't look stamped. Composition stays locked for brand identity.
  const sceneLine = coverScene && coverScene.trim().length > 0
    ? `Scene: ${coverScene.trim()} — kept SOFT-FOCUS in the background only; never compete with the device or headline.`
    : `Scene: clean studio surface, soft natural light.`;
  return [
    `Create a 16:9 brand cover image — wide horizontal composition.`,
    `Background: ${style.backgroundColor} as the dominant base color.`,
    sceneLine,
    `Accent color: ${style.themeColor} — used ONLY for the headline typography and a small badge.`,
    `IMPORTANT — Safe zone: all text, the device, and the badge MUST stay within the CENTER 70% of the frame. The outer 15% on each side and 10% top/bottom should be the soft-focus scene background. This prevents any text or content from being cropped when the image is displayed at different aspect ratios.`,
    `Right side of the frame (inside the safe zone): ${style.deviceHint}, screen visible and in focus.`,
    `The device screen displays: ${coverSubject}.`,
    `Left side of the frame (inside the safe zone): vertical text block —`,
    `  Headline (large, bold, color ${style.themeColor}, MUST FIT on 2-3 lines): "${headline}"`,
    `  Below the headline, a small rounded pill badge — background ${style.themeColor}, text white — saying "Blog".`,
    style.extraStyleHints ? `Photographic style: ${style.extraStyleHints}.` : "",
    `Rendering rules: the headline text must be clearly legible and exactly as written. No extra background text, no watermarks, no AI artefacts, no garbled glyphs. No people in the foreground. Keep the headline + device dominant; the scene props are atmosphere only.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Augment a body image prompt with style-specific guardrails. Photos get
// the no-text + no-stock-cliché reminder; diagrams get the explicit
// label list quoted verbatim so the image model renders correct text
// instead of garbled characters.
function augmentBodyPrompt(
  rawPrompt: string,
  style: "photo" | "diagram",
  brandThemeColor: string | undefined,
  labels: string[] | undefined,
): string {
  if (style === "diagram") {
    const colorHint = brandThemeColor
      ? `Use ${brandThemeColor} as the primary accent color for shapes, arrows, and label backgrounds.`
      : "Use a single brand accent color throughout.";
    // Cap at 5 labels — more than that and the model starts skipping/
    // mangling text. Quote each one so the model treats it as literal.
    const safeLabels = (labels ?? []).slice(0, 5).filter((l) => l && l.trim().length > 0);
    const labelLine = safeLabels.length > 0
      ? `The diagram MUST contain ONLY these labels, spelled EXACTLY as written and clearly readable: ${safeLabels.map((l) => `"${l.trim()}"`).join(", ")}. Each label appears EXACTLY ONCE. Do NOT add any other words, captions, titles, or numbers anywhere in the image.`
      : `Every shape needs ONE short readable label (1-3 common English words). No other text anywhere.`;
    return [
      rawPrompt + ".",
      `Clean flat illustration on a white background.`,
      colorHint,
      labelLine,
      `Use simple geometric shapes (rectangles, circles, arrows) and sans-serif typography. Plenty of whitespace between labels so text renders crisply. No decorative chrome, no extra background art, no watermarks, no AI artefacts.`,
    ].join(" ");
  }
  // photo (default)
  return [
    rawPrompt + ".",
    `Real photograph. No text in the image, no labels, no watermarks. Avoid stock-photo clichés (no smiling-team-around-a-laptop). Brand-safe, agency-grade.`,
  ].join(" ");
}

// Run the image generation loop and capture any per-image errors visibly on
// meta.imageErrors so they're debuggable from the dashboard instead of only
// surfacing as a marker_leak finding after post-review.
//
// `onlyOrds` (optional) restricts generation to those ord indices — used
// by the targeted-retry path so successful images aren't regenerated.
async function runImageGeneration(
  contentItemId: string,
  businessId: string,
  businessSlug: string,
  slug: string,
  imagePrompts: BlogOutline["imagePrompts"],
  articleTitle: string,
  coverHeadline: string | undefined,
  coverScene: string | undefined,
  onlyOrds?: number[],
): Promise<void> {
  await setStatus(contentItemId, "generating_media");
  const ordsToGenerate = onlyOrds && onlyOrds.length > 0 ? new Set(onlyOrds) : null;
  const brand = brandSiteFor(businessSlug);
  const errors: Array<{ ord: number; prompt: string; message: string }> = [];
  let succeeded = 0;
  for (const [i, ip] of imagePrompts.slice(0, 5).entries()) {
    if (ordsToGenerate && !ordsToGenerate.has(i)) continue;
    const isHero = ip.placement === "hero";
    // Build the actual prompt sent to OpenAI:
    //   - hero: brand-templated cover composition + AI-supplied subject hint
    //   - body photo: raw prompt + safety rails (no text, no clichés)
    //   - body diagram: raw prompt + flat-illustration + label rules + brand color
    let finalPrompt: string;
    if (isHero) {
      finalPrompt = brand?.coverImageStyle
        ? buildBrandCoverPrompt(brand.coverImageStyle, articleTitle, ip.prompt, coverHeadline, coverScene)
        : ip.prompt;
    } else {
      finalPrompt = augmentBodyPrompt(ip.prompt, ip.style ?? "photo", brand?.coverImageStyle?.themeColor, ip.labels);
    }
    const styleLabel = isHero ? "brand cover" : (ip.style ?? "photo");
    const label = `Image #${i}${isHero ? " · hero (cover)" : ` · ${styleLabel}`}`;
    await logStep(contentItemId, `image_${i}`, "started", { label });
    const imgT0 = Date.now();
    try {
      const img = await generateImage({
        prompt: finalPrompt,
        // Drop hero from "high" to "medium". The brand template carries the
        // visual lift; we don't need photo-grade rendering — and "high" was
        // costing ~2.7× medium for a marginal quality difference.
        quality: "medium",
        businessSlug,
        filenameHint: `${slug}-${i}`,
      });
      await prisma.asset.create({
        data: {
          businessId,
          contentItemId,
          kind: "image",
          path: img.relPath,
          provider: "openai_image",
          prompt: finalPrompt,
          altText: ip.alt ?? null,
          ord: i, // 0 = hero / OG image, 1..N = inline markers
          costUsd: img.costUsd,
        },
      });
      await bumpCost(contentItemId, img.costUsd);
      succeeded += 1;
      await logStep(contentItemId, `image_${i}`, "completed", {
        label,
        durationMs: Date.now() - imgT0,
        metadata: { costUsd: img.costUsd, quality: "medium", style: styleLabel },
      });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      logger.error({ err, prompt: finalPrompt, ord: i }, "blog.image_failed");
      errors.push({ ord: i, prompt: finalPrompt, message });
      await logStep(contentItemId, `image_${i}`, "failed", {
        label,
        message,
        durationMs: Date.now() - imgT0,
      });
    }
  }
  // Persist the error list (and clear it on success) so the dashboard can
  // show "2/4 images failed: <reason>" instead of mysteriously missing media.
  // For targeted retries, MERGE: keep existing imageErrors for ords we didn't
  // touch, replace entries for ords we just attempted.
  const current = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  const currentMeta = (current.meta ?? {}) as { imageErrors?: Array<{ ord: number; prompt: string; message: string }> };
  let mergedErrors: Array<{ ord: number; prompt: string; message: string }>;
  if (ordsToGenerate) {
    const untouched = (currentMeta.imageErrors ?? []).filter((e) => !ordsToGenerate.has(e.ord));
    mergedErrors = [...untouched, ...errors];
  } else {
    mergedErrors = errors;
  }
  const attemptedCount = ordsToGenerate ? ordsToGenerate.size : Math.min(imagePrompts.length, 5);
  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: {
      meta: {
        ...(current.meta as object),
        imageErrors: mergedErrors as unknown as Prisma.InputJsonValue,
        imagesGenerated: succeeded,
        imagesAttempted: attemptedCount,
      } as Prisma.InputJsonValue,
    },
  });
  if (errors.length > 0) {
    logger.warn(
      { contentItemId, failed: errors.length, succeeded, targeted: !!ordsToGenerate },
      "blog.image_generation_partial",
    );
    await maybeNotifyAdminOfImageFailure(contentItemId, errors);
  }
}

// Build the research context block fed into the outline prompt.
// Sources (in priority order):
//   1. Fresh per-article Grok call — only if the admin enabled it on the
//      topic (freshResearchEnabled). Used for breaking/time-sensitive topics
//      where the morning daily_brief snapshot has gone stale.
//   2. The morning daily_brief Grok snapshot stored on raw.grokBrief.
//   3. Nothing — falls back to a vanilla outline call.
async function buildResearchContext(
  candidate: Awaited<ReturnType<typeof prisma.topicCandidate.findUnique>>,
  topicTitle: string,
): Promise<string | undefined> {
  if (!candidate) return undefined;
  const raw = (candidate.raw ?? {}) as {
    grokBrief?: { angles?: string[]; examples?: string[]; sources?: string[] } | null;
    whyNow?: string | null;
  };

  // Per-article fresh research path.
  if (candidate.freshResearchEnabled) {
    try {
      const { briefs } = await grokBatchedBriefs({ topics: [topicTitle] });
      const fresh = briefs[0];
      if (fresh) {
        logger.info({ topicCandidateId: candidate.id }, "blog.fresh_grok_research_used");
        return formatBrief(fresh.angles, fresh.examples, fresh.sources, raw.whyNow, "FRESH RESEARCH (just now)");
      }
    } catch (err) {
      logger.warn({ err, topicCandidateId: candidate.id }, "blog.fresh_grok_failed_falling_back");
    }
  }

  // Morning batched brief path.
  if (raw.grokBrief) {
    return formatBrief(
      raw.grokBrief.angles,
      raw.grokBrief.examples,
      raw.grokBrief.sources,
      raw.whyNow,
      "DAILY BRIEFING (this morning)",
    );
  }

  if (raw.whyNow) {
    return `WHY NOW: ${raw.whyNow}`;
  }

  return undefined;
}

function formatBrief(
  angles: string[] | undefined,
  examples: string[] | undefined,
  sources: string[] | undefined,
  whyNow: string | null | undefined,
  header: string,
): string {
  const parts: string[] = [`Source: ${header}`];
  if (whyNow) parts.push(`Why this matters now: ${whyNow}`);
  if (angles && angles.length) parts.push(`Angles to cover:\n${angles.map((a) => `  - ${a}`).join("\n")}`);
  if (examples && examples.length) parts.push(`Concrete examples to weave in:\n${examples.map((e) => `  - ${e}`).join("\n")}`);
  if (sources && sources.length) parts.push(`Reference URLs (optional citations):\n${sources.map((s) => `  - ${s}`).join("\n")}`);
  return parts.join("\n\n");
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

  // 2026 SEO metadata spec — same one-shot retry treatment as structural counts.
  if (o.slug) {
    const slugWordCount = o.slug.split("-").filter(Boolean).length;
    if (slugWordCount < 3 || slugWordCount > 5) {
      issues.push(`slug must be 3-5 hyphen-separated words, got ${slugWordCount} ("${o.slug}")`);
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(o.slug)) {
      issues.push(`slug must be lowercase ASCII with hyphens only, got "${o.slug}"`);
    }
  } else {
    issues.push(`slug required`);
  }
  if (o.metaTitle) {
    const len = o.metaTitle.length;
    if (len < 50 || len > 60) issues.push(`metaTitle must be 50-60 chars, got ${len}`);
  } else {
    issues.push(`metaTitle required`);
  }
  if (o.metaDescription) {
    const len = o.metaDescription.length;
    if (len < 120 || len > 160) issues.push(`metaDescription must be 120-160 chars, got ${len}`);
  } else {
    issues.push(`metaDescription required`);
  }
  if (!o.focusKeyword || o.focusKeyword.trim().split(/\s+/).length > 5) {
    issues.push(`focusKeyword must be a 2-5 word noun phrase`);
  }
  const kwCount = o.keywords?.length ?? 0;
  if (kwCount < 3 || kwCount > 10) {
    issues.push(`keywords must be 3-10 semantic variants, got ${kwCount}`);
  }

  // Cover headline: 4-7 words, anything longer gets cropped on the live page.
  const coverWordCount = (o.coverHeadline ?? "").trim().split(/\s+/).filter(Boolean).length;
  if (coverWordCount < 3 || coverWordCount > 8) {
    issues.push(`coverHeadline must be 4-7 words (a punchy question/hook), got ${coverWordCount} ("${o.coverHeadline ?? ""}")`);
  }

  // Cover scene: 6-15 words. Drives the per-cover variety (background + props).
  const sceneWordCount = (o.coverScene ?? "").trim().split(/\s+/).filter(Boolean).length;
  if (sceneWordCount < 5 || sceneWordCount > 20) {
    issues.push(`coverScene must be 6-15 words (background + props for the cover), got ${sceneWordCount}`);
  }

  // Article archetype must be one of the supported types.
  const VALID_TYPES = [
    "problem_solving","tutorial","industry_analysis","comparison",
    "mistake_driven","behind_the_scenes","trend_analysis","guide",
  ];
  if (!o.articleType || !VALID_TYPES.includes(o.articleType)) {
    issues.push(`articleType must be one of: ${VALID_TYPES.join(", ")} (got "${o.articleType ?? "missing"}")`);
  }

  // Diagram body images must supply explicit labels — gpt-image-1 garbles
  // any free-form "label your shapes" instruction. 2-5 labels per diagram.
  for (const [i, ip] of (o.imagePrompts ?? []).entries()) {
    if (i === 0) continue; // hero never has labels
    if (ip?.style === "diagram") {
      const labels = (ip.labels ?? []).filter((l) => typeof l === "string" && l.trim().length > 0);
      if (labels.length < 2 || labels.length > 5) {
        issues.push(`imagePrompts[${i}] is style=diagram and needs 2-5 explicit labels, got ${labels.length}`);
      }
      for (const lab of labels) {
        const wordCount = lab.trim().split(/\s+/).length;
        if (wordCount > 3) {
          issues.push(`imagePrompts[${i}].labels: each label must be 1-3 words, got "${lab}" (${wordCount} words)`);
        }
      }
    }
  }

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

// AI-tell scrubber. The draft prompt bans these but Claude slips them in
// ~15-20% of the time, which sends the critic to "revise" and triggers a
// wasted re-draft. Catching them with regex is free and catches >80% of
// the problem before the critic ever sees the draft.
//
// Replacements aim for the most natural alternative; some phrases are
// simply dropped (kept as empty string) because there's no clean swap.
//   - "delve into <X>"          → "explore <X>"
//   - "leverage"                 → "use"
//   - "moreover" / "furthermore" → "Also" (sentence starts) or dropped
//   - "navigating the landscape" → "working through the field"
//   - "in today's fast-paced..." → ""  (just drop the throat-clear)
//   - "unlock the power of <X>"  → "get more from <X>"
//   - "elevate your <X>"         → "improve your <X>"
//   - "robust" / "seamless"      → "reliable" / "smooth"
//   - "synergy"                  → "fit"
//   - "game-changer"             → "real shift"
//   - "in conclusion"            → ""  (just delete + start a clean sentence)
type AiTellRule = { pattern: RegExp; replacement: string | ((match: string) => string) };
const AI_TELL_REPLACEMENTS: AiTellRule[] = [
  { pattern: /\bdelve\s+into\b/gi, replacement: "explore" },
  { pattern: /\bdelving\s+into\b/gi, replacement: "exploring" },
  { pattern: /\bleverag(e|es|ed|ing)\b/gi, replacement: (m: string) => m.charAt(0) === "L" ? "Use" : "use" },
  { pattern: /\b(moreover|furthermore)\b\s*,?\s*/gi, replacement: "" },
  { pattern: /navigating the (landscape|complexities|world) of\s+/gi, replacement: "working through " },
  { pattern: /in today'?s (rapidly evolving|fast-paced|ever-changing|dynamic)[^,.]*[,.]?\s*/gi, replacement: "" },
  { pattern: /\bunlock the power of\b/gi, replacement: "get more from" },
  { pattern: /\bunlock the potential of\b/gi, replacement: "get more from" },
  { pattern: /\belevat(e|es|ed|ing) your\b/gi, replacement: "improve your" },
  { pattern: /\brobust\b/gi, replacement: "reliable" },
  { pattern: /\bseamless(ly)?\b/gi, replacement: (m: string) => m === "seamlessly" ? "smoothly" : "smooth" },
  { pattern: /\bsynergy\b/gi, replacement: "fit" },
  { pattern: /\bsynergies\b/gi, replacement: "overlap" },
  { pattern: /\bgame-?changer\b/gi, replacement: "real shift" },
  { pattern: /\bcutting-?edge\b/gi, replacement: "new" },
  { pattern: /\bin conclusion\b\s*,?\s*/gi, replacement: "" },
  { pattern: /\bto sum up\b\s*,?\s*/gi, replacement: "" },
  { pattern: /\bat the end of the day\b\s*,?\s*/gi, replacement: "" },
  { pattern: /\bharness(es|ed|ing)? the power of\b/gi, replacement: "use" },
  { pattern: /\bunleash(es|ed|ing)?\b/gi, replacement: "free up" },
  { pattern: /\bparadigm shift\b/gi, replacement: "change" },
  { pattern: /\bventur(e|es|ed|ing) into\b/gi, replacement: "start" },
  { pattern: /\bembark(s|ed|ing)? on\b/gi, replacement: "start" },
  { pattern: /\bnotwithstanding\b/gi, replacement: "even so" },
  { pattern: /\bheretofore\b/gi, replacement: "until now" },
  { pattern: /\butilize(s|d|)?\b/gi, replacement: "use" },
  { pattern: /\butilizing\b/gi, replacement: "using" },
];

function scrubAiTells(text: string): string {
  let out = text;
  for (const rule of AI_TELL_REPLACEMENTS) {
    if (typeof rule.replacement === "string") {
      out = out.replace(rule.pattern, rule.replacement);
    } else {
      out = out.replace(rule.pattern, rule.replacement);
    }
  }
  // Cleanup: collapse 2+ spaces, fix space-before-punctuation introduced by drops.
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    // Lines that became just whitespace or punctuation after drops — kill them.
    .replace(/^\s*[,.;:!?]+\s*$/gm, "")
    // Collapse 3+ blank lines to 2.
    .replace(/\n{3,}/g, "\n\n");
  return out;
}

// Notify admin when image generation fails, but ONLY when the content
// plan is on AI-review mode (admin needs to act — fix OpenAI credits and
// click Retry). For human_review or auto mode, the human is already in
// the loop or has accepted unattended risk respectively. Detects
// insufficient_quota / billing_hard_limit errors specifically and calls
// them out in the subject line.
async function maybeNotifyAdminOfImageFailure(
  contentItemId: string,
  errors: Array<{ ord: number; prompt: string; message: string }>,
): Promise<void> {
  try {
    const item = await prisma.contentItem.findUnique({
      where: { id: contentItemId },
      include: { business: true },
    });
    if (!item) return;
    const plan = await prisma.contentPlan.findUnique({
      where: { businessId_contentType: { businessId: item.businessId, contentType: item.type } },
    });
    if (plan?.approvalMode !== "ai_review") {
      logger.info({ contentItemId, mode: plan?.approvalMode }, "blog.image_failure_email_skipped_not_ai_review");
      return;
    }
    const to = env().APPROVAL_DIGEST_TO;
    if (!to) {
      logger.warn({ contentItemId }, "blog.image_failure_email_skipped_no_recipient");
      return;
    }

    const creditExhausted = errors.some((e) => isCreditExhaustedError(e.message));
    const reason = creditExhausted ? "OpenAI credits exhausted" : "Image API failure";
    const subject = `[Automation] ${reason} — ${item.business.name} · ${item.title || "(untitled)"}`;
    const dashUrl = `${env().DASHBOARD_URL.replace(/\/$/, "")}/content/${contentItemId}`;

    const html = `
      <div style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 600px;">
        <h2 style="color: #b91c1c;">${reason}</h2>
        <p>${errors.length} image${errors.length === 1 ? "" : "s"} failed to generate for this article:</p>
        <ul>
          <li><b>Business:</b> ${escapeHtml(item.business.name)}</li>
          <li><b>Title:</b> ${escapeHtml(item.title || "(untitled)")}</li>
          <li><b>Type:</b> ${item.type}</li>
        </ul>
        ${creditExhausted
          ? `<p><b>Most likely cause:</b> your OpenAI account is out of credits or hit a billing limit. Top up the account, then click <b>Retry images only</b> on the content page — the existing article text and successful images will be kept.</p>`
          : `<p>See the errors below and check the OpenAI dashboard for status. After fixing, click <b>Retry images only</b> on the content page.</p>`}
        <h3>Errors</h3>
        <ul style="font-family: ui-monospace, monospace; font-size: 12px;">
          ${errors.map((e) => `<li><b>image #${e.ord}:</b> ${escapeHtml(e.message)}</li>`).join("")}
        </ul>
        <p><a href="${dashUrl}" style="display: inline-block; background: #6D28D9; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px;">Open in dashboard</a></p>
      </div>`;

    await sendEmail({
      to,
      subject,
      html,
      text: `${reason}\n\n${errors.length} image(s) failed for ${item.title || "(untitled)"}.\nOpen: ${dashUrl}\n\nErrors:\n${errors.map((e) => `- image #${e.ord}: ${e.message}`).join("\n")}`,
    });
    logger.info({ contentItemId, recipients: to, creditExhausted }, "blog.image_failure_email_sent");
  } catch (err) {
    logger.warn({ err, contentItemId }, "blog.image_failure_email_failed");
  }
}

// Detects the common "out of credits / billing limit" error shapes from
// OpenAI so the admin email can be more specific than just "API failure".
function isCreditExhaustedError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("insufficient_quota") ||
    m.includes("insufficient credit") ||
    m.includes("billing_hard_limit") ||
    m.includes("billing hard limit") ||
    m.includes("exceeded your current quota") ||
    m.includes("you exceeded your") ||
    m.includes("rate_limit_exceeded") && m.includes("quota")
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Re-export so the WebX site (in this monorepo) and other callers can use
// the catalog. brandSiteFor is also pulled in via @ca/shared.
export { brandSiteFor };
