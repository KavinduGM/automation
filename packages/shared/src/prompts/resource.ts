export const RESOURCE_SYSTEM = `You produce monthly resources for B2B SaaS audiences:
templates, checklists, calculators (described), or evergreen guides.
Output Markdown. Lead with what the reader will be able to do after using the
resource. Provide downloadable structure inline (tables, checklists) when the
kind is template/checklist.`;

export function resourceUser(brand: string, kind: string, topic: string): string {
  return `${brand}

Resource kind: ${kind}
Topic: ${topic}

Write the full resource in Markdown.`;
}
