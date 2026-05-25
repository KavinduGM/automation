// Scheduler: enqueues work into BullMQ on a cadence.
//
// Two responsibilities:
//   1. Per-minute tick  — looks at every business's ContentPlan, decides
//                          whether enough items have been queued for the
//                          current day/week/month, and enqueues `draft`
//                          jobs to fill the gap. Idempotent.
//   2. Cron: research   — pulls trending topics into the candidate pool.
//   3. Cron: digest     — sends the pending-review email digest.

import { Cron } from "croner";
import { prisma, env, queue, QUEUES, logger } from "@ca/shared";

logger.info("scheduler.boot");

// ── Per-minute tick ──────────────────────────────────────────────────────
const TICK = env().SCHEDULER_TICK_SECONDS * 1000;
setInterval(() => { void tick().catch((err) => logger.error({ err }, "scheduler.tick_failed")); }, TICK);

async function tick(): Promise<void> {
  const businesses = await prisma.business.findMany({ where: { active: true } });
  for (const biz of businesses) {
    const plans = await prisma.contentPlan.findMany({ where: { businessId: biz.id, active: true } });
    for (const plan of plans) {
      const since = startOfPeriod(plan.period);
      const existing = await prisma.contentItem.count({
        where: {
          businessId: biz.id,
          type: plan.contentType,
          createdAt: { gte: since },
        },
      });
      const target = plan.perPeriod;
      if (existing >= target) continue;

      const need = target - existing;
      for (let i = 0; i < need; i++) {
        const item = await prisma.contentItem.create({
          data: {
            businessId: biz.id,
            type: plan.contentType,
            status: "queued",
          },
        });
        const jobName = `${plan.contentType}:${item.id}`;
        await queue(QUEUES.draft).add(jobName, { contentItemId: item.id, type: plan.contentType });
        logger.info({ businessId: biz.id, type: plan.contentType, itemId: item.id }, "scheduler.enqueued");
      }
    }
  }
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
