import { env, logger } from "@ca/shared";

// Buffer Publish API v1. The free tier supports 3 channels — your case:
// LinkedIn, X, Instagram. Caller supplies the per-channel profile_id.

const BASE = "https://api.bufferapp.com/1";

export interface SchedulePostInput {
  profileIds: string[];   // Buffer profile IDs (per channel)
  text: string;
  imagePath?: string;     // absolute path on disk
  imageUrl?: string;      // OR public URL
  scheduledAt: Date;
}

export interface SchedulePostResult {
  updateIds: string[];
  raw: unknown;
}

function token(): string {
  const t = env().BUFFER_ACCESS_TOKEN;
  if (!t) throw new Error("BUFFER_ACCESS_TOKEN not set");
  return t;
}

export async function schedulePost(input: SchedulePostInput): Promise<SchedulePostResult> {
  const body = new URLSearchParams();
  for (const id of input.profileIds) body.append("profile_ids[]", id);
  body.set("text", input.text);
  body.set("scheduled_at", String(Math.floor(input.scheduledAt.getTime() / 1000)));
  if (input.imageUrl) body.set("media[link]", input.imageUrl);

  const res = await fetch(`${BASE}/updates/create.json?access_token=${encodeURIComponent(token())}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`buffer.schedule ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as {
    success?: boolean;
    updates?: Array<{ id: string }>;
  };
  if (!json.success) throw new Error(`buffer.schedule: ${JSON.stringify(json).slice(0, 200)}`);
  const updateIds = (json.updates ?? []).map((u) => u.id);
  logger.info({ updateIds }, "buffer.scheduled");
  return { updateIds, raw: json };
}
