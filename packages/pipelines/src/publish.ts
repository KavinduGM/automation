import { prisma, logger } from "@ca/shared";
import { schedulePost } from "@ca/providers";
import { setStatus } from "./util.js";

// Materializes an approved ContentItem into the typed published table the
// client website reads from. Idempotent — re-running publishes the same row.

export async function publishContentItem(contentItemId: string): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({
    where: { id: contentItemId },
    include: { assets: true },
  });
  if (item.status !== "approved") {
    logger.warn({ id: contentItemId, status: item.status }, "publish.skipped_not_approved");
    return;
  }
  await setStatus(contentItemId, "publishing");

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
  } catch (err) {
    logger.error({ err, contentItemId }, "publish.failed");
    await prisma.contentItem.update({
      where: { id: contentItemId },
      data: { status: "failed", reviewNotes: String((err as Error).message ?? err) },
    });
    throw err;
  }
}

type Item = Awaited<ReturnType<typeof prisma.contentItem.findUniqueOrThrow>> & { assets: Array<{ kind: string; path: string }> };

async function publishBlog(item: Item) {
  const meta = (item.meta ?? {}) as { excerpt?: string; tags?: string[] };
  const cover = item.assets.find((a) => a.kind === "image");
  await prisma.post.upsert({
    where: { contentItemId: item.id },
    create: {
      businessId: item.businessId,
      contentItemId: item.id,
      slug: item.slug ?? item.id,
      title: item.title,
      excerpt: meta.excerpt ?? "",
      bodyMd: item.bodyMd,
      coverImagePath: cover?.path,
      tags: meta.tags ?? [],
    },
    update: {
      title: item.title,
      excerpt: meta.excerpt ?? "",
      bodyMd: item.bodyMd,
      coverImagePath: cover?.path,
      tags: meta.tags ?? [],
    },
  });
}

async function publishCaseStudy(item: Item) {
  const intake = await prisma.caseStudyIntake.findUnique({ where: { contentItemId: item.id } });
  if (!intake) throw new Error("publishCaseStudy: missing intake");
  const cover = item.assets.find((a) => a.kind === "image");
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
      coverImagePath: cover?.path,
    },
    update: {
      title: item.title,
      clientName: intake.clientName,
      metric: intake.metric,
      bodyMd: item.bodyMd,
      coverImagePath: cover?.path,
    },
  });
}

async function publishResource(item: Item) {
  const meta = (item.meta ?? {}) as { kind?: string; downloadPath?: string };
  const cover = item.assets.find((a) => a.kind === "image");
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
      coverImagePath: cover?.path,
    },
    update: {
      title: item.title,
      kind: meta.kind ?? "guide",
      bodyMd: item.bodyMd,
      downloadPath: meta.downloadPath,
      coverImagePath: cover?.path,
    },
  });
}

async function publishLandingPage(item: Item) {
  const meta = (item.meta ?? {}) as { metaTitle?: string; metaDescription?: string; sections?: unknown };
  await prisma.landingPage.upsert({
    where: { contentItemId: item.id },
    create: {
      businessId: item.businessId,
      contentItemId: item.id,
      slug: item.slug ?? item.id,
      title: item.title,
      sections: (meta.sections as object) ?? [],
      metaTitle: meta.metaTitle ?? null,
      metaDescription: meta.metaDescription ?? null,
    },
    update: {
      title: item.title,
      sections: (meta.sections as object) ?? [],
      metaTitle: meta.metaTitle ?? null,
      metaDescription: meta.metaDescription ?? null,
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
