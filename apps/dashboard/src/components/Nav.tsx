import Link from "next/link";

// Responsive sidebar / top-bar nav.
//   Mobile (< md): collapsed under a <details> with a hamburger summary.
//                   Renders as a full-width strip across the top.
//   Desktop (≥ md): fixed-width sidebar on the left.
// Uses <details> so we stay a Server Component (no useState / "use client").
export function Nav({ businessSlug }: { businessSlug?: string }) {
  const links = [
    { href: "/", label: "Overview" },
    { href: "/review", label: "Review queue" },
    { href: "/auto-review", label: "Auto-review" },
    { href: "/businesses", label: "Businesses" },
    { href: "/jobs", label: "Jobs" },
    { href: "/cost", label: "Cost" },
  ];
  return (
    <aside className="w-full md:w-56 shrink-0 border-b md:border-b-0 md:border-r border-gray-200 bg-white md:min-h-screen">
      {/* Mobile: collapsible header */}
      <details className="md:hidden group" open={false}>
        <summary className="flex items-center justify-between cursor-pointer list-none px-4 py-3 select-none">
          <div className="font-semibold text-brand-700">Content Automation</div>
          <span className="text-xs text-gray-500 group-open:hidden">Menu ▾</span>
          <span className="text-xs text-gray-500 hidden group-open:inline">Close ▴</span>
        </summary>
        <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-3">
          <nav className="grid grid-cols-2 gap-1">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="block rounded px-2 py-2 text-sm text-gray-700 hover:bg-gray-100"
              >
                {l.label}
              </Link>
            ))}
          </nav>
          {businessSlug && (
            <div className="text-xs text-gray-500">
              Active: <span className="text-gray-700">{businessSlug}</span>
            </div>
          )}
          <form action="/api/logout" method="POST">
            <button className="btn-ghost text-xs w-full text-left">Sign out</button>
          </form>
        </div>
      </details>

      {/* Desktop: always-on sidebar */}
      <div className="hidden md:block p-4">
        <div className="font-semibold text-brand-700 mb-4">Content Automation</div>
        <nav className="space-y-1">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="block rounded px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        {businessSlug && (
          <div className="mt-6 text-xs text-gray-500">
            Active: <span className="text-gray-700">{businessSlug}</span>
          </div>
        )}
        <form action="/api/logout" method="POST" className="mt-8">
          <button className="btn-ghost text-xs w-full text-left">Sign out</button>
        </form>
      </div>
    </aside>
  );
}
