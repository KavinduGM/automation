import slugify from "slugify";
import { createHash } from "node:crypto";
import { prisma, Prompts, queue, QUEUES, logger, type Business, type BrandKit, type ContentItem, type Prisma } from "@ca/shared";

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

// Enqueue the publish job for an approved item, respecting any
// scheduledAt slot on the ContentItem. If scheduledAt is in the future,
// sets status="scheduled" and asks BullMQ to delay the job until that
// instant; otherwise sets status="approved" and runs now. This is the
// single chokepoint for all approval → publish transitions.
export async function enqueuePublish(contentItemId: string): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  const now = Date.now();
  const slotMs = item.scheduledAt?.getTime();
  // Auto-fix retries should publish ASAP — their original slot is in the
  // past by definition (the item was already published once). Treat any
  // past scheduledAt as "publish now".
  if (slotMs && slotMs > now) {
    const delay = slotMs - now;
    await setStatus(contentItemId, "scheduled");
    await queue(QUEUES.publish).add(
      "publish",
      { contentItemId },
      { delay, removeOnComplete: 500, removeOnFail: 100 },
    );
    logger.info(
      { contentItemId, scheduledAt: item.scheduledAt?.toISOString(), delaySeconds: Math.round(delay / 1000) },
      "enqueue_publish.deferred_to_slot",
    );
    return;
  }
  await setStatus(contentItemId, "approved");
  await queue(QUEUES.publish).add("publish", { contentItemId });
}
