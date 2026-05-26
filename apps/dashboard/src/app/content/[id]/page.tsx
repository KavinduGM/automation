import { prisma, queue, QUEUES } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { StatusBadge } from "@/components/StatusBadge";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Build a public preview URL for an asset stored on the shared volume.
// Honors ASSETS_PUBLIC_URL (set when the assets domain is wired in Dokploy);
// falls back to a relative /assets/ path for local dev.
const ASSETS_BASE = (process.env.ASSETS_PUBLIC_URL ?? "/assets").replace(/\/$/, "");
function assetPreviewUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path;
  const cleaned = path.replace(/^\/app\/assets\//, "").replace(/^\/+/, "");
  return `${ASSETS_BASE}/${cleaned}`;
}

// Map a finding message to literal line numbers in the body so the human
// reviewer can jump to the problem area in the textarea. Recognizes the
// concrete patterns the post-review checks for: leaked template markers,
// em/en dashes. Returns an empty list when the finding doesn't reference a
// specific token (e.g. "Article has zero <img> tags").
function findLocations(message: string, body: string): number[] {
  const patterns: RegExp[] = [];
  if (/\[\[IMAGE_/.test(message)) patterns.push(/\[\[IMAGE_\d+\]\]/g);
  if (/\[\[CTA/.test(message)) patterns.push(/\[\[CTA:[^\]]+\]\]/g);
  if (/em dash/i.test(message)) patterns.push(/[—–]/g);
  if (patterns.length === 0) return [];
  const lines = body.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (patterns.some((re) => { re.lastIndex = 0; return re.test(line); })) {
      hits.push(i + 1);
      if (hits.length >= 10) break;
    }
  }
  return hits;
}

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
    // Reset the layout-fix counter so the next post-publish review gives a
    // fresh 2 attempts. Without this, an item escalated to admin would be
    // re-escalated on the very next post-review with no chance to fix.
    const current = await prisma.contentItem.findUniqueOrThrow({ where: { id: params.id } });
    const currentMeta = (current.meta ?? {}) as Record<string, unknown>;
    const resetMeta = { ...currentMeta };
    delete resetMeta.autoFixAttempts;
    delete resetMeta.layoutFixExhausted;
    delete resetMeta.fixScope;
    await prisma.contentItem.update({
      where: { id: params.id },
      data: { status: "approved", meta: resetMeta as object },
    });
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

  // Pull a published item back from the live site. Keeps the draft + assets
  // around so the reviewer can re-edit and re-approve.
  async function unpublishAction() {
    "use server";
    const it = await prisma.contentItem.findUniqueOrThrow({ where: { id: params.id } });
    if (it.status !== "published") return;
    switch (it.type) {
      case "blog":         await prisma.post.deleteMany({ where: { contentItemId: params.id } }); break;
      case "case_study":   await prisma.caseStudy.deleteMany({ where: { contentItemId: params.id } }); break;
      case "resource":     await prisma.resource.deleteMany({ where: { contentItemId: params.id } }); break;
      case "landing_page": await prisma.landingPage.deleteMany({ where: { contentItemId: params.id } }); break;
      case "social_post":  await prisma.socialPost.deleteMany({ where: { contentItemId: params.id } }); break;
      case "webinar":      break;
    }
    await prisma.contentItem.update({
      where: { id: params.id },
      data: { status: "review", reviewNotes: "Unpublished — return to queue for edits." },
    });
    await prisma.auditLog.create({
      data: { userId: user.id, businessId: it.businessId, action: "unpublish", target: `ContentItem:${params.id}` },
    });
    redirect(`/content/${params.id}`);
  }

  // Hard delete. Cascades via Prisma onDelete=Cascade — Post, Asset, etc. go too.
  async function deleteAction() {
    "use server";
    const it = await prisma.contentItem.findUnique({ where: { id: params.id } });
    if (!it) return;
    await prisma.contentItem.delete({ where: { id: params.id } });
    await prisma.auditLog.create({
      data: { userId: user.id, businessId: it.businessId, action: "delete", target: `ContentItem:${params.id}` },
    });
    redirect("/");
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

        {(() => {
          const meta = (item.meta ?? {}) as {
            postReview?: { overall?: string; checkedAt?: string; findings?: Array<{ area: string; message: string; severity: string }> };
            lastFindings?: Array<{ area: string; message: string; severity?: string }>;
            imageErrors?: Array<{ ord: number; prompt: string; message: string }>;
            imagesGenerated?: number;
            imagesAttempted?: number;
            autoFixAttempts?: number;        // layout-fix counter
            contentFixAttempts?: number;     // pre-publish critic counter
            layoutFixExhausted?: boolean;
            contentFixGivenUp?: boolean;
            fixScope?: "text" | "images" | "both";
          };
          const findings = meta.lastFindings ?? meta.postReview?.findings ?? [];
          const showFindings = findings.length > 0;
          const imgErrors = meta.imageErrors ?? [];
          return (
            <>
              {meta.contentFixAttempts !== undefined && meta.contentFixAttempts > 0 && (
                <div className="card mb-4 bg-orange-50 border-orange-200 text-sm">
                  <div className="font-medium mb-1 text-orange-900">
                    Content fix history (pre-publish AI critic)
                  </div>
                  <div className="text-orange-800">
                    {meta.contentFixGivenUp
                      ? `Exhausted after ${meta.contentFixAttempts}/2 attempts — published anyway.`
                      : `Attempt ${meta.contentFixAttempts}/2 in progress.`}
                  </div>
                </div>
              )}

              {meta.autoFixAttempts !== undefined && meta.autoFixAttempts > 0 && (
                <div className="card mb-4 bg-orange-50 border-orange-200 text-sm">
                  <div className="font-medium mb-1 text-orange-900">
                    Layout fix history (post-publish reviewer)
                  </div>
                  <div className="text-orange-800">
                    {meta.layoutFixExhausted
                      ? `Exhausted after ${meta.autoFixAttempts}/2 attempts — UNPUBLISHED, awaiting your approval.`
                      : `Attempt ${meta.autoFixAttempts}/2 · scope: ${meta.fixScope ?? "both"}`}
                  </div>
                </div>
              )}

              {showFindings && (
                <div className="card mb-4 bg-red-50 border-red-200 text-sm">
                  <div className="font-medium mb-2 text-red-900">
                    Post-review findings ({findings.length})
                  </div>
                  <ul className="space-y-1">
                    {findings.map((f, idx) => {
                      const sev = (f as { severity?: string }).severity ?? "med";
                      const sevBg = sev === "high" ? "bg-red-200 text-red-900" : sev === "med" ? "bg-orange-200 text-orange-900" : "bg-gray-200 text-gray-800";
                      const area = (f as { area?: string }).area ?? "issue";
                      const message = (f as { message?: string }).message ?? "";
                      const locations = findLocations(message, item.bodyMd);
                      return (
                        <li key={idx} className="text-xs">
                          <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium mr-2 ${sevBg}`}>
                            {sev}
                          </span>
                          <span className="text-gray-500">[{area}]</span> {message}
                          {locations.length > 0 && (
                            <span className="ml-2 text-red-700">
                              · found at line{locations.length > 1 ? "s" : ""} {locations.join(", ")}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {imgErrors.length > 0 && (
                <div className="card mb-4 bg-red-50 border-red-200 text-sm">
                  <div className="font-medium mb-2 text-red-900">
                    Image generation errors ({imgErrors.length}/{meta.imagesAttempted ?? "?"} failed
                    {meta.imagesGenerated !== undefined && ` · ${meta.imagesGenerated} succeeded`})
                  </div>
                  <ul className="space-y-1 text-xs">
                    {imgErrors.map((e, idx) => (
                      <li key={idx}>
                        <span className="text-gray-500">image #{e.ord}:</span> {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {item.reviewNotes && !showFindings && (
                <div className="card mb-4 bg-orange-50 border-orange-200 text-sm whitespace-pre-wrap">
                  <div className="font-medium mb-1 text-orange-900">Review notes</div>
                  {item.reviewNotes}
                </div>
              )}
            </>
          );
        })()}

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
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {item.assets.map((a) => {
                const url = assetPreviewUrl(a.path);
                return (
                  <div key={a.id} className="rounded border bg-gray-50 p-2 text-xs">
                    {a.kind === "image" && url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={url} alt={a.altText ?? ""} className="w-full h-32 object-cover rounded mb-2" />
                    ) : a.kind === "video" && url ? (
                      <video src={url} controls className="w-full h-32 rounded mb-2" />
                    ) : a.kind === "voice" && url ? (
                      <audio src={url} controls className="w-full mb-2" />
                    ) : null}
                    <div className="font-medium">{a.kind} {a.ord === 0 && a.kind === "image" ? "(cover)" : ""}</div>
                    {a.altText && <div className="text-gray-500 mt-0.5 italic line-clamp-2">{a.altText}</div>}
                    <div className="text-gray-400 mt-1 break-all">{a.path}</div>
                    {url && (
                      <a href={url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                        open ↗
                      </a>
                    )}
                    <span className="float-right text-gray-500">${a.costUsd.toFixed(3)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2 items-center">
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
          {item.status === "published" && (
            <form action={unpublishAction}>
              <button className="btn-ghost" title="Take the published row down — keeps the draft for re-editing">
                Unpublish
              </button>
            </form>
          )}
          <form
            action={deleteAction}
            // Browser confirm is enough here — the action cascades and is
            // logged in the audit table, which is the real undo trail.
          >
            <button
              className="btn-danger"
              title="Hard delete — removes the draft, all assets, and any published row"
            >
              Delete
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
