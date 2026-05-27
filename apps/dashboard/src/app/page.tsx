import { prisma } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { StatusBadge } from "@/components/StatusBadge";

// Live overview: counts by status per business + recently published items.

export const dynamic = "force-dynamic";

export default async function Overview() {
  await requireUser();
  const [byStatus, recent, businesses] = await Promise.all([
    prisma.contentItem.groupBy({
      by: ["businessId", "status"],
      _count: { _all: true },
    }),
    prisma.contentItem.findMany({
      where: { status: "published" },
      include: { business: true },
      orderBy: { publishedAt: "desc" },
      take: 10,
    }),
    prisma.business.findMany({ orderBy: { name: "asc" } }),
  ]);

  const byBiz: Record<string, Record<string, number>> = {};
  for (const r of byStatus) {
    byBiz[r.businessId] ??= {};
    byBiz[r.businessId]![r.status] = r._count._all;
  }

  return (
    <div className="flex flex-col md:flex-row">
      <Nav />
      <main className="flex-1 p-6 max-w-6xl">
        <h1 className="text-xl font-semibold mb-4">Overview</h1>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {businesses.map((b) => {
            const c = byBiz[b.id] ?? {};
            return (
              <div key={b.id} className="card">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{b.name}</div>
                  <a href={`/businesses/${b.slug}`} className="text-xs text-brand-700 hover:underline">manage</a>
                </div>
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                  <Cell label="queued"     n={c.queued ?? 0} />
                  <Cell label="drafting"   n={c.drafting ?? 0} />
                  <Cell label="review"     n={c.review ?? 0} />
                  <Cell label="approved"   n={c.approved ?? 0} />
                  <Cell label="published"  n={c.published ?? 0} />
                  <Cell label="failed"     n={c.failed ?? 0} />
                </div>
              </div>
            );
          })}
          {businesses.length === 0 && (
            <div className="card text-sm text-gray-500 col-span-3">
              No businesses yet. <a className="text-brand-700 underline" href="/businesses">Create one →</a>
            </div>
          )}
        </div>

        <h2 className="text-lg font-medium mt-8 mb-2">Recently published</h2>
        <div className="card divide-y">
          {recent.length === 0 && <div className="text-sm text-gray-500">Nothing published yet.</div>}
          {recent.map((r) => (
            <div key={r.id} className="py-2 flex items-center justify-between">
              <div>
                <a href={`/content/${r.id}`} className="text-sm font-medium hover:underline">{r.title}</a>
                <div className="text-xs text-gray-500">{r.business.name} · {r.type}</div>
              </div>
              <StatusBadge status={r.status} />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

function Cell({ label, n }: { label: string; n: number }) {
  return (
    <div className="flex items-center justify-between rounded bg-gray-50 px-2 py-1">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium">{n}</span>
    </div>
  );
}
