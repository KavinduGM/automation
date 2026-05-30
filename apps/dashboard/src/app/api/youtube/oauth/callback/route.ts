import { NextRequest, NextResponse } from "next/server";
import { prisma, seal, env } from "@ca/shared";
import { exchangeCode, listMyChannels, YOUTUBE_SCOPES } from "@ca/providers";

// OAuth callback. Validates the state nonce, exchanges the code for tokens,
// fetches the user's YouTube channels, and stores a YouTubeChannel row per
// channel with the refresh token encrypted at rest.
//
// If the user owns multiple channels, ALL are saved — they'll pick which
// one to publish to on the business's short-video plan.

export async function GET(req: NextRequest) {
  // NOTE: we deliberately don't requireUser() here because Google sometimes
  // strips cookies on the OAuth redirect. The state + nonce cookie pair
  // provides CSRF protection; only a legitimate flow we started can have
  // matching state + nonce.

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errParam = url.searchParams.get("error");

  if (errParam) {
    return NextResponse.redirect(redirectBack(req, `/?ytError=${encodeURIComponent(errParam)}`));
  }
  if (!code || !state) {
    return NextResponse.redirect(redirectBack(req, `/?ytError=missing_code_or_state`));
  }
  const [businessId, nonce] = state.split(".");
  if (!businessId || !nonce) {
    return NextResponse.redirect(redirectBack(req, `/?ytError=bad_state`));
  }
  const cookieNonce = req.cookies.get("yt_oauth_nonce")?.value;
  if (!cookieNonce || cookieNonce !== nonce) {
    return NextResponse.redirect(redirectBack(req, `/?ytError=csrf_mismatch`));
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) {
    return NextResponse.redirect(redirectBack(req, `/?ytError=business_missing`));
  }

  // Exchange the code for tokens.
  let tokens;
  try {
    tokens = await exchangeCode(code);
  } catch (err) {
    const msg = encodeURIComponent((err as Error).message);
    return NextResponse.redirect(redirectBack(req, `/businesses/${business.slug}/youtube?ytError=${msg}`));
  }

  // Look up the user's channels with the fresh refresh token.
  let channels;
  try {
    channels = await listMyChannels(tokens.refreshToken);
  } catch (err) {
    const msg = encodeURIComponent((err as Error).message);
    return NextResponse.redirect(redirectBack(req, `/businesses/${business.slug}/youtube?ytError=${msg}`));
  }
  if (channels.length === 0) {
    return NextResponse.redirect(redirectBack(req, `/businesses/${business.slug}/youtube?ytError=no_channels_on_this_account`));
  }

  // Save (or refresh) a YouTubeChannel row per channel.
  for (const ch of channels) {
    const sealed = seal(tokens.refreshToken);
    await prisma.youTubeChannel.upsert({
      where: { youtubeChannelId: ch.channelId },
      create: {
        businessId,
        youtubeChannelId: ch.channelId,
        channelTitle: ch.title,
        channelHandle: ch.handle,
        refreshTokenCipher: sealed.cipher,
        refreshTokenIv: sealed.iv,
        refreshTokenTag: sealed.tag,
        scopes: tokens.scope ?? YOUTUBE_SCOPES.join(" "),
        lastRefreshedAt: new Date(),
        refreshError: null,
        refreshErrorAt: null,
      },
      update: {
        businessId, // re-attach if admin moved it to a different business
        channelTitle: ch.title,
        channelHandle: ch.handle,
        refreshTokenCipher: sealed.cipher,
        refreshTokenIv: sealed.iv,
        refreshTokenTag: sealed.tag,
        scopes: tokens.scope ?? YOUTUBE_SCOPES.join(" "),
        lastRefreshedAt: new Date(),
        refreshError: null,
        refreshErrorAt: null,
      },
    });
  }

  const res = NextResponse.redirect(redirectBack(req, `/businesses/${business.slug}/youtube?ok=connected`));
  res.cookies.delete("yt_oauth_nonce");
  return res;
}

function redirectBack(_req: NextRequest, path: string): string {
  // Use DASHBOARD_URL (the configured public origin) rather than req.url.
  // Behind Dokploy's Traefik proxy, req.url resolves to the container's
  // internal `localhost:3000`, which the browser cannot reach. Forwarded
  // headers (X-Forwarded-Host etc.) are not always trustworthy either, so
  // we just use the canonical public URL from env.
  const origin = env().DASHBOARD_URL.replace(/\/$/, "");
  return `${origin}${path}`;
}
