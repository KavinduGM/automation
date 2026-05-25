import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@ca/shared";

// Minimal session: opaque cookie → Session row → User row.
// Allow-listed by ALLOWED_LOGIN_EMAILS at signup time.

const COOKIE = "ca_session";

export async function getCurrentUser() {
  const c = cookies().get(COOKIE);
  if (!c) return null;
  const session = await prisma.session.findUnique({
    where: { id: c.value },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}

export async function requireUser() {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  return u;
}

export async function setSessionCookie(sessionId: string, expiresAt: Date) {
  cookies().set(COOKIE, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  cookies().delete(COOKIE);
}
