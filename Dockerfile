# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage Dockerfile for the monorepo. Builds shared/providers/pipelines,
# then each app, then ships a slim runtime image used by all services.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production \
    PNPM_HOME=/app/.pnpm \
    NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# ── deps ────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* tsconfig.base.json ./
COPY prisma ./prisma
COPY packages/shared/package.json    packages/shared/
COPY packages/providers/package.json packages/providers/
COPY packages/pipelines/package.json packages/pipelines/
COPY apps/dashboard/package.json     apps/dashboard/
COPY apps/worker/package.json        apps/worker/
COPY apps/scheduler/package.json     apps/scheduler/
RUN npm install --include=dev --no-audit --no-fund

# ── build ───────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
# Defensive: make sure Next.js's expected `public/` dir exists even when no
# static assets are committed — otherwise the runtime stage's COPY fails.
RUN mkdir -p apps/dashboard/public
RUN npx prisma generate
RUN npm run build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM base AS runtime
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=build /app/prisma ./prisma

COPY --from=build /app/packages/shared/dist     ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/providers/dist  ./packages/providers/dist
COPY --from=build /app/packages/providers/package.json ./packages/providers/package.json
COPY --from=build /app/packages/pipelines/dist  ./packages/pipelines/dist
COPY --from=build /app/packages/pipelines/package.json ./packages/pipelines/package.json

COPY --from=build /app/apps/dashboard/.next         ./apps/dashboard/.next
COPY --from=build /app/apps/dashboard/public        ./apps/dashboard/public
COPY --from=build /app/apps/dashboard/package.json  ./apps/dashboard/package.json
COPY --from=build /app/apps/dashboard/next.config.mjs ./apps/dashboard/next.config.mjs

COPY --from=build /app/apps/worker/dist             ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json     ./apps/worker/package.json

COPY --from=build /app/apps/scheduler/dist          ./apps/scheduler/dist
COPY --from=build /app/apps/scheduler/package.json  ./apps/scheduler/package.json

# default mounts (override in compose)
VOLUME ["/app/assets", "/app/tmp"]
