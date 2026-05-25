// Worker process. Spins up one BullMQ consumer per logical queue.
// All long-running work happens here — Next.js routes only enqueue.

import { QUEUES, logger, spawnWorker, env, queue } from "@ca/shared";
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
} from "@ca/pipelines";
import { runDigestNow } from "./digest.js";

logger.info({ concurrency: env().WORKER_CONCURRENCY }, "worker.boot");

// ── Research (per-business topic gathering) ──────────────────────────────
spawnWorker(QUEUES.research, async (job) => {
  const { businessId } = job.data as { businessId: string };
  return runResearchForBusiness(businessId);
}, { concurrency: 2 });

// ── Pipeline kickoffs (one entry per content type) ───────────────────────
spawnWorker(QUEUES.draft, async (job) => {
  const { contentItemId, type, sub } = job.data as { contentItemId: string; type: string; sub?: string };
  switch (type) {
    case "blog":         return runBlogPipeline(contentItemId);
    case "social_post":  return runSocialPipeline(contentItemId);
    case "case_study":   return runCaseStudyPipeline(contentItemId);
    case "resource":     return runResourcePipeline(contentItemId);
    case "landing_page": return runLandingPagePipeline(contentItemId);
    case "webinar":
      if (sub === "titles") return runWebinarTitlesStep(contentItemId);
      return runWebinarScriptAndProduce(contentItemId);
    default:
      throw new Error(`draft: unknown type ${type}`);
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

logger.info("worker.ready");

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT",  () => process.exit(0));
