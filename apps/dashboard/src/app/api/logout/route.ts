import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth";

export async function POST() {
  await clearSessionCookie();
  return NextResponse.redirect(new URL("/login", "http://localhost"), 303);
}
