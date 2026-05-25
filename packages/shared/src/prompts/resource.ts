export const RESOURCE_SYSTEM = `You produce monthly SEO-optimized resources for B2B SaaS audiences:
templates, checklists, calculators (described), or evergreen guides.
Output Markdown. Lead with what the reader will be able to do after using the
resource. Provide downloadable structure inline (tables, checklists) when the
kind is template/checklist. Use H2 / H3 hierarchy properly.`;

export function resourceUser(brand: string, kind: string, topic: string): string {
  return `${brand}

Resource kind: ${kind}
Topic: ${topic}

Write the full resource in Markdown.`;
}

export const RESOURCE_SEO_SYSTEM = `You write SEO metadata for a B2B resource (template / checklist / guide).
Output JSON only:
{
  "metaTitle":        string,    // <= 60 chars
  "metaDescription":  string,    // <= 155 chars
  "excerpt":          string,
  "focusKeyword":     string,
  "keywords":         string[],  // 5-10
  "ogImageAlt":       string
}`;

export function resourceSeoUser(brand: string, kind: string, body: string): string {
  return `${brand}

Resource kind: ${kind}

Draft (first 4000 chars):
"""
${body.slice(0, 4000)}
"""

Return JSON only.`;
}
