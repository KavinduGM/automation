# YouTube Automation integration — patch instructions

The Content Automation system calls the existing YouTube Automation project
(`/Users/kavindugamlath/Desktop/YouTube Automation`) over HTTP to schedule
webinar uploads. The YT app already has all the publishing logic — it just
needs two small additions so service-to-service requests work without a
browser session:

1. A **bearer-token middleware** so calls authenticate via `Authorization`
   header (not the existing email-based session cookies).
2. A **`POST /api/items`** route that creates a `planned` item from JSON.

Apply these two edits to the YT project, redeploy it, and the integration
works.

---

## 1. Add the bearer token to YT's env

In the YT project's `.env`:

```bash
AUTOMATION_BEARER=$(openssl rand -hex 32)
```

Add the same value to **this** project's `.env`:

```bash
YT_AUTOMATION_API_TOKEN=<same value>
YT_AUTOMATION_API_URL=http://yt-api:4000   # if both stacks share the docker network
```

If the YT stack runs in a different Dokploy project, expose its API on a
subdomain (e.g. `https://yt-api.groovymark.com`) and put that URL here.

---

## 2. Patch the YT API — copy-paste ready

Open `apps/api/src/index.ts` (or wherever Fastify is initialised) and add:

```ts
// ── Bearer token middleware for service-to-service calls ──────────────────
// Place this BEFORE the existing route registrations.
fastify.addHook("onRequest", async (req, reply) => {
  // Only enforce on /api/* routes; let /oauth, /health etc. through.
  if (!req.url.startsWith("/api/")) return;

  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    if (process.env.AUTOMATION_BEARER && token === process.env.AUTOMATION_BEARER) {
      // mark request as service-authenticated; bypass cookie session checks
      (req as any).serviceAuth = true;
      return;
    }
  }
  // fall through to existing session-cookie auth
});
```

Then, in the same file, register the new route (adjust the import of the
Prisma client to match the existing pattern):

```ts
import { prisma } from "@yt/shared";  // or wherever yours lives

fastify.post("/api/items", async (req, reply) => {
  if (!(req as any).serviceAuth) return reply.code(401).send({ error: "unauthorized" });

  const body = req.body as {
    channel: "OAP" | "OAG" | "NUR";
    type: "long" | "short";
    scheduledPublishAt: string;
    title: string;
    description: string;
    tags?: string[];
    filename: string;
    thumbnailFilename?: string;
    source?: string;
    sourceRef?: string;
  };

  if (!body.channel || !body.type || !body.filename || !body.title) {
    return reply.code(400).send({ error: "channel/type/filename/title required" });
  }

  // Resolve the Channel row by code (OAP/OAG/NUR → channelId).
  // The exact column name depends on your schema — adjust if yours differs.
  const channel = await prisma.channel.findFirst({
    where: { code: body.channel },
  });
  if (!channel) return reply.code(404).send({ error: `channel ${body.channel} not found` });

  const item = await prisma.item.create({
    data: {
      channelId: channel.id,
      type: body.type,
      status: "planned",
      filename: body.filename,
      thumbnailFilename: body.thumbnailFilename ?? null,
      title: body.title,
      description: body.description,
      tags: body.tags ?? [],
      scheduledPublishAt: new Date(body.scheduledPublishAt),
      // Optional traceability — these columns are nullable in your schema.
      // If they don't exist, drop them or add them via a migration.
      // source: body.source ?? "automation",
      // sourceRef: body.sourceRef ?? null,
    },
  });

  return reply.code(201).send({ id: item.id });
});
```

> **Schema check:** look at `prisma/schema.prisma` in the YT project. If the
> `Item` model is named `Video` (or similar), adjust `prisma.item.create` to
> match. The fields above (`channelId`, `type`, `status`, `filename`,
> `thumbnailFilename`, `title`, `description`, `tags`, `scheduledPublishAt`)
> all exist per the README's status lifecycle and filename convention.

---

## 3. Add `AUTOMATION_BEARER` to YT's docker-compose

In the YT `docker-compose.yml`, find every service that already lists env
vars and add the new one alongside:

```yaml
  api:
    environment:
      # … existing vars …
      AUTOMATION_BEARER: ${AUTOMATION_BEARER}
```

---

## 4. Optional: connect the docker networks

If both stacks live on the same VPS, share the network so the automation
worker reaches the YT API by container name (`http://yt-api:4000`) without
exposing it publicly.

Both compose files already include `dokploy-network: external: true`, so they
join the same Dokploy overlay automatically. Just make sure each YT service's
`networks:` array contains `dokploy-network` and that this project's
`YT_AUTOMATION_API_URL` is `http://<yt-api-service-name>:4000`.

---

## 5. Verify

After both stacks are up:

```bash
curl -X POST http://yt-api:4000/api/items \
  -H "Authorization: Bearer $AUTOMATION_BEARER" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "OAP",
    "type": "long",
    "filename": "OAP_2026-06-W1_long_1.mp4",
    "title": "Test webinar",
    "description": "Verification",
    "scheduledPublishAt": "2026-06-07T14:00:00Z"
  }'
```

Expect `201` with `{"id":"<cuid>"}`. The YT dashboard's items list will show
a `planned` row waiting for the Drive file with that exact filename.
