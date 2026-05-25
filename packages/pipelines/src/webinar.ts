import { prisma, Prompts, logger, queue, QUEUES, type Prisma } from "@ca/shared";
import { claude, tts, startAvatarRender, pollAvatarRender, planItem, generateImage } from "@ca/providers";
import { bumpCost, loadBrandContext, makeSlug, setStatus } from "./util.js";
import { routeApproval } from "./route.js";

// Webinar pipeline modes:
//   self_record  — system creates a YT plan item with a fixed filename; user
//                  drops the recording into Drive; YT app finishes the job.
//   avatar       — ElevenLabs voice → HeyGen avatar render → async poll →
//                  handoff to YT.
//   animated     — slide images (gpt-image-1) + ElevenLabs narration; ffmpeg
//                  stitches → handoff to YT.

interface TitleOption { title: string; angle: string }

// ── Step 1: propose titles (paused for human pick) ────────────────────────
export async function runWebinarTitlesStep(contentItemId: string): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  const { brandBlock } = await loadBrandContext(item.businessId);
  const meta = (item.meta ?? {}) as { theme?: string };
  const theme = meta.theme ?? item.title ?? "core brand topics";

  const res = await claude<{ options: TitleOption[] }>({
    model: "writing",
    json: true,
    maxTokens: 1024,
    system: Prompts.WEBINAR_TITLES_SYSTEM,
    user: Prompts.webinarTitlesUser(brandBlock, theme),
  });
  await bumpCost(contentItemId, res.costUsd);

  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: {
      meta: {
        ...meta,
        titleOptions: (res.json?.options ?? []) as unknown as Prisma.InputJsonValue,
      } as Prisma.InputJsonValue,
      status: "review",
    },
  });
  // Halts in `review` — dashboard prompts user to pick mode + title.
}

// ── Step 2: write script and start producing (mode-aware, non-blocking) ──
export async function runWebinarScriptAndProduce(contentItemId: string): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  const intent = await prisma.webinarIntent.findUnique({ where: { contentItemId } });
  if (!intent) throw new Error("webinar: WebinarIntent missing — pick a mode in the dashboard");
  const { business, brandBlock } = await loadBrandContext(item.businessId);
  const meta = (item.meta ?? {}) as { selectedOption?: TitleOption };
  const opt = meta.selectedOption;
  if (!opt) throw new Error("webinar: selected title/angle missing");

  await setStatus(contentItemId, "drafting");
  const script = await claude<string>({
    model: "writing",
    maxTokens: 6000,
    system: Prompts.WEBINAR_SCRIPT_SYSTEM,
    user: Prompts.webinarScriptUser(brandBlock, opt.title, opt.angle),
  });
  await bumpCost(contentItemId, script.costUsd);
  await prisma.contentItem.update({
    where: { id: contentItemId },
    data: { title: opt.title, slug: makeSlug(opt.title), bodyMd: script.text },
  });
  await prisma.webinarIntent.update({
    where: { contentItemId },
    data: { scriptMd: script.text },
  });

  await setStatus(contentItemId, "generating_media");

  switch (intent.mode) {
    case "self_record":
      await handoffToYt({ contentItemId, scriptTitle: opt.title, scriptBody: script.text });
      await setStatus(contentItemId, "self_critique");
      await routeApproval(contentItemId);
      return;

    case "avatar": {
      const voice = await tts({ text: stripCues(script.text), businessSlug: business.slug });
      await prisma.asset.create({
        data: { businessId: item.businessId, contentItemId, kind: "voice", path: voice.relPath, provider: "elevenlabs", costUsd: voice.costUsd },
      });
      await bumpCost(contentItemId, voice.costUsd);

      const start = await startAvatarRender({ script: stripCues(script.text) });
      // Hand off to the async poller — no in-process waiting.
      await queue(QUEUES.heygen_poll).add(
        `heygen:${contentItemId}`,
        { contentItemId, videoId: start.videoId, attempt: 0 },
        { delay: 30_000 },
      );
      return; // pipeline resumes when poller calls onAvatarReady().
    }

    case "animated": {
      // Enqueue the ffmpeg stitcher — keeps the worker free while the slides
      // and per-section voice files generate.
      await queue(QUEUES.animate).add(
        `animate:${contentItemId}`,
        { contentItemId, script: script.text, title: opt.title },
      );
      return;
    }
  }
}

// ── Called by the heygen_poll worker when render completes ───────────────
export async function onAvatarReady(args: { contentItemId: string; videoUrl: string; durationSeconds: number; costUsd: number }): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: args.contentItemId } });
  await prisma.asset.create({
    data: {
      businessId: item.businessId,
      contentItemId: args.contentItemId,
      kind: "video",
      path: args.videoUrl,
      provider: "heygen",
      costUsd: args.costUsd,
      meta: { durationSeconds: args.durationSeconds } as object,
    },
  });
  await bumpCost(args.contentItemId, args.costUsd);
  await handoffToYt({
    contentItemId: args.contentItemId,
    scriptTitle: item.title,
    scriptBody: item.bodyMd,
  });
  await setStatus(args.contentItemId, "self_critique");
  await routeApproval(args.contentItemId);
}

// ── Called by the animate worker when ffmpeg finishes ────────────────────
export async function onAnimatedReady(args: { contentItemId: string; videoPath: string }): Promise<void> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: args.contentItemId } });
  await prisma.asset.create({
    data: {
      businessId: item.businessId,
      contentItemId: args.contentItemId,
      kind: "video",
      path: args.videoPath,
      provider: "local_ffmpeg",
      costUsd: 0,
    },
  });
  await handoffToYt({
    contentItemId: args.contentItemId,
    scriptTitle: item.title,
    scriptBody: item.bodyMd,
  });
  await setStatus(args.contentItemId, "self_critique");
  await routeApproval(args.contentItemId);
}

// Re-export the polling helper from the providers layer so workers can call it
// directly without importing two packages.
export { pollAvatarRender, generateImage };

function stripCues(md: string): string {
  return md
    .replace(/^##.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function handoffToYt(args: { contentItemId: string; scriptTitle: string; scriptBody: string }) {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: args.contentItemId } });
  const meta = (item.meta ?? {}) as { ytChannel?: "OAP" | "OAG" | "NUR"; ytScheduledAt?: string };
  const channel = meta.ytChannel ?? "OAP";
  const scheduledAt = meta.ytScheduledAt ? new Date(meta.ytScheduledAt) : new Date(Date.now() + 24 * 3600_000);
  const filename = buildYtFilename({ channel, scheduledAt, type: "long" });
  try {
    const res = await planItem({
      channel,
      type: "long",
      scheduledPublishAt: scheduledAt,
      title: args.scriptTitle,
      description: args.scriptBody.slice(0, 4500),
      filename,
      sourceRef: args.contentItemId,
    });
    await prisma.webinarIntent.update({
      where: { contentItemId: args.contentItemId },
      data: { ytItemId: res.itemId, driveFilename: filename },
    });
  } catch (err) {
    logger.error({ err }, "webinar.handoff_failed — leaving in review with filename only");
    await prisma.webinarIntent.update({
      where: { contentItemId: args.contentItemId },
      data: { driveFilename: filename },
    });
  }
}

function buildYtFilename(args: { channel: "OAP" | "OAG" | "NUR"; scheduledAt: Date; type: "long" | "short" }): string {
  const d = args.scheduledAt;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const wn = Math.floor((d.getUTCDate() - 1) / 7) + 1;
  return `${args.channel}_${year}-${month}-W${wn}_${args.type}_1.mp4`;
}
