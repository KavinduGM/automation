import Link from "next/link";

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
    <aside className="w-56 shrink-0 border-r border-gray-200 bg-white p-4 min-h-screen">
      <div className="font-semibold text-brand-700 mb-4">Content Automation</div>
      <nav className="space-y-1">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className="block rounded px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
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
    </aside>
  );
}
