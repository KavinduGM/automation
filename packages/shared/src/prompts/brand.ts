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
  if (kit.bannedWords?.length) {
    lines.push(
      `Banned words (when describing the brand): ${kit.bannedWords.join(", ")}`,
    );
    lines.push(
      "These words must NEVER appear in any sentence that uses 'we', 'our', 'us', or the brand name. " +
      "They MAY appear when describing competitors, alternatives we don't recommend, or in literal/contrastive context " +
      "(e.g. \"Some agencies offer cheap web development, but those projects fail at scale\"). " +
      "The rule: don't use these words to positively describe what the brand offers.",
    );
  }
  if (kit.styleGuideMd) lines.push("Style guide:\n" + kit.styleGuideMd);
  lines.push("</brand_kit>");
  return lines.join("\n");
}
