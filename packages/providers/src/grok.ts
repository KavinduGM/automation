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
