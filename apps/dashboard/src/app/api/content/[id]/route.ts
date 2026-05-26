import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@ca/shared";
import { requireUser } from "@/lib/auth";

// DELETE /api/content/:id
// Hard-removes a ContentItem and its published row (Post, CaseStudy, …) plus
// associated assets. Used by the dashboard's "Delete" button for content the
// reviewer never wants to keep — including already-published posts.
//
// Cascading deletes are wired in the Prisma schema (Asset, Post, CaseStudy,
// Resource, LandingPage, SocialPost all have onDelete:Cascade against
// ContentItem), so this single delete pulls everything with it.

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const item = await prisma.contentItem.findUnique({ where: { id: params.id } });
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });

  await prisma.contentItem.delete({ where: { id: params.id } });
  await prisma.auditLog.create({
    data: { userId: user.id, businessId: item.businessId, action: "delete", target: `ContentItem:${params.id}` },
  });
  return NextResponse.json({ ok: true });
}
