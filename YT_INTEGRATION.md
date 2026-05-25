# YouTube Automation integration

> **Status: already implemented in the YT project.**
> Commit `501a9e1` on
> [`KavinduGM/YouTube_automation`](https://github.com/KavinduGM/YouTube_automation)
> adds the `/automation/*` routes referenced below. You don't need to
> hand-patch anything — just pull and redeploy that project after setting
> `AUTOMATION_BEARER`.

## What was added on the YT side

- `apps/api/src/routes/automation.ts` — new Fastify plugin mounted at
  `/automation/*`, with its own bearer-token auth hook scoped to this
  plugin only (existing cookie-session routes under `/items`, `/auth`,
  etc. are untouched).
- `POST /automation/items` — creates a planned `ContentItem` from JSON;
  the existing detection → Drive-match → upload pipeline takes over from
  there.
- `GET  /automation/ping` — liveness probe (bearer-protected).
- `AUTOMATION_BEARER` added to `packages/shared/src/env.ts` (optional;
  when unset, every `/automation/*` route returns 503).
- `AUTOMATION_BEARER: ${AUTOMATION_BEARER:-}` added to the `api` service
  in `docker-compose.yml`.

Channel resolution uses the existing `Channel.filenamePrefix` column
(e.g. `OAP` / `OAG` / `NUR`), so **no schema change is required**.
Source traceability is written to a `ContentEvent` row of type
`created_by_automation`.

---

## Deploy steps

### 1. Set the bearer token on both sides

Generate one shared token:

```bash
openssl rand -hex 32
```

In the **YouTube Automation** `.env` (or Dokploy env tab):

```bash
AUTOMATION_BEARER=<the token>
```

In the **Content Automation** `.env`:

```bash
YT_AUTOMATION_API_TOKEN=<the same token>
YT_AUTOMATION_API_URL=http://yt-api:4000     # if both stacks share the docker network
# or
YT_AUTOMATION_API_URL=https://api.youryt.com # if YT runs on a different host
```

### 2. Pull and redeploy YT

```bash
# On the VPS, in the YT project dir (or trigger from Dokploy UI):
git pull
docker compose up -d --build
```

### 3. Verify

```bash
curl -X POST http://yt-api:4000/automation/items \
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

Expected: HTTP `201` with `{"id":"<cuid>"}`. The YT dashboard's Items
view will show a `planned` row with that exact filename, waiting for the
Drive file to land.

If you instead get `503 automation_integration_disabled`, the YT app's
`AUTOMATION_BEARER` env var isn't set.
If you get `401 invalid_bearer`, the tokens don't match between the two
projects.

---

## API contract (locked)

`POST /automation/items` — request body:

```json
{
  "channel": "OAP",                           // Channel.filenamePrefix, required
  "type": "long",                             // "long" | "short" | "post", default "long"
  "format": null,                             // "question" | "animation" | null
  "filename": "OAP_2026-06-W1_long_1.mp4",    // must match YT's regex
  "examTag": "D330",                          // optional
  "title": "string (1..100 chars)",
  "description": "string (..5000 chars)",
  "tags": ["array", "of", "strings"],
  "categoryId": "27",                         // YouTube category, default Education
  "defaultLanguage": "en-US",
  "recordingCountry": "US",
  "madeForKids": false,
  "scheduledPublishAt": "2026-06-07T14:00:00Z",
  "source": "automation",                     // free-form, logged to ContentEvent
  "sourceRef": "<ContentItem.id>"             // free-form, logged to ContentEvent
}
```

Response: `201 { "id": "<cuid>" }`.

Error codes:
- `400` — Zod validation failed; message names the bad field.
- `401` — missing or wrong bearer.
- `404` — `filenamePrefix` doesn't match any Channel row.
- `409` — duplicate `expectedFilename`.
- `503` — `AUTOMATION_BEARER` not set on the YT side.
