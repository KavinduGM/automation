import Link from "next/link";
import { prisma } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { StatusBadge } from "@/components/StatusBadge";

// Auto-review hub. Three buckets:
//   1. In-flight   — published items whose 3-minute reviewer hasn't fired yet
//                    (status = published AND no meta.postReview)
//   2. Auto-fixing — items the reviewer rolled back that are mid-regeneration
//                    (meta.autoFixAttempts > 0 AND status in queued/researching/drafting/generating_media)
//   3. Rollbacks   — recent rollbacks now in human review with auto-fix done
//                    (status = review AND meta.lastFindings present)
//
// All buckets link straight to /content/[id] so the operator can drill in.

export const dynamic = "force-dynamic";

type Item = Awaited<ReturnType<typeof prisma.contentItem.findMany>>[number];

const AUTO_FIX_BUSY_STATUSES = ["queued", "researching", "drafting", "generating_media", "self_critique"] as const;

export default async function AutoReviewPage() {
  await requireUser();

  // Pull a generous window of recent activity in one query, then bucket
  // client-side. Faster than three separate queries for a busy install.
  const recent = await prisma.contentItem.findMany({
    where: {
      OR: [
        { status: "published" },
        {
          AND: [
            { status: { in: ["queued", "researching", "drafting", "generating_media", "self_critique", "review"] } },
            { meta: { path: ["autoFixAttempts"], gt: 0 } as never }, // narrow Prisma JSON filter
          ],
        },
      ],
    },
    include: { business: true },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  const inFlight: Item[] = [];
  const autoFixing: Item[] = [];
  const rolledBack: Item[] = [];

  for (const it of recent) {
    const meta = (it.meta ?? {}) as { postReview?: { overall?: string; checkedAt?: string }; autoFixAttempts?: number; lastFindings?: unknown[] };
    if (it.status === "published" && !meta.postReview) {
      inFlight.push(it);
    } else if ((meta.autoFixAttempts ?? 0) > 0 && (AUTO_FIX_BUSY_STATUSES as readonly string[]).includes(it.status)) {
      autoFixing.push(it);
    } else if (it.status === "review" && meta.lastFindings && Array.isArray(meta.lastFindings) && meta.lastFindings.length > 0) {
      rolledBack.push(it);
    }
  }

  return (
    <div className="flex">
      <Nav />
      <main className="flex-1 p-6 max-w-5xl">
        <div className="flex items-baseline justify-between mb-6">
          <h1 className="text-xl font-semibold">Auto-review</h1>
          <div className="text-xs text-gray-500">
            Live-page checks fire ~3 minutes after publish · up to 2 auto-fix retries per item
          </div>
        </div>

        <Bucket
          title="In-flight"
          subtitle="Recently published — reviewer hasn't fired yet"
          items={inFlight}
          empty="Nothing in flight."
          tone="info"
        />

        <Bucket
          title="Auto-fixing"
          subtitle="Rolled back by the reviewer, currently regenerating"
          items={autoFixing}
          empty="No auto-fix attempts in progress."
          tone="warning"
          showAttempts
        />

        <Bucket
          title="Recent rollbacks (in human review)"
          subtitle="Auto-fix exhausted or content type doesn't auto-fix — needs your eyes"
          items={rolledBack}
          empty="No rolled-back items waiting on humans."
          tone="critical"
          showFindings
        />
      </main>
    </div>
  );
}

function Bucket({
  title,
  subtitle,
  items,
  empty,
  tone,
  showAttempts,
  showFindings,
}: {
  title: string;
  subtitle: string;
  items: Item[];
  empty: string;
  tone: "info" | "warning" | "critical";
  showAttempts?: boolean;
  showFindings?: boolean;
}) {
  const toneClasses = {
    info:     "border-gray-200 bg-white",
    warning:  "border-orange-200 bg-orange-50/60",
    critical: "border-red-200 bg-red-50/60",
  }[tone];
  const dotClasses = {
    info:     "bg-gray-400",
    warning:  "bg-orange-500",
    critical: "bg-red-500",
  }[tone];

  return (
    <section className="mb-8">
      <div className="flex items-baseline gap-3 mb-2">
        <h2 className="font-medium text-base">{title}</h2>
        <span className={`inline-flex items-center gap-1.5 text-xs text-gray-500`}>
          <span className={`w-1.5 h-1.5 rounded-full ${dotClasses}`} />
          {items.length}
        </span>
      </div>
      <p className="text-xs text-gray-500 mb-3">{subtitle}</p>
      <div className={`rounded-lg border ${toneClasses}`}>
        {items.length === 0 && <div className="p-4 text-sm text-gray-500">{empty}</div>}
        {items.map((it) => {
          const meta = (it.meta ?? {}) as {
            autoFixAttempts?: number;
            postReview?: { overall?: string; findings?: Array<{ area: string; message: string; severity: string }> };
            lastFindings?: Array<{ area: string; message: string }>;
            autoFixExhausted?: boolean;
          };
          const findings = (meta.lastFindings ?? meta.postReview?.findings ?? []).filter((f) => (f as { severity?: string }).severity !== "low");
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
                    {(it as Item & { business: { name: string } }).business.name} · {it.type} · {it.updatedAt.toISOString().replace("T", " ").slice(0, 16)}
                    {showAttempts && meta.autoFixAttempts ? <> · attempt {meta.autoFixAttempts}/2</> : null}
                    {meta.autoFixExhausted ? <> · <span className="text-red-700 font-medium">retries exhausted</span></> : null}
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
                </div>
                <StatusBadge status={it.status} />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
