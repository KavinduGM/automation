import { prisma, logger } from "@ca/shared";
import { topPosts, grokTrends, claude } from "@ca/providers";
import { dedupeHash } from "./util.js";

// Pulls topic candidates from configured sources for one business and writes
// them to topic_candidates. Idempotent thanks to dedupeHash.

export async function runResearchForBusiness(businessId: string): Promise<{ inserted: number }> {
  const sources = await prisma.topicSource.findMany({ where: { businessId, active: true } });
  if (sources.length === 0) {
    logger.warn({ businessId }, "research.no_sources");
    return { inserted: 0 };
  }

  let inserted = 0;

  for (const src of sources) {
    try {
      if (src.kind === "reddit") {
        const subs = ((src.config as { subreddits?: string[] }).subreddits) ?? [];
        const time = ((src.config as { time?: "day" | "week" }).time) ?? "day";
        const posts = await topPosts(subs, { time, limit: 25 });
        for (const p of posts) {
          const hash = dedupeHash(p.title);
          const r = await prisma.topicCandidate.upsert({
            where: { businessId_dedupeHash: { businessId, dedupeHash: hash } },
            create: {
              businessId, source: "reddit", title: p.title, url: p.permalink,
              raw: p as unknown as object, score: Math.log1p(p.score) * 10, dedupeHash: hash,
            },
            update: {},
          });
          if (r.createdAt.getTime() > Date.now() - 60_000) inserted++;
        }
      } else if (src.kind === "grok_x") {
        const query = ((src.config as { query?: string }).query) ?? "trending B2B SaaS topics in the last 24h";
        const { items } = await grokTrends({ query });
        for (const it of items) {
          const hash = dedupeHash(it.topic);
          await prisma.topicCandidate.upsert({
            where: { businessId_dedupeHash: { businessId, dedupeHash: hash } },
            create: {
              businessId, source: "grok_x", title: it.topic, url: it.url,
              raw: it as unknown as object, score: 50, dedupeHash: hash,
            },
            update: {},
          });
          inserted++;
        }
      } else if (src.kind === "claude_seed") {
        const brief = ((src.config as { brief?: string }).brief) ?? "evergreen topics this brand should cover";
        const res = await claude<{ topics: string[] }>({
          model: "routing",
          json: true,
          maxTokens: 1024,
          system:
            "Propose evergreen B2B content topics. Output JSON only: { topics: string[] } with 10 distinct topics.",
          user: brief,
        });
        for (const t of res.json?.topics ?? []) {
          const hash = dedupeHash(t);
          await prisma.topicCandidate.upsert({
            where: { businessId_dedupeHash: { businessId, dedupeHash: hash } },
            create: {
              businessId, source: "claude_seed", title: t,
              raw: {} as object, score: 30, dedupeHash: hash,
            },
            update: {},
          });
          inserted++;
        }
      }
      await prisma.topicSource.update({ where: { id: src.id }, data: { lastRunAt: new Date() } });
    } catch (err) {
      logger.error({ err, sourceId: src.id, kind: src.kind }, "research.source_failed");
    }
  }

  // Score topics with Haiku — boost ones aligned to the brand kit.
  await scoreNewCandidates(businessId);

  logger.info({ businessId, inserted }, "research.done");
  return { inserted };
}

async function scoreNewCandidates(businessId: string) {
  const recents = await prisma.topicCandidate.findMany({
    where: { businessId, usedAt: null },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  if (recents.length === 0) return;
  const kit = await prisma.brandKit.findUnique({ where: { businessId } });
  if (!kit) return;

  try {
    const res = await claude<{ scores: Array<{ id: string; score: number }> }>({
      model: "routing",
      json: true,
      maxTokens: 1024,
      system:
        "Given a brand kit and a list of candidate topics, score each 0-100 on relevance to the brand. " +
        "Return JSON only: { scores: [{ id, score }] }",
      user: JSON.stringify({
        brand: { icp: kit.icp, usps: kit.usps, voice: kit.voice },
        candidates: recents.map((r) => ({ id: r.id, title: r.title })),
      }),
    });
    for (const s of res.json?.scores ?? []) {
      await prisma.topicCandidate.update({ where: { id: s.id }, data: { score: s.score } }).catch(() => {});
    }
  } catch (err) {
    logger.warn({ err, businessId }, "research.scoring_skipped");
  }
}
