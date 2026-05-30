import { prisma } from "@ca/shared";
import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Per-business YouTube channel connection panel.
//
// Admin clicks "Connect new channel" → OAuth flow → returns here with one
// or more YouTubeChannel rows saved. From here they can:
//   - See last refresh time + any refresh errors
//   - Mark one as the active publish target for ShortVideoPlan
//   - Disconnect a channel (deletes the row + revokes consent serverside is optional)

export default async function YouTubeConnectPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: { ok?: string; ytError?: string };
}) {
  await requireUser();
  const biz = await prisma.business.findUnique({ where: { slug: params.slug } });
  if (!biz) notFound();
  const channels = await prisma.youTubeChannel.findMany({
    where: { businessId: biz.id },
    orderBy: { createdAt: "desc" },
  });
  const plan = await prisma.shortVideoPlan.findUnique({ where: { businessId: biz.id } });

  async function disconnect(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    await prisma.youTubeChannel.delete({ where: { id } });
    redirect(`/businesses/${params.slug}/youtube?ok=disconnected`);
  }

  async function setAsPublishTarget(formData: FormData) {
    "use server";
    const id = String(formData.get("id"));
    const business = await prisma.business.findUniqueOrThrow({ where: { slug: params.slug } });
    await prisma.shortVideoPlan.upsert({
      where: { businessId: business.id },
      create: {
        businessId: business.id,
        youtubeChannelRowId: id,
      },
      update: { youtubeChannelRowId: id },
    });
    redirect(`/businesses/${params.slug}/youtube?ok=publishTargetSet`);
  }

  const okMessage = searchParams?.ok ? OK_MESSAGES[searchParams.ok] : null;

  return (
    <div className="flex flex-col md:flex-row">
      <Nav businessSlug={biz.slug} />
      <main className="flex-1 p-6 max-w-3xl space-y-4">
        <div>
          <a href={`/businesses/${biz.slug}`} className="text-xs text-brand-700 hover:underline">← {biz.name}</a>
          <h1 className="mt-2 text-xl font-semibold">YouTube channels</h1>
          <p className="text-xs text-gray-500 mt-1">
            Connect the YouTube channels this business publishes shorts to. Each connection grants this app permission to upload videos with scheduled <code>publishAt</code> times.
          </p>
        </div>

        {okMessage && (
          <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            {okMessage}
          </div>
        )}
        {searchParams?.ytError && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 whitespace-pre-wrap">
            <b>YouTube OAuth failed:</b> {decodeURIComponent(searchParams.ytError)}
          </div>
        )}

        <section className="card">
          <h2 className="font-medium mb-3">Connected channels ({channels.length})</h2>
          {channels.length === 0 ? (
            <div className="text-xs text-gray-500 mb-3">No channels connected yet.</div>
          ) : (
            <ul className="space-y-2">
              {channels.map((c) => {
                const isActive = plan?.youtubeChannelRowId === c.id;
                return (
                  <li key={c.id} className="rounded border border-gray-200 bg-gray-50 p-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">
                          {c.channelTitle}
                          {c.channelHandle && <span className="text-xs text-gray-500 ml-2">{c.channelHandle}</span>}
                          {isActive && <span className="ml-2 inline-block bg-green-100 text-green-800 px-1.5 py-0.5 text-[10px] rounded">active publish target</span>}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5 break-all">
                          channelId: <code>{c.youtubeChannelId}</code>
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          Last refreshed: {c.lastRefreshedAt ? c.lastRefreshedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never"}
                        </div>
                        {c.refreshError && (
                          <div className="text-xs text-red-700 mt-1">
                            <b>Refresh error</b> ({c.refreshErrorAt?.toISOString().slice(0,16)}): {c.refreshError}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-1 shrink-0">
                        {!isActive && (
                          <form action={setAsPublishTarget}>
                            <input type="hidden" name="id" value={c.id} />
                            <button className="btn-ghost text-xs">Set as publish target</button>
                          </form>
                        )}
                        <form action={disconnect}>
                          <input type="hidden" name="id" value={c.id} />
                          <button className="btn-danger text-xs">Disconnect</button>
                        </form>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-4">
            <a
              href={`/api/youtube/oauth/start?businessId=${biz.id}`}
              className="btn-primary text-sm inline-flex items-center"
            >
              {channels.length === 0 ? "Connect a YouTube channel" : "Connect another channel"}
            </a>
          </div>
        </section>

        <section className="card text-xs text-gray-600 space-y-2">
          <h3 className="font-medium text-sm text-gray-900">Setup checklist</h3>
          <ol className="list-decimal ml-5 space-y-1">
            <li>In Google Cloud Console: create an OAuth client (Web application).</li>
            <li>Set the authorized redirect URI to: <code className="break-all">{`${process.env.DASHBOARD_URL ?? "https://your-dashboard"}/api/youtube/oauth/callback`}</code></li>
            <li>OAuth consent screen: choose <b>Internal</b> if you have Workspace (no expiry, no verification). Otherwise External + add yourself as test user.</li>
            <li>Enable the YouTube Data API v3 on the project.</li>
            <li>Add the client id + secret to env: <code>GOOGLE_OAUTH_CLIENT_ID</code> + <code>GOOGLE_OAUTH_CLIENT_SECRET</code></li>
            <li>Click <b>Connect a YouTube channel</b> above. Sign in with the Google account that owns the channel. Grant all three YouTube scopes when asked.</li>
          </ol>
        </section>
      </main>
    </div>
  );
}

const OK_MESSAGES: Record<string, string> = {
  connected: "YouTube channel connected. Refresh token saved (encrypted).",
  disconnected: "YouTube channel disconnected.",
  publishTargetSet: "Publish target set. New shorts for this business will upload to that channel.",
};
