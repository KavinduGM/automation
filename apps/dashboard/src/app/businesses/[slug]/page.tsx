import { prisma, seal, open, queue, QUEUES } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { notFound, redirect } from "next/navigation";
import type { ContentType, Period, ApprovalMode, TopicSourceKind } from "@prisma/client";

export const dynamic = "force-dynamic";

const CONTENT_TYPES: ContentType[] = ["blog","case_study","resource","social_post","landing_page","webinar"];
const PERIODS: Period[] = ["day","week","month"];
const MODES: ApprovalMode[] = ["auto","ai_review","human_review"];
const INTEGRATION_KINDS = ["buffer","youtube_proxy","canva","site_db","site_revalidate"] as const;

const OK_MESSAGES: Record<string, string> = {
  brandKit: "Brand kit saved.",
  plan: "Content plan saved.",
  planDeleted: "Content plan deleted.",
  planToggled: "Content plan status updated.",
  topic: "Topic source saved.",
  topicDeleted: "Topic source deleted.",
  topicToggled: "Topic source status updated.",
  integration: "Integration saved.",
  integrationDeleted: "Integration deleted.",
  freshOn: "Fresh research enabled — Grok will run per article for this topic.",
  freshOff: "Fresh research disabled.",
  topicCandidateDeleted: "Topic deleted.",
  researchEnqueued: "Research job enqueued — check the Jobs page in a minute.",
  draftEnqueued: "Test draft enqueued — it will publish ASAP (slot ignored for test mode).",
};

