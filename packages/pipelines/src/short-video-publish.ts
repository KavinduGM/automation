import { prisma, env, logger, open } from "@ca/shared";
import { uploadVideo, setThumbnail, ytCreateItem, ytBuildExpectedFilename } from "@ca/providers";
import fs from "node:fs/promises";
import path from "node:path";

// Publishes a rendered short to YouTube. Two paths supported:
//
//   A. NATIVE (recommended) — plan.youtubeChannelRowId is set.
//      Read the encrypted refresh token, upload via YouTube Data API v3
//      with scheduled publishAt, set custom thumbnail, store videoId.
//      Replaces the previous Drive-drop + YT Automation hop entirely.
//
//   B. LEGACY — plan.ytChannelPrefix + plan.ytChannelId are set (and the
//      YT Automation env vars are configured). Drops MP4 into Drive sync
//      folder + creates a ContentItem in the YT Automation system.
//      Kept for the OAP/OAG/NUR education channels that still use the
//      original tool.

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
    await markFailed(scriptId, "No videoPath — render did not complete");
    return;
  }

  const plan = await prisma.shortVideoPlan.findUnique({ where: { businessId: row.businessId } });
  if (!plan) {
    await markFailed(scriptId, "No ShortVideoPlan configured for this business");
    return;
  }

  // Resolve absolute paths to the rendered files.
  const assetsDir = env().ASSETS_DIR;
  const videoAbs = path.isAbsolute(row.videoPath) ? row.videoPath : path.join(assetsDir, row.videoPath);
  const thumbAbs = row.thumbnailPath
    ? (path.isAbsolute(row.thumbnailPath) ? row.thumbnailPath : path.join(assetsDir, row.thumbnailPath))
    : null;

  // Sanity: file must exist before we tell YouTube about it.
  try {
    await fs.access(videoAbs);
  } catch {
    await markFailed(scriptId, `Rendered video missing on disk at ${videoAbs}`);
    return;
  }

  await prisma.shortVideoScript.update({ where: { id: scriptId }, data: { status: "uploading" } });

  // ── Path A: NATIVE YouTube upload ─────────────────────────────────────
  if (plan.youtubeChannelRowId) {
    await publishNative({ scriptId, row, plan, videoAbs, thumbAbs });
    return;
  }

  // ── Path B: LEGACY YT Automation handoff ──────────────────────────────
  if (plan.ytChannelPrefix && plan.ytChannelId) {
    await publishLegacy({ scriptId, row, plan, videoAbs, thumbAbs });
    return;
  }

  await markFailed(
    scriptId,
    "Neither youtubeChannelRowId (native path) nor ytChannelPrefix+ytChannelId (legacy path) configured on the business plan — open the business page → Short-video plan and connect a YouTube channel.",
  );
}

