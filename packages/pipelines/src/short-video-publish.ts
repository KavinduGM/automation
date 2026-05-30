import { prisma, env, logger, open } from "@ca/shared";
import { uploadVideo, ytCreateItem, ytBuildExpectedFilename } from "@ca/providers";
import fs from "node:fs/promises";
import path from "node:path";

// Publishes a rendered short to YouTube. Two paths supported:
//
//   A. NATIVE (recommended) — plan.youtubeChannelRowId is set.
//      Read the encrypted refresh token, upload via YouTube Data API v3
//      with scheduled publishAt, store videoId.
//      Replaces the previous Drive-drop + YT Automation hop entirely.
//
//   B. LEGACY — plan.ytChannelPrefix + plan.ytChannelId are set (and the
//      YT Automation env vars are configured). Drops MP4 into Drive sync
//      folder + creates a ContentItem in the YT Automation system.
//      Kept for the OAP/OAG/NUR education channels that still use the
//      original tool.
//
// Thumbnails: intentionally NOT generated or uploaded for shorts. YouTube
// auto-creates a thumbnail from the first frame, and Shorts on most channels
// don't honor custom thumbnails anyway. When the long-video pipeline lands
// we'll add brand-templated thumbnail generation + upload there.

export async function runShortVideoPublish(
  scriptId: string,
  opts: { testMode?: boolean } = {},
): Promise<void> {
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

  // Resolve absolute path to the rendered video.
  const assetsDir = env().ASSETS_DIR;
  const videoAbs = path.isAbsolute(row.videoPath) ? row.videoPath : path.join(assetsDir, row.videoPath);

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
    await publishNative({ scriptId, row, plan, videoAbs, testMode: opts.testMode === true });
    return;
  }

  // ── Path B: LEGACY YT Automation handoff ──────────────────────────────
  if (plan.ytChannelPrefix && plan.ytChannelId) {
    await publishLegacy({ scriptId, row, plan, videoAbs });
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
  testMode: boolean;
}): Promise<void> {
  const { scriptId, row, plan, videoAbs, testMode } = args;
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
  const baseDescription = composeDescription(row.description, row.hashtags);
  const description = testMode
    ? `[TEST RUN — uploaded as unlisted for review]\n\n${baseDescription}`
    : baseDescription;

  // Test mode: upload as unlisted with NO schedule so you can preview
  // immediately via the video URL without it being publicly listed or
  // recommended. Normal flow: private + publishAt = the scheduled slot,
  // YouTube auto-flips to public at that time.
  const publishAt = testMode ? null : (row.scheduledPublishAt ?? null);
  const privacyOverride = testMode ? "unlisted" : undefined;

  try {
    const upload = await uploadVideo({
      refreshToken,
      videoFilePath: videoAbs,
      title: testMode ? `[TEST] ${row.title}`.slice(0, 100) : row.title,
      description,
      tags: row.tags,
      publishAt,
      privacyStatus: privacyOverride,
      categoryId: "22",         // People & Blogs — broad default for shorts
      defaultLanguage: "en",
      madeForKids: false,
      isShort: true,
    });
    logger.info({ scriptId, videoId: upload.videoId, publishAt: upload.publishAt, testMode }, "shortvideo.publish.native_uploaded");

    // Shorts: no custom thumbnail uploaded — YouTube auto-generates one
    // from the first frame. (Long-video pipeline will set custom thumbs.)

    const watchUrl = `https://youtu.be/${upload.videoId}`;
    await prisma.shortVideoScript.update({
      where: { id: scriptId },
      data: {
        status: "scheduled",
        ytItemId: upload.videoId,    // reuse this column to store YouTube videoId for native path
        reviewNotes: testMode ? `TEST RUN ok — watch: ${watchUrl} (unlisted)` : "",
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
}): Promise<void> {
  const { scriptId, row, plan, videoAbs } = args;
  const scheduledAt = row.scheduledPublishAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
  const expectedFilename = ytBuildExpectedFilename({
    prefix: plan.ytChannelPrefix!,
    date: scheduledAt,
    type: "short",
    slot: row.ord,
    ext: "mp4",
  });

  const dropDir = process.env.YT_DRIVE_DROP_DIR;
  if (dropDir) {
    try {
      const target = path.join(dropDir, plan.ytChannelPrefix!);
      await fs.mkdir(target, { recursive: true });
      await fs.copyFile(videoAbs, path.join(target, expectedFilename));
      // Shorts: no thumbnail copied — YouTube auto-generates from first frame.
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
