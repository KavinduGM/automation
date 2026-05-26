import OpenAI from "openai";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { env, imageCost, logger } from "@ca/shared";

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (_client) return _client;
  const key = env().OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  _client = new OpenAI({ apiKey: key });
  return _client;
}

export interface GenerateImageInput {
  prompt: string;
  size?: "1024x1024" | "1536x1024" | "1024x1536" | "auto";
  quality?: "low" | "medium" | "high";
  businessSlug: string;
  filenameHint?: string;
}

export interface GenerateImageResult {
  path: string;     // absolute on disk
  relPath: string;  // relative to ASSETS_DIR (what client sites serve)
  costUsd: number;
}

export async function generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
  const quality = input.quality ?? "medium";
  // The OpenAI SDK v4.71 types `quality` as "standard" | "hd" (dall-e-3),
  // but the gpt-image-1 model accepts "low" | "medium" | "high" at runtime.
  // gpt-image-1 returns b64_json by default.
  const res = await client().images.generate({
    model: env().OPENAI_IMAGE_MODEL,
    prompt: input.prompt,
    size: input.size ?? "1536x1024",
    quality: quality as unknown as never,
    n: 1,
  });

  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error("openai-image: empty response");

  const fname = `${input.filenameHint ?? randomUUID()}.png`;
  const rel = join(input.businessSlug, "image", fname);
  const abs = join(env().ASSETS_DIR, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, Buffer.from(b64, "base64"));

  const costUsd = imageCost(quality, 1);
  logger.info({ quality, costUsd, rel }, "openai-image.generated");
  return { path: abs, relPath: rel, costUsd };
}
