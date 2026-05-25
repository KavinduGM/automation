import type { BrandKit } from "@prisma/client";

// Renders the brand kit as a compact context block injected into every
// generation prompt. Keep it short — token budget matters across many calls.

export function brandContextBlock(kit: BrandKit | null): string {
  if (!kit) return "";
  const voice = (kit.voice ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  lines.push("<brand_kit>");
  if (voice.tone) lines.push(`Tone: ${voice.tone}`);
  if (voice.audience) lines.push(`Audience: ${voice.audience}`);
  if (voice.persona) lines.push(`Brand persona: ${voice.persona}`);
  if (voice.readingLevel) lines.push(`Reading level: ${voice.readingLevel}`);
  if (voice.pointOfView) lines.push(`Point of view: ${voice.pointOfView}`);
  if (kit.icp) lines.push(`ICP: ${kit.icp}`);
  if (kit.usps?.length) lines.push(`USPs: ${kit.usps.join("; ")}`);
  if (kit.bannedWords?.length) lines.push(`Avoid these words: ${kit.bannedWords.join(", ")}`);
  if (kit.styleGuideMd) lines.push("Style guide:\n" + kit.styleGuideMd);
  lines.push("</brand_kit>");
  return lines.join("\n");
}
