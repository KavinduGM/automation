// Worker process. Spins up one BullMQ consumer per logical queue.
// All long-running work happens here — Next.js routes only enqueue.

import { QUEUES, logger, spawnWorker, env, queue, prisma } from "@ca/shared";
import {
  runBlogPipeline,
  runSocialPipeline,
  runCaseStudyPipeline,
  runResourcePipeline,
  runLandingPagePipeline,
  runWebinarScriptAndProduce,
  runWebinarTitlesStep,
  runResearchForBusiness,
  publishContentItem,
  runAnimate,
  onAnimatedReady,
  onAvatarReady,
  pollAvatarRender,
  runPostReview,
  runShortScriptsFromBlog,
  runShortVideoRender,
  runShortVideoPublish,
} from "@ca/pipelines";
import { runDigestNow } from "./digest.js";

// When a pipeline throws, BullMQ logs the failure but the ContentItem stays
// frozen in whatever status it was in (often `researching` or `drafting`),
// making the dashboard misleading. This wrapper updates the row so reviewers
// see what actually went wrong.
async function markItemFailed(contentItemId: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    await prisma.contentItem.update({
      where: { id: contentItemId },
      data: { status: "failed", reviewNotes: msg.slice(0, 4000) },
    });
  } catch (updateErr) {
    logger.error({ updateErr, contentItemId }, "worker.mark_failed_update_failed");
  }
}

logger.info({ concurrency: env().WORKER_CONCURRENCY }, "worker.boot");

// ── Research (per-business topic gathering) ──────────────────────────────
spawnWorker(QUEUES.research, async (job) => {
  const { businessId } = job.data as { businessId: string };
  return runResearchForBusiness(businessId);
}, { concurrency: 2 });

// ── Pipeline kickoffs (one entry per content type) ───────────────────────
spawnWorker(QUEUES.draft, async (job) => {
  const { contentItemId, type, sub } = job.data as { contentItemId: string; type: string; sub?: string };
  try {
    switch (type) {
      case "blog":         return await runBlogPipeline(contentItemId);
      case "social_post":  return await runSocialPipeline(contentItemId);
      case "case_study":   return await runCaseStudyPipeline(contentItemId);
      case "resource":     return await runResourcePipeline(contentItemId);
      case "landing_page": return await runLandingPagePipeline(contentItemId);
      case "webinar":
        if (sub === "titles") return await runWebinarTitlesStep(contentItemId);
        return await runWebinarScriptAndProduce(contentItemId);
      default:
        throw new Error(`draft: unknown type ${type}`);
    }
  } catch (err) {
    logger.error({ err, contentItemId, type }, "worker.draft_failed");
    await markItemFailed(contentItemId, err);
    throw err; // let BullMQ record the job as failed (with retries)
  }
});

// ── Publish (materializes approved items into typed published tables) ────
spawnWorker(QUEUES.publish, async (job) => {
  const { contentItemId } = job.data as { contentItemId: string };
  return publishContentItem(contentItemId);
});

// ── Digest emails ────────────────────────────────────────────────────────
spawnWorker(QUEUES.digest, async () => runDigestNow());

// ── HeyGen async polling ─────────────────────────────────────────────────
// Re-enqueues itself with backoff while the render is still processing.
const HEYGEN_MAX_ATTEMPTS = 80;       // 80 × 30s = ~40 min ceiling
const HEYGEN_DELAY_MS     = 30_000;

spawnWorker(QUEUES.heygen_poll, async (job) => {
  const { contentItemId, videoId, attempt } = job.data as { contentItemId: string; videoId: string; attempt: number };
  const status = await pollAvatarRender(videoId);
  if (status.status === "completed" && status.videoUrl) {
    await onAvatarReady({
      contentItemId,
      videoUrl: status.videoUrl,
      durationSeconds: status.durationSeconds ?? 0,
      costUsd: status.costUsd,
    });
    return { done: true };
  }
  if (status.status === "failed") {
    throw new Error(`HeyGen render ${videoId} failed`);
  }
  if (attempt >= HEYGEN_MAX_ATTEMPTS) {
    throw new Error(`HeyGen render ${videoId} timed out after ${attempt} polls`);
  }
  await queue(QUEUES.heygen_poll).add(
    `heygen:${contentItemId}`,
    { contentItemId, videoId, attempt: attempt + 1 },
    { delay: HEYGEN_DELAY_MS },
  );
  return { stillProcessing: true, attempt };
}, { concurrency: 4 });

// ── Animated webinar stitcher ────────────────────────────────────────────
spawnWorker(QUEUES.animate, async (job) => {
  const data = job.data as { contentItemId: string; script: string; title: string };
  const res = await runAnimate(data);
  await onAnimatedReady({ contentItemId: data.contentItemId, videoPath: res.videoPath });
  return res;
}, { concurrency: 1 }); // ffmpeg is CPU-bound; one at a time on KVM 2

// ── Post-publish live-page review ────────────────────────────────────────
// Runs ~90s after publish (delay is set by the enqueuer). Fetches the live
// URL, checks images/links/CTAs/markers, and auto-rolls back critical fails.
spawnWorker(QUEUES.post_review, async (job) => {
  const data = job.data as { contentItemId: string; publicUrl: string };
  return runPostReview(data);
}, { concurrency: 2 });

// ── Short-form video pipeline ────────────────────────────────────────────
// Three queues:
//   1. shortvideo_scripts — generate 5 scripts from a published blog
//   2. shortvideo_render — call the renderer service (off-hours only,
//      concurrency 1 to keep CPU + RAM headroom for the web stack)
//   3. shortvideo_publish — upload to Drive + register with YT Automation

spawnWorker(QUEUES.shortvideo_scripts, async (job) => {
  const { contentItemId } = job.data as { contentItemId: string };
  return runShortScriptsFromBlog(contentItemId);
}, { concurrency: 1 });

spawnWorker(QUEUES.shortvideo_render, async (job) => {
  const { scriptId } = job.data as { scriptId: string };
  return runShortVideoRender(scriptId);
}, { concurrency: 1 });

spawnWorker(QUEUES.shortvideo_publish, async (job) => {
  const { scriptId } = job.data as { scriptId: string };
  return runShortVideoPublish(scriptId);
}, { concurrency: 1 });

logger.info("worker.ready");

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT",  () => process.exit(0));
