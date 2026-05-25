import { prisma, queue, QUEUES } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { StatusBadge } from "@/components/StatusBadge";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ContentDetail({ params }: { params: { id: string } }) {
  const user = await requireUser();
  const item = await prisma.contentItem.findUnique({
    where: { id: params.id },
    include: { business: true, assets: true, webinarIntent: true, caseStudyIntake: true },
  });
  if (!item) notFound();

  async function save(formData: FormData) {
    "use server";
    const title = String(formData.get("title") ?? "");
    const slug = String(formData.get("slug") ?? "");
    const bodyMd = String(formData.get("bodyMd") ?? "");
    await prisma.contentItem.update({
      where: { id: params.id },
      data: { title, slug, bodyMd, version: { increment: 1 } },
    });
    await prisma.auditLog.create({
      data: { userId: user.id, businessId: item!.businessId, action: "edit", target: `ContentItem:${params.id}` },
    });
    redirect(`/content/${params.id}`);
  }

  async function approve() {
    "use server";
    await prisma.contentItem.update({ where: { id: params.id }, data: { status: "approved" } });
    await queue(QUEUES.publish).add("publish", { contentItemId: params.id });
    await prisma.auditLog.create({ data: { userId: user.id, businessId: item!.businessId, action: "approve", target: `ContentItem:${params.id}` } });
    redirect("/review");
  }

  async function reject(formData: FormData) {
    "use server";
    const reason = String(formData.get("reason") ?? "");
    await prisma.contentItem.update({ where: { id: params.id }, data: { status: "rejected", reviewNotes: reason } });
    await prisma.auditLog.create({ data: { userId: user.id, businessId: item!.businessId, action: "reject", target: `ContentItem:${params.id}`, diff: { reason } as object } });
    redirect("/review");
  }

  async function retry() {
    "use server";
    await prisma.contentItem.update({ where: { id: params.id }, data: { status: "queued" } });
    await queue(QUEUES.draft).add(`${item!.type}:${params.id}`, { contentItemId: params.id, type: item!.type });
    redirect(`/content/${params.id}`);
  }

  return (
    <div className="flex">
      <Nav businessSlug={item.business.slug} />
      <main className="flex-1 p-6 max-w-4xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold">{item.title || "(untitled)"}</h1>
            <div className="text-xs text-gray-500">{item.business.name} · {item.type} · v{item.version} · cost ${item.costUsd.toFixed(2)}</div>
          </div>
          <StatusBadge status={item.status} />
        </div>

        {item.reviewNotes && (
          <div className="card mb-4 bg-orange-50 border-orange-200 text-sm whitespace-pre-wrap">
            <div className="font-medium mb-1 text-orange-900">Review notes</div>
            {item.reviewNotes}
          </div>
        )}

        <form action={save} className="card space-y-3">
          <div>
            <label className="label">Title</label>
            <input className="input" name="title" defaultValue={item.title} />
          </div>
          <div>
            <label className="label">Slug</label>
            <input className="input" name="slug" defaultValue={item.slug ?? ""} />
          </div>
          <div>
            <label className="label">Body (Markdown)</label>
            <textarea className="input font-mono text-xs" name="bodyMd" rows={24} defaultValue={item.bodyMd} />
          </div>
          <button className="btn-primary">Save edits</button>
        </form>

        {item.assets.length > 0 && (
          <div className="card mt-4">
            <h3 className="font-medium mb-2">Assets ({item.assets.length})</h3>
            <ul className="text-xs space-y-1">
              {item.assets.map((a) => (
                <li key={a.id} className="flex justify-between">
                  <span>{a.kind} · <code className="text-[10px]">{a.path}</code></span>
                  <span className="text-gray-500">${a.costUsd.toFixed(3)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 flex gap-2">
          {item.status === "review" && (
            <>
              <form action={approve}><button className="btn-primary">Approve & publish</button></form>
              <form action={reject} className="flex gap-2 items-center">
                <input className="input" name="reason" placeholder="Reason for rejection" />
                <button className="btn-danger">Reject</button>
              </form>
            </>
          )}
          {(item.status === "failed" || item.status === "rejected") && (
            <form action={retry}><button className="btn-ghost">Retry</button></form>
          )}
        </div>
      </main>
    </div>
  );
}
