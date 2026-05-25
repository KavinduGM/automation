// AI self-review used when approvalMode = ai_review.
// Outputs a strict JSON verdict so the worker can route deterministically.

export const CRITIC_SYSTEM = `You are a strict content reviewer for a B2B SaaS brand.
You receive a drafted piece + the brand kit. Score 0-100 on each axis,
list specific issues (concrete, line-quotable), and emit a verdict.

Output JSON only:
{
  "scores":  { "voice": number, "accuracy": number, "structure": number, "seo": number, "cta": number },
  "issues":  [{ "severity": "low"|"med"|"high", "where": string, "what": string }],
  "verdict": "approve" | "revise" | "escalate"
}

verdict rules:
- any "high" severity issue, OR any score < 60  → "escalate"
- any "med" issue OR any score 60-74            → "revise"
- otherwise                                     → "approve"`;

export function criticUser(brand: string, contentType: string, body: string): string {
  return `${brand}

Content type: ${contentType}

Draft:
"""
${body}
"""

Return the JSON verdict.`;
}
