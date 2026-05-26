// Scheduler: enqueues work into BullMQ on a cadence.
//
// Two responsibilities:
//   1. Per-minute tick  — looks at every business's ContentPlan, decides
//                          whether enough items have been queued for the
//                          current day/week/month, and enqueues `draft`
//                          jobs to fill the gap. Idempotent.
//                          Plans with timeSlots use slot-based scheduling
//                          (one item per slot, assigned scheduledAt at
//                          creation time). Plans without timeSlots use
//                          the legacy ASAP behavior.
//   2. Cron: research   — pulls trending topics into the candidate pool.
//   3. Cron: digest     — sends the pending-review email digest.

import { Cron } from "croner";
import { prisma, env, queue, QUEUES, logger, nextSlotsUtc } from "@ca/shared";

logger.info("scheduler.boot");

// ── Per-minute tick ──────────────────────────────────────────────────────
const TICK = env().SCHEDULER_TICK_SECONDS * 1000;
setInterval(() => { void tick().catch((err) => logger.error({ err }, "scheduler.tick_failed")); }, TICK);

async function tick(): Promise<void> {
  const businesses = await prisma.business.findMany({ where: { active: true } });
  for (const biz of businesses) {
    const plans = await prisma.contentPlan.findMany({ where: { businessId: biz.id, active: true } });
    for (const plan of plans) {
      const slots = readSlots(plan.timeSlots);
      if (slots.length > 0 && plan.period === "day") {
        await fillSlotBasedPlan(biz.id, plan, slots);
      } else {
        await fillLegacyPlan(biz.id, plan);
      }
    }
  }
}

// Legacy behavior: count items created this period; create more if under quota.
async function fillLegacyPlan(
  businessId: string,
  plan: { id: string; contentType: "blog" | "case_study" | "resource" | "social_post" | "landing_page" | "webinar"; perPeriod: number; period: "day" | "week" | "month" },
): Promise<void> {
  const since = startOfPeriod(plan.period);
  const existing = await prisma.contentItem.count({
    where: {
      businessId,
      type: plan.contentType,
      createdAt: { gte: since },
    },
  });
  const need = plan.perPeriod - existing;
  if (need <= 0) return;
  for (let i = 0; i < need; i++) {
    const item = await prisma.contentItem.create({
      data: { businessId, type: plan.contentType, status: "queued" },
    });
    await queue(QUEUES.draft).add(`${plan.contentType}:${item.id}`, { contentItemId: item.id, type: plan.contentType });
    logger.info({ businessId, type: plan.contentType, itemId: item.id }, "scheduler.enqueued");
  }
}

// Slot-based scheduling: for each configured slot, ensure exactly one
// ContentItem exists targeting that slot's next occurrence. Past-slot rule
// is handled inside nextSlotsUtc: slots already past today roll to
// tomorrow.
async function fillSlotBasedPlan(
  businessId: string,
  plan: { id: string; contentType: "blog" | "case_study" | "resource" | "social_post" | "landing_page" | "webinar" },
  slots: string[],
): Promise<void> {
  const tz = await timezoneFor(plan.id);
  const targetSlotsUtc = nextSlotsUtc(slots, tz);
  if (targetSlotsUtc.length === 0) return;

  // Pull every not-yet-published item for this plan with a scheduledAt in
  // the future. These are the "slots already filled" set. We match by
  // exact scheduledAt timestamp; the scheduler is the only writer of that
  // field for items it creates, so equality is safe.
  const upcoming = await prisma.contentItem.findMany({
    where: {
      businessId,
      type: plan.contentType,
      status: { notIn: ["published", "failed", "cancelled", "rejected"] },
      scheduledAt: { gte: new Date() },
    },
    select: { id: true, scheduledAt: true },
  });
  const filled = new Set(upcoming.map((i) => i.scheduledAt?.getTime()).filter((t): t is number => !!t));

  for (const slotUtc of targetSlotsUtc) {
    if (filled.has(slotUtc.getTime())) continue;
    const item = await prisma.contentItem.create({
      data: {
        businessId,
        type: plan.contentType,
        status: "queued",
        scheduledAt: slotUtc,
      },
    });
    await queue(QUEUES.draft).add(`${plan.contentType}:${item.id}`, { contentItemId: item.id, type: plan.contentType });
    logger.info(
      { businessId, type: plan.contentType, itemId: item.id, slot: slotUtc.toISOString() },
      "scheduler.enqueued_for_slot",
    );
  }
}

async function timezoneFor(planId: string): Promise<string> {
  const p = await prisma.contentPlan.findUnique({ where: { id: planId }, select: { timezone: true } });
  return p?.timezone || "America/New_York";
}

function readSlots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function startOfPeriod(p: "day" | "week" | "month"): Date {
  const d = new Date();
  if (p === "day") { d.setUTCHours(0,0,0,0); return d; }
  if (p === "week") {
    const day = d.getUTCDay() || 7; // Mon=1..Sun=7
    d.setUTCDate(d.getUTCDate() - (day - 1));
    d.setUTCHours(0,0,0,0);
    return d;
  }
  d.setUTCDate(1); d.setUTCHours(0,0,0,0); return d;
}

// ── Cron: research ───────────────────────────────────────────────────────
new Cron(env().RESEARCH_CRON, { timezone: "UTC" }, async () => {
  const businesses = await prisma.business.findMany({ where: { active: true } });
  for (const b of businesses) {
    await queue(QUEUES.research).add("research", { businessId: b.id });
  }
  logger.info({ count: businesses.length }, "scheduler.research_enqueued");
});

// ── Cron: digest emails ──────────────────────────────────────────────────
new Cron(env().DIGEST_CRON, { timezone: "UTC" }, async () => {
  await queue(QUEUES.digest).add("digest", {});
  logger.info("scheduler.digest_enqueued");
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT",  () => process.exit(0));
