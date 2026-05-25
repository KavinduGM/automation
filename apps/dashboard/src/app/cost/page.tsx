import { prisma } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";

export const dynamic = "force-dynamic";

export default async function CostPage() {
  await requireUser();
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0,0,0,0);

  const rows = await prisma.contentItem.groupBy({
    by: ["businessId", "type"],
    where: { createdAt: { gte: start } },
    _sum: { costUsd: true },
    _count: { _all: true },
  });
  const businesses = await prisma.business.findMany();
  const byId = Object.fromEntries(businesses.map(b => [b.id, b]));

  const grouped: Record<string, Array<{ type: string; cost: number; n: number }>> = {};
  for (const r of rows) {
    grouped[r.businessId] ??= [];
    grouped[r.businessId]!.push({ type: r.type, cost: r._sum.costUsd ?? 0, n: r._count._all });
  }

  const totalMonth = rows.reduce((a, r) => a + (r._sum.costUsd ?? 0), 0);

  return (
    <div className="flex">
      <Nav />
      <main className="flex-1 p-6 max-w-3xl">
        <h1 className="text-xl font-semibold mb-1">Cost (month-to-date)</h1>
        <div className="text-sm text-gray-500 mb-4">Total across all businesses: <span className="font-medium text-gray-900">${totalMonth.toFixed(2)}</span></div>
        <div className="space-y-3">
          {Object.entries(grouped).map(([bid, list]) => {
            const subtotal = list.reduce((a, l) => a + l.cost, 0);
            return (
              <div key={bid} className="card">
                <div className="flex justify-between mb-2">
                  <div className="font-medium">{byId[bid]?.name ?? bid}</div>
                  <div className="text-sm">${subtotal.toFixed(2)}</div>
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {list.map((l) => (
                      <tr key={l.type} className="border-t">
                        <td className="py-1.5 text-gray-600">{l.type}</td>
                        <td className="py-1.5 text-right text-gray-500">{l.n} items</td>
                        <td className="py-1.5 text-right">${l.cost.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
