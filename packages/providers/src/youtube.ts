import { google } from "googleapis";
import { env, logger } from "@ca/shared";
import { createReadStream, statSync } from "node:fs";
import type { Readable } from "node:stream";

// Native YouTube Data API v3 wrapper.
//
// Replaces the YT-Automation-tool + rclone hop with direct upload from this
// automation system. One OAuth app at the Google account level; per-channel
// refresh tokens stored encrypted on YouTubeChannel rows.
//
// CONSENT SCREEN SETUP (one-time, in Google Cloud Console):
//   User type:
//     • Internal (Workspace org) — RECOMMENDED. No verification, no 7-day
//       refresh-token expiry, no scary unverified-app warning.
//     • External + Testing — works, but refresh tokens expire after 7 days.
//   Scopes (request all three so we can list channels too):
//     https://www.googleapis.com/auth/youtube
//     https://www.googleapis.com/auth/youtube.upload
//     https://www.googleapis.com/auth/youtube.readonly
//   Redirect URI:
//     ${DASHBOARD_URL}/api/youtube/oauth/callback

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

function redirectUri(): string {
  return `${env().DASHBOARD_URL.replace(/\/$/, "")}/api/youtube/oauth/callback`;
}

function clientPair(): { clientId: string; clientSecret: string } {
  const clientId = env().GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env().GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not set");
  }
  return { clientId, clientSecret };
}

// Returns a freshly-constructed OAuth2 client. We never reuse instances
// because refresh tokens are scoped per-channel.
export function oauthClient(refreshToken?: string) {
  const { clientId, clientSecret } = clientPair();
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri());
  if (refreshToken) {
    client.setCredentials({ refresh_token: refreshToken });
  }
  return client;
}

// Build the URL we redirect the admin to so they can grant consent.
// `state` carries the businessId (and a random nonce) so the callback knows
// which business to attach the resulting refresh token to.
export function buildAuthUrl(state: string): string {
  const client = oauthClient();
  return client.generateAuthUrl({
    access_type: "offline",      // need a refresh_token
    prompt: "consent",            // force the consent screen so we always get refresh_token back (Google omits it on repeat grants otherwise)
    scope: YOUTUBE_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

// Exchange the one-time code from the callback for tokens.
export async function exchangeCode(code: string): Promise<{
  refreshToken: string;
  accessToken: string;
  scope: string;
  expiresAtMs: number | null;
}> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh_token. Revoke the app's access at https://myaccount.google.com/permissions and try again with prompt=consent.");
  }
  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? "",
    scope: tokens.scope ?? YOUTUBE_SCOPES.join(" "),
    expiresAtMs: tokens.expiry_date ?? null,
  };
}

// List the YouTube channels owned by the authenticated user. After OAuth
// completes we call this and store one YouTubeChannel row per channel the
// admin is connected to.
export interface YtMyChannel {
  channelId: string;
  title: string;
  handle: string | null;
  thumbnailUrl: string | null;
}

export async function listMyChannels(refreshToken: string): Promise<YtMyChannel[]> {
  const auth = oauthClient(refreshToken);
  const yt = google.youtube({ version: "v3", auth });
  const res = await yt.channels.list({
    mine: true,
    part: ["id", "snippet", "brandingSettings"],
  });
  const items = res.data.items ?? [];
  return items.map((c) => ({
    channelId: c.id ?? "",
    title: c.snippet?.title ?? "(untitled)",
    handle: c.snippet?.customUrl ?? null,
    thumbnailUrl: c.snippet?.thumbnails?.default?.url ?? null,
  })).filter((c) => c.channelId);
}

// Upload a video. Returns the created videoId. Uses YouTube's resumable
// upload protocol via the googleapis library. Schedules publication via
// `publishAt` when status is set to "private" — YouTube flips it to public
// at the requested instant.
export interface UploadVideoArgs {
  refreshToken: string;
  videoFilePath: string;
  title: string;
  description: string;
  tags?: string[];
  // Optional ISO instant; if set, video uploads as private + scheduled.
  // If null, the video uploads as private with no schedule (admin can
  // publish manually from YouTube Studio).
  publishAt?: Date | null;
  categoryId?: string;       // default "22" (People & Blogs); set "27" (Education) for OAP-style
  defaultLanguage?: string;  // BCP-47, default "en"
  madeForKids?: boolean;     // default false
  // Shorts-friendly defaults. Most clients flip this on for vertical videos
  // ≤60 sec — YouTube auto-detects too but explicit is better.
  isShort?: boolean;
  // Override privacy status. Default is "private" so publishAt can schedule.
  // Set "unlisted" for test runs (instantly viewable via URL but not listed
  // or searchable) or "public" to publish immediately.
  privacyStatus?: "private" | "unlisted" | "public";
}

