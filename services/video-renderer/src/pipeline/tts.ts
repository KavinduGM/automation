// ElevenLabs TTS — replaces the custom voice-clone server tts.ts from the
// AI Video Creator desktop tool. Same call shape, different backend.

import fs from 'node:fs'
import path from 'node:path'

export interface ElevenLabsTtsArgs {
  apiKey: string
  voiceId: string
  modelId?: string                  // default: eleven_flash_v2_5 (cheap + fast)
  text: string
  outAudioPath: string              // absolute path to write the MP3 to
  speed?: number                    // 0.5-2.0; default 1.0
}

export interface ElevenLabsTtsResult {
  audioPath: string
  durationSeconds: number
  costUsd: number
  charCount: number
}

const FLASH_PRICE_PER_1K_CHARS = 0.075   // ~$0.075/1k chars for Flash v2.5 starter
const MULTILINGUAL_PRICE_PER_1K_CHARS = 0.30

export async function generateAudio(args: ElevenLabsTtsArgs): Promise<ElevenLabsTtsResult> {
  if (!args.apiKey) throw new Error('ELEVENLABS_API_KEY missing')
  if (!args.voiceId) throw new Error('ElevenLabs voiceId missing')
  if (!args.text || args.text.trim().length === 0) throw new Error('text is empty')

  const model = args.modelId ?? 'eleven_flash_v2_5'
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(args.voiceId)}`

  const body: Record<string, unknown> = {
    text: args.text,
    model_id: model,
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.8,
      style: 0.0,
      use_speaker_boost: true,
    },
  }
  if (args.speed && args.speed !== 1.0) {
    // ElevenLabs doesn't natively expose speed on TTS endpoint; we'd post-process
    // with ffmpeg `atempo` filter elsewhere. Stash on the result so the runner
    // can apply it if needed.
    (body as { speaking_rate?: number }).speaking_rate = args.speed
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': args.apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`elevenlabs ${res.status}: ${errBody.slice(0, 300)}`)
  }

  const buf = Buffer.from(await res.arrayBuffer())
  await fs.promises.mkdir(path.dirname(args.outAudioPath), { recursive: true })
  await fs.promises.writeFile(args.outAudioPath, buf)

  const chars = args.text.length
  const pricePer1k = model.startsWith('eleven_flash') ? FLASH_PRICE_PER_1K_CHARS : MULTILINGUAL_PRICE_PER_1K_CHARS
  const costUsd = (chars / 1000) * pricePer1k

  // Rough duration estimate: 14 chars/sec at normal pace. The runner
  // probes the actual audio file with ffprobe afterwards for accuracy.
  const durationSeconds = Math.max(1, Math.round(chars / 14))

  return {
    audioPath: args.outAudioPath,
    durationSeconds,
    costUsd,
    charCount: chars,
  }
}
