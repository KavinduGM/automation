import { prisma, queue, QUEUES, isShortVideoDisabled, type Prisma } from "@ca/shared";
import { runShortScriptsFromBlog } from "@ca/pipelines";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Per-blog short-video script review page.
//
// Sections (top → bottom):
//   1. Plan + diagnostics — what would happen if you clicked Generate
//   2. Pipeline events — every shortvideo_* step ever logged for this blog
//   3. Scripts list — review/edit/approve/render/publish each one
//
// Manual triggers always available, even when auto-generate is off.

const OK_MESSAGES: Record<string, string> = {
  shortVideoTestStarted: "Test pipeline running — render in progress, will upload as unlisted.",
  scriptsRegenerated: "Scripts regenerated.",
  scriptsGenerated: "Scripts generated successfully.",
  approved: "Script approved and render queued.",
  approvedAll: "All pending scripts approved and queued for render.",
  saved: "Edits saved.",
  deleted: "Script deleted.",
  renderQueued: "Render queued.",
};

export default async function ShortsReviewPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { ok?: string; err?: string };
}) {
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
  const channel = plan?.youtubeChannelRowId
    ? await prisma.youTubeChannel.findUnique({ where: { id: plan.youtubeChannelRowId } })
    : null;
  // All pipeline events whose step starts with "shortvideo_" — gives a
  // chronological record of what happened (or failed) for this blog's shorts.
  const events = await prisma.pipelineEvent.findMany({
    where: { contentItemId: params.id, step: { startsWith: "shortvideo" } },
    orderBy: { createdAt: "asc" },
  });

  const okMsg = searchParams?.ok ? OK_MESSAGES[searchParams.ok] : null;
  const errMsg = searchParams?.err ? decodeURIComponent(searchParams.err) : null;
  const killSwitchOn = isShortVideoDisabled();

  // ────────────────────────────────────────────────────────────────────
  // Server actions
  // ────────────────────────────────────────────────────────────────────

  // The big one: actually run script generation INLINE (not via queue) so the
  // admin gets immediate success/error feedback in the URL.
  async function generateNow() {
    "use server";
    try {
      await runShortScriptsFromBlog(params.id, { force: true });
      redirect(`/content/${params.id}/shorts?ok=scriptsGenerated`);
    } catch (err) {
      const digest = (err as { digest?: unknown })?.digest;
      if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error("[shorts/generateNow] failed:", err);
      redirect(`/content/${params.id}/shorts?err=${encodeURIComponent(msg.slice(0, 800))}`);
    }
  }

  async function regenerateAll() {
    "use server";
    try {
      // Drop existing scripts first so the new generation isn't blocked by
      // the "already have N" guard, and so old ords don't linger.
      await prisma.shortVideoScript.deleteMany({ where: { contentItemId: params.id } });
      await runShortScriptsFromBlog(params.id, { force: true });
      redirect(`/content/${params.id}/shorts?ok=scriptsRegenerated`);
    } catch (err) {
      const digest = (err as { digest?: unknown })?.digest;
      if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error("[shorts/regenerateAll] failed:", err);
      redirect(`/content/${params.id}/shorts?err=${encodeURIComponent(msg.slice(0, 800))}`);
    }
  }

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
    redirect(`/content/${params.id}/shorts?ok=saved`);
  }

  async function approveOne(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    const testMode = formData.get("testMode") === "1";
    await prisma.shortVideoScript.update({ where: { id }, data: { status: "approved", reviewNotes: "" } });
    await queue(QUEUES.shortvideo_render).add(`render:${id}${testMode ? ":test" : ""}`, { scriptId: id, testMode });
    redirect(`/content/${params.id}/shorts?ok=${testMode ? "renderQueued" : "approved"}`);
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
    redirect(`/content/${params.id}/shorts?ok=approvedAll`);
  }

  async function deleteOne(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    await prisma.shortVideoScript.delete({ where: { id } });
    redirect(`/content/${params.id}/shorts?ok=deleted`);
  }

  // ────────────────────────────────────────────────────────────────────
  // Render helpers
  // ────────────────────────────────────────────────────────────────────

  type ScriptObj = Prisma.JsonObject & {
    scenes?: Array<{ voiceover: string; explainer: string }>;
    style?: { description?: string };
  };
  const readScript = (j: unknown) => j as ScriptObj;

  // ────────────────────────────────────────────────────────────────────
  // Diagnostics — what would happen if you clicked Generate right now
  // ────────────────────────────────────────────────────────────────────

  const blogBodyLen = (item.bodyMd ?? "").length;
  const diagnostics: { ok: boolean; label: string; detail?: string }[] = [
    {
      ok: item.type === "blog",
      label: "Content item is a blog",
      detail: item.type !== "blog" ? `type=${item.type}` : undefined,
    },
    {
      ok: item.status === "published",
      label: "Blog is published",
      detail: item.status !== "published" ? `status=${item.status}` : undefined,
    },
    {
      ok: blogBodyLen > 200,
      label: `Blog body has content (${blogBodyLen} chars)`,
      detail: blogBodyLen <= 200 ? "Body is empty or too short for script generation" : undefined,
    },
    {
      ok: !!plan,
      label: "ShortVideoPlan exists for this business",
      detail: !plan ? "Open business page → Short-video plan → save it" : undefined,
    },
    {
      ok: !!plan?.voiceId,
      label: "ElevenLabs voice ID is set",
      detail: !plan?.voiceId ? "Plan saved but voice ID is empty" : `voiceId=${plan?.voiceId}`,
    },
    {
      ok: !!channel,
      label: "YouTube channel selected as publish target",
      detail: !channel
        ? "No channel set — open Business → Short-video plan → YouTube channels → Set as publish target"
        : `${channel.channelTitle} (${channel.channelHandle ?? "no handle"})`,
    },
    {
      ok: !!plan?.autoGenerate,
      label: "Auto-generate after blog publishes is ON",
      detail: plan && !plan.autoGenerate ? "Off — manual generation still works via Generate now" : undefined,
    },
  ];

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
              {plan ? ` · render window ${pad2(plan.renderWindowStartHourUtc)}:00-${pad2(plan.renderWindowEndHourUtc)}:00 UTC` : ""}
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-1">From: {item.title}</p>
        </div>

        {killSwitchOn && (
          <div className="rounded-md border border-orange-300 bg-orange-50 px-3 py-3 text-sm text-orange-900">
            <b>🛑 Short-video pipeline is DISABLED.</b>
            <div className="text-xs mt-1">
              The <code>SHORTVIDEO_DISABLED</code> env var is set. All Claude calls
              (script generation, scene HTML, visual review) are blocked. Render
              and publish queue jobs are also no-ops. Edit, approve, and other
              non-Claude actions still work for review.
              <div className="mt-1">
                To re-enable: unset <code>SHORTVIDEO_DISABLED</code> in Dokploy and redeploy.
              </div>
            </div>
          </div>
        )}
        {okMsg && (
          <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            {okMsg}
          </div>
        )}
        {errMsg && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <b>Script generation failed:</b>
            <div className="text-xs mt-1 whitespace-pre-wrap break-words">{errMsg}</div>
          </div>
        )}

        {/* ─── Section 1: Diagnostics ─────────────────────────────── */}
        <section className="card space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="font-medium">Pipeline readiness</h2>
            <div className="flex gap-2">
              <form action={generateNow}>
                <button className="btn-primary text-xs" disabled={killSwitchOn} title={killSwitchOn ? "Disabled — SHORTVIDEO_DISABLED env is set" : ""}>
                  ▶ Generate scripts now
                </button>
              </form>
              {scripts.length > 0 && (
                <form action={regenerateAll}>
                  <button className="btn-ghost text-xs" disabled={killSwitchOn} title={killSwitchOn ? "Disabled — SHORTVIDEO_DISABLED env is set" : ""}>
                    ↻ Regenerate (delete + re-run)
                  </button>
                </form>
              )}
            </div>
          </div>
          <ul className="space-y-1 text-sm">
            {diagnostics.map((d, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className={d.ok ? "text-green-600" : "text-red-600"}>
                  {d.ok ? "✓" : "✗"}
                </span>
                <div className="flex-1">
                  <div className={d.ok ? "text-gray-800" : "text-red-800 font-medium"}>{d.label}</div>
                  {d.detail && <div className="text-xs text-gray-500">{d.detail}</div>}
                </div>
              </li>
            ))}
          </ul>
          {plan && (
            <div className="text-xs text-gray-500 border-t border-gray-100 pt-2">
              Plan: {plan.scriptsPerBlog} script/blog · voice <code>{plan.voiceId}</code>
              {plan.publishSlots.length > 0 && ` · slots ${plan.publishSlots.join(", ")} (${plan.timezone})`}
            </div>
          )}
        </section>

        {/* ─── Section 2: Pipeline timeline (shortvideo_* events only) */}
        <section className="card">
          <h2 className="font-medium mb-2">Short-video pipeline events</h2>
          {events.length === 0 ? (
            <div className="text-xs text-gray-500">
              No events yet. Events appear here as soon as the script generator, renderer, or publisher does anything for this blog.
            </div>
          ) : (
            <ol className="space-y-2">
              {events.map((e) => (
                <li key={e.id} className="text-sm border-l-2 border-gray-200 pl-3 py-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <div>
                      <span className="font-mono text-xs text-gray-600">{e.step}</span>
                      <span className={`ml-2 text-xs ${stateTone(e.status)}`}>{e.status}</span>
                      {e.label && <span className="ml-2 text-gray-700">{e.label}</span>}
                    </div>
                    <div className="text-xs text-gray-500 whitespace-nowrap">
                      {e.createdAt.toISOString().slice(11, 19)} UTC
                      {e.durationMs ? ` · ${(e.durationMs / 1000).toFixed(1)}s` : ""}
                    </div>
                  </div>
                  {e.message && (
                    <div className={`text-xs mt-1 whitespace-pre-wrap ${e.status === "failed" ? "text-red-700" : "text-gray-600"}`}>
                      {e.message}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* ─── Section 3: Scripts ──────────────────────────────────── */}
        {scripts.length === 0 ? (
          <div className="card text-sm text-gray-600">
            <p className="font-medium mb-1">No scripts yet.</p>
            <p className="text-xs text-gray-500">
              Click <b>Generate scripts now</b> above to create one immediately.
              {plan?.autoGenerate
                ? " (Auto-generation runs after every blog publishes. If you just published, the worker should have queued it — check Pipeline events above.)"
                : " Auto-generation is off, so manual is the only path."}
            </p>
          </div>
        ) : (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Scripts ({scripts.length})</h2>
              <form action={approveAll}>
                <button className="btn-primary text-xs">Approve all pending</button>
              </form>
            </div>

            {scripts.map((s) => {
              const scriptObj = readScript(s.script);
              const wordCount = (scriptObj.scenes ?? []).reduce(
                (acc, sc) => acc + (sc.voiceover ?? "").split(/\s+/).length,
                0,
              );
              const watchUrl = s.ytItemId ? `https://youtu.be/${s.ytItemId}` : null;
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

                  {watchUrl && (
                    <div className="rounded bg-purple-50 border border-purple-200 px-3 py-2 text-sm">
                      ▶ <a href={watchUrl} target="_blank" rel="noopener" className="text-purple-800 underline font-medium">{watchUrl}</a>
                      <div className="text-xs text-purple-600 mt-0.5">
                        {s.status === "scheduled" && s.scheduledPublishAt
                          ? `Scheduled to go public at ${s.scheduledPublishAt.toISOString().slice(0, 16)} UTC`
                          : "Live on YouTube"}
                      </div>
                    </div>
                  )}

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
                      <label className="label">Scheduled publish (UTC ISO, blank = upload private)</label>
                      <input
                        className="input"
                        name="scheduledPublishAt"
                        defaultValue={s.scheduledPublishAt ? s.scheduledPublishAt.toISOString().slice(0, 16) : ""}
                        placeholder="2026-06-01T14:00"
                      />
                    </div>

                    {/* Scene preview */}
                    <details className="text-xs">
                      <summary className="cursor-pointer text-gray-600">Scene-by-scene preview ({scriptObj.scenes?.length ?? 0} scenes)</summary>
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
                      <div className={`text-xs whitespace-pre-wrap rounded px-2 py-1 ${s.status === "failed" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>
                        {s.reviewNotes}
                      </div>
                    )}

                    <div className="flex items-center gap-2">
                      <button className="btn-primary text-xs">Save edits</button>
                    </div>
                  </form>

                  <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-gray-100">
                    {(s.status === "pending_review" || s.status === "failed") && (
                      <>
                        <form action={approveOne}>
                          <input type="hidden" name="id" value={s.id} />
                          <button className="btn-primary text-xs">Approve &amp; queue render</button>
                        </form>
                        <form action={approveOne}>
                          <input type="hidden" name="id" value={s.id} />
                          <input type="hidden" name="testMode" value="1" />
                          <button className="btn-ghost text-xs" title="Render now (bypass off-hours window) + upload as UNLISTED">
                            ▶ Render now (test, unlisted)
                          </button>
                        </form>
                      </>
                    )}
                    {s.status === "approved" && (
                      <span className="text-xs text-blue-700">
                        Queued — will start during {pad2(plan?.renderWindowStartHourUtc ?? 2)}:00-{pad2(plan?.renderWindowEndHourUtc ?? 8)}:00 UTC (or now if test mode)
                      </span>
                    )}
                    {s.status === "rendering" && (
                      <span className="text-xs text-purple-700 animate-pulse">
                        ▶ Rendering — typically 5–10 min for 4 scenes. Watch Dokploy → video-renderer → Logs for live per-scene progress.
                      </span>
                    )}
                    {s.status === "rendered" && (
                      <span className="text-xs text-blue-700">
                        Render done — upload in progress
                      </span>
                    )}
                    {s.status === "uploading" && (
                      <span className="text-xs text-purple-700 animate-pulse">
                        ▶ Uploading to YouTube
                      </span>
                    )}
                    <form action={deleteOne}>
                      <input type="hidden" name="id" value={s.id} />
                      <button className="btn-danger text-xs">Delete</button>
                    </form>
                    {s.videoPath && (
                      <span className="text-xs text-gray-600 ml-auto">Rendered: <code>{s.videoPath}</code></span>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
        )}
      </main>
    </div>
  );
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
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

function stateTone(state: string): string {
  switch (state) {
    case "completed": return "text-green-700";
    case "started": return "text-blue-700";
    case "failed": return "text-red-700";
    case "skipped": return "text-gray-500";
    default: return "text-gray-600";
  }
}
