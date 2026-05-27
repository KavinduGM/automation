import { prisma, brandSiteFor, logger, type Prisma } from "@ca/shared";
import { topPosts, grokTrends, grokBatchedBriefs, claude } from "@ca/providers";
import { dedupeHash } from "./util.js";

// Article archetypes — must match the BlogOutline.articleType enum.
// Pinned here so the daily_brief rotation logic can pass them through.
const ARTICLE_ARCHETYPES = [
  "problem_solving",
  "tutorial",
  "industry_analysis",
  "comparison",
  "mistake_driven",
  "behind_the_scenes",
  "trend_analysis",
  "guide",
] as const;

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
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  const brand = business ? brandSiteFor(business.slug) : null;

  // Rotation context — what's been over-covered lately so Claude can
  // spread proposals across less-touched services + article archetypes.
  // This is THE fix for the "all articles are about ML/AI integration"
  // problem: without it, Claude keeps proposing topics in the same
  // narrow groove because nothing tells it the catalog is wider.
  const rotation = await getRotationContext(businessId);
  const allServiceSlugs = brand?.services.map((s) => `${s.slug} (${s.title})`) ?? [];
  const underusedServices = (brand?.services ?? [])
    .filter((s) => (rotation.serviceCoverage.get(s.slug) ?? 0) < 2)
    .map((s) => `${s.slug} (${s.title}, category: ${s.category})`);
  const overusedServices = [...rotation.serviceCoverage.entries()]
    .filter(([, n]) => n >= 2)
    .sort(([, a], [, b]) => b - a)
    .map(([slug, n]) => `${slug} (${n}×)`);
  const underusedArchetypes = ARTICLE_ARCHETYPES.filter((a) => !rotation.recentArchetypes.includes(a));

  // Step 1 — Claude proposes N brand-aligned topics, each tagged for sensitivity.
  const proposalSystem =
    `Propose ${n} distinct blog topics for the brand below. Each topic must:
- Center on ONE service from the brand's catalog (provide the slug as serviceSlug).
- Use a specific article archetype (problem_solving | tutorial | industry_analysis | comparison | mistake_driven | behind_the_scenes | trend_analysis | guide).
- Tag sensitivity: "evergreen" | "time_sensitive" | "breaking".

ROTATION RULES (read carefully — these are the difference between a varied content calendar and a one-note blog):

1. SERVICES: Prefer UNDERUSED services from the rotation context. The brand has many services; don't just propose topics for the same 2-3 every cycle. Pull from the underusedServices list first. If you must repeat a service, it must be unique within THIS batch.

2. ARCHETYPES: Vary archetypes within the batch. Don't propose 3 tutorials in a row. Prefer archetypes from underusedArchetypes. Reasonable batch mix examples:
   - [problem_solving, tutorial, comparison]
   - [behind_the_scenes, mistake_driven, industry_analysis]
   - [guide, trend_analysis, problem_solving]

3. SENSITIVITY: Mix freely — at least one evergreen is preferred per batch.

4. ANGLES: Lean into PROBLEM-SOLVING and TUTORIAL content (those rank best in search). For service-focused articles, the angle should be the customer's PAIN, not the brand's offering. Bad: "Our AI Chatbot Service". Good: "Why your support team drowns in tier-1 tickets and how an AI tier-0 layer fixes it" → leads naturally to ai-chatbot service.

Output JSON only:
{
  "topics": [{
    "title": string,
    "serviceSlug": string,        // MUST be from the brand's services list
    "articleType": string,        // ONE of the 8 archetypes
    "sensitivity": "evergreen" | "time_sensitive" | "breaking",
    "whyNow"?: string             // 1 sentence on why this is interesting now
  }]
}`;
  const proposalUser = JSON.stringify({
    industry: cfg.industry ?? "general B2B",
    audience: cfg.audience ?? "professional readers",
    brand: kit ? { icp: kit.icp, usps: kit.usps, voice: kit.voice } : null,
    services: allServiceSlugs,
    rotationContext: {
      underusedServices,
      overusedServicesLast30Days: overusedServices,
      underusedArchetypes,
      recentArchetypes: rotation.recentArchetypes,
    },
    extraGuidance: cfg.extraGuidance ?? null,
  });

  type Proposal = {
    topics: Array<{
      title: string;
      sensitivity?: string;
      whyNow?: string;
      serviceSlug?: string;
      articleType?: string;
    }>;
  };
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
    // Validate articleType against the known set; default to problem_solving
    // (best-ranking archetype) if Claude omitted or invented one.
    const articleType = (ARTICLE_ARCHETYPES as readonly string[]).includes(p.articleType ?? "")
      ? p.articleType
      : "problem_solving";
    // Validate serviceSlug against the brand catalog; null if invalid.
    const serviceSlug = brand?.services.find((s) => s.slug === p.serviceSlug)?.slug ?? null;
    const raw = {
      whyNow: p.whyNow ?? null,
      grokBrief: brief ?? null,
      enriched: !!brief,
      articleType,
      serviceSlug,
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

// Build the rotation context used by daily_brief topic proposal.
//   - serviceCoverage:  map of primaryServiceSlug → count over last 30 days
//   - recentArchetypes: list of articleTypes used in the LAST 5 articles
//                      (so Claude knows which archetypes to lean away from)
//
// Without this, Claude keeps proposing topics in whatever narrow groove
// it landed in last time, and every article ends up about the same
// 2-3 services in the same archetype style.
async function getRotationContext(businessId: string): Promise<{
  serviceCoverage: Map<string, number>;
  recentArchetypes: string[];
}> {
  const SINCE_DAYS = 30;
  const since = new Date(Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000);
  const recent = await prisma.contentItem.findMany({
    where: { businessId, type: "blog", createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { meta: true },
  });
  const serviceCoverage = new Map<string, number>();
  const recentArchetypes: string[] = [];
  for (const [i, it] of recent.entries()) {
    const meta = (it.meta ?? {}) as {
      outline?: { primaryServiceSlug?: string; articleType?: string };
    };
    const slug = meta.outline?.primaryServiceSlug;
    if (slug) serviceCoverage.set(slug, (serviceCoverage.get(slug) ?? 0) + 1);
    if (i < 5) {
      const t = meta.outline?.articleType;
      if (t) recentArchetypes.push(t);
    }
  }
  return { serviceCoverage, recentArchetypes };
}
