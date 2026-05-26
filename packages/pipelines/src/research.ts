import { prisma, logger, type Prisma } from "@ca/shared";
import { topPosts, grokTrends, grokBatchedBriefs, claude } from "@ca/providers";
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
      } else if (src.kind === "daily_brief") {
        inserted += await runDailyBrief(businessId, src);
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

// daily_brief: Claude proposes N brand-aligned blog topics (N = today's
// blog quota from ContentPlan, capped 1..10). Each topic comes back tagged
// evergreen | time_sensitive | breaking. Then ONE batched Grok call enriches
// all N with current X angles + concrete examples. Saved as TopicCandidates
// with the Grok brief on raw.grokBrief so the blog outline step can use it.
//
// Config shape (optional fields):
//   { "industry": "B2B SaaS web dev", "audience": "tech founders",
//     "topicsPerDay": null, "extraGuidance": "avoid AI-hype topics" }
//
// Falls back gracefully: if Grok fails, topics are still saved without
// enrichment (Claude can still write a decent generic article).
async function runDailyBrief(
  businessId: string,
  src: { id: string; config: unknown },
): Promise<number> {
  const cfg = (src.config ?? {}) as {
    industry?: string;
    audience?: string;
    topicsPerDay?: number | null;
    extraGuidance?: string;
  };

  // Default N = today's blog quota; cap at 10 to keep Claude/Grok output sane.
  const blogPlan = await prisma.contentPlan.findUnique({
    where: { businessId_contentType: { businessId, contentType: "blog" } },
  });
  const planQuota = blogPlan?.active ? Math.max(1, blogPlan.perPeriod) : 3;
  const n = Math.min(10, Math.max(1, cfg.topicsPerDay ?? planQuota));

  const kit = await prisma.brandKit.findUnique({ where: { businessId } });

  // Step 1 — Claude proposes N brand-aligned topics, each tagged for sensitivity.
  const proposalSystem =
    `Propose ${n} distinct blog topics for the brand below. For each topic, tag its sensitivity:
- "evergreen" — content that stays relevant for months (best practices, how-tos, frameworks).
- "time_sensitive" — depends on recent context but won't expire same-day (industry shifts, quarterly trends).
- "breaking" — news-reactive; loses value within 48h (acquisitions, product launches, viral events).

Output JSON only: { topics: [{ title: string, sensitivity: "evergreen"|"time_sensitive"|"breaking", whyNow?: string }] }`;
  const proposalUser = JSON.stringify({
    industry: cfg.industry ?? "general B2B",
    audience: cfg.audience ?? "professional readers",
    brand: kit ? { icp: kit.icp, usps: kit.usps, voice: kit.voice } : null,
    extraGuidance: cfg.extraGuidance ?? null,
  });

  type Proposal = { topics: Array<{ title: string; sensitivity?: string; whyNow?: string }> };
  let proposal: Proposal["topics"] = [];
  try {
    const res = await claude<Proposal>({
      model: "routing",
      json: true,
      maxTokens: 2048,
      system: proposalSystem,
      user: proposalUser,
    });
    proposal = res.json?.topics ?? [];
  } catch (err) {
    logger.error({ err, businessId }, "daily_brief.claude_proposal_failed");
    return 0;
  }
  if (proposal.length === 0) {
    logger.warn({ businessId }, "daily_brief.no_topics_proposed");
    return 0;
  }

  // Step 2 — ONE batched Grok call to enrich all proposed topics.
  let briefsByTopic = new Map<string, { angles: string[]; examples: string[]; sources?: string[] }>();
  try {
    const { briefs } = await grokBatchedBriefs({
      topics: proposal.map((p) => p.title),
      industry: cfg.industry,
      audience: cfg.audience,
    });
    briefsByTopic = new Map(briefs.map((b) => [b.topic.trim().toLowerCase(), {
      angles: b.angles ?? [],
      examples: b.examples ?? [],
      sources: b.sources,
    }]));
  } catch (err) {
    logger.warn({ err, businessId }, "daily_brief.grok_enrichment_failed_proceeding_without");
  }

  // Step 3 — Save each as a TopicCandidate. High score (75) so the blog
  // pipeline picks these first over generic seed/reddit topics.
  let inserted = 0;
  for (const p of proposal) {
    const hash = dedupeHash(p.title);
    const brief = briefsByTopic.get(p.title.trim().toLowerCase());
    const sensitivity = (p.sensitivity === "evergreen" || p.sensitivity === "time_sensitive" || p.sensitivity === "breaking")
      ? p.sensitivity
      : "evergreen";
    const raw = {
      whyNow: p.whyNow ?? null,
      grokBrief: brief ?? null,
      enriched: !!brief,
    };
    const created = await prisma.topicCandidate.upsert({
      where: { businessId_dedupeHash: { businessId, dedupeHash: hash } },
      create: {
        businessId,
        source: "daily_brief",
        title: p.title,
        raw: raw as unknown as Prisma.InputJsonValue,
        score: brief ? 75 : 55, // enriched topics rank above non-enriched
        sensitivity,
        dedupeHash: hash,
      },
      update: {},
    });
    if (created.createdAt.getTime() > Date.now() - 60_000) inserted++;
  }

  logger.info(
    { businessId, proposed: proposal.length, enriched: briefsByTopic.size, inserted },
    "daily_brief.done",
  );
  return inserted;
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
