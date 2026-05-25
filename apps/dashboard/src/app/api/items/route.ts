import { NextRequest, NextResponse } from "next/server";
import { prisma, queue, QUEUES } from "@ca/shared";
import { requireUser } from "@/lib/auth";

// Manual "create now" endpoint — used from per-business pages, also handy for
// scripting via curl. Enqueues immediately.

export async function POST(req: NextRequest) {
  await requireUser();
  const body = (await req.json()) as {
    businessId: string;
    type: "blog" | "case_study" | "resource" | "social_post" | "landing_page" | "webinar";
    seed?: { title?: string; meta?: Record<string, unknown> };
  };
  if (!body.businessId || !body.type) {
    return NextResponse.json({ error: "businessId + type required" }, { status: 400 });
  }
  const item = await prisma.contentItem.create({
    data: {
      businessId: body.businessId,
      type: body.type,
      title: body.seed?.title ?? "",
      meta: (body.seed?.meta as object) ?? {},
      status: "queued",
    },
  });
  await queue(QUEUES.draft).add(`${body.type}:${item.id}`, { contentItemId: item.id, type: body.type });
  return NextResponse.json({ id: item.id });
}
