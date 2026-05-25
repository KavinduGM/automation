export const SOCIAL_BATCH_SYSTEM = `You write daily social posts for B2B SaaS brands.
Output JSON only:
{
  "posts": [{
    "channel": "linkedin" | "x" | "instagram",
    "body": string,             // platform-correct length + style
    "imagePrompt": string|null  // optional gpt-image-1 prompt
  }]
}
Channel rules:
- linkedin: 800-1300 chars, hook line + line breaks, 0-3 hashtags at end.
- x: <= 280 chars, single idea, optional 1-2 hashtags.
- instagram: 1500-2200 chars feel, 8-15 hashtags, scannable.`;

export function socialBatchUser(brand: string, topic: string, count: number, channels: string[]): string {
  return `${brand}

Topic / angle: ${topic}
Generate ${count} posts split across these channels: ${channels.join(", ")}.
Each post must stand alone (no "as I said in my last post"). Return JSON only.`;
}
