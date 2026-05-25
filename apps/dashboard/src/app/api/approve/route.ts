import { NextRequest, NextResponse } from "next/server";
import { prisma, verifyApprovalToken, queue, QUEUES } from "@ca/shared";

// One-click approve/reject from digest emails. The token is HMAC-signed and
// carries { a: "approve"|"reject", id: ContentItem.id }. No login required.

export async function GET(req: NextRequest) {
  const t = req.nextUrl.searchParams.get("t");
  if (!t) return NextResponse.json({ error: "missing token" }, { status: 400 });

  const payload = verifyApprovalToken<{ a: "approve" | "reject"; id: string }>(t);
  if (!payload) return NextResponse.json({ error: "invalid or expired token" }, { status: 400 });

  const item = await prisma.contentItem.findUnique({ where: { id: payload.id } });
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (item.status !== "review") {
    return NextResponse.json({ error: `item is ${item.status}, not awaiting review` }, { status: 409 });
  }

  if (payload.a === "approve") {
    await prisma.contentItem.update({ where: { id: payload.id }, data: { status: "approved" } });
    await queue(QUEUES.publish).add("publish", { contentItemId: payload.id });
    await prisma.auditLog.create({ data: { businessId: item.businessId, action: "approve(link)", target: `ContentItem:${payload.id}` } });
    return htmlResponse("✅ Approved", "Item moved to publishing. You can close this tab.");
  } else {
    await prisma.contentItem.update({ where: { id: payload.id }, data: { status: "rejected", reviewNotes: "Rejected via digest email" } });
    await prisma.auditLog.create({ data: { businessId: item.businessId, action: "reject(link)", target: `ContentItem:${payload.id}` } });
    return htmlResponse("❌ Rejected", "Item marked rejected. You can close this tab.");
  }
}

function htmlResponse(title: string, body: string) {
  return new NextResponse(
    `<!doctype html><meta charset=utf-8><title>${title}</title>
     <style>body{font-family:system-ui;padding:48px;max-width:560px;margin:auto}</style>
     <h1 style="font-size:24px">${title}</h1><p style="color:#555">${body}</p>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
