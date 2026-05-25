import { env, logger } from "@ca/shared";

// Reddit free-tier: script-app OAuth client_credentials → app-only token.
// 60 reqs/min limit. We pull top posts per subreddit per day → topic candidates.

let _token: { value: string; expiresAt: number } | null = null;

async function appToken(): Promise<string> {
  const now = Date.now();
  if (_token && _token.expiresAt > now + 30_000) return _token.value;
  const id = env().REDDIT_CLIENT_ID;
  const secret = env().REDDIT_CLIENT_SECRET;
  if (!id || !secret) throw new Error("REDDIT_CLIENT_ID/SECRET not set");
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": env().REDDIT_USER_AGENT,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`reddit.token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  _token = { value: j.access_token, expiresAt: now + j.expires_in * 1000 };
  return _token.value;
}

export interface RedditPost {
  title: string;
  url: string;
  permalink: string;
  score: number;
  numComments: number;
  subreddit: string;
}

export async function topPosts(subreddits: string[], opts: { time?: "day" | "week"; limit?: number } = {}): Promise<RedditPost[]> {
  const token = await appToken();
  const out: RedditPost[] = [];
  const time = opts.time ?? "day";
  const limit = opts.limit ?? 25;
  for (const sub of subreddits) {
    const res = await fetch(
      `https://oauth.reddit.com/r/${encodeURIComponent(sub)}/top?t=${time}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${token}`, "User-Agent": env().REDDIT_USER_AGENT } },
    );
    if (!res.ok) {
      logger.warn({ sub, status: res.status }, "reddit.top_failed");
      continue;
    }
    const j = (await res.json()) as {
      data?: { children?: Array<{ data?: Record<string, unknown> }> };
    };
    for (const c of j.data?.children ?? []) {
      const d = c.data ?? {};
      out.push({
        title:       String(d.title ?? ""),
        url:         String(d.url ?? ""),
        permalink:   `https://reddit.com${String(d.permalink ?? "")}`,
        score:       Number(d.score ?? 0),
        numComments: Number(d.num_comments ?? 0),
        subreddit:   String(d.subreddit ?? sub),
      });
    }
  }
  return out;
}
