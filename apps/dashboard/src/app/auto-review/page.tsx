import Link from "next/link";
import { prisma } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";

// Auto-review hub. Five buckets ordered by attention required:
//
//   1. Unpublished — needs admin    (status=review, meta.layoutFixExhausted)
//   2. Layout fixing                 (status=queued/etc, autoFixAttempts > 0)
//   3. Content fixing                (status=queued/etc, contentFixAttempts > 0)
//   4. In-flight                     (status=published, no postReview yet)
//   5. Published (recent)            (status=published with postReview)
//
// "Content" and "layout" are separate concerns:
//   - Content checks run pre-publish (AI critic, route.ts). 2 fix attempts,
//     then publish anyway. No human escalation for content.
//   - Layout checks run post-publish (post-review.ts). 2 fix attempts,
//     then UNPUBLISH and notify admin — layout damage is never left live.

export const dynamic = "force-dynamic";

type Item = Awaited<ReturnType<typeof prisma.contentItem.findMany>>[number];
type Meta = {
  autoFixAttempts?: number;       // layout-fix counter (legacy name)
  contentFixAttempts?: number;    // pre-publish content-fix counter
  fixScope?: "text" | "images" | "both";
  postReview?: {
    overall?: "ok" | "warnings" | "critical";
    checkedAt?: string;
    findings?: Array<{ area: string; message: string; severity: string }>;
  };
  lastFindings?: Array<{ area: string; message: string; severity?: string }>;
  layoutFixExhausted?: boolean;
  contentFixGivenUp?: boolean;
  imageErrors?: Array<{ ord: number; message: string }>;
};

const BUSY_STATUSES = ["queued", "researching", "drafting", "generating_media", "self_critique"] as const;
const MAX_ATTEMPTS = 2;

export default async function AutoReviewPage() {
  await requireUser();

  const recent = await prisma.contentItem.findMany({
    where: {
      OR: [
        { status: "published" },
        {
          AND: [
            { status: { in: ["queued", "researching", "drafting", "generating_media", "self_critique"] } },
            {
              OR: [
                { meta: { path: ["autoFixAttempts"], gt: 0 } as never },
                { meta: { path: ["contentFixAttempts"], gt: 0 } as never },
              ],
            },
          ],
        },
        { AND: [{ status: "review" }, { meta: { path: ["layoutFixExhausted"], equals: true } as never }] },
      ],
    },
    include: { business: true },
    orderBy: { updatedAt: "desc" },
    take: 250,
  });

  // For busy items, fetch the most recent pipeline event so we can show a
  // "currently on: X" chip. One query for all of them keeps this cheap.
  const busyIds = recent
    .filter((it) => ["queued", "researching", "drafting", "generating_media", "self_critique"].includes(it.status))
    .map((it) => it.id);
  const latestEvents = busyIds.length === 0 ? [] : await prisma.pipelineEvent.findMany({
    where: { contentItemId: { in: busyIds } },
    orderBy: { createdAt: "desc" },
    distinct: ["contentItemId"],
    take: busyIds.length * 3,
  });
  const eventByItem = new Map(latestEvents.map((e) => [e.contentItemId, e]));

  const unpublishedNeedsAdmin: Item[] = [];
  const layoutFixing: Item[] = [];
  const contentFixing: Item[] = [];
  const inFlight: Item[] = [];
  const publishedOk: Item[] = [];

  for (const it of recent) {
    const meta = (it.meta ?? {}) as Meta;
    const busy = (BUSY_STATUSES as readonly string[]).includes(it.status);
    if (it.status === "review" && meta.layoutFixExhausted) {
      unpublishedNeedsAdmin.push(it);
    } else if (busy && (meta.autoFixAttempts ?? 0) > 0) {
      layoutFixing.push(it);
    } else if (busy && (meta.contentFixAttempts ?? 0) > 0) {
      contentFixing.push(it);
    } else if (it.status === "published" && !meta.postReview) {
      inFlight.push(it);
    } else if (it.status === "published" && meta.postReview) {
      publishedOk.push(it);
    }
  }

  return (
    <div className="flex flex-col md:flex-row">
      <Nav />
      <main className="flex-1 p-6 max-w-5xl">
        <div className="flex items-baseline justify-between mb-6">
          <h1 className="text-xl font-semibold">Auto-review</h1>
          <div className="text-xs text-gray-500">
            Content checked pre-publish · Layout checked post-publish · {MAX_ATTEMPTS} auto-fix tries each
          </div>
        </div>

        <Bucket
          title="Needs admin — unpublished"
          subtitle={`Layout fix exhausted after ${MAX_ATTEMPTS} attempts. Page is OFF. Open to review and re-approve.`}
          items={unpublishedNeedsAdmin}
          empty="Nothing waiting on admin."
          tone="critical"
          showFindings
        />

        <Bucket
          title="Layout fixing"
          subtitle="Layout reviewer rolled the page back — system is regenerating"
          items={layoutFixing}
          empty="No layout fixes in progress."
          tone="warning"
          showFindings
          latestEvents={eventByItem}
        />

        <Bucket
          title="Content fixing"
          subtitle="AI critic flagged content issues pre-publish — re-drafting"
          items={contentFixing}
          empty="No content fixes in progress."
          tone="warning"
          latestEvents={eventByItem}
        />

        <Bucket
          title="In-flight"
          subtitle="Just published — layout reviewer fires in ~3 min"
          items={inFlight}
          empty="Nothing in flight."
          tone="info"
        />

        <Bucket
          title="Recently published"
          subtitle="Last layout review result"
          items={publishedOk.slice(0, 30)}
          empty="No reviewed items yet."
          tone="success"
        />
      </main>
    </div>
  );
}

