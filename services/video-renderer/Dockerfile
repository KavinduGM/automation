# Video renderer service.
#
# Bundles:
#   - Node 22 + Fastify HTTP API (Hyperframes >=0.6.62 requires Node >=22)
#   - ffmpeg (via ffmpeg-static, no system install)
#   - HeyGen Hyperframes CLI (installed via `npx skills add heygen-com/hyperframes`)
#   - Headless Chromium (Hyperframes ships its own renderer; if it requires
#     Chrome we install via puppeteer/playwright as needed)
#
# Note: this image is BIG (~1.5GB) because of Chromium. Build it once and
# reuse via Docker layer cache.

FROM node:22-bookworm-slim

# System deps for headless Chrome (Hyperframes uses Puppeteer under the hood).
# Skip apt-get clean of /var/lib/apt/lists/* to allow `apt-get` again later
# during the npx skills add step if needed.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      fonts-liberation \
      libasound2 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libnspr4 \
      libnss3 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libxkbcommon0 \
      libpango-1.0-0 \
      libcairo2 \
      xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install JS dependencies first for layer caching.
COPY services/video-renderer/package.json services/video-renderer/tsconfig.json ./
RUN npm install --no-audit --no-fund

# Install Hyperframes CLI. The `npx skills add` command pins it globally.
RUN npx --yes skills add heygen-com/hyperframes || true

# Copy source.
COPY services/video-renderer/src ./src

# Build TypeScript.
RUN npx tsc -p tsconfig.json

ENV NODE_ENV=production
ENV PORT=4100
EXPOSE 4100

CMD ["node", "dist/server.js"]
