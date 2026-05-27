import { prisma, logger, queue, QUEUES, type Prisma } from "@ca/shared";
import { schedulePost, revalidateForContent } from "@ca/providers";
import { setStatus, logStep } from "./util.js";
import { publishedSeo, type SeoBundle, emptySeo } from "./seo.js";
import { publicUrlFor } from "./post-review.js";

// Materializes an approved ContentItem into the typed published table the
// client website reads from. Idempotent — re-running publishes the same row.

export async function publishContentItem(contentItemId: string): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({
    where: { id: contentItemId },
    include: { assets: { orderBy: { ord: "asc" } } },
  });
  if (item.status !== "approved" && item.status !== "scheduled") {
    logger.warn({ id: contentItemId, status: item.status }, "publish.skipped_not_approved");
    return;
  }
  await setStatus(contentItemId, "publishing");
  await logStep(contentItemId, "publish", "started", { label: "Publish to client site" });
  const publishT0 = Date.now();

  try {
    switch (item.type) {
      case "blog":          await publishBlog(item); break;
      case "case_study":    await publishCaseStudy(item); break;
      case "resource":      await publishResource(item); break;
      case "landing_page":  await publishLandingPage(item); break;
      case "social_post":   await publishSocial(item); break;
      case "webinar":
        // Webinar publishing is delegated to the YT proxy in the webinar pipeline.
        // By the time we get here, the YT item is already planned.
        break;
    }
    await prisma.contentItem.update({
      where: { id: contentItemId },
      data: { status: "published", publishedAt: new Date() },
    });
    await logStep(contentItemId, "publish", "completed", {
      label: "Published live",
      durationMs: Date.now() - publishT0,
    });

    // Tell the client site to flush the index + detail pages from its ISR
    // cache immediately. Without this, the /blog index keeps serving the
    // pre-publish HTML (no new card) — OR after a rollback re-publish, the
    // /blog index keeps the old card pointing at a now-404 detail page.
    if (item.type === "blog" || item.type === "case_study" || item.type === "resource" || item.type === "landing_page") {
      void revalidateForContent({
        businessId: item.businessId,
        type: item.type,
        slug: item.slug,
      }).catch((err) => logger.warn({ err, contentItemId }, "publish.revalidate_failed"));
    }

    // Schedule a post-publish LAYOUT review ~3 minutes out so any stale
    // 404 ISR cache from a previous failed publish has time to expire
    // (Next.js `revalidate: 60` on /blog/[slug] tops out at 60s, plus
    // ~90s of safety margin for slow regeneration on a busy worker box).
    // Only for content types with a real public URL.
    //
    // Always runs — layout issues are unacceptable to leave live, and the
    // reviewer no longer touches content (that's the pre-publish critic).
    const business = await prisma.business.findUnique({ where: { id: item.businessId } });
    const publicUrl = business ? publicUrlFor({ type: item.type, slug: item.slug, businessId: item.businessId }, business.slug) : null;
    if (publicUrl) {
      try {
        await queue(QUEUES.post_review).add(
          `review:${contentItemId}`,
          { contentItemId, publicUrl, attempt: 0 },
          { delay: 180_000, removeOnComplete: 500, removeOnFail: 100 },
        );
        logger.info({ contentItemId, publicUrl }, "publish.post_review_enqueued");
      } catch (err) {
        logger.warn({ err, contentItemId }, "publish.post_review_enqueue_failed");
      }
    }
  } catch (err) {
    logger.error({ err, contentItemId }, "publish.failed");
    await logStep(contentItemId, "publish", "failed", {
      label: "Publish",
      message: String((err as Error).message ?? err),
      durationMs: Date.now() - publishT0,
    });
    await prisma.contentItem.update({
      where: { id: contentItemId },
      data: { status: "failed", reviewNotes: String((err as Error).message ?? err) },
    });
    throw err;
  }
}

type Item = Awaited<ReturnType<typeof prisma.contentItem.findUniqueOrThrow>> & {
  assets: Array<{ kind: string; path: string; altText: string | null; ord: number }>;
};

// Pull the SEO bundle out of ContentItem.meta.seo (set by the pipelines).
function extractSeo(item: Item): SeoBundle {
  const meta = (item.meta ?? {}) as { seo?: SeoBundle };
  return meta.seo ?? emptySeo();
}

