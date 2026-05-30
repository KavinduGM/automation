import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@ca/shared";
import { buildAuthUrl } from "@ca/providers";
import { requireUser } from "@/lib/auth";
import { randomBytes } from "node:crypto";

// Kick off the YouTube OAuth flow for a specific business. The state param
// carries the businessId + a random nonce — the callback verifies the
// nonce against a session cookie to prevent CSRF.

export async function GET(req: NextRequest) {
  await requireUser();
  const url = new URL(req.url);
  const businessId = url.searchParams.get("businessId") ?? "";
  if (!businessId) {
    return NextResponse.json({ error: "businessId required" }, { status: 400 });
  }
  const biz = await prisma.business.findUnique({ where: { id: businessId } });
  if (!biz) {
    return NextResponse.json({ error: "business not found" }, { status: 404 });
  }

  const nonce = randomBytes(16).toString("hex");
  const state = `${businessId}.${nonce}`;
  let authUrl: string;
  try {
    authUrl = buildAuthUrl(state);
  } catch (err) {
    // Most common cause: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET
    // not set in the dashboard container's env. Show the admin a useful
    // page instead of the silent blank 500 Next renders by default.
    const msg = (err as Error).message ?? String(err);
    return new NextResponse(
      `<html><body style="font-family:system-ui;padding:2rem;max-width:640px">
        <h1>YouTube OAuth not configured</h1>
        <p style="color:#b91c1c"><b>Error:</b> ${escapeHtml(msg)}</p>
        <p>Add <code>GOOGLE_OAUTH_CLIENT_ID</code> and <code>GOOGLE_OAUTH_CLIENT_SECRET</code> to the dashboard's env vars in Dokploy and redeploy.</p>
        <p>See <code>.env.example</code> in the repo for the full setup checklist.</p>
        <p><a href="/businesses/${biz.slug}/youtube">← back</a></p>
       </body></html>`,
      { status: 500, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  const res = NextResponse.redirect(authUrl);
  res.cookies.set("yt_oauth_nonce", nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600, // 10 min — plenty for the consent screen
    path: "/",
  });
  return res;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
