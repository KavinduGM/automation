import { prisma, Prompts, brandSiteFor, logger, type Prisma } from "@ca/shared";
import { claude, generateImage } from "@ca/providers";
import { bumpCost, loadBrandContext, logStep, makeSlug, setStatus } from "./util.js";
import { routeApproval } from "./route.js";
import type { SeoBundle } from "./seo.js";

// Case study expects a CaseStudyIntake row already linked to the ContentItem
// AND any project images already uploaded as Assets with role="cover", "pillar_1_X",
// etc. (The dashboard form / API stores both together.)
//
// Flow (NO inline image generation — admin uploads real project shots):
//   1. Load intake + brand + uploaded image roster
//   2. Claude (Sonnet, cached system) expands minimal intake into the rich
//      structured shape mirroring /lib/caseStudies.js
//   3. Validator catches off-spec counts; one-shot retry
//   4. Claude Haiku generates SEO metadata from the expansion
//   5. Generate ONE brand-templated cover image (no body images)
//   6. Persist everything on the ContentItem; route through approval

export interface StructuredCaseStudy {
  title: string;
  subtitle: string;
  headline: string;
  shortDescription: string;
  category: string;
  tags: string[];
  metrics: Array<{ value: string; label: string }>;
  problemIntro: string;
  problems: Array<{ title: string; text: string }>;
  problemCallout: string;
  solutionIntro: string;
  pillars: Array<{
    title: string;
    intro: string;
    featuresLabel: string;
    features: string[];
    imageRoles: string[];
  }>;
  results: Array<{ label: string; text: string }>;
  techDelivered: string[];
  closing: { lede: string; punchline: string; cta: string; callout: string };
  finalCta: { heading: string; intro: string; tiredOf: string[]; tiredOfOutro: string; finalLine: string };
  about: { intro: string; services: string[] };
}

