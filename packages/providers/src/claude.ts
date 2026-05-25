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
  // For JSON calls, prepend an assistant turn opening with `{` — Anthropic's
  // documented technique to force the response to start with valid JSON and
  // avoid prose preambles.
  const wantsJson = !!call.json;
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: call.user },
  ];
  if (wantsJson) {
    messages.push({ role: "assistant", content: "{" });
  }

  const res = await client().messages.create({
    model,
    max_tokens: call.maxTokens ?? 4096,
    system: call.system,
    messages,
  });
  let text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // Anthropic does NOT echo the assistant prefill in the response, so we
  // re-add the leading `{` for JSON parsing.
  if (wantsJson) text = "{" + text;

  const inTok = res.usage.input_tokens;
  const outTok = res.usage.output_tokens;
  const costUsd = claudeCost(model as "claude-sonnet-4-6" | "claude-haiku-4-5", inTok, outTok);

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

  logger.info({ model, inTok, outTok, costUsd }, "claude.call");
  return { text, json, costUsd, inTokens: inTok, outTokens: outTok };
}

// Robust JSON extraction tried in order, easiest → most defensive:
//   1. Direct parse (assistant prefill of `{` usually makes this work)
//   2. Stripped ```json fences
//   3. First balanced `{...}` or `[...]` substring
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
