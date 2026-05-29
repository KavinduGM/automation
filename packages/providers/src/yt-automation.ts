import { env, logger } from "@ca/shared";

// Full client for the user's YouTube Automation project (Fastify API on
// :4000). Replaces the bare stub in yt-proxy.ts for the short-video flow.
//
// Endpoints used:
//   POST /channels       — one-time: register the WEBX (or other) channel
//   POST /items          — create a scheduled video item with metadata
//   POST /items/bulk     — batch (when we publish a multi-short batch)
//   GET  /channels       — list channels (for the dashboard plan picker)

export interface YtChannelCreateInput {
  slug: string;            // url-friendly id e.g. "groovymark-webx"
  name: string;            // display name e.g. "GroovyMark WebX"
  filenamePrefix: string;  // uppercase 3-6 char prefix used in Drive filenames, e.g. "WEBX"
  youtubeChannelId?: string;
  hasShortVideos?: boolean;
  hasQuestionVideos?: boolean;
  hasAnimationVideos?: boolean;
}

export interface YtChannel {
  id: string;
  slug: string;
  name: string;
  filenamePrefix: string | null;
}

export interface YtItemCreateInput {
  channelId: string;
  type: "long" | "short" | "post";
  expectedFilename: string;         // {PREFIX}_{YYYY-MM-DD}_{TYPE}_{SLOT}.mp4
  title: string;
  description: string;
  tags?: string[];
  scheduledPublishAt: string;       // ISO date
  source?: "automation";
  sourceRef?: string;               // ContentItem.id for traceability
}

export interface YtItem {
  id: string;
  channelId: string;
  expectedFilename: string;
  status: string;
}

function base(): string {
  const url = env().YT_AUTOMATION_API_URL;
  if (!url) throw new Error("YT_AUTOMATION_API_URL not set — point at your YT Automation Fastify API");
  return url.replace(/\/$/, "");
}

function headers(): Record<string, string> {
  const t = env().YT_AUTOMATION_API_TOKEN;
  return {
    "Content-Type": "application/json",
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  };
}

export async function listChannels(): Promise<YtChannel[]> {
  const res = await fetch(`${base()}/channels`, { headers: headers() });
  if (!res.ok) throw new Error(`yt-automation listChannels ${res.status}: ${await res.text()}`);
  return (await res.json()) as YtChannel[];
}

export async function createChannel(input: YtChannelCreateInput): Promise<YtChannel> {
  const res = await fetch(`${base()}/channels`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      slug: input.slug,
      name: input.name,
      filenamePrefix: input.filenamePrefix,
      youtubeChannelId: input.youtubeChannelId ?? null,
      hasShortVideos: input.hasShortVideos ?? true,
      hasQuestionVideos: input.hasQuestionVideos ?? false,
      hasAnimationVideos: input.hasAnimationVideos ?? false,
    }),
  });
  if (!res.ok) throw new Error(`yt-automation createChannel ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as YtChannel;
  logger.info({ id: json.id, prefix: json.filenamePrefix }, "yt-automation.channel_created");
  return json;
}

export async function createItem(input: YtItemCreateInput): Promise<YtItem> {
  const res = await fetch(`${base()}/items`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`yt-automation createItem ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as YtItem;
  logger.info({ id: json.id, filename: json.expectedFilename }, "yt-automation.item_created");
  return json;
}

// Compose the filename the YT Automation watcher expects.
//   {PREFIX}_{YYYY-MM-DD}_{TYPE}_{SLOT}.{ext}
// e.g. WEBX_2026-06-01_short_3.mp4
export function buildExpectedFilename(opts: {
  prefix: string;
  date: Date;
  type: "short" | "long" | "post";
  slot: number;
  ext: "mp4" | "mov" | "m4v" | "webm" | "jpg" | "png";
}): string {
  const y = opts.date.getUTCFullYear();
  const m = String(opts.date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(opts.date.getUTCDate()).padStart(2, "0");
  return `${opts.prefix.toUpperCase()}_${y}-${m}-${d}_${opts.type}_${opts.slot}.${opts.ext}`;
}
