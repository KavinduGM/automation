import { prisma, seal, open } from "@ca/shared";
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
    await prisma.contentPlan.upsert({
      where: { businessId_contentType: { businessId: business.id, contentType } },
      create: { businessId: business.id, contentType, perPeriod, period, approvalMode, active },
      update: { perPeriod, period, approvalMode, active },
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
            {biz.contentPlans.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2 rounded bg-gray-50 px-2 py-1.5">
                <span className="flex-1">
                  <span className="font-medium">{p.contentType}</span> · {p.perPeriod}/{p.period} · {p.approvalMode} ·{" "}
                  <span className={`badge ${p.active ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-700"}`}>
                    {p.active ? "active" : "hold"}
                  </span>
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
            ))}
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
            {biz.topicSources.length === 0 && <div className="text-gray-500">None — add one. Reddit example config: {`{ "subreddits": ["SaaS","marketing"], "time": "day" }`}</div>}
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
                  rows={3}
                  defaultValue={editingTopic ? JSON.stringify(editingTopic.config, null, 2) : `{ "subreddits": ["SaaS"], "time": "day" }`}
                />
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
