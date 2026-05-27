import { prisma } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";

export const dynamic = "force-dynamic";

export default async function Jobs() {
  await requireUser();
  const recent = await prisma.contentItem.findMany({
    orderBy: { updatedAt: "desc" },
    take: 50,
    include: { business: true },
  });
  return (
    <div className="flex flex-col md:flex-row">
      <Nav />
      <main className="flex-1 p-6 max-w-5xl">
        <h1 className="text-xl font-semibold mb-4">Recent activity</h1>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 text-left">
              <tr>
                <th className="py-1.5">When</th>
                <th>Business</th>
                <th>Type</th>
                <th>Title</th>
                <th>Status</th>
                <th className="text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-1.5 text-xs text-gray-500">{r.updatedAt.toISOString().replace("T"," ").slice(0,16)}</td>
                  <td className="text-xs">{r.business.name}</td>
                  <td className="text-xs">{r.type}</td>
                  <td><a className="hover:underline" href={`/content/${r.id}`}>{r.title || "(untitled)"}</a></td>
                  <td className="text-xs">{r.status}</td>
                  <td className="text-right text-xs">${r.costUsd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
