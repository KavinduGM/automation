import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@ca/shared";
import { requireUser } from "@/lib/auth";

// POST /api/content/:id/unpublish
// Takes a `published` item out of public view: status → review, AND deletes
// the published row (Post / CaseStudy / Resource / LandingPage) so the
// client site stops serving it. The ContentItem (draft + assets) is kept
// so an editor can re-publish later from the same source.

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const item = await prisma.contentItem.findUnique({ where: { id: params.id } });
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (item.status !== "published") {
    return NextResponse.json({ error: `item is ${item.status}, not published` }, { status: 409 });
  }

  // Remove the materialized published row (one per type).
  switch (item.type) {
    case "blog":         await prisma.post.deleteMany({ where: { contentItemId: params.id } }); break;
    case "case_study":   await prisma.caseStudy.deleteMany({ where: { contentItemId: params.id } }); break;
    case "resource":     await prisma.resource.deleteMany({ where: { contentItemId: params.id } }); break;
    case "landing_page": await prisma.landingPage.deleteMany({ where: { contentItemId: params.id } }); break;
    case "social_post":  await prisma.socialPost.deleteMany({ where: { contentItemId: params.id } }); break;
    case "webinar":
      // Webinar publishing lives in the YT app — nothing to clean up here.
      break;
  }

  await prisma.contentItem.update({
    where: { id: params.id },
    data: { status: "review", reviewNotes: "Unpublished — return to queue for edits." },
  });
  await prisma.auditLog.create({
    data: { userId: user.id, businessId: item.businessId, action: "unpublish", target: `ContentItem:${params.id}` },
  });
  return NextResponse.json({ ok: true });
}
