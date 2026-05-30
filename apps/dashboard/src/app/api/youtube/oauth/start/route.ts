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
  const authUrl = buildAuthUrl(state);

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
