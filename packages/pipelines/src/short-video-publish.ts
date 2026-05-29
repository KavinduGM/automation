import { prisma, env, logger } from "@ca/shared";
import { ytCreateItem, ytBuildExpectedFilename } from "@ca/providers";
import fs from "node:fs/promises";
import path from "node:path";

// Uploads the rendered MP4 + thumbnail into the YT Automation system's
// Drive folder and registers a scheduled ContentItem with their API.
//
// Two integration strategies depending on env config:
//   A. YT_DRIVE_DROP_DIR set: write the files to a local directory that
//      is rclone-synced to Drive by ops. Lowest-friction; no Google
//      OAuth needed on the automation side. RECOMMENDED.
//   B. YT_DRIVE_API_ENABLED: use a Google service account or shared
//      refresh token to upload via the Drive REST API. Future-friendly
//      but needs OAuth plumbing.
//
// Either way, the YT Automation watcher picks up the files by name
// match and proceeds with its existing approval + upload flow.

export async function runShortVideoPublish(scriptId: string): Promise<void> {
  const row = await prisma.shortVideoScript.findUnique({ where: { id: scriptId } });
  if (!row) {
    logger.warn({ scriptId }, "shortvideo.publish.row_missing");
    return;
  }
  if (row.status !== "rendered" && row.status !== "uploading") {
    logger.info({ scriptId, status: row.status }, "shortvideo.publish.skipped_not_rendered");
    return;
  }
  if (!row.videoPath) {
    await prisma.shortVideoScript.update({
      where: { id: scriptId },
      data: { status: "failed", reviewNotes: "No videoPath — render did not complete" },
    });
    return;
  }

  const plan = await prisma.shortVideoPlan.findUnique({ where: { businessId: row.businessId } });
  if (!plan?.ytChannelPrefix || !plan.ytChannelId) {
    await prisma.shortVideoScript.update({
      where: { id: scriptId },
      data: {
        status: "failed",
        reviewNotes:
          "Missing ytChannelPrefix or ytChannelId on the business video plan — set them on the dashboard so the upload can target the right channel.",
      },
    });
    return;
  }

  await prisma.shortVideoScript.update({
    where: { id: scriptId },
    data: { status: "uploading" },
  });

  const scheduledAt = row.scheduledPublishAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
  const expectedFilename = ytBuildExpectedFilename({
    prefix: plan.ytChannelPrefix,
    date: scheduledAt,
    type: "short",
    slot: row.ord,
    ext: "mp4",
  });
  const expectedThumb = expectedFilename.replace(/\.mp4$/, ".jpg");

  // ── Strategy A: copy into the local Drive drop dir ─────────────────────
  const dropDir = process.env.YT_DRIVE_DROP_DIR;
  if (dropDir) {
    try {
      const assetsDir = env().ASSETS_DIR;
      const srcVideo = path.isAbsolute(row.videoPath) ? row.videoPath : path.join(assetsDir, row.videoPath);
      const srcThumb = row.thumbnailPath
        ? path.isAbsolute(row.thumbnailPath) ? row.thumbnailPath : path.join(assetsDir, row.thumbnailPath)
        : null;

      const target = path.join(dropDir, plan.ytChannelPrefix);
      await fs.mkdir(target, { recursive: true });
      await fs.copyFile(srcVideo, path.join(target, expectedFilename));
      if (srcThumb) {
        try {
          await fs.copyFile(srcThumb, path.join(target, expectedThumb));
        } catch (err) {
          logger.warn({ err, scriptId }, "shortvideo.publish.thumbnail_copy_failed");
        }
      }
      logger.info({ scriptId, expectedFilename }, "shortvideo.publish.dropped_for_drive_sync");
    } catch (err) {
      logger.error({ err, scriptId }, "shortvideo.publish.drop_failed");
      await prisma.shortVideoScript.update({
        where: { id: scriptId },
        data: { status: "failed", reviewNotes: `Drop to drive folder failed: ${(err as Error).message}` },
      });
      return;
    }
  } else {
    logger.warn({ scriptId }, "shortvideo.publish.no_drive_drop_dir — set YT_DRIVE_DROP_DIR or implement strategy B");
  }

  // ── Always POST /items to YT Automation so its watcher knows what to match ──
  try {
    const item = await ytCreateItem({
      channelId: plan.ytChannelId,
      type: "short",
      expectedFilename,
      title: row.title,
      description: composeDescription(row.description, row.hashtags),
      tags: row.tags,
      scheduledPublishAt: scheduledAt.toISOString(),
      source: "automation",
      sourceRef: row.id,
    });

    await prisma.shortVideoScript.update({
      where: { id: scriptId },
      data: { status: "scheduled", ytItemId: item.id, reviewNotes: "" },
    });
    logger.info({ scriptId, ytItemId: item.id, expectedFilename }, "shortvideo.publish.scheduled");
  } catch (err) {
    logger.error({ err, scriptId }, "shortvideo.publish.yt_register_failed");
    await prisma.shortVideoScript.update({
      where: { id: scriptId },
      data: {
        status: "failed",
        reviewNotes: `YT Automation register failed: ${(err as Error).message}`,
      },
    });
  }
}

// Build the YouTube description string from the saved description + hashtags.
function composeDescription(desc: string, hashtags: string[]): string {
  const tail = (hashtags ?? []).filter(Boolean).join(" ");
  if (!tail) return desc;
  return `${desc.trim()}\n\n${tail}`;
}
