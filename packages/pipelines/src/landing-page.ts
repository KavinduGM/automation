import { prisma, Prompts, type Prisma } from "@ca/shared";
import { claude, generateImage } from "@ca/providers";
import { bumpCost, loadBrandContext, makeSlug, setStatus } from "./util.js";
import { routeApproval } from "./route.js";

interface LpJson {
  title: string;
  slug: string;
  metaTitle: string;
  metaDescription: string;
  focusKeyword: string;
  keywords: string[];
  ogImageAlt: string;
  sections: Array<{ kind: string; props: Record<string, unknown> }>;
}

export async function runLandingPagePipeline(contentItemId: string): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  const { business, brandBlock } = await loadBrandContext(item.businessId);

  const meta = (item.meta ?? {}) as { brief?: string };
  const brief = meta.brief ?? item.title ?? "general high-intent landing page";

  await setStatus(contentItemId, "drafting");
  const res = await claude<LpJson>({
    model: "writing",
    json: true,
    maxTokens: 4096,
    system: Prompts.LANDING_PAGE_SYSTEM,
    user: Prompts.landingPageUser(brandBlock, brief),
  });
  if (!res.json) throw new Error("lp: missing JSON");
  await bumpCost(contentItemId, res.costUsd);

  const slug = makeSlug(res.json.slug || res.json.title);
  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: {
      title: res.json.title,
      slug,
      bodyMd: "", // LPs are JSON-driven
      meta: {
        ...meta,
        sections: res.json.sections as unknown as Prisma.InputJsonValue,
        seo: {
          metaTitle: res.json.metaTitle,
          metaDescription: res.json.metaDescription,
          focusKeyword: res.json.focusKeyword,
          keywords: res.json.keywords ?? [],
          ogImageAlt: res.json.ogImageAlt ?? null,
        } as unknown as Prisma.InputJsonValue,
      } as Prisma.InputJsonValue,
    },
  });

  // Hero image
  await setStatus(contentItemId, "generating_media");
  try {
    const hero = res.json.sections.find((s) => s.kind === "hero");
    const heroText = (hero?.props as { headline?: string })?.headline ?? res.json.title;
    const img = await generateImage({
      prompt: `Landing page hero image, modern B2B SaaS aesthetic. Concept: ${heroText}. Clean, brand-aligned, photographic style.`,
      quality: "high",
      businessSlug: business.slug,
      filenameHint: `lp-${slug}`,
    });
    await prisma.asset.create({
      data: {
        businessId: business.id,
        contentItemId,
        kind: "image",
        path: img.relPath,
        provider: "openai_image",
        prompt: "lp hero",
        altText: res.json.ogImageAlt ?? heroText,
        ord: 0,
        costUsd: img.costUsd,
      },
    });
    await bumpCost(contentItemId, img.costUsd);
  } catch { /* non-fatal */ }

  await setStatus(contentItemId, "self_critique");
  await routeApproval(contentItemId);
}