export async function runCaseStudyPipeline(contentItemId: string): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  const intake = await prisma.caseStudyIntake.findUnique({ where: { contentItemId } });
  if (!intake) throw new Error("case_study: intake form missing — submit it in the dashboard first");
  const { business, brandBlock } = await loadBrandContext(item.businessId);

  // 1. Image roster — uploaded assets the admin attached BEFORE this pipeline ran.
  //    Each Asset has role="cover" | "pillar_dashboard" | ... set by the upload endpoint.
  const uploadedImages = await prisma.asset.findMany({
    where: { contentItemId, kind: "image", role: { not: null } },
  });
  const roster = uploadedImages.map((a) => ({
    role: a.role!,
    alt: a.altText ?? "",
    path: a.path,
  }));
  const nonCoverRoles = roster.filter((r) => r.role !== "cover");

  await logStep(contentItemId, "topic", "completed", {
    label: "Intake loaded",
    message: `${intake.clientName} · ${nonCoverRoles.length} project images uploaded`,
  });

  // 2. Expand intake → structured case study
  await setStatus(contentItemId, "drafting");
  await logStep(contentItemId, "expand", "started", { label: "AI expansion (Sonnet)" });
  const expandT0 = Date.now();
  const expansion = await claude<StructuredCaseStudy>({
    model: "writing",
    json: true,
    maxTokens: 8000,
    system: [{ text: Prompts.CASE_STUDY_EXPAND_SYSTEM, cache: true }],
    user: Prompts.caseStudyExpandUser(brandBlock, {
      clientName: intake.clientName,
      problem: intake.problem,
      solution: intake.solution,
      metric: intake.metric,
      industry: intake.industry,
      location: intake.location,
      projectType: intake.projectType,
      timeline: intake.timeline,
      category: intake.category,
      testimonial: intake.quote ? {
        quote: intake.quote,
        name: intake.quoteAuthor ?? null,
        role: intake.quoteRole ?? null,
        flag: intake.quoteFlag ?? null,
      } : null,
      imageRoster: nonCoverRoles.map((r) => ({ role: r.role, alt: r.alt })),
    }),
  });
  if (!expansion.json) throw new Error("case_study: expansion JSON missing");
  await bumpCost(contentItemId, expansion.costUsd);

  const structured = expansion.json;
  const issues = validateStructure(structured, nonCoverRoles.map((r) => r.role));
  if (issues.length > 0) {
    await logStep(contentItemId, "expand", "warning", {
      label: "Expansion off-spec",
      message: issues.slice(0, 3).join("; "),
    });
    logger.warn({ contentItemId, issues }, "case_study.expansion_off_spec");
    // Note: not retrying like blog does, because the schema is large and
    // off-spec items usually self-correct on the human review pass.
    // If this becomes a problem, swap to a one-shot retry like blog.
  }
  await logStep(contentItemId, "expand", "completed", {
    label: "AI expansion",
    durationMs: Date.now() - expandT0,
    metadata: { costUsd: expansion.costUsd, pillars: structured.pillars.length, problems: structured.problems.length },
  });

  // 3. Title + slug from expansion. Slug capped at 5 keyword-dense words.
  const slug = makeSlug(structured.title);

  // 4. Build pillars images by resolving role → asset path
  const rolesByName = new Map(roster.map((r) => [r.role, r]));
  const pillarsWithImages = structured.pillars.map((p) => ({
    ...p,
    images: (p.imageRoles ?? [])
      .map((role) => {
        const asset = rolesByName.get(role);
        if (!asset) return null;
        return { src: asset.path, alt: asset.alt, caption: asset.alt };
      })
      .filter((x): x is { src: string; alt: string; caption: string } => x !== null),
  }));

  // Persist the structured payload on item.meta so SEO + publish can read it.
  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: {
      title: structured.title,
      slug,
      bodyMd: buildFallbackMarkdown(structured), // for SEO snippet + fallback rendering
      meta: {
        ...(item.meta as object),
        structured: { ...structured, pillars: pillarsWithImages } as unknown as Prisma.InputJsonValue,
      } as Prisma.InputJsonValue,
    },
  });

  // 5. SEO finalization
  await logStep(contentItemId, "seo_metadata", "started", { label: "SEO metadata (Haiku)" });
  const seoT0 = Date.now();
  const seoRes = await claude<SeoBundle>({
    model: "routing",
    json: true,
    maxTokens: 1024,
    system: [{ text: Prompts.CASE_STUDY_SEO_SYSTEM, cache: true }],
    user: Prompts.caseStudySeoUser(brandBlock, structured, intake),
  });
  await bumpCost(contentItemId, seoRes.costUsd);
  const seo: SeoBundle = seoRes.json ?? {
    metaTitle: structured.title,
    metaDescription: structured.shortDescription,
    excerpt: structured.shortDescription,
    focusKeyword: intake.clientName,
    keywords: structured.tags ?? [],
    ogImageAlt: null,
  };
  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: {
      meta: {
        ...((await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } })).meta as object),
        seo: seo as unknown as Prisma.InputJsonValue,
        excerpt: seo.excerpt,
      } as Prisma.InputJsonValue,
    },
  });
  await logStep(contentItemId, "seo_metadata", "completed", {
    label: "SEO metadata",
    durationMs: Date.now() - seoT0,
    metadata: { costUsd: seoRes.costUsd },
  });

  // 6. Cover image — brand-templated, only if the admin didn't upload a cover.
  await setStatus(contentItemId, "generating_media");
  const adminCover = roster.find((r) => r.role === "cover");
  if (adminCover) {
    await logStep(contentItemId, "image_0", "skipped", {
      label: "Cover (admin upload)",
      message: "Admin uploaded cover — skipping AI generation",
    });
    // Make sure the uploaded cover has ord=0 so coverFor() in publish picks it up.
    await prisma.asset.updateMany({
      where: { contentItemId, kind: "image", role: "cover" },
      data: { ord: 0 },
    });
  } else {
    const brand = brandSiteFor(business.slug);
    const headline = (structured.title.length > 40 ? `${intake.clientName.toUpperCase()} CASE STUDY` : structured.title.toUpperCase());
    const coverSubject = structured.headline.split(".")[0] ?? structured.shortDescription;
    await logStep(contentItemId, "image_0", "started", { label: "Cover image (brand template)" });
    const coverT0 = Date.now();
    try {
      const coverPrompt = brand?.coverImageStyle
        ? buildCaseStudyCoverPrompt(brand.coverImageStyle, headline, coverSubject)
        : `Editorial cover image for a case study about ${intake.clientName} achieving ${intake.metric}. Modern, professional.`;
      const img = await generateImage({
        prompt: coverPrompt,
        quality: "medium",
        businessSlug: business.slug,
        filenameHint: `case-${slug || item.id}-cover`,
      });
      await prisma.asset.create({
        data: {
          businessId: business.id,
          contentItemId,
          kind: "image",
          path: img.relPath,
          provider: "openai_image",
          prompt: "case study cover",
          altText: seo.ogImageAlt ?? `${intake.clientName} case study cover`,
          ord: 0,
          role: "cover",
          costUsd: img.costUsd,
        },
      });
      await bumpCost(contentItemId, img.costUsd);
      await logStep(contentItemId, "image_0", "completed", {
        label: "Cover image",
        durationMs: Date.now() - coverT0,
        metadata: { costUsd: img.costUsd },
      });
    } catch (err) {
      logger.error({ err, contentItemId }, "case_study.cover_image_failed");
      await logStep(contentItemId, "image_0", "failed", {
        label: "Cover image",
        message: (err as Error).message ?? String(err),
        durationMs: Date.now() - coverT0,
      });
      // Non-fatal — the case study can publish without a cover.
    }
  }

  // 7. Route through approval (same auto/ai_review/human_review flow as blog).
  await setStatus(contentItemId, "self_critique");
  await logStep(contentItemId, "route_approval", "started", { label: "Approval routing" });
  await routeApproval(contentItemId);
  await logStep(contentItemId, "route_approval", "completed", { label: "Approval routing" });
}

