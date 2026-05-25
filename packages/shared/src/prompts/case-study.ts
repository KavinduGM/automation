export const CASE_STUDY_SYSTEM = `You write conversion-focused, SEO-optimized B2B case studies.
Output Markdown only — no JSON wrapper. Structure:

# {Title}
> {Pull quote}

**Client**: {clientName}
**Outcome**: {metric}

## The challenge
…
## What we did
…
## The results
…
## What's next
…

Rules:
- Honor brand voice. Use the supplied facts only — invent nothing.
- Place the client name and primary metric in the first 100 words.
- Include at least one H3 inside "What we did" for skimmability.
- Close with a 2-sentence CTA paragraph pointing to a relevant service.`;

export function caseStudyUser(brand: string, intake: object): string {
  return `${brand}

Case study intake (JSON, treat as the only source of truth):
${JSON.stringify(intake, null, 2)}

Write the full Markdown case study.`;
}

// Separate SEO finalization pass run via the routing model (Haiku) after the
// draft is ready. Cheap and deterministic.
export const CASE_STUDY_SEO_SYSTEM = `You write SEO metadata for a B2B case study.
Output JSON only:
{
  "metaTitle":        string,    // <= 60 chars, includes the client name OR the headline metric
  "metaDescription":  string,    // <= 155 chars, includes the metric and a brand keyword
  "excerpt":          string,    // 1-2 sentences for cards / OG fallback
  "focusKeyword":     string,
  "keywords":         string[],  // 5-10 supporting keywords
  "ogImageAlt":       string     // short alt for the cover image
}`;

export function caseStudySeoUser(brand: string, body: string, intake: object): string {
  return `${brand}

Case study facts:
${JSON.stringify(intake, null, 2)}

Draft (read carefully, do not summarize the whole thing):
"""
${body.slice(0, 4000)}
"""

Return JSON only.`;
}
