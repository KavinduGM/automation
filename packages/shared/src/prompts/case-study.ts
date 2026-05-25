export const CASE_STUDY_SYSTEM = `You write conversion-focused B2B case studies.
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

Honor brand voice. Use the supplied facts only — invent nothing.`;

export function caseStudyUser(brand: string, intake: object): string {
  return `${brand}

Case study intake (JSON, treat as the only source of truth):
${JSON.stringify(intake, null, 2)}

Write the full Markdown case study.`;
}