// Validate the expansion against the locked counts. Off-spec items are
// logged as warnings; the human review pass catches anything genuinely
// wrong. We don't retry (Sonnet expansion is the biggest cost in this
// pipeline; eat the imperfect first try rather than double-pay).
function validateStructure(s: StructuredCaseStudy, expectedRoles: string[]): string[] {
  const issues: string[] = [];
  if ((s.metrics?.length ?? 0) !== 4) issues.push(`metrics must be 4 KPI tiles, got ${s.metrics?.length ?? 0}`);
  if ((s.problems?.length ?? 0) !== 6) issues.push(`problems must be 6 cards, got ${s.problems?.length ?? 0}`);
  const pillarCount = s.pillars?.length ?? 0;
  if (pillarCount < 3 || pillarCount > 5) issues.push(`pillars must be 3-5, got ${pillarCount}`);
  if ((s.results?.length ?? 0) < 10) issues.push(`results must be 10+, got ${s.results?.length ?? 0}`);
  if ((s.techDelivered?.length ?? 0) !== 15) issues.push(`techDelivered must be 15 items, got ${s.techDelivered?.length ?? 0}`);
  if ((s.tags?.length ?? 0) !== 5) issues.push(`tags must be 5, got ${s.tags?.length ?? 0}`);
  if ((s.finalCta?.tiredOf?.length ?? 0) !== 5) issues.push(`finalCta.tiredOf must be 5 items, got ${s.finalCta?.tiredOf?.length ?? 0}`);
  // Every non-cover uploaded image role should be slotted into some pillar.
  const placedRoles = new Set<string>();
  for (const p of s.pillars ?? []) {
    for (const r of p.imageRoles ?? []) placedRoles.add(r);
  }
  for (const role of expectedRoles) {
    if (!placedRoles.has(role)) {
      issues.push(`image role "${role}" was not placed in any pillar`);
    }
  }
  return issues;
}

// Fallback markdown — used for SEO snippets, dashboard preview, and the
// post-review checks that scan bodyMd. The /case-studies/[slug] route
// renders structured fields directly, not this.
function buildFallbackMarkdown(s: StructuredCaseStudy): string {
  const lines: string[] = [];
  lines.push(`# ${s.title}`, "", s.headline, "");
  lines.push("## The problem", "", s.problemIntro, "");
  for (const p of s.problems) lines.push(`### ${p.title}`, "", p.text, "");
  lines.push("## The solution", "", s.solutionIntro, "");
  for (const p of s.pillars) {
    lines.push(`### ${p.title}`, "", p.intro, "");
    for (const f of p.features) lines.push(`- ${f}`);
    lines.push("");
  }
  lines.push("## Results", "");
  for (const r of s.results) lines.push(`- **${r.label}** — ${r.text}`);
  lines.push("", "## What we shipped", "");
  for (const t of s.techDelivered) lines.push(`- ${t}`);
  lines.push("", s.closing.lede, "", `> ${s.closing.punchline}`, "", s.closing.cta);
  return lines.join("\n");
}

// Case-study covers reuse the blog brand-cover composition but with a
// different badge ("Case Study" instead of "Blog") and slightly different
// scene defaults. The composition stays inside the center 70% safe zone.
function buildCaseStudyCoverPrompt(
  style: NonNullable<ReturnType<typeof brandSiteFor>>["coverImageStyle"],
  headline: string,
  subject: string,
): string {
  if (!style) return `${subject}. ${headline}.`;
  return [
    `Create a 16:9 brand cover image — wide horizontal composition.`,
    `Background: ${style.backgroundColor} as the dominant base color.`,
    `Scene: clean studio surface with subtle props (mug, notebook) in soft focus, professional photography.`,
    `Accent color: ${style.themeColor} — used ONLY for the headline typography and the badge.`,
    `Safe zone: all text, device, and badge MUST stay within the CENTER 70% of the frame.`,
    `Right side of the frame (inside safe zone): ${style.deviceHint}, screen visible and in focus.`,
    `The device screen displays: ${subject}.`,
    `Left side of the frame (inside safe zone): vertical text block —`,
    `  Headline (large, bold, color ${style.themeColor}, fits on 2-3 lines): "${headline.toUpperCase()}"`,
    `  Below the headline, a small rounded pill badge — background ${style.themeColor}, text white — saying "Case Study".`,
    style.extraStyleHints ? `Photographic style: ${style.extraStyleHints}.` : "",
    `Rendering rules: headline text MUST render exactly as written and clearly legible. No watermarks, no extra background text, no garbled glyphs, no people in foreground.`,
  ].filter(Boolean).join("\n");
}
