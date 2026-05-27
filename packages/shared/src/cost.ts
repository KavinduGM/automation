// Live API pricing table (USD). Easy to update as providers change rates.
// Used by providers to attribute per-call cost back to ContentItem.costUsd.

export const PRICING = {
  // Claude — per-million input/output token rates.
  // Conservative placeholders; tune from your account console.
  "claude-sonnet-4-6": { inUsdPer1M: 3.0, outUsdPer1M: 15.0 },
  "claude-haiku-4-5":  { inUsdPer1M: 0.8, outUsdPer1M: 4.0 },

  // OpenAI gpt-image-1 — per image by quality tier (approx).
  "gpt-image-1.low":    { perImageUsd: 0.02 },
  "gpt-image-1.medium": { perImageUsd: 0.07 },
  "gpt-image-1.high":   { perImageUsd: 0.19 },

  // ElevenLabs — per 1k characters (multilingual v2 ~ $0.30 / 1k chars).
  "elevenlabs": { per1kCharsUsd: 0.30 },

  // HeyGen — per minute of avatar video (rough average mid-tier).
  "heygen.minute": { perMinuteUsd: 1.5 },
} as const;

// Anthropic prompt-cache multipliers (vs base input price):
//   cache write = 1.25× input  (first time the block is sent)
//   cache read  = 0.10× input  (subsequent calls within ~5min TTL)
// inTok from the SDK EXCLUDES cacheCreate + cacheRead tokens, so they're
// billed as separate buckets here.
export function claudeCost(
  model: "claude-sonnet-4-6" | "claude-haiku-4-5",
  inTok: number,
  outTok: number,
  opts: { cacheCreate?: number; cacheRead?: number } = {},
) {
  const p = PRICING[model];
  const base = (inTok / 1_000_000) * p.inUsdPer1M + (outTok / 1_000_000) * p.outUsdPer1M;
  const cacheWrite = ((opts.cacheCreate ?? 0) / 1_000_000) * p.inUsdPer1M * 1.25;
  const cacheRead = ((opts.cacheRead ?? 0) / 1_000_000) * p.inUsdPer1M * 0.10;
  return base + cacheWrite + cacheRead;
}

export function imageCost(quality: "low" | "medium" | "high", n = 1): number {
  return PRICING[`gpt-image-1.${quality}` as const].perImageUsd * n;
}

export function voiceCost(chars: number): number {
  return (chars / 1000) * PRICING["elevenlabs"].per1kCharsUsd;
}

export function videoCost(seconds: number): number {
  return (seconds / 60) * PRICING["heygen.minute"].perMinuteUsd;
}
