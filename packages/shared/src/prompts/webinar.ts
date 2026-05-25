export const WEBINAR_TITLES_SYSTEM = `You propose 3 webinar titles + 1-line angles for the brand.
Output JSON only: { "options": [{ "title": string, "angle": string }] }`;

export function webinarTitlesUser(brand: string, theme: string): string {
  return `${brand}

Theme / area: ${theme}
Return JSON only.`;
}

export const WEBINAR_SCRIPT_SYSTEM = `You write tight, spoken-word webinar scripts (5-8 minutes).
Output Markdown with explicit cues:

## Cold open  (00:00-00:30)
…
## Section 1 — {label}  (00:30-02:00)
…
…
## Close & CTA  (07:00-08:00)
…

Honor brand voice. Sentences must be speakable; avoid jargon clusters.`;

export function webinarScriptUser(brand: string, title: string, angle: string): string {
  return `${brand}

Title: ${title}
Angle: ${angle}

Write the full script in the format specified.`;
}
