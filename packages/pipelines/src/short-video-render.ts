import { prisma, env, logger, queue, QUEUES } from "@ca/shared";

// Calls the video-renderer Docker service over HTTP. On success, stores
// the returned video path + thumbnail on the ShortVideoScript row and
// enqueues the publish step.
//
// Rate limiting: this worker has concurrency=1 set at the worker level.
// Additionally, the function checks the business plan's render window
// (default 02:00-08:00 UTC) and re-delays the job into the next window
// if we're outside it — that keeps daytime CPU on the main VPS free.

interface RenderResponse {
  ok: boolean;
  videoPath?: string;          // relative to ASSETS_DIR
  thumbnailPath?: string | null;  // always null for shorts — YouTube auto-generates from first frame
  totalDurationSeconds?: number;
  costUsdBreakdown?: { tts: number; claudeHtml: number; visualReview: number; total: number };
  sceneNotes?: string[];
  error?: string;
}

const RENDERER_URL = process.env.VIDEO_RENDERER_URL ?? "http://video-renderer:4100";

export async function runShortVideoRender(scriptId: string): Promise<void> {
  const row = await prisma.shortVideoScript.findUnique({ where: { id: scriptId } });
  if (!row) {
    logger.warn({ scriptId }, "shortvideo.render.row_missing");
    return;
  }
  if (row.status !== "approved" && row.status !== "rendering") {
    logger.info({ scriptId, status: row.status }, "shortvideo.render.skipped_not_approved");
    return;
  }

  // Off-hours window check. If we're outside it, requeue with a delay until
  // the next window start so the job sleeps quietly in BullMQ.
  const plan = await prisma.shortVideoPlan.findUnique({ where: { businessId: row.businessId } });
  if (plan) {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const inWindow =
      plan.renderWindowStartHourUtc <= plan.renderWindowEndHourUtc
        ? utcHour >= plan.renderWindowStartHourUtc && utcHour < plan.renderWindowEndHourUtc
        : utcHour >= plan.renderWindowStartHourUtc || utcHour < plan.renderWindowEndHourUtc;
    if (!inWindow) {
      const delayMs = msUntilHourUtc(plan.renderWindowStartHourUtc);
      await queue(QUEUES.shortvideo_render).add(
        `render:${scriptId}:deferred`,
        { scriptId },
        { delay: delayMs, removeOnComplete: 500, removeOnFail: 100 },
      );
      logger.info(
        { scriptId, delayMinutes: Math.round(delayMs / 60_000), windowStartUtc: plan.renderWindowStartHourUtc },
        "shortvideo.render.deferred_to_window",
      );
      return;
    }
  }

  await prisma.shortVideoScript.update({
    where: { id: scriptId },
    data: { status: "rendering", reviewNotes: "" },
  });

  // Where the renderer writes the MP4 + thumbnail (inside ASSETS_DIR so
  // both services see it through the shared volume).
  const outputRel = `short-videos/${scriptId}`;
  const voiceId = plan?.voiceId ?? env().ELEVENLABS_DEFAULT_VOICE_ID ?? "";
  if (!voiceId) {
    await prisma.shortVideoScript.update({
      where: { id: scriptId },
      data: { status: "failed", reviewNotes: "No ElevenLabs voice configured on the business plan" },
    });
    return;
  }

  try {
    const res = await fetch(`${RENDERER_URL}/render`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.RENDERER_AUTH_TOKEN ? { "X-Renderer-Token": process.env.RENDERER_AUTH_TOKEN } : {}),
      },
      body: JSON.stringify({
        spec: row.script,
        voiceId,
        outputDir: outputRel,
        visualReviewMaxAttempts: 2,
      }),
    });

    const json = (await res.json()) as RenderResponse;
    if (!res.ok || !json.ok || !json.videoPath) {
      throw new Error(json.error ?? `renderer returned ${res.status}`);
    }

    await prisma.shortVideoScript.update({
      where: { id: scriptId },
      data: {
        status: "rendered",
        videoPath: json.videoPath,
        thumbnailPath: null,            // shorts: no custom thumbnail (YouTube uses first frame)
        costUsd: { increment: json.costUsdBreakdown?.total ?? 0 },
        reviewNotes:
          (json.sceneNotes ?? []).length > 0
            ? `Rendered with notes:\n${(json.sceneNotes ?? []).join("\n")}`
            : "",
      },
    });

    // Auto-enqueue publish.
    await queue(QUEUES.shortvideo_publish).add(`publish:${scriptId}`, { scriptId });
    logger.info({ scriptId, duration: json.totalDurationSeconds }, "shortvideo.render.done");
  } catch (err) {
    logger.error({ err, scriptId }, "shortvideo.render.failed");
    await prisma.shortVideoScript.update({
      where: { id: scriptId },
      data: { status: "failed", reviewNotes: (err as Error).message ?? String(err) },
    });
  }
}

// Milliseconds until the next occurrence of HH:00 UTC.
function msUntilHourUtc(hourUtc: number): number {
  const now = new Date();
  const target = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hourUtc,
    0,
    0,
  ));
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - now.getTime();
}
