import { prisma } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { redirect } from "next/navigation";
import slugify from "slugify";

export const dynamic = "force-dynamic";

export default async function BusinessesPage() {
  await requireUser();
  const businesses = await prisma.business.findMany({ orderBy: { name: "asc" } });

  async function create(formData: FormData) {
    "use server";
    const name = String(formData.get("name") ?? "").trim();
    if (!name) return;
    const slug = slugify(name, { lower: true, strict: true });
    await prisma.business.create({ data: { name, slug } });
    redirect(`/businesses/${slug}`);
  }

  return (
    <div className="flex">
      <Nav />
      <main className="flex-1 p-6 max-w-3xl">
        <h1 className="text-xl font-semibold mb-4">Businesses</h1>
        <div className="card mb-6">
          <form action={create} className="flex gap-2">
            <input className="input flex-1" name="name" placeholder="Business name (e.g. GroovyMark WebX)" />
            <button className="btn-primary">Create</button>
          </form>
        </div>

        <div className="card divide-y">
          {businesses.length === 0 && <div className="text-sm text-gray-500">No businesses yet.</div>}
          {businesses.map((b) => (
            <a key={b.id} href={`/businesses/${b.slug}`} className="flex items-center justify-between py-3 hover:bg-gray-50 px-2 -mx-2 rounded">
              <div>
                <div className="font-medium">{b.name}</div>
                <div className="text-xs text-gray-500">{b.slug} · {b.active ? "active" : "paused"}</div>
              </div>
              <span className="text-xs text-brand-700">manage →</span>
            </a>
          ))}
        </div>
      </main>
    </div>
  );
}
