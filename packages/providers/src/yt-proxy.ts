import { env, logger } from "@ca/shared";

// Thin client for the user's existing YouTube Automation project (Fastify API
// at apps/api). The new automation system creates a planned "item" there;
// the YT project then handles drive-match, approval and the upload itself.
//
// NOTE: the YT API currently uses session cookies for browser auth. We assume
// a single bearer token will be added on its side (a one-line middleware) so
// service-to-service calls work cleanly. The token is YT_AUTOMATION_API_TOKEN.

export interface YtPlanItemInput {
  channel: "OAP" | "OAG" | "NUR";
  type: "long" | "short";
  scheduledPublishAt: Date;   // NY time conversion handled inside YT app
  title: string;
  description: string;
  tags?: string[];
  filename: string;           // expected Drive filename per YT's convention
  thumbnailFilename?: string;
  source?: "automation";
  sourceRef?: string;          // ContentItem.id, for traceability
}

export interface YtPlanItemResult {
  itemId: string;
}

function base(): string {
  const url = env().YT_AUTOMATION_API_URL;
  if (!url) throw new Error("YT_AUTOMATION_API_URL not set");
  return url.replace(/\/$/, "");
}

function headers(): Record<string, string> {
  const t = env().YT_AUTOMATION_API_TOKEN;
  return {
    "Content-Type": "application/json",
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  };
}

export async function planItem(input: YtPlanItemInput): Promise<YtPlanItemResult> {
  // The YT app exposes service-to-service endpoints under /automation/*
  // (separate plugin with bearer-token auth; cookie-session routes live
  // under /items and are not intended for cross-service calls).
  const res = await fetch(`${base()}/automation/items`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      ...input,
      scheduledPublishAt: input.scheduledPublishAt.toISOString(),
      source: "automation",
    }),
  });
  if (!res.ok) {
    throw new Error(`yt-proxy.planItem ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error("yt-proxy.planItem: missing id in response");
  logger.info({ itemId: j.id, channel: input.channel, type: input.type }, "yt-proxy.planned");
  return { itemId: j.id };
}

// Upload a pre-rendered video file to the YT app (used for avatar/animated
// modes where automation produced the file locally and bypasses Drive).
// Implementation note: YT app needs a small `/api/items/:id/upload` endpoint
// that accepts multipart. Until then, this throws — fall back to Drive flow.
export async function uploadPreRenderedVideo(
  _ytItemId: string,
  _filePath: string,
  _thumbnailPath?: string,
): Promise<void> {
  throw new Error(
    "yt-proxy.uploadPreRenderedVideo: requires a new endpoint on the YT app. " +
      "Use the Drive flow until then.",
  );
}
