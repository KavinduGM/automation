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
  // `system` accepts either a plain string OR an array of text blocks.
  // The array form lets callers mark stable prefixes (system prompt,
  // brand kit, services catalog) with `cache: true` so Anthropic
  // ephemeral cache_control kicks in: subsequent calls in the next ~5min
  // pay 1.25× on the first write, then 0.1× per cached read. Big win
  // when the scheduler drafts multiple articles in the same window.
  // Cache requires ≥1024 input tokens per block to activate.
  system: string | Array<{ text: string; cache?: boolean }>;
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
  const wantsJson = !!call.json;

  // For JSON requests, append a strong reminder to the user turn instead of
  // using an assistant-message prefill. Some Claude variants (notably the
  // newer extended-thinking models) reject prefill with:
  //   "This model does not support assistant message prefill. The
  //    conversation must end with a user message."
  // The reminder + the robust extractor below give us the same reliability
  // without the API restriction.
  const userContent = wantsJson
    ? call.user +
      "\n\nReturn ONLY the JSON object — no markdown fences, no preamble, no commentary. Start the response with `{` and end with `}`."
    : call.user;

  // Build system param. If the caller passed structured blocks with cache
  // hints, build the cache_control-decorated array form. Otherwise stay
  // string for maximum SDK compatibility.
  const systemParam: string | Anthropic.TextBlockParam[] = Array.isArray(call.system)
    ? call.system.map((b) => ({
        type: "text" as const,
        text: b.text,
        ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
      }))
    : call.system;

  const res = await client().messages.create({
    model,
    max_tokens: call.maxTokens ?? 4096,
    system: systemParam,
    messages: [{ role: "user", content: userContent }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const inTok = res.usage.input_tokens;
  const outTok = res.usage.output_tokens;
  // Cache reads are billed at 0.1× input; cache writes at 1.25×. The SDK
  // surfaces those buckets separately when they're present.
  const usage = res.usage as unknown as {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const costUsd = claudeCost(
    model as "claude-sonnet-4-6" | "claude-haiku-4-5",
    inTok,
    outTok,
    { cacheCreate, cacheRead },
  );

  let json: T | undefined;
  if (wantsJson) {
    json = tryParseJson<T>(text);
    if (json === undefined) {
      logger.warn(
        {
          model,
          outTokens: outTok,
          stopReason: res.stop_reason,
          sampleHead: text.slice(0, 200),
          sampleTail: text.slice(-200),
        },
        "claude.json_parse_failed",
      );
      const hint =
        res.stop_reason === "max_tokens"
          ? " (hit max_tokens — increase maxTokens or shorten the schema)"
          : "";
      throw new Error("Claude returned non-JSON when JSON was requested" + hint);
    }
  }

  logger.info(
    { model, inTok, outTok, cacheCreate, cacheRead, costUsd },
    "claude.call",
  );
  return { text, json, costUsd, inTokens: inTok, outTokens: outTok };
}

// Robust JSON extraction tried in order, easiest → most defensive:
//   1. Direct parse (succeeds when Claude follows the "JSON only" reminder)
//   2. Stripped ```json fences
//   3. First balanced `{...}` or `[...]` substring (escape-aware,
//      ignores braces inside string literals)
// Returns undefined if nothing parsable was found.
function tryParseJson<T>(text: string): T | undefined {
  const candidates = [
    text.trim(),
    stripFences(text),
    balancedExtract(text, "{", "}"),
    balancedExtract(text, "[", "]"),
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c) as T;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

function stripFences(text: string): string | null {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m && m[1] ? m[1].trim() : null;
}

// Walks the string from the first `open` char, tracking nested
// open/close balance and ignoring chars inside string literals (with
// escape-aware scanning). Returns the first complete balanced substring,
// or null if no balanced pair exists.
function balancedExtract(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
