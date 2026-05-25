import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { env, voiceCost, logger } from "@ca/shared";

// Hand-rolled REST call — keeps the dependency surface small. ElevenLabs v1.
export interface TtsInput {
  text: string;
  voiceId?: string;
  businessSlug: string;
  modelId?: string;
}

export interface TtsResult {
  path: string;
  relPath: string;
  costUsd: number;
  durationSecondsEstimate: number;
}

export async function tts(input: TtsInput): Promise<TtsResult> {
  const key = env().ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  const voiceId = input.voiceId ?? env().ELEVENLABS_DEFAULT_VOICE_ID;
  if (!voiceId) throw new Error("ELEVENLABS voice id missing");

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": key,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: input.text,
      model_id: input.modelId ?? "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`elevenlabs.tts ${res.status}: ${body.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const fname = `${randomUUID()}.mp3`;
  const rel = join(input.businessSlug, "voice", fname);
  const abs = join(env().ASSETS_DIR, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, buf);

  const costUsd = voiceCost(input.text.length);
  // Rough: 14 chars/sec at normal pace.
  const durationSecondsEstimate = Math.ceil(input.text.length / 14);
  logger.info({ costUsd, chars: input.text.length, rel }, "elevenlabs.tts");
  return { path: abs, relPath: rel, costUsd, durationSecondsEstimate };
}
