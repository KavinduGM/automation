// On-demand ISR revalidation for client sites.
//
// The agency site exposes /api/revalidate (Next.js) that flushes specific
// paths from its ISR cache. We call it on every state change that affects
// what visitors see: publish, unpublish, rollback, delete. This closes the
// 60-second SEO-poisoning gap where the index card lives on but the article
// detail page returns 404.
//
// Endpoint discovery: each business's `site_revalidate` Integration row holds
// `{ url, secret }`. If unset, this is a noop — useful for businesses whose
// sites don't run Next.js / ISR.

import { prisma } from "@ca/shared";
import { open } from "@ca/shared";
import { logger } from "@ca/shared";

interface SiteRevalidateConfig {
  url: string;     // e.g. "https://webx.groovymark.com/api/revalidate"
  secret: string;  // matches the site's REVALIDATE_SECRET env var
}

// Top-level cache (per worker process) so we don't decrypt the config on
// every call. Invalidated when an Integration row is updated.
const CONFIG_CACHE = new Map<string, SiteRevalidateConfig | null>();

async function configFor(businessId: string): Promise<SiteRevalidateConfig | null> {
  if (CONFIG_CACHE.has(businessId)) return CONFIG_CACHE.get(businessId) ?? null;
  const row = await prisma.integration.findUnique({
    where: { businessId_kind: { businessId, kind: "site_revalidate" } },
  });
  if (!row) {
    CONFIG_CACHE.set(businessId, null);
    return null;
  }
  try {
    const plain = open({ cipher: row.configCipher, iv: row.configIv, tag: row.configTag });
    const cfg = JSON.parse(plain) as SiteRevalidateConfig;
    if (!cfg.url || !cfg.secret) {
      CONFIG_CACHE.set(businessId, null);
      return null;
    }
    CONFIG_CACHE.set(businessId, cfg);
    return cfg;
  } catch (err) {
    logger.warn({ err, businessId }, "site_revalidate.config_decrypt_failed");
    CONFIG_CACHE.set(businessId, null);
    return null;
  }
}

export function invalidateConfigCache(businessId: string) {
  CONFIG_CACHE.delete(businessId);
}

export async function revalidatePaths(businessId: string, paths: string[]): Promise<{ ok: boolean; revalidated?: string[]; error?: string }> {
  if (paths.length === 0) return { ok: true, revalidated: [] };
  const cfg = await configFor(businessId);
  if (!cfg) {
    logger.info({ businessId, paths }, "site_revalidate.skipped_no_config");
    return { ok: true, revalidated: [] };
  }
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-revalidate-secret": cfg.secret,
      },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn({ businessId, status: res.status, body: text.slice(0, 200), paths }, "site_revalidate.non_2xx");
      return { ok: false, error: `${res.status}: ${text.slice(0, 200)}` };
    }
    const j = (await res.json().catch(() => ({}))) as { revalidated?: string[] };
    logger.info({ businessId, revalidated: j.revalidated }, "site_revalidate.done");
    return { ok: true, revalidated: j.revalidated };
  } catch (err) {
    logger.warn({ err, businessId, paths }, "site_revalidate.fetch_failed");
    return { ok: false, error: (err as Error).message };
  }
}

// Convenience for the common publish/unpublish/rollback case: invalidate the
// type's index page AND the specific slug page in one call. Includes / and
// /sitemap.xml on a best-effort basis so OG previewers + search crawlers see
// the change as soon as possible.
export async function revalidateForContent(args: {
  businessId: string;
  type: "blog" | "case_study" | "resource" | "landing_page";
  slug: string | null;
}): Promise<void> {
  const paths = new Set<string>(["/", "/sitemap.xml"]);
  switch (args.type) {
    case "blog":         paths.add("/blog");          if (args.slug) paths.add(`/blog/${args.slug}`);          break;
    case "case_study":   /* index lives at /portfolio */          if (args.slug) paths.add(`/case-studies/${args.slug}`); break;
    case "resource":     paths.add("/resources");     if (args.slug) paths.add(`/resources/${args.slug}`);     break;
    case "landing_page":                              if (args.slug) paths.add(`/lp/${args.slug}`);            break;
  }
  await revalidatePaths(args.businessId, [...paths]);
}
