import slugify from "slugify";
import { createHash } from "node:crypto";
import { prisma, Prompts, queue, QUEUES, logger, type Business, type BrandKit, type ContentItem, type Prisma } from "@ca/shared";

// Defensive slug builder. Even when Claude returns a tighter slug, we
// normalize + strip filler words + cap at 5 hyphen-separated words per
// the 2026 SEO spec (3-5 words, keyword-dense, no fluff).
const SLUG_FILLER = new Set([
  "the","a","an","and","or","for","of","in","on","at","to","with","by","from",
  "is","are","be","this","that","these","those","your","our","you","we",
  "guide","tips","tricks","best","how","what","why","when","where",
]);

export function makeSlug(s: string): string {
  const base = slugify(s, { lower: true, strict: true, trim: true });
  const parts = base.split("-").filter(Boolean);
  // Strip filler words, but never empty out the slug — keep originals if filtering ate everything.
  const meaningful = parts.filter((p) => !SLUG_FILLER.has(p));
  const picked = (meaningful.length >= 2 ? meaningful : parts).slice(0, 5);
  return picked.join("-").slice(0, 60);
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

// ── Pipeline step event logging ──────────────────────────────────────
// Single write per call; powers the timeline view on the content detail
// page. Safe to call from anywhere in the pipeline — failures are logged
// but never thrown (instrumenting must not break the pipeline itself).

export type PipelineStepStatus = "started" | "completed" | "failed" | "skipped" | "warning";

export interface LogStepOpts {
  label?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  durationMs?: number;
}

export async function logStep(
  contentItemId: string,
  step: string,
  status: PipelineStepStatus,
  opts: LogStepOpts = {},
): Promise<void> {
  try {
    await prisma.pipelineEvent.create({
      data: {
        contentItemId,
        step,
        status,
        label: opts.label ?? null,
        message: opts.message ?? null,
        metadata: (opts.metadata ?? {}) as Prisma.InputJsonValue,
        durationMs: opts.durationMs ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err, contentItemId, step, status }, "logStep.failed");
  }
}

// Wrap an async step with automatic start/complete/failed event logging.
// On thrown error, logs failed (with error message) then re-throws.
export async function step<T>(
  contentItemId: string,
  name: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  await logStep(contentItemId, name, "started", { label });
  const t0 = Date.now();
  try {
    const result = await fn();
    await logStep(contentItemId, name, "completed", { label, durationMs: Date.now() - t0 });
    return result;
  } catch (err) {
    await logStep(contentItemId, name, "failed", {
      label,
      message: (err as Error).message ?? String(err),
      durationMs: Date.now() - t0,
    });
    throw err;
  }
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
