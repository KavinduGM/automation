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
    <div className="flex flex-col md:flex-row">
      <Nav />
      <main className="flex-1 p-6 max-w-4xl">
        <h1 className="text-xl font-semibold mb-1">Review queue ({items.length})</h1>
        <p className="text-xs text-gray-500 mb-4">
          Items here need a human decision. Anything tagged{" "}
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">
            bounced
          </span>{" "}
          came back from auto-review — open it to see what the reviewer found.
        </p>

        {items.length === 0 && <div className="card text-sm text-gray-500">Nothing pending review.</div>}

        <div className="space-y-2">
          {items.map((i) => {
            const meta = (i.meta ?? {}) as {
              lastFindings?: Array<{ area: string; message: string }>;
              autoFixAttempts?: number;
              autoFixExhausted?: boolean;
            };
            const bounced = (meta.lastFindings?.length ?? 0) > 0;
            const exhausted = meta.autoFixExhausted === true;

            return (
              <a
                key={i.id}
                href={`/content/${i.id}`}
                className={`card block hover:bg-gray-50 ${
                  bounced ? "border-red-200 bg-red-50/40" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="font-medium">{i.title || "(untitled)"}</div>
                      {bounced && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-xs font-medium">
                          bounced from auto-review
                        </span>
                      )}
                      {exhausted && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-xs font-medium">
                          auto-fix exhausted
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {i.business.name} · {i.type} · {i.bodyMd.length.toLocaleString()} chars
                      {meta.autoFixAttempts ? <> · {meta.autoFixAttempts} auto-fix attempt{meta.autoFixAttempts === 1 ? "" : "s"}</> : null}
                    </div>
                    {i.reviewNotes && (
                      <div className={`text-xs mt-2 line-clamp-3 whitespace-pre-line ${bounced ? "text-red-800" : "text-orange-700"}`}>
                        {i.reviewNotes}
                      </div>
                    )}
                  </div>
                  <StatusBadge status={i.status} />
                </div>
              </a>
            );
          })}
        </div>
      </main>
    </div>
  );
}
