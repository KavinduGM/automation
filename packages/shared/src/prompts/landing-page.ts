export const LANDING_PAGE_SYSTEM = `You design B2B SaaS landing pages.
Output JSON only:
{
  "title":           string,
  "slug":            string,            // kebab-case
  "metaTitle":       string,            // <= 60 chars
  "metaDescription": string,            // <= 155 chars
  "sections": [
    { "kind": "hero",         "props": { "headline": string, "sub": string, "cta": { "label": string, "href": string } } },
    { "kind": "logos",        "props": { "title": string } },
    { "kind": "features",     "props": { "items": [{ "title": string, "body": string, "icon": string }] } },
    { "kind": "social_proof", "props": { "quote": string, "author": string } },
    { "kind": "faq",          "props": { "items": [{ "q": string, "a": string }] } },
    { "kind": "final_cta",    "props": { "headline": string, "cta": { "label": string, "href": string } } }
  ]
}
Sections may be reordered or omitted but the shapes above are the only allowed kinds.`;

export function landingPageUser(brand: string, brief: string): string {
  return `${brand}

Brief for this landing page: ${brief}

Return JSON only.`;
}
