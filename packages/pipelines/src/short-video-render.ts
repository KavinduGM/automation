import { prisma, env, logger, queue, QUEUES, isShortVideoDisabled } from "@ca/shared";

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

export async function runShortVideoRender(
  scriptId: string,
  opts: { testMode?: boolean } = {},
): Promise<void> {
  if (isShortVideoDisabled()) {
    logger.info({ scriptId }, "shortvideo.render.killed_by_env");
    // Mark the row so the dashboard surfaces the reason instead of leaving
    // it stuck in "approved" forever.
    await prisma.shortVideoScript.updateMany({
      where: { id: scriptId, status: { in: ["approved", "rendering"] } },
      data: {
        status: "failed",
        reviewNotes:
          "Render aborted: SHORTVIDEO_DISABLED env var is set (safety lock). Unset it in Dokploy and redeploy to re-enable, or wait for the renderer migration.",
      },
    });
    return;
  }
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
  // Test mode bypasses the window entirely so admins can verify the
  // pipeline end-to-end during business hours.
  const plan = await prisma.shortVideoPlan.findUnique({ where: { businessId: row.businessId } });
  if (plan && !opts.testMode) {
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

  // The script JSON stored on the row carries our internal _meta field
  // (title/description/hashtags/etc.) which the renderer's strict YAML
  // parser would reject as an unknown top-level key. Strip it before
  // sending — the renderer only needs the actual spec fields.
  const cleanSpec = stripMeta(row.script);

  let res: Response;
  try {
    res = await fetch(`${RENDERER_URL}/render`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.RENDERER_AUTH_TOKEN ? { "X-Renderer-Token": process.env.RENDERER_AUTH_TOKEN } : {}),
      },
      body: JSON.stringify({
        spec: cleanSpec,
        voiceId,
        outputDir: outputRel,
        visualReviewMaxAttempts: 2,
      }),
    });
  } catch (err) {
    // The bare Node fetch error is "fetch failed" — completely opaque.
    // Wrap with the URL we tried + a hint so the dashboard error message
    // is actually useful.
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    const code = cause?.code ?? "";
    const msg =
      `Could not reach video-renderer at ${RENDERER_URL}/render — ${(err as Error).message}` +
      (code ? ` (cause: ${code})` : "") +
      `. Check that the video-renderer container is running (Dokploy → services → video-renderer → Logs).` +
      ` If RENDERER_AUTH_TOKEN is set, make sure both worker and video-renderer have the same value.`;
    throw new Error(msg);
  }
  try {
    const json = (await res.json()) as RenderResponse;
    if (!res.ok || !json.ok || !json.videoPath) {
      throw new Error(json.error ?? `renderer returned HTTP ${res.status}`);
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

    // Auto-enqueue publish — propagate testMode so the publish step uses
    // unlisted privacy + no schedule.
    await queue(QUEUES.shortvideo_publish).add(
      `publish:${scriptId}${opts.testMode ? ":test" : ""}`,
      { scriptId, testMode: opts.testMode === true },
    );
    logger.info({ scriptId, duration: json.totalDurationSeconds }, "shortvideo.render.done");
  } catch (err) {
    logger.error({ err, scriptId }, "shortvideo.render.failed");
    await prisma.shortVideoScript.update({
      where: { id: scriptId },
      data: { status: "failed", reviewNotes: (err as Error).message ?? String(err) },
    });
  }
}

// Drop the internal `_meta` field (title/description/hashtags/tags/
// suggestedSlotIdx) from the spec so the renderer's strict allowlist
// parser doesn't reject the whole payload. `_meta` is for the publish
// step, not the render step.
function stripMeta(script: unknown): unknown {
  if (!script || typeof script !== "object") return script;
  // Shallow strip — _meta lives at the top level, not inside scenes.
  const { _meta: _drop, ...rest } = script as Record<string, unknown>;
  void _drop;
  return rest;
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
