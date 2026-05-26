import { env, logger } from "@ca/shared";

// xAI Grok API — OpenAI-compatible chat completions endpoint.
// We use it once/day per business to pull current X/Twitter trend signal
// without paying for the X API directly.

const BASE = "https://api.x.ai/v1/chat/completions";

export interface GrokTrendInput {
  query: string;       // e.g. "top trending B2B SaaS topics on X in the last 24h about marketing automation"
  model?: string;      // default "grok-2-latest"
}

export interface GrokTrendItem {
  topic: string;
  url?: string;
  why?: string;
}

export interface GrokTrendResult {
  items: GrokTrendItem[];
  rawText: string;
}

export async function grokTrends(input: GrokTrendInput): Promise<GrokTrendResult> {
  const key = env().GROK_API_KEY;
  if (!key) throw new Error("GROK_API_KEY not set");

  const res = await fetch(BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: input.model ?? "grok-2-latest",
      messages: [
        {
          role: "system",
          content:
            "You list current trending X/Twitter conversations relevant to the user query. " +
            "Return JSON only, no prose, schema: { items: [{ topic: string, url?: string, why?: string }] }. " +
            "10 items, deduped.",
        },
        { role: "user", content: input.query },
      ],
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`grok ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content ?? "";
  let items: GrokTrendItem[] = [];
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const j = JSON.parse(fenced?.[1] ?? text) as { items?: GrokTrendItem[] };
    items = j.items ?? [];
  } catch (err) {
    logger.warn({ err, sample: text.slice(0, 200) }, "grok.parse_failed");
  }
  return { items, rawText: text };
}

// Batched topic enrichment — used by the daily_brief chain. Takes N
// candidate topics (already proposed by Claude with brand context) and
// asks Grok for the live X angle on each, all in one call. This keeps
// Grok usage at exactly 1 call per business per day regardless of how
// many articles the daily plan calls for.

export interface GrokBriefInput {
  topics: string[];                // titles from Claude's proposal
  industry?: string;               // optional vertical context
  audience?: string;               // optional persona context
  model?: string;
}

export interface GrokTopicBrief {
  topic: string;                   // echo of the input title (for matching)
  angles: string[];                // 2-4 current angles/hooks worth covering
  examples: string[];              // 1-3 specific recent examples
  sources?: string[];              // URLs Grok cited, if any
}

export interface GrokBriefResult {
  briefs: GrokTopicBrief[];
  rawText: string;
}

export async function grokBatchedBriefs(input: GrokBriefInput): Promise<GrokBriefResult> {
  const key = env().GROK_API_KEY;
  if (!key) throw new Error("GROK_API_KEY not set");
  if (input.topics.length === 0) return { briefs: [], rawText: "" };

  const userPrompt = `Industry context: ${input.industry ?? "general B2B"}
Audience: ${input.audience ?? "professional readers"}

For EACH topic below, return what's currently being discussed on X (last 24-48h):
- 2-4 specific angles or hooks worth covering in a blog
- 1-3 concrete examples (companies, threads, events, names) from the last week
- 1-2 URLs if you can cite them

Topics:
${input.topics.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Return JSON only, no prose:
{ "briefs": [{ "topic": string, "angles": string[], "examples": string[], "sources"?: string[] }] }
The "topic" field MUST echo the input title verbatim so each brief can be matched.`;

  const res = await fetch(BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: input.model ?? "grok-2-latest",
      messages: [
        {
          role: "system",
          content:
            "You are a research assistant that surfaces the current X/Twitter conversation around given topics. " +
            "Be specific (names, events, threads — not vague trends). Return JSON only.",
        },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`grok ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content ?? "";
  let briefs: GrokTopicBrief[] = [];
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const j = JSON.parse(fenced?.[1] ?? text) as { briefs?: GrokTopicBrief[] };
    briefs = j.briefs ?? [];
  } catch (err) {
    logger.warn({ err, sample: text.slice(0, 200) }, "grok.briefs_parse_failed");
  }
  return { briefs, rawText: text };
}
