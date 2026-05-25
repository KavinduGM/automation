import { prisma } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { StatusBadge } from "@/components/StatusBadge";

export const dynamic = "force-dynamic";

export default async function ReviewQueue() {
  await requireUser();
  const items = await prisma.contentItem.findMany({
    where: { status: "review" },
    include: { business: true },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return (
    <div className="flex">
      <Nav />
      <main className="flex-1 p-6 max-w-4xl">
        <h1 className="text-xl font-semibold mb-4">Review queue ({items.length})</h1>
        {items.length === 0 && <div className="card text-sm text-gray-500">Nothing pending review.</div>}
        <div className="space-y-2">
          {items.map((i) => (
            <a key={i.id} href={`/content/${i.id}`} className="card flex items-center justify-between hover:bg-gray-50">
              <div>
                <div className="font-medium">{i.title || "(untitled)"}</div>
                <div className="text-xs text-gray-500">{i.business.name} · {i.type} · {i.bodyMd.length.toLocaleString()} chars</div>
                {i.reviewNotes && <div className="text-xs text-orange-700 mt-1 line-clamp-2">{i.reviewNotes}</div>}
              </div>
              <StatusBadge status={i.status} />
            </a>
          ))}
        </div>
      </main>
    </div>
  );
}