function statusLine(it: Item): { label: string; tone: "info" | "warning" | "success" | "muted" | "critical" } {
  const meta = (it.meta ?? {}) as Meta;
  const layoutN = meta.autoFixAttempts ?? 0;
  const contentN = meta.contentFixAttempts ?? 0;
  const scope = meta.fixScope ?? "both";
  const busy = (BUSY_STATUSES as readonly string[]).includes(it.status);

  if (it.status === "review" && meta.layoutFixExhausted) {
    return { label: `Unpublished · layout ${MAX_ATTEMPTS}/${MAX_ATTEMPTS} tries used`, tone: "critical" };
  }
  if (busy && layoutN > 0) {
    let action = "Auto-fixing layout";
    if (scope === "text") action = it.status === "generating_media" ? "Refreshing media" : "Patching text for layout";
    else if (scope === "images") action = "Creating images";
    else action = it.status === "generating_media" ? "Creating images" : "Patching layout";
    return { label: `${action} · try ${layoutN}/${MAX_ATTEMPTS}`, tone: "warning" };
  }
  if (busy && contentN > 0) {
    return { label: `Redrafting (content critic) · try ${contentN}/${MAX_ATTEMPTS}`, tone: "warning" };
  }
  if (it.status === "published" && !meta.postReview) {
    return { label: "Awaiting layout review", tone: "info" };
  }
  if (it.status === "published" && meta.postReview?.overall === "ok") {
    if (meta.contentFixGivenUp) return { label: "Published · content fix exhausted", tone: "muted" };
    return { label: "Published — layout OK", tone: "success" };
  }
  if (it.status === "published" && meta.postReview?.overall === "warnings") {
    return { label: "Published with warnings", tone: "info" };
  }
  return { label: it.status, tone: "muted" };
}

function fmtTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function Bucket({
  title,
  subtitle,
  items,
  empty,
  tone,
  showFindings,
  latestEvents,
}: {
  title: string;
  subtitle: string;
  items: Item[];
  empty: string;
  tone: "info" | "warning" | "critical" | "success" | "muted";
  showFindings?: boolean;
  latestEvents?: Map<string, { step: string; label: string | null; status: string }>;
}) {
  const toneClasses = {
    info:     "border-gray-200 bg-white",
    warning:  "border-orange-200 bg-orange-50/60",
    critical: "border-red-200 bg-red-50/60",
    success:  "border-green-200 bg-green-50/40",
    muted:    "border-gray-200 bg-gray-50/60",
  }[tone];
  const dotClasses = {
    info:     "bg-gray-400",
    warning:  "bg-orange-500",
    critical: "bg-red-500",
    success:  "bg-green-500",
    muted:    "bg-gray-400",
  }[tone];

  return (
    <section className="mb-8">
      <div className="flex items-baseline gap-3 mb-2">
        <h2 className="font-medium text-base">{title}</h2>
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
          <span className={`w-1.5 h-1.5 rounded-full ${dotClasses}`} />
          {items.length}
        </span>
      </div>
      <p className="text-xs text-gray-500 mb-3">{subtitle}</p>
      <div className={`rounded-lg border ${toneClasses}`}>
        {items.length === 0 && <div className="p-4 text-sm text-gray-500">{empty}</div>}
        {items.map((it) => {
          const meta = (it.meta ?? {}) as Meta;
          const status = statusLine(it);
          const findings = (meta.lastFindings ?? meta.postReview?.findings ?? [])
            .filter((f) => (f as { severity?: string }).severity !== "low");
          const publishedAt = it.publishedAt ? fmtTime(it.publishedAt) : null;
          const checkedAt = meta.postReview?.checkedAt ? fmtTime(meta.postReview.checkedAt) : null;
          return (
            <Link
              key={it.id}
              href={`/content/${it.id}`}
              className="block px-4 py-3 border-b last:border-b-0 hover:bg-black/[0.02] transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm truncate">{it.title || "(untitled)"}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {(it as Item & { business: { name: string } }).business.name} · {it.type}
                    {publishedAt && <> · published {publishedAt}</>}
                    {checkedAt && <> · checked {checkedAt}</>}
                    {!publishedAt && <> · updated {fmtTime(it.updatedAt)}</>}
                  </div>
                  {showFindings && findings.length > 0 && (
                    <ul className="mt-2 text-xs text-gray-700 space-y-0.5">
                      {findings.slice(0, 3).map((f, idx) => (
                        <li key={idx} className="truncate">
                          <span className="text-gray-400">[{(f as { area?: string }).area ?? "issue"}]</span>{" "}
                          {(f as { message?: string }).message ?? ""}
                        </li>
                      ))}
                      {findings.length > 3 && (
                        <li className="text-gray-500 italic">…and {findings.length - 3} more</li>
                      )}
                    </ul>
                  )}
                  {latestEvents && latestEvents.has(it.id) && (() => {
                    const ev = latestEvents.get(it.id)!;
                    const evDotTone =
                      ev.status === "started"   ? "bg-blue-500 animate-pulse" :
                      ev.status === "failed"    ? "bg-red-500" :
                      ev.status === "warning"   ? "bg-amber-500" :
                                                   "bg-green-500";
                    return (
                      <div className="mt-2 inline-flex items-center gap-1.5 text-xs text-gray-700 bg-white border border-gray-200 px-2 py-0.5 rounded">
                        <span className={`w-1.5 h-1.5 rounded-full ${evDotTone}`} />
                        Currently on: <span className="font-medium">{ev.label || ev.step}</span>
                      </div>
                    );
                  })()}
                </div>
                <StatusPill label={status.label} tone={status.tone} />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function StatusPill({ label, tone }: { label: string; tone: "info" | "warning" | "success" | "muted" | "critical" }) {
  const classes = {
    info:     "bg-gray-100 text-gray-700",
    warning:  "bg-orange-100 text-orange-800",
    success:  "bg-green-100 text-green-800",
    muted:    "bg-gray-100 text-gray-600",
    critical: "bg-red-100 text-red-800",
  }[tone];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${classes}`}>
      {label}
    </span>
  );
}
