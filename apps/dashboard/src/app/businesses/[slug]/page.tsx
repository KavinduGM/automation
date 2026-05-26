import { prisma, seal } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { notFound, redirect } from "next/navigation";
import type { ContentType, Period, ApprovalMode, TopicSourceKind } from "@prisma/client";

export const dynamic = "force-dynamic";

const CONTENT_TYPES: ContentType[] = ["blog","case_study","resource","social_post","landing_page","webinar"];
const PERIODS: Period[] = ["day","week","month"];
const MODES: ApprovalMode[] = ["auto","ai_review","human_review"];

export default async function BusinessDetail({ params }: { params: { slug: string } }) {
  await requireUser();
  const biz = await prisma.business.findUnique({
    where: { slug: params.slug },
    include: { brandKit: true, contentPlans: true, topicSources: true, integrations: true },
  });
  if (!biz) notFound();

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
    redirect(`/businesses/${params.slug}`);
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
    redirect(`/businesses/${params.slug}`);
  }

  async function addTopicSource(formData: FormData) {
    "use server";
    const business = await prisma.business.findUniqueOrThrow({ where: { slug: params.slug } });
    const kind = String(formData.get("kind")) as TopicSourceKind;
    const cfg = String(formData.get("config") ?? "{}");
    let config: object;
    try { config = JSON.parse(cfg); } catch { config = {}; }
    await prisma.topicSource.create({ data: { businessId: business.id, kind, config } });
    redirect(`/businesses/${params.slug}`);
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
    redirect(`/businesses/${params.slug}`);
  }

  return (
    <div className="flex">
      <Nav businessSlug={biz.slug} />
      <main className="flex-1 p-6 max-w-4xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold">{biz.name}</h1>
          <div className="text-xs text-gray-500">{biz.slug} · {biz.timezone}</div>
        </div>

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
              <div key={p.id} className="flex items-center justify-between rounded bg-gray-50 px-2 py-1">
                <span><span className="font-medium">{p.contentType}</span> · {p.perPeriod}/{p.period} · {p.approvalMode} · {p.active ? "on" : "off"}</span>
              </div>
            ))}
            {biz.contentPlans.length === 0 && <div className="text-gray-500">No plans yet — add one below.</div>}
          </div>
          <form action={savePlan} className="grid grid-cols-2 gap-2 items-end">
            <div>
              <label className="label">Type</label>
              <select className="input" name="contentType">{CONTENT_TYPES.map(t => <option key={t}>{t}</option>)}</select>
            </div>
            <div>
              <label className="label">Per period</label>
              <input className="input" type="number" min="1" max="50" name="perPeriod" defaultValue={1} />
            </div>
            <div>
              <label className="label">Period</label>
              <select className="input" name="period">{PERIODS.map(t => <option key={t}>{t}</option>)}</select>
            </div>
            <div>
              <label className="label">Approval</label>
              <select className="input" name="approvalMode">{MODES.map(t => <option key={t}>{t}</option>)}</select>
            </div>
            <label className="text-xs flex items-center gap-2 col-span-2">
              <input type="checkbox" name="active" defaultChecked /> active
            </label>
            <button className="btn-primary col-span-2">Save plan</button>
          </form>
        </section>

        {/* ── Topic sources ─────────────────────────────────────────── */}
        <section className="card">
          <h2 className="font-medium mb-3">Topic sources</h2>
          <div className="grid gap-2 text-xs mb-3">
            {biz.topicSources.map((s) => (
              <div key={s.id} className="rounded bg-gray-50 px-2 py-1">
                <span className="font-medium">{s.kind}</span> · last run: {s.lastRunAt ? new Date(s.lastRunAt).toISOString().slice(0,16) : "never"}
                <pre className="text-[10px] mt-1 whitespace-pre-wrap">{JSON.stringify(s.config, null, 2)}</pre>
              </div>
            ))}
            {biz.topicSources.length === 0 && <div className="text-gray-500">None — add one. Reddit example config: {`{ "subreddits": ["SaaS","marketing"], "time": "day" }`}</div>}
          </div>
          <form action={addTopicSource} className="grid grid-cols-1 gap-2">
            <div>
              <label className="label">Kind</label>
              <select className="input" name="kind">
                <option value="reddit">reddit</option>
                <option value="grok_x">grok_x</option>
                <option value="claude_seed">claude_seed</option>
                <option value="rss">rss</option>
              </select>
            </div>
            <div>
              <label className="label">Config (JSON)</label>
              <textarea className="input font-mono text-xs" name="config" rows={3} defaultValue={`{ "subreddits": ["SaaS"], "time": "day" }`} />
            </div>
            <button className="btn-primary">Add source</button>
          </form>
        </section>

        {/* ── Integrations ──────────────────────────────────────────── */}
        <section className="card">
          <h2 className="font-medium mb-3">Integrations</h2>
          <div className="text-xs text-gray-500 mb-2">
            Stored encrypted (AES-256-GCM). Existing: {biz.integrations.map(i => i.kind).join(", ") || "none"}.
          </div>
          <form action={saveIntegration} className="grid grid-cols-1 gap-2">
            <div>
              <label className="label">Kind</label>
              <select className="input" name="kind">
                <option value="buffer">buffer</option>
                <option value="youtube_proxy">youtube_proxy</option>
                <option value="canva">canva</option>
                <option value="site_db">site_db</option>
                <option value="site_revalidate">site_revalidate</option>
              </select>
            </div>
            <div>
              <label className="label">Config (JSON — examples in README)</label>
              <textarea className="input font-mono text-xs" name="config" rows={4} defaultValue={`{ "linkedinProfileId": "...", "xProfileId": "...", "instagramProfileId": "..." }`} />
            </div>
            <button className="btn-primary">Save integration</button>
          </form>
        </section>
      </main>
    </div>
  );
}