export interface UploadVideoResult {
  videoId: string;
  privacyStatus: string;
  publishAt: string | null;
}

export async function uploadVideo(args: UploadVideoArgs): Promise<UploadVideoResult> {
  const auth = oauthClient(args.refreshToken);
  const yt = google.youtube({ version: "v3", auth });

  const fileSize = statSync(args.videoFilePath).size;
  const stream = createReadStream(args.videoFilePath) as Readable;

  // For scheduled publish, status MUST be "private". Once publishAt fires,
  // YouTube flips it to "public" automatically. Override (unlisted/public)
  // is used for test runs and immediate publishes.
  const privacyStatus = args.privacyStatus ?? "private";

  const res = await yt.videos.insert({
    part: ["snippet", "status"],
    notifySubscribers: true,
    requestBody: {
      snippet: {
        title: args.title.slice(0, 100),                  // YouTube limit
        description: args.description.slice(0, 5000),     // YouTube limit
        tags: (args.tags ?? []).slice(0, 500),            // total tag string length ≤ 500 chars enforced by YT
        categoryId: args.categoryId ?? "22",
        defaultLanguage: args.defaultLanguage ?? "en",
        defaultAudioLanguage: args.defaultLanguage ?? "en",
      },
      status: {
        privacyStatus,
        publishAt: args.publishAt ? args.publishAt.toISOString() : undefined,
        selfDeclaredMadeForKids: args.madeForKids ?? false,
        embeddable: true,
        license: "youtube",
      },
    },
    media: { mimeType: "video/mp4", body: stream },
  }, {
    // Show progress to caller via log lines (the rendererService logs these).
    onUploadProgress: (evt) => {
      const pct = Math.round((evt.bytesRead / fileSize) * 100);
      logger.info({ pct, bytesRead: evt.bytesRead, fileSize }, "youtube.upload.progress");
    },
  });

  if (!res.data.id) throw new Error("youtube.videos.insert returned no id");
  return {
    videoId: res.data.id,
    privacyStatus: res.data.status?.privacyStatus ?? privacyStatus,
    publishAt: res.data.status?.publishAt ?? null,
  };
}

// Upload (or replace) a custom thumbnail for an existing video. Shorts CAN
// have custom thumbnails since late 2023, but the feature is gated for some
// new channels — we try, and if YouTube returns a quotaExceeded /
// thumbnailNotAllowed error we log + continue (the auto-generated
// first-frame thumb stays).
export async function setThumbnail(args: {
  refreshToken: string;
  videoId: string;
  thumbnailFilePath: string;
}): Promise<{ ok: boolean; message?: string }> {
  const auth = oauthClient(args.refreshToken);
  const yt = google.youtube({ version: "v3", auth });
  try {
    await yt.thumbnails.set({
      videoId: args.videoId,
      media: { mimeType: "image/jpeg", body: createReadStream(args.thumbnailFilePath) as Readable },
    });
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    logger.warn({ err, videoId: args.videoId }, "youtube.thumbnail_set_failed");
    return { ok: false, message: msg };
  }
}

// Fetch video status — used by the dashboard to reflect "scheduled" vs
// "live" vs "deleted" without polling YouTube every page load.
export async function getVideoStatus(args: {
  refreshToken: string;
  videoId: string;
}): Promise<{
  found: boolean;
  privacyStatus: string | null;
  publishAt: string | null;
  uploadStatus: string | null;
  rejectionReason: string | null;
}> {
  const auth = oauthClient(args.refreshToken);
  const yt = google.youtube({ version: "v3", auth });
  const res = await yt.videos.list({ id: [args.videoId], part: ["status"] });
  const v = res.data.items?.[0];
  if (!v) {
    return { found: false, privacyStatus: null, publishAt: null, uploadStatus: null, rejectionReason: null };
  }
  return {
    found: true,
    privacyStatus: v.status?.privacyStatus ?? null,
    publishAt: v.status?.publishAt ?? null,
    uploadStatus: v.status?.uploadStatus ?? null,
    rejectionReason: v.status?.rejectionReason ?? null,
  };
}
