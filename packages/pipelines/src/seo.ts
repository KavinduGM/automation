// SEO helpers shared across pipelines + publish.

// Average adult reading speed ~225 wpm for non-technical prose. We use 200
// to keep the number conservative and easy to verify.
const WORDS_PER_MINUTE = 200;

export function readingMinutes(body: string): number {
  const words = (body.match(/\S+/g) ?? []).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

// Tight clamps so the values can be written straight into <title> and
// <meta description>. Truncates on a word boundary when possible.
export function clampTitle(s: string | undefined, max = 60): string | null {
  return clamp(s, max);
}
export function clampDescription(s: string | undefined, max = 155): string | null {
  return clamp(s, max);
}
function clamp(s: string | undefined, max: number): string | null {
  if (!s) return null;
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const last = cut.lastIndexOf(" ");
  return (last > max * 0.6 ? cut.slice(0, last) : cut).trimEnd();
}

// Used as a structured payload on ContentItem.meta.seo
export interface SeoBundle {
  metaTitle: string | null;
  metaDescription: string | null;
  excerpt: string | null;
  focusKeyword: string | null;
  keywords: string[];
  ogImageAlt: string | null;
  faq?: Array<{ q: string; a: string }>;
  internalLinkSuggestions?: Array<{ anchor: string; path: string }>;
}

export function emptySeo(): SeoBundle {
  return {
    metaTitle: null,
    metaDescription: null,
    excerpt: null,
    focusKeyword: null,
    keywords: [],
    ogImageAlt: null,
  };
}

// Build the SEO fields object passed to prisma.{post|caseStudy|…}.upsert
export interface PublishedSeoFields {
  metaTitle: string | null;
  metaDescription: string | null;
  keywords: string[];
  focusKeyword: string | null;
  ogImagePath: string | null;
  ogImageAlt: string | null;
  readingMinutes?: number | null;
  canonicalPath: string | null;
  authorName: string | null;
  authorRole: string | null;
  authorUrl: string | null;
}

export function publishedSeo(opts: {
  seo: SeoBundle;
  fallbackTitle: string;
  body?: string;
  coverImagePath?: string | null;
  authorName?: string | null;
  authorRole?: string | null;
  authorUrl?: string | null;
  includeReadingMinutes?: boolean;
}): PublishedSeoFields {
  return {
    metaTitle: clampTitle(opts.seo.metaTitle ?? opts.fallbackTitle),
    metaDescription: clampDescription(opts.seo.metaDescription ?? opts.seo.excerpt ?? undefined),
    keywords: opts.seo.keywords ?? [],
    focusKeyword: opts.seo.focusKeyword ?? null,
    ogImagePath: opts.coverImagePath ?? null,
    ogImageAlt: opts.seo.ogImageAlt ?? null,
    readingMinutes: opts.includeReadingMinutes && opts.body ? readingMinutes(opts.body) : null,
    canonicalPath: null,
    authorName: opts.authorName ?? null,
    authorRole: opts.authorRole ?? null,
    authorUrl: opts.authorUrl ?? null,
  };
}
