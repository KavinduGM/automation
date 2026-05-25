import Anthropic from "@anthropic-ai/sdk";
import { env, claudeCost, logger } from "@ca/shared";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  const key = env().ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  _client = new Anthropic({ apiKey: key });
  return _client;
}

export interface ClaudeCall {
  system: string;
  user: string;
  model?: "writing" | "routing";   // 'writing' → Sonnet, 'routing' → Haiku
  maxTokens?: number;
  json?: boolean;                  // if true, response should be valid JSON
}

export interface ClaudeResult<T = string> {
  text: string;
  json?: T;
  costUsd: number;
  inTokens: number;
  outTokens: number;
}

function modelFor(kind: "writing" | "routing" | undefined): "claude-sonnet-4-6" | "claude-haiku-4-5" {
  if (kind === "routing") return env().ANTHROPIC_MODEL_ROUTING as "claude-haiku-4-5";
  return env().ANTHROPIC_MODEL_WRITING as "claude-sonnet-4-6";
}

export async function claude<T = string>(call: ClaudeCall): Promise<ClaudeResult<T>> {
  const model = modelFor(call.model);
  const res = await client().messages.create({
    model,
    max_tokens: call.maxTokens ?? 4096,
    system: call.system,
    messages: [{ role: "user", content: call.user }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const inTok = res.usage.input_tokens;
  const outTok = res.usage.output_tokens;
  const costUsd = claudeCost(model as "claude-sonnet-4-6" | "claude-haiku-4-5", inTok, outTok);

  let json: T | undefined;
  if (call.json) {
    try {
      json = JSON.parse(extractJson(text)) as T;
    } catch (err) {
      logger.warn({ err, model, sample: text.slice(0, 200) }, "claude.json_parse_failed");
      throw new Error("Claude returned non-JSON when JSON was requested");
    }
  }

  logger.info({ model, inTok, outTok, costUsd }, "claude.call");
  return { text, json, costUsd, inTokens: inTok, outTokens: outTok };
}

// Claude occasionally wraps JSON in ```json fences — strip them safely.
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  return text.trim();
}
