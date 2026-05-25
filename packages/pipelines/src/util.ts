import slugify from "slugify";
import { createHash } from "node:crypto";
import { prisma, Prompts, type Business, type BrandKit, type ContentItem, type Prisma } from "@ca/shared";

export function makeSlug(s: string): string {
  return slugify(s, { lower: true, strict: true, trim: true }).slice(0, 60);
}

export function dedupeHash(title: string): string {
  return createHash("sha256")
    .update(title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())
    .digest("hex");
}

export async function loadBrandContext(businessId: string): Promise<{
  business: Business;
  brandKit: BrandKit | null;
  brandBlock: string;
}> {
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  const brandKit = await prisma.brandKit.findUnique({ where: { businessId } });
  return { business, brandKit, brandBlock: Prompts.brandContextBlock(brandKit) };
}

export async function bumpCost(contentItemId: string, deltaUsd: number) {
  if (!deltaUsd) return;
  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: { costUsd: { increment: deltaUsd } },
  });
}

export async function setStatus(contentItemId: string, status: ContentItem["status"], extra: Prisma.ContentItemUpdateInput = {}) {
  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: { status, ...extra },
  });
}

export async function unusedTopicFor(businessId: string) {
  return prisma.topicCandidate.findFirst({
    where: { businessId, usedAt: null },
    orderBy: { score: "desc" },
  });
}

export async function markTopicUsed(id: string) {
  await prisma.topicCandidate.update({ where: { id }, data: { usedAt: new Date() } });
}