export default async function BusinessDetail({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: { ok?: string; editPlan?: string; editTopic?: string; editInt?: string };
}) {
  await requireUser();
  const biz = await prisma.business.findUnique({
    where: { slug: params.slug },
    include: { brandKit: true, contentPlans: true, topicSources: true, integrations: true },
  });
  if (!biz) notFound();

  // Pull time-sensitive / breaking topic candidates so the admin can
  // explicitly opt them into per-article Grok research.
  const flaggedTopics = await prisma.topicCandidate.findMany({
    where: {
      businessId: biz.id,
      usedAt: null,
      sensitivity: { in: ["time_sensitive", "breaking"] },
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  const okMsg = searchParams?.ok ? OK_MESSAGES[searchParams.ok] : null;
  const editPlanId = searchParams?.editPlan ?? null;
  const editTopicId = searchParams?.editTopic ?? null;
  const editIntId = searchParams?.editInt ?? null;

  const editingPlan = editPlanId ? biz.contentPlans.find(p => p.id === editPlanId) ?? null : null;
  const editingTopic = editTopicId ? biz.topicSources.find(s => s.id === editTopicId) ?? null : null;
  const editingInt = editIntId ? biz.integrations.find(i => i.id === editIntId) ?? null : null;

  let editingIntConfig = "";
  if (editingInt) {
    try {
      editingIntConfig = open({ cipher: editingInt.configCipher, iv: editingInt.configIv, tag: editingInt.configTag });
    } catch {
      editingIntConfig = "";
    }
  }

  // ── Server actions ───────────────────────────────────────────────────
  async function saveBrandKit(formData: FormData) {
    "use server";
    const business = await prisma.business.findUniqueOrThrow({ where: { slug: params.slug } });
    const voiceJson = String(formData.get("voice_json") ?? "{}");
    let voice: object;
    try { voice = JSON.parse(voiceJson); } catch { voice = {}; }
    const icp = String(formData.get("icp") ?? "");
    const usps = String(formData.get("usps") ?? "").split("\n").map(s => s.trim()).filter(Boolean);
    const bannedWords = String(formData.get("bannedWords") ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const styleGuideMd = String(formData.get("styleGuideMd") ?? "");
    await prisma.brandKit.upsert({
      where: { businessId: business.id },
      create: { businessId: business.id, voice, icp, usps, bannedWords, styleGuideMd },
      update: { voice, icp, usps, bannedWords, styleGuideMd },
    });
    redirect(`/businesses/${params.slug}?ok=brandKit`);
  }

  async function savePlan(formData: FormData) {
    "use server";
    const business = await prisma.business.findUniqueOrThrow({ where: { slug: params.slug } });
    const contentType = String(formData.get("contentType")) as ContentType;
    const perPeriod = Number(formData.get("perPeriod") ?? 1);
    const period = String(formData.get("period")) as Period;
    const approvalMode = String(formData.get("approvalMode")) as ApprovalMode;
    const active = formData.get("active") === "on";
    const timeSlotsRaw = String(formData.get("timeSlots") ?? "");
    const timezone = String(formData.get("timezone") ?? "America/New_York").trim() || "America/New_York";
    // Slots come in as a comma-separated "09:00, 13:00, 17:00" string. Empty
    // input = legacy "publish ASAP" behavior.
    const timeSlots = timeSlotsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d{1,2}:\d{2}$/.test(s));
    await prisma.contentPlan.upsert({
      where: { businessId_contentType: { businessId: business.id, contentType } },
      create: { businessId: business.id, contentType, perPeriod, period, approvalMode, active, timeSlots, timezone },
      update: { perPeriod, period, approvalMode, active, timeSlots, timezone },
    });
    redirect(`/businesses/${params.slug}?ok=plan`);
  }

  async function deletePlan(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    await prisma.contentPlan.delete({ where: { id } });
    redirect(`/businesses/${params.slug}?ok=planDeleted`);
  }

  async function togglePlan(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    const plan = await prisma.contentPlan.findUniqueOrThrow({ where: { id } });
    await prisma.contentPlan.update({ where: { id }, data: { active: !plan.active } });
    redirect(`/businesses/${params.slug}?ok=planToggled`);
  }

  async function addTopicSource(formData: FormData) {
    "use server";
    const business = await prisma.business.findUniqueOrThrow({ where: { slug: params.slug } });
    const kind = String(formData.get("kind")) as TopicSourceKind;
    const cfg = String(formData.get("config") ?? "{}");
    let config: object;
    try { config = JSON.parse(cfg); } catch { config = {}; }
    await prisma.topicSource.create({ data: { businessId: business.id, kind, config } });
    redirect(`/businesses/${params.slug}?ok=topic`);
  }

  async function updateTopicSource(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    const kind = String(formData.get("kind")) as TopicSourceKind;
    const cfg = String(formData.get("config") ?? "{}");
    let config: object;
    try { config = JSON.parse(cfg); } catch { config = {}; }
    const active = formData.get("active") === "on";
    await prisma.topicSource.update({ where: { id }, data: { kind, config, active } });
    redirect(`/businesses/${params.slug}?ok=topic`);
  }

  async function deleteTopicSource(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    await prisma.topicSource.delete({ where: { id } });
    redirect(`/businesses/${params.slug}?ok=topicDeleted`);
  }

  async function toggleTopicSource(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    const src = await prisma.topicSource.findUniqueOrThrow({ where: { id } });
    await prisma.topicSource.update({ where: { id }, data: { active: !src.active } });
    redirect(`/businesses/${params.slug}?ok=topicToggled`);
  }

  async function toggleFreshResearch(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    const current = await prisma.topicCandidate.findUniqueOrThrow({ where: { id } });
    const next = !current.freshResearchEnabled;
    await prisma.topicCandidate.update({ where: { id }, data: { freshResearchEnabled: next } });
    redirect(`/businesses/${params.slug}?ok=${next ? "freshOn" : "freshOff"}`);
  }

  async function deleteTopicCandidate(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    await prisma.topicCandidate.delete({ where: { id } });
    redirect(`/businesses/${params.slug}?ok=topicCandidateDeleted`);
  }

  async function saveIntegration(formData: FormData) {
    "use server";
    const business = await prisma.business.findUniqueOrThrow({ where: { slug: params.slug } });
    const kind = String(formData.get("kind") ?? "buffer");
    const plain = String(formData.get("config") ?? "{}");
    const sealed = seal(plain);
    await prisma.integration.upsert({
      where: { businessId_kind: { businessId: business.id, kind } },
      create: { businessId: business.id, kind, configCipher: sealed.cipher, configIv: sealed.iv, configTag: sealed.tag },
      update: { configCipher: sealed.cipher, configIv: sealed.iv, configTag: sealed.tag },
    });
    redirect(`/businesses/${params.slug}?ok=integration`);
  }

  async function deleteIntegration(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    await prisma.integration.delete({ where: { id } });
    redirect(`/businesses/${params.slug}?ok=integrationDeleted`);
  }

  async function runResearchNow() {
    "use server";
    const business = await prisma.business.findUniqueOrThrow({ where: { slug: params.slug } });
    await queue(QUEUES.research).add(`research:manual:${Date.now()}`, { businessId: business.id });
    redirect(`/businesses/${params.slug}?ok=researchEnqueued`);
  }

  // Create a ContentItem and immediately enqueue draft, bypassing slots
  // and content plans. scheduledAt left null so enqueuePublish treats it
  // as publish-ASAP at the end of the pipeline. For test mode only.
  async function draftTestNow(formData: FormData) {
    "use server";
    const business = await prisma.business.findUniqueOrThrow({ where: { slug: params.slug } });
    const type = String(formData.get("type") ?? "blog") as ContentType;
    const item = await prisma.contentItem.create({
      data: { businessId: business.id, type, status: "queued" },
    });
    await queue(QUEUES.draft).add(`${type}:${item.id}:test`, { contentItemId: item.id, type });
    redirect(`/content/${item.id}?ok=draftEnqueued`);
  }

  return (
    <div className="flex">
      <Nav businessSlug={biz.slug} />
      <main className="flex-1 p-6 max-w-4xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold">{biz.name}</h1>
          <div className="text-xs text-gray-500">{biz.slug} · {biz.timezone}</div>
        </div>

        {okMsg && (
          <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            {okMsg}
          </div>
        )}

        {/* ── Test actions ─────────────────────────────────────────── */}
        <section className="card border-blue-200 bg-blue-50/40">
          <h2 className="font-medium mb-1">Test mode</h2>
          <p className="text-xs text-gray-600 mb-3">
            Run jobs on demand instead of waiting for the 04:00 UTC research cron or a scheduled slot. Use this to verify the pipeline end-to-end before letting automation drive.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <form action={runResearchNow}>
              <button className="btn-primary text-xs">Run research now</button>
            </form>
            <form action={draftTestNow} className="flex items-center gap-2">
              <select className="input text-xs" name="type" defaultValue="blog">
                {CONTENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <button className="btn-primary text-xs">Draft one now (ASAP)</button>
            </form>
          </div>
          <div className="mt-2 text-xs text-gray-500">
            <b>Run research now</b> kicks off all active Topic Sources for this business and adds new candidates. <b>Draft one now</b> creates a single ContentItem and publishes it ASAP, ignoring any time slots — slots are only honored by the per-minute scheduler tick.
          </div>
        </section>

        {/* ── Brand kit ─────────────────────────────────────────────── */}
        <section className="card">
          <h2 className="font-medium mb-3">Brand kit</h2>
          <form action={saveBrandKit} className="space-y-3">
            <div>
              <label className="label">Voice (JSON)</label>
              <textarea
                name="voice_json"
                rows={4}
                className="input font-mono text-xs"
                defaultValue={JSON.stringify(biz.brandKit?.voice ?? { tone: "", audience: "", persona: "", readingLevel: "" }, null, 2)}
              />
              <div className="mt-1 text-xs text-gray-500">
                Fields: tone, audience, persona, readingLevel, pointOfView, dosAndDonts, exampleHooks.
              </div>
            </div>
            <div>
              <label className="label">ICP (ideal customer profile)</label>
              <input className="input" name="icp" defaultValue={biz.brandKit?.icp ?? ""} />
            </div>
            <div>
              <label className="label">USPs (one per line)</label>
              <textarea className="input" name="usps" rows={3} defaultValue={(biz.brandKit?.usps ?? []).join("\n")} />
            </div>
            <div>
              <label className="label">Banned words (comma-separated)</label>
              <input className="input" name="bannedWords" defaultValue={(biz.brandKit?.bannedWords ?? []).join(", ")} />
            </div>
            <div>
              <label className="label">Style guide (Markdown — optional, AI can auto-generate)</label>
              <textarea className="input font-mono text-xs" name="styleGuideMd" rows={6} defaultValue={biz.brandKit?.styleGuideMd ?? ""} />
            </div>
            <button className="btn-primary">Save brand kit</button>
          </form>
        </section>

        {/* ── Content plans ─────────────────────────────────────────── */}
        <section className="card">
          <h2 className="font-medium mb-3">Content plans</h2>
          <div className="grid gap-2 text-xs mb-3">
            {biz.contentPlans.map((p) => {
              const slots = Array.isArray(p.timeSlots) ? (p.timeSlots as string[]) : [];
              return (
                <div key={p.id} className="flex items-center justify-between gap-2 rounded bg-gray-50 px-2 py-1.5">
                  <span className="flex-1">
                    <span className="font-medium">{p.contentType}</span> · {p.perPeriod}/{p.period} · {p.approvalMode} ·{" "}
                    <span className={`badge ${p.active ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-700"}`}>
                      {p.active ? "active" : "hold"}
                    </span>
                    {slots.length > 0 && (
                      <span className="ml-1 text-gray-500">· slots {slots.join(", ")} ({p.timezone})</span>
                    )}
                    {slots.length === 0 && (
                      <span className="ml-1 text-gray-400">· publish ASAP</span>
                    )}
                  </span>
                  <div className="flex items-center gap-1">
                    <a className="btn-ghost px-2 py-1 text-xs" href={`/businesses/${biz.slug}?editPlan=${p.id}`}>Edit</a>
                    <form action={togglePlan}>
                      <input type="hidden" name="id" value={p.id} />
                      <button className="btn-ghost px-2 py-1 text-xs">{p.active ? "Hold" : "Activate"}</button>
                    </form>
                    <form action={deletePlan}>
                      <input type="hidden" name="id" value={p.id} />
                      <button className="btn-danger px-2 py-1 text-xs">Delete</button>
                    </form>
                  </div>
                </div>
              );
            })}
            {biz.contentPlans.length === 0 && <div className="text-gray-500">No plans yet — add one below.</div>}
          </div>
          <div className="border-t pt-3">
            <div className="text-xs font-medium text-gray-600 mb-2">
              {editingPlan ? `Edit plan: ${editingPlan.contentType}` : "Add / update plan"}
            </div>
            <form action={savePlan} className="grid grid-cols-2 gap-2 items-end">
              <div>
                <label className="label">Type</label>
                <select className="input" name="contentType" defaultValue={editingPlan?.contentType} disabled={!!editingPlan}>
                  {CONTENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                {editingPlan && <input type="hidden" name="contentType" value={editingPlan.contentType} />}
              </div>
              <div>
                <label className="label">Per period</label>
                <input className="input" type="number" min="1" max="50" name="perPeriod" defaultValue={editingPlan?.perPeriod ?? 1} />
              </div>
              <div>
                <label className="label">Period</label>
                <select className="input" name="period" defaultValue={editingPlan?.period}>
                  {PERIODS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Approval</label>
                <select className="input" name="approvalMode" defaultValue={editingPlan?.approvalMode}>
                  {MODES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="label">Publish slots (comma-separated, in plan timezone)</label>
                <input
                  className="input"
                  name="timeSlots"
                  placeholder="09:00, 13:00, 17:00 — leave blank for ASAP"
                  defaultValue={editingPlan && Array.isArray(editingPlan.timeSlots) ? (editingPlan.timeSlots as string[]).join(", ") : ""}
                />
                <div className="mt-1 text-xs text-gray-500">
                  When set, articles are created at these wall-clock times daily. Past slots roll to tomorrow. <b>Slot count overrides Per period</b> — one article per slot per day.
                </div>
              </div>
              <div className="col-span-2">
                <label className="label">Timezone (IANA)</label>
                <select className="input" name="timezone" defaultValue={editingPlan?.timezone ?? "America/New_York"}>
                  <option value="America/New_York">America/New_York (Eastern)</option>
                  <option value="America/Chicago">America/Chicago (Central)</option>
                  <option value="America/Denver">America/Denver (Mountain)</option>
                  <option value="America/Los_Angeles">America/Los_Angeles (Pacific)</option>
                  <option value="UTC">UTC</option>
                </select>
              </div>
              <label className="text-xs flex items-center gap-2 col-span-2">
                <input type="checkbox" name="active" defaultChecked={editingPlan ? editingPlan.active : true} /> active
              </label>
              <button className="btn-primary col-span-2">{editingPlan ? "Save changes" : "Save plan"}</button>
              {editingPlan && (
                <a className="btn-ghost col-span-2 text-center" href={`/businesses/${biz.slug}`}>Cancel</a>
              )}
            </form>
          </div>
        </section>

        {/* ── Topic sources ─────────────────────────────────────────── */}
        <section className="card">
          <h2 className="font-medium mb-3">Topic sources</h2>
          <div className="grid gap-2 text-xs mb-3">
            {biz.topicSources.map((s) => (
              <div key={s.id} className="rounded bg-gray-50 px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{s.kind}</span> ·{" "}
                    <span className={`badge ${s.active ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-700"}`}>
                      {s.active ? "active" : "hold"}
                    </span>{" "}
                    · last run: {s.lastRunAt ? new Date(s.lastRunAt).toISOString().slice(0,16) : "never"}
                  </span>
                  <div className="flex items-center gap-1">
                    <a className="btn-ghost px-2 py-1 text-xs" href={`/businesses/${biz.slug}?editTopic=${s.id}`}>Edit</a>
                    <form action={toggleTopicSource}>
                      <input type="hidden" name="id" value={s.id} />
                      <button className="btn-ghost px-2 py-1 text-xs">{s.active ? "Hold" : "Activate"}</button>
                    </form>
                    <form action={deleteTopicSource}>
                      <input type="hidden" name="id" value={s.id} />
                      <button className="btn-danger px-2 py-1 text-xs">Delete</button>
                    </form>
                  </div>
                </div>
                <pre className="text-[10px] mt-1 whitespace-pre-wrap">{JSON.stringify(s.config, null, 2)}</pre>
              </div>
            ))}
            {biz.topicSources.length === 0 && (
              <div className="text-gray-500 space-y-1">
                <div>None yet — add one. Example configs:</div>
                <div><code>daily_brief</code> (recommended): {`{ "industry": "B2B SaaS web dev", "audience": "tech founders" }`}</div>
                <div><code>reddit</code>: {`{ "subreddits": ["SaaS","marketing"], "time": "day" }`}</div>
                <div><code>grok_x</code>: {`{ "query": "trending B2B SaaS topics on X in the last 24h" }`}</div>
                <div><code>claude_seed</code>: {`{ "brief": "evergreen topics this brand should cover" }`}</div>
              </div>
            )}
          </div>
          <div className="border-t pt-3">
            <div className="text-xs font-medium text-gray-600 mb-2">
              {editingTopic ? `Edit topic source` : "Add topic source"}
            </div>
            <form action={editingTopic ? updateTopicSource : addTopicSource} className="grid grid-cols-1 gap-2">
              {editingTopic && <input type="hidden" name="id" value={editingTopic.id} />}
              <div>
                <label className="label">Kind</label>
                <select className="input" name="kind" defaultValue={editingTopic?.kind}>
                  <option value="daily_brief">daily_brief (Claude→Grok chain, recommended)</option>
                  <option value="reddit">reddit</option>
                  <option value="grok_x">grok_x</option>
                  <option value="claude_seed">claude_seed</option>
                  <option value="rss">rss</option>
                </select>
              </div>
              <div>
                <label className="label">Config (JSON)</label>
                <textarea
                  className="input font-mono text-xs"
                  name="config"
                  rows={4}
                  defaultValue={editingTopic ? JSON.stringify(editingTopic.config, null, 2) : `{
  "industry": "B2B SaaS web development & AI automation",
  "audience": "tech founders and product engineering teams",
  "topicsPerDay": null,
  "extraGuidance": "Cover ALL service categories over time, not just AI. Favor problem-solving and tutorial archetypes."
}`}
                />
                <div className="mt-1 text-xs text-gray-500 space-y-0.5">
                  <div><b>daily_brief</b> (recommended): industry, audience, topicsPerDay (null = use blog quota), extraGuidance — all optional. Now rotates across all services + 8 article archetypes automatically.</div>
                  <div><b>reddit</b>: <code>{`{ "subreddits": ["SaaS","marketing"], "time": "day" }`}</code></div>
                  <div><b>grok_x</b>: <code>{`{ "query": "trending B2B SaaS topics on X in the last 24h" }`}</code></div>
                  <div><b>claude_seed</b>: <code>{`{ "brief": "evergreen topics this brand should cover" }`}</code></div>
                </div>
              </div>
              {editingTopic && (
                <label className="text-xs flex items-center gap-2">
                  <input type="checkbox" name="active" defaultChecked={editingTopic.active} /> active
                </label>
              )}
              <button className="btn-primary">{editingTopic ? "Save changes" : "Add source"}</button>
              {editingTopic && (
                <a className="btn-ghost text-center" href={`/businesses/${biz.slug}`}>Cancel</a>
              )}
            </form>
          </div>
        </section>

        {/* ── Topics flagged for fresh research ────────────────────── */}
        <section className="card">
          <h2 className="font-medium mb-1">Topics flagged for fresh research</h2>
          <p className="text-xs text-gray-500 mb-3">
            <code>daily_brief</code> tags each topic by sensitivity. Time-sensitive and breaking topics may go stale between the 04:00 UTC research window and the time the blog actually drafts. Enable per-article research below to make Grok re-check just before drafting.
          </p>
          {flaggedTopics.length === 0 ? (
            <div className="text-xs text-gray-500">
              No flagged topics yet. Add a <code>daily_brief</code> Topic source and wait for the next research run (04:00 UTC daily).
            </div>
          ) : (
            <div className="grid gap-2 text-xs">
              {flaggedTopics.map((t) => {
                const sevBg = t.sensitivity === "breaking"
                  ? "bg-red-100 text-red-800"
                  : "bg-orange-100 text-orange-800";
                const raw = (t.raw ?? {}) as { whyNow?: string | null; enriched?: boolean };
                return (
                  <div key={t.id} className="rounded bg-gray-50 px-2 py-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium truncate">{t.title}</span>
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${sevBg}`}>
                            {t.sensitivity}
                          </span>
                          {raw.enriched && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-700">
                              has morning brief
                            </span>
                          )}
                          {t.freshResearchEnabled && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-800">
                              fresh research ON
                            </span>
                          )}
                        </div>
                        {raw.whyNow && (
                          <div className="text-gray-500 mt-0.5 italic">{raw.whyNow}</div>
                        )}
                        <div className="text-gray-400 mt-0.5">score {t.score.toFixed(0)} · added {t.createdAt.toISOString().slice(0, 10)}</div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <form action={toggleFreshResearch}>
                          <input type="hidden" name="id" value={t.id} />
                          <button className="btn-ghost px-2 py-1 text-xs">
                            {t.freshResearchEnabled ? "Disable fresh" : "Enable fresh"}
                          </button>
                        </form>
                        <form action={deleteTopicCandidate}>
                          <input type="hidden" name="id" value={t.id} />
                          <button className="btn-danger px-2 py-1 text-xs">Delete</button>
                        </form>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Integrations ──────────────────────────────────────────── */}
        <section className="card">
          <h2 className="font-medium mb-3">Integrations</h2>
          <div className="text-xs text-gray-500 mb-2">
            Stored encrypted (AES-256-GCM).
          </div>
          <div className="grid gap-2 text-xs mb-3">
            {biz.integrations.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-2 rounded bg-gray-50 px-2 py-1.5">
                <span className="font-medium">{i.kind}</span>
                <div className="flex items-center gap-1">
                  <a className="btn-ghost px-2 py-1 text-xs" href={`/businesses/${biz.slug}?editInt=${i.id}`}>Edit</a>
                  <form action={deleteIntegration}>
                    <input type="hidden" name="id" value={i.id} />
                    <button className="btn-danger px-2 py-1 text-xs">Delete</button>
                  </form>
                </div>
              </div>
            ))}
            {biz.integrations.length === 0 && <div className="text-gray-500">No integrations yet.</div>}
          </div>
          <div className="border-t pt-3">
            <div className="text-xs font-medium text-gray-600 mb-2">
              {editingInt ? `Edit integration: ${editingInt.kind}` : "Add / update integration"}
            </div>
            <form action={saveIntegration} className="grid grid-cols-1 gap-2">
              <div>
                <label className="label">Kind</label>
                <select className="input" name="kind" defaultValue={editingInt?.kind} disabled={!!editingInt}>
                  {INTEGRATION_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
                {editingInt && <input type="hidden" name="kind" value={editingInt.kind} />}
              </div>
              <div>
                <label className="label">Config (JSON — examples in README)</label>
                <textarea
                  className="input font-mono text-xs"
                  name="config"
                  rows={4}
                  defaultValue={editingInt ? editingIntConfig : `{ "linkedinProfileId": "...", "xProfileId": "...", "instagramProfileId": "..." }`}
                />
              </div>
              <button className="btn-primary">{editingInt ? "Save changes" : "Save integration"}</button>
              {editingInt && (
                <a className="btn-ghost text-center" href={`/businesses/${biz.slug}`}>Cancel</a>
              )}
            </form>
          </div>
        </section>
      </main>
    </div>
  );
}