async function publishNative(args: {
  scriptId: string;
  row: Awaited<ReturnType<typeof prisma.shortVideoScript.findUnique>>;
  plan: Awaited<ReturnType<typeof prisma.shortVideoPlan.findUnique>>;
  videoAbs: string;
  thumbAbs: string | null;
}): Promise<void> {
  const { scriptId, row, plan, videoAbs, thumbAbs } = args;
  if (!row || !plan?.youtubeChannelRowId) return;

  const ch = await prisma.youTubeChannel.findUnique({ where: { id: plan.youtubeChannelRowId } });
  if (!ch) {
    await markFailed(scriptId, "Configured YouTube channel row not found (was it disconnected?)");
    return;
  }

  // Decrypt the refresh token.
  let refreshToken: string;
  try {
    refreshToken = open({ cipher: ch.refreshTokenCipher, iv: ch.refreshTokenIv, tag: ch.refreshTokenTag });
  } catch (err) {
    await markFailed(scriptId, `Failed to decrypt YouTube refresh token: ${(err as Error).message}`);
    return;
  }

  // Compose YouTube description = body + hashtags on its own line.
  const description = composeDescription(row.description, row.hashtags);
  // scheduledPublishAt is the wall-clock instant YouTube flips the video
  // from private → public. If we somehow don't have one, upload as private
  // with no schedule (admin can flip it from YouTube Studio).
  const publishAt = row.scheduledPublishAt ?? null;

  try {
    const upload = await uploadVideo({
      refreshToken,
      videoFilePath: videoAbs,
      title: row.title,
      description,
      tags: row.tags,
      publishAt,
      categoryId: "22",         // People & Blogs — broad default for shorts
      defaultLanguage: "en",
      madeForKids: false,
      isShort: true,
    });
    logger.info({ scriptId, videoId: upload.videoId, publishAt: upload.publishAt }, "shortvideo.publish.native_uploaded");

    // Try to set a custom thumbnail — non-fatal on failure (shorts can
    // refuse custom thumbs on new channels; YouTube auto-generates one
    // from the first frame as a fallback).
    let thumbNote = "";
    if (thumbAbs) {
      try {
        await fs.access(thumbAbs);
        const r = await setThumbnail({ refreshToken, videoId: upload.videoId, thumbnailFilePath: thumbAbs });
        if (!r.ok) thumbNote = `Thumbnail upload skipped: ${r.message ?? "unknown"}`;
      } catch (err) {
        thumbNote = `Thumbnail not uploaded: ${(err as Error).message}`;
      }
    }

    await prisma.shortVideoScript.update({
      where: { id: scriptId },
      data: {
        status: "scheduled",
        ytItemId: upload.videoId,    // reuse this column to store YouTube videoId for native path
        reviewNotes: thumbNote,
      },
    });
    // Update the channel's lastRefreshedAt — successful upload implies the
    // refresh token still works.
    await prisma.youTubeChannel.update({
      where: { id: ch.id },
      data: { lastRefreshedAt: new Date(), refreshError: null, refreshErrorAt: null },
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    logger.error({ err, scriptId, channelId: ch.youtubeChannelId }, "shortvideo.publish.native_failed");

    // If the error looks like a token problem, mark the channel as needing
    // reconnection so the dashboard nags the admin.
    if (looksLikeAuthError(msg)) {
      await prisma.youTubeChannel.update({
        where: { id: ch.id },
        data: { refreshError: msg.slice(0, 500), refreshErrorAt: new Date() },
      });
    }
    await markFailed(scriptId, msg);
  }
}

// Legacy path kept verbatim (Drive drop + YT Automation /items).
async function publishLegacy(args: {
  scriptId: string;
  row: NonNullable<Awaited<ReturnType<typeof prisma.shortVideoScript.findUnique>>>;
  plan: NonNullable<Awaited<ReturnType<typeof prisma.shortVideoPlan.findUnique>>>;
  videoAbs: string;
  thumbAbs: string | null;
}): Promise<void> {
  const { scriptId, row, plan, videoAbs, thumbAbs } = args;
  const scheduledAt = row.scheduledPublishAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
  const expectedFilename = ytBuildExpectedFilename({
    prefix: plan.ytChannelPrefix!,
    date: scheduledAt,
    type: "short",
    slot: row.ord,
    ext: "mp4",
  });
  const expectedThumb = expectedFilename.replace(/\.mp4$/, ".jpg");

  const dropDir = process.env.YT_DRIVE_DROP_DIR;
  if (dropDir) {
    try {
      const target = path.join(dropDir, plan.ytChannelPrefix!);
      await fs.mkdir(target, { recursive: true });
      await fs.copyFile(videoAbs, path.join(target, expectedFilename));
      if (thumbAbs) {
        try { await fs.copyFile(thumbAbs, path.join(target, expectedThumb)); } catch { /* non-fatal */ }
      }
    } catch (err) {
      await markFailed(scriptId, `Drop to drive folder failed: ${(err as Error).message}`);
      return;
    }
  }

  try {
    const item = await ytCreateItem({
      channelId: plan.ytChannelId!,
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
  } catch (err) {
    await markFailed(scriptId, `YT Automation register failed: ${(err as Error).message}`);
  }
}

async function markFailed(scriptId: string, reason: string): Promise<void> {
  await prisma.shortVideoScript.update({
    where: { id: scriptId },
    data: { status: "failed", reviewNotes: reason.slice(0, 4000) },
  });
}

function composeDescription(desc: string, hashtags: string[]): string {
  const tail = (hashtags ?? []).filter(Boolean).join(" ");
  if (!tail) return desc;
  return `${desc.trim()}\n\n${tail}`;
}

// Recognize OAuth refresh-token failures. We use this to flag the
// YouTubeChannel row so the dashboard can prompt for re-auth.
function looksLikeAuthError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("invalid_grant") ||
    m.includes("token has been expired or revoked") ||
    m.includes("invalid credentials") ||
    m.includes("unauthorized_client") ||
    m.includes("401")
  );
}
