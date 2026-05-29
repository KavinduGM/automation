import { prisma, queue, QUEUES, type Prisma } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Per-blog short-video script review page.
//
// Lists the N scripts generated after this blog published. Admin can:
//   - Edit title / description / hashtags / scheduledPublishAt inline
//   - Regenerate a single script (re-run script gen for that ord only)
//   - Approve a script — flips status to approved + enqueues render
//   - Approve all
//   - Delete a script (drops it from the pool, no render)

export default async function ShortsReviewPage({ params }: { params: { id: string } }) {
  await requireUser();
  const item = await prisma.contentItem.findUnique({
    where: { id: params.id },
    include: { business: true },
  });
  if (!item) notFound();
  const scripts = await prisma.shortVideoScript.findMany({
    where: { contentItemId: params.id },
    orderBy: { ord: "asc" },
  });
  const plan = await prisma.shortVideoPlan.findUnique({ where: { businessId: item.businessId } });

  async function saveScript(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    const title = String(formData.get("title") ?? "");
    const description = String(formData.get("description") ?? "");
    const hashtags = String(formData.get("hashtags") ?? "")
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const tags = String(formData.get("tags") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const schedRaw = String(formData.get("scheduledPublishAt") ?? "").trim();
    const scheduledPublishAt = schedRaw ? new Date(schedRaw) : null;
    await prisma.shortVideoScript.update({
      where: { id },
      data: { title, description, hashtags, tags, scheduledPublishAt: scheduledPublishAt ?? null },
    });
    redirect(`/content/${params.id}/shorts`);
  }

  async function approveOne(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    await prisma.shortVideoScript.update({ where: { id }, data: { status: "approved", reviewNotes: "" } });
    await queue(QUEUES.shortvideo_render).add(`render:${id}`, { scriptId: id });
    redirect(`/content/${params.id}/shorts`);
  }

  async function approveAll() {
    "use server";
    const pending = await prisma.shortVideoScript.findMany({
      where: { contentItemId: params.id, status: "pending_review" },
      select: { id: true },
    });
    for (const p of pending) {
      await prisma.shortVideoScript.update({ where: { id: p.id }, data: { status: "approved", reviewNotes: "" } });
      await queue(QUEUES.shortvideo_render).add(`render:${p.id}`, { scriptId: p.id });
    }
    redirect(`/content/${params.id}/shorts`);
  }

  async function regenerateOne(formData: FormData) {
    "use server";
    // Single-script regen just bumps the parent ContentItem through a fresh
    // batch generation — the upsert in runShortScriptsFromBlog will replace
    // each script's content keyed by ord.
    void formData;
    await queue(QUEUES.shortvideo_scripts).add(`scripts:${params.id}:regen`, { contentItemId: params.id });
    redirect(`/content/${params.id}/shorts`);
  }

  async function deleteOne(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    await prisma.shortVideoScript.delete({ where: { id } });
    redirect(`/content/${params.id}/shorts`);
  }

  // Helper to read a JSON field safely (script is Prisma.JsonValue).
  const readScript = (j: unknown) => j as Prisma.JsonObject & {
    scenes?: Array<{ voiceover: string; explainer: string }>;
    style?: { description?: string };
  };

  return (
    <div className="flex flex-col md:flex-row">
      <Nav businessSlug={item.business.slug} />
      <main className="flex-1 p-6 max-w-5xl space-y-6">
        <div>
          <a href={`/content/${params.id}`} className="text-xs text-brand-700 hover:underline">← Back to article</a>
          <div className="flex items-baseline justify-between mt-2">
            <h1 className="text-xl font-semibold">Short-video scripts</h1>
            <div className="text-xs text-gray-500">
              {scripts.length} script{scripts.length === 1 ? "" : "s"}
              {plan ? ` · render window ${plan.renderWindowStartHourUtc.toString().padStart(2,"0")}:00-${plan.renderWindowEndHourUtc.toString().padStart(2,"0")}:00 UTC` : ""}
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-1">From: {item.title}</p>
        </div>

        {!plan && (
          <div className="card border-amber-200 bg-amber-50 text-sm">
            No <code>ShortVideoPlan</code> for this business — scripts won&apos;t auto-generate.
            Configure one (voice ID + YT channel) before approving.
          </div>
        )}

        {scripts.length === 0 ? (
          <div className="card text-sm text-gray-500">
            No scripts yet. They generate automatically after the blog publishes. If you just published, give it a minute and refresh.
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              <form action={approveAll}>
                <button className="btn-primary text-xs">Approve all pending</button>
              </form>
              <form action={regenerateOne}>
                <button className="btn-ghost text-xs">Regenerate all</button>
              </form>
            </div>

            <div className="space-y-4">
              {scripts.map((s) => {
                const scriptObj = readScript(s.script);
                const wordCount = (scriptObj.scenes ?? []).reduce(
                  (acc, sc) => acc + (sc.voiceover ?? "").split(/\s+/).length,
                  0,
                );
                return (
                  <div key={s.id} className="card space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-sm">
                        #{s.ord} — <span className={statusTone(s.status)}>{s.status}</span>
                      </div>
                      <div className="text-xs text-gray-500">
                        ~{wordCount} words · {scriptObj.scenes?.length ?? 0} scenes · est ${s.costUsd.toFixed(3)}
                      </div>
                    </div>

                    <form action={saveScript} className="space-y-2">
                      <input type="hidden" name="id" value={s.id} />
                      <div>
                        <label className="label">Title</label>
                        <input className="input" name="title" defaultValue={s.title} />
                      </div>
                      <div>
                        <label className="label">Description</label>
                        <textarea className="input" name="description" rows={3} defaultValue={s.description} />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <label className="label">Hashtags (space-separated)</label>
                          <input className="input" name="hashtags" defaultValue={(s.hashtags ?? []).join(" ")} />
                        </div>
                        <div>
                          <label className="label">YouTube tags (comma-separated)</label>
                          <input className="input" name="tags" defaultValue={(s.tags ?? []).join(", ")} />
                        </div>
                      </div>
                      <div>
                        <label className="label">Scheduled publish (UTC ISO)</label>
                        <input
                          className="input"
                          name="scheduledPublishAt"
                          defaultValue={s.scheduledPublishAt ? s.scheduledPublishAt.toISOString().slice(0, 16) : ""}
                          placeholder="2026-06-01T14:00"
                        />
                      </div>

                      {/* Scene preview */}
                      <details className="text-xs">
                        <summary className="cursor-pointer text-gray-600">Scene-by-scene preview</summary>
                        <ol className="mt-2 space-y-2">
                          {(scriptObj.scenes ?? []).map((sc, idx) => (
                            <li key={idx} className="rounded bg-gray-50 p-2">
                              <div className="font-medium">Scene {idx + 1}</div>
                              <div className="text-gray-600 mt-0.5"><b>Voiceover:</b> {sc.voiceover}</div>
                              <div className="text-gray-500 mt-0.5"><b>Visuals:</b> {sc.explainer}</div>
                            </li>
                          ))}
                        </ol>
                      </details>

                      {s.reviewNotes && (
                        <div className="text-xs text-amber-700 whitespace-pre-wrap">{s.reviewNotes}</div>
                      )}

                      <div className="flex items-center gap-2">
                        <button className="btn-primary text-xs">Save edits</button>
                      </div>
                    </form>

                    <div className="flex items-center gap-2">
                      {s.status === "pending_review" && (
                        <form action={approveOne}>
                          <input type="hidden" name="id" value={s.id} />
                          <button className="btn-primary text-xs">Approve & queue render</button>
                        </form>
                      )}
                      <form action={deleteOne}>
                        <input type="hidden" name="id" value={s.id} />
                        <button className="btn-danger text-xs">Delete</button>
                      </form>
                      {s.videoPath && (
                        <span className="text-xs text-gray-600">Rendered: <code>{s.videoPath}</code></span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function statusTone(status: string): string {
  switch (status) {
    case "pending_review": return "text-amber-700";
    case "approved": return "text-blue-700";
    case "rendering": return "text-purple-700";
    case "rendered": return "text-blue-700";
    case "uploading": return "text-purple-700";
    case "scheduled": return "text-green-700";
    case "published": return "text-green-700";
    case "failed": return "text-red-700";
    default: return "text-gray-700";
  }
}