// Find the canonical cover image — ord=0 image if present.
function coverFor(item: Item): { path: string | null; alt: string | null } {
  const image = item.assets.find((a) => a.kind === "image" && a.ord === 0) ?? item.assets.find((a) => a.kind === "image");
  return { path: image?.path ?? null, alt: image?.altText ?? null };
}

// Inline images = every image asset with ord >= 1, sorted by ord. Each entry
// keeps the original relative path + alt so the WebX renderer can resolve
// [[IMAGE_N]] markers without joining back to the Asset table.
function inlineImagesFor(item: Item): Array<{ path: string; alt: string | null; ord: number }> {
  return item.assets
    .filter((a) => a.kind === "image" && a.ord >= 1)
    .sort((a, b) => a.ord - b.ord)
    .map((a) => ({ path: a.path, alt: a.altText, ord: a.ord }));
}

// Remove any [[IMAGE_N]] marker whose `ord` isn't backed by an actual Asset
// row. This is the safety net for partial image-generation failures: we'd
// rather show the article with a gap than leak a template token to the
// live page (which the layout reviewer would then roll back). The marker
// removal collapses any blank line it lived on so the body stays clean.
function stripUnmatchedImageMarkers(body: string, availableOrds: Set<number>): string {
  // Lines containing only an IMAGE marker get deleted entirely. Inline
  // markers (rare but possible) get replaced with an empty string.
  const lines = body.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const soloMatch = /^\[\[IMAGE_(\d+)\]\]$/.exec(trimmed);
    if (soloMatch) {
      const ord = Number(soloMatch[1]);
      if (availableOrds.has(ord)) {
        out.push(line);
      }
      // else: drop the whole line.
      continue;
    }
    // Inline (mid-line) markers — replace any unmatched ones in place.
    const cleaned = line.replace(/\[\[IMAGE_(\d+)\]\]/g, (m, ordStr) => {
      const ord = Number(ordStr);
      return availableOrds.has(ord) ? m : "";
    });
    out.push(cleaned);
  }
  // Collapse 3+ consecutive blank lines that may result from dropped markers.
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

async function publishBlog(item: Item) {
  const meta = (item.meta ?? {}) as {
    excerpt?: string;
    tags?: string[];
    authorName?: string;
    authorUrl?: string;
    faq?: Array<{ q: string; a: string }>;
  };
  const cover = coverFor(item);
  const inline = inlineImagesFor(item);
  // Scrub any [[IMAGE_N]] markers that don't have a matching asset.
  // Happens when image generation partially failed (e.g. OpenAI credits)
  // and the body still references images that were never written. Without
  // this, the markers leak to live HTML and the layout reviewer rolls the
  // page back for marker_leak.
  const availableOrds = new Set(item.assets.filter((a) => a.kind === "image").map((a) => a.ord));
  const safeBody = stripUnmatchedImageMarkers(item.bodyMd, availableOrds);
  const seo = extractSeo(item);
  const seoFields = publishedSeo({
    seo,
    fallbackTitle: item.title,
    body: safeBody,
    coverImagePath: cover.path,
    authorName: meta.authorName ?? null,
    authorUrl: meta.authorUrl ?? null,
    includeReadingMinutes: true,
  });
  // If the asset doesn't already carry alt, fall back to the OG alt the AI proposed.
  if (!seoFields.ogImageAlt && cover.alt) seoFields.ogImageAlt = cover.alt;

  await prisma.post.upsert({
    where: { contentItemId: item.id },
    create: {
      businessId: item.businessId,
      contentItemId: item.id,
      slug: item.slug ?? item.id,
      title: item.title,
      excerpt: seo.excerpt ?? meta.excerpt ?? "",
      bodyMd: safeBody,
      coverImagePath: cover.path,
      inlineImages: inline as unknown as Prisma.InputJsonValue,
      tags: meta.tags ?? [],
      faq: (meta.faq ?? seo.faq ?? []) as unknown as Prisma.InputJsonValue,
      ...seoFields,
    },
    update: {
      title: item.title,
      excerpt: seo.excerpt ?? meta.excerpt ?? "",
      bodyMd: safeBody,
      coverImagePath: cover.path,
      inlineImages: inline as unknown as Prisma.InputJsonValue,
      tags: meta.tags ?? [],
      faq: (meta.faq ?? seo.faq ?? []) as unknown as Prisma.InputJsonValue,
      ...seoFields,
    },
  });
}

