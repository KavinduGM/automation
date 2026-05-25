import { prisma, Prompts } from "@ca/shared";
import { claude, generateImage } from "@ca/providers";
import { bumpCost, loadBrandContext, makeSlug, setStatus } from "./util.js";
import { routeApproval } from "./route.js";

// Case study expects a CaseStudyIntake row already linked to the ContentItem.
// (The dashboard creates the item + intake together via the intake form.)

export async function runCaseStudyPipeline(contentItemId: string): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  const intake = await prisma.caseStudyIntake.findUnique({ where: { contentItemId } });
  if (!intake) throw new Error("case_study: intake form missing — submit it in the dashboard first");
  const { business, brandBlock } = await loadBrandContext(item.businessId);

  await setStatus(contentItemId, "drafting");
  const draft = await claude<string>({
    model: "writing",
    maxTokens: 5000,
    system: Prompts.CASE_STUDY_SYSTEM,
    user: Prompts.caseStudyUser(brandBlock, intake),
  });
  await bumpCost(contentItemId, draft.costUsd);

  const title = `${intake.clientName}: ${intake.metric}`;
  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: { title, slug: makeSlug(title), bodyMd: draft.text },
  });

  // Cover image
  await setStatus(contentItemId, "generating_media");
  try {
    const img = await generateImage({
      prompt: `Editorial cover image for a case study about ${intake.clientName} achieving ${intake.metric}. Modern, professional, brand-aligned.`,
      quality: "high",
      businessSlug: business.slug,
      filenameHint: `case-${item.id}`,
    });
    await prisma.asset.create({
      data: { businessId: business.id, contentItemId, kind: "image", path: img.relPath, provider: "openai_image", prompt: "case study cover", costUsd: img.costUsd },
    });
    await bumpCost(contentItemId, img.costUsd);
  } catch { /* non-fatal */ }

  await setStatus(contentItemId, "self_critique");
  await routeApproval(contentItemId);
}
