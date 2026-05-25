import { env, videoCost, logger } from "@ca/shared";

// HeyGen v2 video.generate API. Returns a video_id; we poll for status.
// Caller is responsible for downloading the rendered file to ASSETS_DIR.

export interface AvatarRenderInput {
  script: string;
  avatarId?: string;
  voiceId?: string;
  background?: string; // hex or asset ID
}

export interface AvatarRenderResult {
  videoId: string;
  status: "processing" | "completed" | "failed";
  videoUrl?: string;
  costUsd: number; // estimate; HeyGen bills by credits, not minutes
  durationSeconds?: number;
}

const BASE = "https://api.heygen.com";

function key(): string {
  const k = env().HEYGEN_API_KEY;
  if (!k) throw new Error("HEYGEN_API_KEY is not set");
  return k;
}

export async function startAvatarRender(input: AvatarRenderInput): Promise<{ videoId: string }> {
  const avatarId = input.avatarId ?? env().HEYGEN_DEFAULT_AVATAR_ID;
  const voiceId = input.voiceId ?? env().HEYGEN_DEFAULT_VOICE_ID;
  if (!avatarId || !voiceId) throw new Error("HeyGen avatar/voice id missing");

  const res = await fetch(`${BASE}/v2/video/generate`, {
    method: "POST",
    headers: { "X-Api-Key": key(), "Content-Type": "application/json" },
    body: JSON.stringify({
      video_inputs: [
        {
          character: { type: "avatar", avatar_id: avatarId, avatar_style: "normal" },
          voice:     { type: "text", input_text: input.script, voice_id: voiceId },
          background: input.background
            ? { type: "color", value: input.background }
            : { type: "color", value: "#ffffff" },
        },
      ],
      dimension: { width: 1920, height: 1080 },
    }),
  });
  if (!res.ok) throw new Error(`heygen.generate ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data?: { video_id?: string } };
  const videoId = json.data?.video_id;
  if (!videoId) throw new Error("heygen.generate: missing video_id");
  logger.info({ videoId }, "heygen.started");
  return { videoId };
}

export async function pollAvatarRender(videoId: string): Promise<AvatarRenderResult> {
  const res = await fetch(`${BASE}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, {
    headers: { "X-Api-Key": key() },
  });
  if (!res.ok) throw new Error(`heygen.status ${res.status}`);
  const json = (await res.json()) as {
    data?: { status?: string; video_url?: string; duration?: number };
  };
  const status = (json.data?.status ?? "processing") as AvatarRenderResult["status"];
  const duration = json.data?.duration ?? 0;
  return {
    videoId,
    status,
    videoUrl: json.data?.video_url,
    costUsd: videoCost(duration),
    durationSeconds: duration,
  };
}
