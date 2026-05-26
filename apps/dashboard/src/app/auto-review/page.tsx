import Link from "next/link";
import { prisma } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";

// Auto-review hub. Four buckets ordered by urgency:
//   1. Auto-fixing       — reviewer rolled back, currently regenerating text or images
//   2. In-flight         — just published, reviewer hasn't fired yet (within 3-min delay)
//   3. Published as-is   — gave up after 2 attempts; still live, no further review
//   4. Recently OK       — last reviewed clean
//
// Each row shows a friendly status line ("Doing text changes · try 2/2"),
// the publish time (or last-checked time), and the top findings.

export const dynamic = "force-dynamic";

type Item = Awaited<ReturnType<typeof prisma.contentItem.findMany>>[number];
type Meta = {
  autoFixAttempts?: number;
  fixScope?: "text" | "images" | "both";
  postReview?: {
    overall?: "ok" | "warnings" | "critical";
    checkedAt?: string;
    findings?: Array<{ area: string; message: string; severity: string }>;
  };
  lastFindings?: Array<{ area: string; message: string; severity?: string }>;
  autoFixGivenUp?: boolean;
  autoFixExhausted?: boolean;
  imageErrors?: Array<{ ord: number; message: string }>;
};

const AUTO_FIX_BUSY_STATUSES = ["queued", "researching", "drafting", "generating_media", "self_critique"] as const;
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
            { meta: { path: ["autoFixAttempts"], gt: 0 } as never },
          ],
        },
      ],
    },
    include: { business: true },
    orderBy: { updatedAt: "desc" },
    take: 250,
  });

  const autoFixing: Item[] = [];
  const inFlight: Item[] = [];
  const publishedAsIs: Item[] = [];
  const reviewedOk: Item[] = [];

  for (const it of recent) {
    const meta = (it.meta ?? {}) as Meta;
    const busy = (AUTO_FIX_BUSY_STATUSES as readonly string[]).includes(it.status);
    if (busy && (meta.autoFixAttempts ?? 0) > 0) {
      autoFixing.push(it);
    } else if (it.status === "published" && meta.autoFixGivenUp) {
      publishedAsIs.push(it);
    } else if (it.status === "published" && !meta.postReview) {
      inFlight.push(it);
    } else if (it.status === "published" && meta.postReview?.overall === "ok") {
      reviewedOk.push(it);
    } else if (it.status === "published" && meta.postReview?.overall === "warnings") {
      // Warnings stay published but worth surfacing; treat as reviewed bucket
      reviewedOk.push(it);
    }
  }

  return (
    <div className="flex">
      <Nav />
      <main className="flex-1 p-6 max-w-5xl">
        <div className="flex items-baseline justify-between mb-6">
          <h1 className="text-xl font-semibold">Auto-review</h1>
          <div className="text-xs text-gray-500">
            Live-page checks fire ~3 min after publish · up to {MAX_ATTEMPTS} auto-fix retries · gives up after that
          </div>
        </div>

        <Bucket
          title="Auto-fixing"
          subtitle="Reviewer found issues — system is regenerating"
          items={autoFixing}
          empty="No auto-fix attempts in progress."
          tone="warning"
        />

        <Bucket
          title="In-flight"
          subtitle="Just published — reviewer fires in ~3 min"
          items={inFlight}
          empty="Nothing in flight."
          tone="info"
        />

        <Bucket
          title="Published as-is"
          subtitle={`Gave up after ${MAX_ATTEMPTS} attempts — kept live, no further review`}
          items={publishedAsIs}
          empty="Nothing here."
          tone="muted"
          showFindings
        />

        <Bucket
          title="Published correctly"
          subtitle="Last review came back clean (or warnings only)"
          items={reviewedOk.slice(0, 30)}
          empty="No reviewed items yet."
          tone="success"
        />
      </main>
    </div>
  );
}

function statusLine(it: Item): { label: string; tone: "info" | "warning" | "success" | "muted" | "critical" } {
  const meta = (it.meta ?? {}) as Meta;
  const attempts = meta.autoFixAttempts ?? 0;
  const scope = meta.fixScope ?? "both";
  const busy = (AUTO_FIX_BUSY_STATUSES as readonly string[]).includes(it.status);

  if (busy && attempts > 0) {
    let action = "Auto-fixing";
    if (scope === "text") {
      action = it.status === "generating_media" ? "Refreshing media" : "Doing text changes";
    } else if (scope === "images") {
      action = "Creating images";
    } else {
      action = it.status === "generating_media" ? "Creating images" : "Doing text changes";
    }
    return { label: `${action} · try ${attempts}/${MAX_ATTEMPTS}`, tone: "warning" };
  }
  if (it.status === "published" && meta.autoFixGivenUp) {
    return { label: `Published as-is · ${MAX_ATTEMPTS}/${MAX_ATTEMPTS} tries used`, tone: "muted" };
  }
  if (it.status === "published" && !meta.postReview) {
    return { label: "Awaiting review", tone: "info" };
  }
  if (it.status === "published" && meta.postReview?.overall === "ok") {
    return { label: "Published correctly", tone: "success" };
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
}: {
  title: string;
  subtitle: string;
  items: Item[];
  empty: string;
  tone: "info" | "warning" | "critical" | "success" | "muted";
  showFindings?: boolean;
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
                  {(showFindings || status.tone === "warning") && findings.length > 0 && (
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
