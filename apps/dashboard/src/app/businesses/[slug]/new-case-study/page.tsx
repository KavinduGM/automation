import { prisma, queue, QUEUES, env } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { notFound, redirect } from "next/navigation";
import { writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";

export const dynamic = "force-dynamic";

// Server Component page for creating a new case study.
//
// The flow:
//   1. Admin fills bare-minimum text (clientName, problem, solution,
//      metric, testimonial) + uploads project images named by role
//      (cover.png, dashboard.png, mobile-app.png, etc).
//   2. Submitting the form runs the createCaseStudy server action:
//      - Creates the ContentItem + CaseStudyIntake row
//      - Writes each uploaded file to /app/assets/{biz}/case-study/{id}/{role}.{ext}
//      - Creates Asset rows with role=<derived from filename>
//      - Enqueues the draft job
//   3. The case-study pipeline expands the intake into the rich structured
//      case study and routes through approval like blog.
//
// Filename → role convention:
//   "cover.png"               → role="cover" (used as the hero/OG image)
//   "dashboard.png"           → role="dashboard"
//   "mobile-app.png"          → role="mobile_app"
//   "pillar-1-overview.png"   → role="pillar_1_overview"
// Roles are matched by Claude during expansion to specific pillar sections.

export default async function NewCaseStudyPage({ params }: { params: { slug: string } }) {
  await requireUser();
  const business = await prisma.business.findUnique({ where: { slug: params.slug } });
  if (!business) notFound();

  async function createCaseStudy(formData: FormData) {
    "use server";
    const biz = await prisma.business.findUniqueOrThrow({ where: { slug: params.slug } });
    const clientName = String(formData.get("clientName") ?? "").trim();
    const problem = String(formData.get("problem") ?? "").trim();
    const solution = String(formData.get("solution") ?? "").trim();
    const metric = String(formData.get("metric") ?? "").trim();
    if (!clientName || !problem || !solution || !metric) {
      throw new Error("clientName, problem, solution, metric are all required");
    }

    const item = await prisma.contentItem.create({
      data: {
        businessId: biz.id,
        type: "case_study",
        title: `${clientName}: ${metric}`,
        status: "queued",
      },
    });
    await prisma.caseStudyIntake.create({
      data: {
        contentItemId: item.id,
        clientName,
        problem,
        solution,
        metric,
        industry: optionalStr(formData.get("industry")),
        location: optionalStr(formData.get("location")),
        projectType: optionalStr(formData.get("projectType")),
        timeline: optionalStr(formData.get("timeline")),
        category: optionalStr(formData.get("category")),
        quote: optionalStr(formData.get("quote")),
        quoteAuthor: optionalStr(formData.get("quoteAuthor")),
        quoteRole: optionalStr(formData.get("quoteRole")),
        quoteFlag: optionalStr(formData.get("quoteFlag")),
      },
    });

    // Process uploaded images. Each <input type="file" name="images" multiple>
    // contribution lands as a File entry under "images".
    const files = formData.getAll("images").filter((v): v is File => v instanceof File && v.size > 0);
    const assetsDir = env().ASSETS_DIR.replace(/\/$/, "");
    const relDirParts = [biz.slug, "case-study", item.id];
    const targetDir = join(assetsDir, ...relDirParts);
    await mkdir(targetDir, { recursive: true });

    for (const file of files) {
      const original = file.name || "image";
      const ext = (extname(original) || ".png").toLowerCase();
      const baseRaw = original.slice(0, original.length - (extname(original)?.length || 0)) || "image";
      // role: lowercase, hyphens → underscores, alphanumeric + underscore only.
      const role = baseRaw
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/-/g, "_")
        .replace(/[^a-z0-9_]/g, "")
        || "image";
      const safeFilename = `${role}${ext}`;
      const abs = join(targetDir, safeFilename);
      const rel = join(...relDirParts, safeFilename);
      const buf = Buffer.from(await file.arrayBuffer());
      await writeFile(abs, buf);
      await prisma.asset.create({
        data: {
          businessId: biz.id,
          contentItemId: item.id,
          kind: "image",
          path: rel,
          provider: "user_upload",
          prompt: "",
          altText: humanizeRole(role) + " (case study image)",
          ord: role === "cover" ? 0 : 1,
          role,
          costUsd: 0,
        },
      });
    }

    await queue(QUEUES.draft).add(`case_study:${item.id}`, { contentItemId: item.id, type: "case_study" });
    redirect(`/content/${item.id}`);
  }

  return (
    <div className="flex flex-col md:flex-row">
      <Nav businessSlug={business.slug} />
      <main className="flex-1 p-6 max-w-3xl space-y-6">
        <div>
          <a href={`/businesses/${business.slug}`} className="text-xs text-brand-700 hover:underline">← Back to {business.name}</a>
          <h1 className="mt-2 text-xl font-semibold">New case study</h1>
          <p className="text-xs text-gray-500 mt-1">
            Fill the basics — AI expands them into a full long-form case study (5-6 problem cards, 3-5 solution pillars, 10+ results, 15 tech items, closing CTA). You provide real project images; the AI generates ONLY the cover (and only if you don&apos;t upload one).
          </p>
        </div>

        <form action={createCaseStudy} className="space-y-6" encType="multipart/form-data">
          {/* ── Client ─────────────────────────────────────────────── */}
          <section className="card space-y-3">
            <h2 className="font-medium">Client</h2>
            <div>
              <label className="label">Client name *</label>
              <input className="input" name="clientName" required placeholder="e.g. Australian YouTube Content Production Agency" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Industry</label>
                <input className="input" name="industry" placeholder="e.g. YouTube Content Production" />
              </div>
              <div>
                <label className="label">Location</label>
                <input className="input" name="location" placeholder="e.g. Australia" />
              </div>
              <div>
                <label className="label">Project type</label>
                <input className="input" name="projectType" placeholder="e.g. End-to-End Publishing Automation" />
              </div>
              <div>
                <label className="label">Timeline</label>
                <input className="input" name="timeline" placeholder="e.g. 1 week" />
              </div>
              <div className="sm:col-span-2">
                <label className="label">Category</label>
                <input className="input" name="category" placeholder="e.g. AI & Automation" />
              </div>
            </div>
          </section>

          {/* ── Story ──────────────────────────────────────────────── */}
          <section className="card space-y-3">
            <h2 className="font-medium">Story (bare minimum — AI expands)</h2>
            <div>
              <label className="label">Problem (2-3 sentences) *</label>
              <textarea className="input" name="problem" rows={3} required placeholder="What operational pain was the client running into? Be specific about the day-to-day breakdowns." />
            </div>
            <div>
              <label className="label">Solution (2-3 sentences) *</label>
              <textarea className="input" name="solution" rows={3} required placeholder="What did we build and how does it solve their problem? Architecture in plain words." />
            </div>
            <div>
              <label className="label">Headline metric *</label>
              <input className="input" name="metric" required placeholder='e.g. "+312% qualified leads" or "End-to-end pipeline automated"' />
            </div>
          </section>

          {/* ── Testimonial ────────────────────────────────────────── */}
          <section className="card space-y-3">
            <h2 className="font-medium">Testimonial (optional — used verbatim)</h2>
            <div>
              <label className="label">Quote</label>
              <textarea className="input" name="quote" rows={4} placeholder="Paste the client's quote verbatim — AI will never paraphrase it." />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="label">Name</label>
                <input className="input" name="quoteAuthor" placeholder="e.g. Liam Hartley" />
              </div>
              <div>
                <label className="label">Role</label>
                <input className="input" name="quoteRole" placeholder="e.g. Founder" />
              </div>
              <div>
                <label className="label">Flag emoji</label>
                <input className="input" name="quoteFlag" placeholder="e.g. 🇦🇺" />
              </div>
            </div>
          </section>

          {/* ── Images ─────────────────────────────────────────────── */}
          <section className="card space-y-3">
            <h2 className="font-medium">Project images</h2>
            <p className="text-xs text-gray-500">
              Real screenshots of the build. <b>Name each file with its role</b> — that&apos;s how the AI knows where to place it.
              Filename becomes the role (extension stripped, hyphens → underscores). Examples:
            </p>
            <ul className="text-xs text-gray-600 list-disc ml-5 space-y-0.5">
              <li><code>cover.png</code> → used as the hero/OG image (if omitted, AI generates a brand-templated cover)</li>
              <li><code>dashboard.png</code> → role <code>dashboard</code></li>
              <li><code>mobile-app.png</code> → role <code>mobile_app</code></li>
              <li><code>pillar-1-overview.png</code> → role <code>pillar_1_overview</code></li>
            </ul>
            <input
              type="file"
              name="images"
              multiple
              accept="image/png,image/jpeg,image/webp"
              className="block w-full text-sm text-gray-700 file:mr-3 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-brand-50 file:text-brand-700 hover:file:bg-brand-100"
            />
          </section>

          <div className="flex items-center gap-3">
            <button className="btn-primary">Save & start expansion</button>
            <a href={`/businesses/${business.slug}`} className="btn-ghost">Cancel</a>
          </div>
        </form>
      </main>
    </div>
  );
}

function optionalStr(v: FormDataEntryValue | null): string | null {
  if (v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function humanizeRole(role: string): string {
  return role.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}