async function publishCaseStudy(item: Item) {
  const intake = await prisma.caseStudyIntake.findUnique({ where: { contentItemId: item.id } });
  if (!intake) throw new Error("publishCaseStudy: missing intake");
  const cover = coverFor(item);
  const seo = extractSeo(item);
  const seoFields = publishedSeo({
    seo,
    fallbackTitle: item.title,
    body: item.bodyMd,
    coverImagePath: cover.path,
    includeReadingMinutes: true,
  });
  if (!seoFields.ogImageAlt && cover.alt) seoFields.ogImageAlt = cover.alt;

  await prisma.caseStudy.upsert({
    where: { contentItemId: item.id },
    create: {
      businessId: item.businessId,
      contentItemId: item.id,
      slug: item.slug ?? item.id,
      title: item.title,
      clientName: intake.clientName,
      metric: intake.metric,
      bodyMd: item.bodyMd,
      coverImagePath: cover.path,
      ...seoFields,
    },
    update: {
      title: item.title,
      clientName: intake.clientName,
      metric: intake.metric,
      bodyMd: item.bodyMd,
      coverImagePath: cover.path,
      ...seoFields,
    },
  });
}

async function publishResource(item: Item) {
  const meta = (item.meta ?? {}) as { kind?: string; downloadPath?: string };
  const cover = coverFor(item);
  const seo = extractSeo(item);
  const seoFields = publishedSeo({
    seo,
    fallbackTitle: item.title,
    body: item.bodyMd,
    coverImagePath: cover.path,
    includeReadingMinutes: true,
  });
  if (!seoFields.ogImageAlt && cover.alt) seoFields.ogImageAlt = cover.alt;

  await prisma.resource.upsert({
    where: { contentItemId: item.id },
    create: {
      businessId: item.businessId,
      contentItemId: item.id,
      slug: item.slug ?? item.id,
      title: item.title,
      kind: meta.kind ?? "guide",
      bodyMd: item.bodyMd,
      downloadPath: meta.downloadPath,
      coverImagePath: cover.path,
      ...seoFields,
    },
    update: {
      title: item.title,
      kind: meta.kind ?? "guide",
      bodyMd: item.bodyMd,
      downloadPath: meta.downloadPath,
      coverImagePath: cover.path,
      ...seoFields,
    },
  });
}

async function publishLandingPage(item: Item) {
  const meta = (item.meta ?? {}) as { sections?: unknown };
  const cover = coverFor(item);
  const seo = extractSeo(item);
  // LandingPage doesn't carry readingMinutes/authorName.
  const seoFields = publishedSeo({
    seo,
    fallbackTitle: item.title,
    coverImagePath: cover.path,
    includeReadingMinutes: false,
  });
  if (!seoFields.ogImageAlt && cover.alt) seoFields.ogImageAlt = cover.alt;
  const { readingMinutes: _r, authorName: _an, authorUrl: _au, ...lpSeoFields } = seoFields;

  await prisma.landingPage.upsert({
    where: { contentItemId: item.id },
    create: {
      businessId: item.businessId,
      contentItemId: item.id,
      slug: item.slug ?? item.id,
      title: item.title,
      sections: (meta.sections as object) ?? [],
      ...lpSeoFields,
    },
    update: {
      title: item.title,
      sections: (meta.sections as object) ?? [],
      ...lpSeoFields,
    },
  });
}

async function publishSocial(item: Item) {
  // For social posts the meta carries channel + scheduledAt + profile_ids.
  const meta = (item.meta ?? {}) as {
    channel: "linkedin" | "x" | "instagram";
    scheduledAt: string;
    bufferProfileIds: string[];
    imageUrl?: string;
  };
  const scheduledAt = new Date(meta.scheduledAt);

  let bufferUpdateId: string | undefined;
  try {
    const res = await schedulePost({
      profileIds: meta.bufferProfileIds,
      text: item.bodyMd,
      imageUrl: meta.imageUrl,
      scheduledAt,
    });
    bufferUpdateId = res.updateIds[0];
  } catch (err) {
    logger.error({ err }, "publish.social.buffer_failed");
    throw err;
  }

  await prisma.socialPost.upsert({
    where: { contentItemId: item.id },
    create: {
      businessId: item.businessId,
      contentItemId: item.id,
      channel: meta.channel,
      body: item.bodyMd,
      bufferUpdateId,
      scheduledAt,
    },
    update: { bufferUpdateId, scheduledAt },
  });
}
