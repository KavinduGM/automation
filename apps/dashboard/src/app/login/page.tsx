import { redirect } from "next/navigation";
import { prisma, hashPassword, verifyPassword, allowedLoginEmails } from "@ca/shared";
import { setSessionCookie } from "@/lib/auth";

// Server-action driven login + first-user signup. Allowlisted by email.

export default function LoginPage({ searchParams }: { searchParams: { mode?: string; err?: string } }) {
  const mode = searchParams.mode === "signup" ? "signup" : "login";
  async function login(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    const password = String(formData.get("password") ?? "");
    if (!allowedLoginEmails().includes(email)) redirect("/login?err=not_allowed");
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !verifyPassword(password, user.passwordHash)) redirect("/login?err=bad_credentials");
    const session = await prisma.session.create({
      data: { userId: user!.id, expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14) },
    });
    await setSessionCookie(session.id, session.expiresAt);
    redirect("/");
  }
  async function signup(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    const password = String(formData.get("password") ?? "");
    const name = String(formData.get("name") ?? "");
    if (!allowedLoginEmails().includes(email)) redirect("/login?mode=signup&err=not_allowed");
    if (password.length < 12) redirect("/login?mode=signup&err=weak_password");
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) redirect("/login?mode=signup&err=exists");
    const user = await prisma.user.create({
      data: { email, name, passwordHash: hashPassword(password), role: "admin" },
    });
    const session = await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14) },
    });
    await setSessionCookie(session.id, session.expiresAt);
    redirect("/");
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
      <div className="w-full max-w-sm card">
        <h1 className="text-xl font-semibold mb-1">Content Automation</h1>
        <p className="text-sm text-gray-500 mb-4">{mode === "signup" ? "Create the first admin" : "Sign in"}</p>
        {searchParams.err && (
          <div className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.err}</div>
        )}
        <form action={mode === "signup" ? signup : login} className="space-y-3">
          {mode === "signup" && (
            <div>
              <label className="label">Name</label>
              <input className="input" name="name" required />
            </div>
          )}
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" name="email" required />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" name="password" required />
          </div>
          <button className="btn-primary w-full" type="submit">
            {mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>
        <p className="mt-4 text-xs text-gray-500">
          {mode === "signup" ? (
            <a className="underline" href="/login">Have an account? Sign in</a>
          ) : (
            <a className="underline" href="/login?mode=signup">First time? Create the admin account</a>
          )}
        </p>
      </div>
    </main>
  );
}
