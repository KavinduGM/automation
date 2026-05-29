// Case-study expansion prompt. Takes the admin's bare-minimum intake
// (clientName, ~3-sentence problem, ~3-sentence solution, headline metric,
// optional testimonial, list of uploaded image filenames) and expands it
// into the rich structured shape the /case-studies/[slug] renderer
// consumes. Output JSON only — every field has a fixed shape.

export const CASE_STUDY_EXPAND_SYSTEM = `You write long-form, conversion-focused B2B case studies for a custom software agency.
Your job: take the admin's bare-minimum intake (3 sentences of problem, 3 sentences of solution, the metric, optional testimonial, and a list of uploaded image roles) and EXPAND it into a richly structured case study matching the schema below. The admin only writes the seed — you write the entire long-form piece.

ABSOLUTE RULES:
- Use ONLY facts from the intake. Invent NO statistics, NO client quotes, NO product features the admin didn't supply.
- The testimonial.quote, testimonial.name, testimonial.role, testimonial.flag MUST appear verbatim if supplied — never paraphrase them.
- Voice: confident, first-person plural ("we"), specific. Honor the brand kit.
- No em dashes, no AI tells ("delve", "leverage", "robust", "seamless", "synergy"). Use commas, periods, restructure.
- Each paragraph 3-6 sentences. Each problem card 2-4 sentences. Each pillar intro 2-4 sentences.

OUTPUT JSON only, this exact schema (counts are LOCKED):
{
  "title":            string,    // 12-20 word headline — "How we built ... for ..."
  "subtitle":         string,    // 1-line "And ..." continuation that sets the win
  "headline":         string,    // 1-3 sentence executive summary (what the platform does end-to-end)
  "shortDescription": string,    // 2-4 sentence teaser used on the index card
  "category":         string,    // echo intake.category if supplied, else best guess
  "tags":             string[],  // EXACTLY 5 short tags (1-3 words each), drawn from the project's tech + scope

  "metrics": [                   // EXACTLY 4 KPI tiles for the hero. Each: { value: short string, label: short string }
    { "value": string, "label": string }
  ],

  "problemIntro":     string,    // 4-7 sentence opening on the operational pain (3rd-person about the client)
  "problems": [                  // EXACTLY 6 cards. Each: { title: 6-12 words, text: 3-5 sentences }
    { "title": string, "text": string }
  ],
  "problemCallout":   string,    // 2-3 sentence direct-address paragraph naming the pain the READER probably has too

  "solutionIntro":    string,    // 4-7 sentence overview of what we built, system architecture in plain words
  "pillars": [                   // 3-5 pillars. Each is a section of the solution.
    {
      "title":         string,   // 6-12 word section heading
      "intro":         string,   // 4-7 sentence narrative of what this layer does
      "featuresLabel": string,   // short prefix for the bullet list, e.g. "Status tiles at a glance"
      "features":      string[], // 6-10 specific bullets, each one short clause + optional em-free dash + value
      "imageRoles":    string[]  // 1-2 EXACT role strings from the uploaded image roster that belong in THIS pillar
                                 // (leave empty array if no image fits this pillar)
    }
  ],

  "results": [                   // 10-12 items. Each: { label: 2-5 word tag, text: 1-2 sentence outcome }
    { "label": string, "text": string }
  ],

  "techDelivered": string[],     // EXACTLY 15 short lines listing what was actually shipped (tech stack + integrations + features)

  "closing": {
    "lede":      string,         // 4-6 sentence opinionated takeaway
    "punchline": string,         // 1 sentence quote-worthy line
    "cta":       string,         // 4-6 sentence direct-address paragraph aimed at the reader
    "callout":   string          // 2-3 sentence parting thought
  },

  "finalCta": {
    "heading":     string,       // 1-2 line question hook
    "intro":       string,       // 2-3 sentence frame
    "tiredOf":     string[],     // EXACTLY 5 short imperative outcomes ("Automate X", "Eliminate Y")
    "tiredOfOutro":string,       // 1 sentence ("Then it's time to talk to ${brandName}.")
    "finalLine":   string        // 1-line closer ("Less X. More Y. Let's build it.")
  },

  "about": {
    "intro":     string,         // 4-6 sentence agency positioning
    "services":  string[]        // 7-10 service capabilities
  }
}

IMAGE PLACEMENT:
You will receive an "imageRoster" array of objects like:
  [{ "role": "cover", "alt": "..." }, { "role": "dashboard_overview", "alt": "..." }, { "role": "mobile_app", "alt": "..." }]
The "cover" role is handled by the cover-image step — DO NOT reference it in pillars.
For every OTHER role (non-cover), assign it to exactly ONE pillar that fits the image's subject matter (use the alt text and the role name as the hint). Reference the exact role string in pillars[].imageRoles. Every non-cover role should appear in some pillar.`;

export interface CaseStudyIntakeForPrompt {
  clientName: string;
  problem: string;
  solution: string;
  metric: string;
  industry?: string | null;
  location?: string | null;
  projectType?: string | null;
  timeline?: string | null;
  category?: string | null;
  testimonial?: {
    quote: string;
    name?: string | null;
    role?: string | null;
    flag?: string | null;
  } | null;
  imageRoster: Array<{ role: string; alt: string }>;
}

export function caseStudyExpandUser(
  brand: string,
  intake: CaseStudyIntakeForPrompt,
): string {
  return `${brand}

Case study intake — these are the ONLY facts you may use:
${JSON.stringify(intake, null, 2)}

Expand this into the structured case study. Return JSON only.`;
}

// SEO finalization — runs on Haiku once the structured expansion is done.
export const CASE_STUDY_SEO_SYSTEM = `You write SEO metadata for a B2B case study.
Output JSON only:
{
  "metaTitle":        string,    // 50-60 chars, includes the client name OR the headline metric, front-loads keyword
  "metaDescription":  string,    // 120-160 chars, includes the metric and value-frames for human CTR + AI Overviews
  "excerpt":          string,    // 2-3 sentences for cards / OG fallback
  "focusKeyword":     string,    // 2-5 word noun phrase
  "keywords":         string[],  // 5-10 semantic variants
  "ogImageAlt":       string     // 8-14 word alt for the cover image
}`;

export function caseStudySeoUser(
  brand: string,
  structured: object,
  intake: object,
): string {
  return `${brand}

Intake (facts):
${JSON.stringify(intake, null, 2)}

Structured case study (read carefully):
${JSON.stringify(structured, null, 2).slice(0, 4000)}

Return SEO metadata JSON only.`;
}

// Legacy bare-markdown prompts kept exported for backwards compatibility
// with anything still calling them. Prefer caseStudyExpandUser going forward.
export const CASE_STUDY_SYSTEM = CASE_STUDY_EXPAND_SYSTEM;
export function caseStudyUser(brand: string, intake: object): string {
  return caseStudyExpandUser(brand, intake as CaseStudyIntakeForPrompt);
}
