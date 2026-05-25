import { mkdir, writeFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { env, prisma, logger } from "@ca/shared";
import { generateImage, tts } from "@ca/providers";
import { bumpCost } from "./util.js";

// Animated webinar pipeline:
//   1. Split the script into sections by markdown H2.
//   2. Generate one slide image per section via gpt-image-1 (1920x1080).
//   3. Generate one ElevenLabs voiceover per section, capture duration.
//   4. ffmpeg concat → single mp4 in the assets dir.
// Output path returned for handoff to YT pipeline.

export interface AnimateJobData {
  contentItemId: string;
  script: string;
  title: string;
}

interface Section {
  heading: string;
  body: string;
}

export async function runAnimate(data: AnimateJobData): Promise<{ videoPath: string }> {
  const item = await prisma.contentItem.findUniqueOrThrow({
    where: { id: data.contentItemId },
    include: { business: true },
  });
  const sections = splitSections(data.script);
  if (sections.length === 0) throw new Error("animate: script has no parsable sections");

  const work = join(env().TMP_DIR, `animate-${data.contentItemId}-${randomUUID().slice(0, 8)}`);
  await mkdir(work, { recursive: true });

  // 1. Slides + 2. voice (parallel per section)
  const parts = await Promise.all(
    sections.map(async (s, i) => {
      const slide = await generateImage({
        prompt: slidePrompt(s, data.title),
        size: "1536x1024",
        quality: "medium",
        businessSlug: item.business.slug,
        filenameHint: `webinar-${data.contentItemId}-slide-${i + 1}`,
      });
      await bumpCost(data.contentItemId, slide.costUsd);

      const voice = await tts({
        text: s.body || s.heading,
        businessSlug: item.business.slug,
      });
      await bumpCost(data.contentItemId, voice.costUsd);

      // Record assets for cost/transparency in the UI.
      await prisma.asset.createMany({
        data: [
          { businessId: item.businessId, contentItemId: data.contentItemId, kind: "image", path: slide.relPath, provider: "openai_image", costUsd: slide.costUsd, prompt: slidePrompt(s, data.title) },
          { businessId: item.businessId, contentItemId: data.contentItemId, kind: "voice", path: voice.relPath, provider: "elevenlabs", costUsd: voice.costUsd },
        ],
      });

      return {
        slidePath: slide.path,
        voicePath: voice.path,
        durationSeconds: voice.durationSecondsEstimate,
      };
    }),
  );

  // 3. ffmpeg: build a concat file with one segment per (slide, voice) pair.
  // Each segment uses -loop 1 -t <duration> over the slide image with the voice.
  const segmentPaths: string[] = [];
  for (const [i, p] of parts.entries()) {
    const segPath = join(work, `seg-${i}.mp4`);
    await ffmpegRun([
      "-y",
      "-loop", "1",
      "-i", p.slidePath,
      "-i", p.voicePath,
      "-t", String(Math.max(2, p.durationSeconds)),
      "-c:v", "libx264",
      "-tune", "stillimage",
      "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p",
      "-r", "30",
      "-c:a", "aac",
      "-b:a", "128k",
      "-shortest",
      segPath,
    ]);
    segmentPaths.push(segPath);
  }

  // 4. Concat
  const concatList = join(work, "concat.txt");
  await writeFile(concatList, segmentPaths.map((p) => `file '${p}'`).join("\n"));
  const outRel = join(item.business.slug, "video", `webinar-${data.contentItemId}.mp4`);
  const outAbs = join(env().ASSETS_DIR, outRel);
  await mkdir(join(env().ASSETS_DIR, item.business.slug, "video"), { recursive: true });

  await ffmpegRun([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatList,
    "-c", "copy",
    outAbs,
  ]);

  // 5. Cleanup intermediates (best-effort)
  for (const p of segmentPaths) await unlink(p).catch(() => {});
  await unlink(concatList).catch(() => {});

  logger.info({ contentItemId: data.contentItemId, outAbs, sections: sections.length }, "animate.done");
  return { videoPath: outAbs };
}

function slidePrompt(s: Section, title: string): string {
  return `Clean editorial slide for a webinar titled "${title}". Section: "${s.heading}". Style: minimalist, high contrast, modern B2B SaaS, large readable headline only, no body text, soft gradient background. No watermarks, no logos.`;
}

function splitSections(md: string): Section[] {
  const lines = md.split(/\r?\n/);
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const ln of lines) {
    const m = /^##\s+(.+)$/.exec(ln);
    if (m) {
      if (cur) out.push(cur);
      cur = { heading: m[1]!.trim(), body: "" };
    } else if (cur) {
      cur.body += (cur.body ? " " : "") + ln.trim();
    }
  }
  if (cur) out.push(cur);
  return out.filter((s) => s.heading || s.body);
}

function ffmpegRun(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += String(d); });
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
    p.on("error", reject);
  });
}
