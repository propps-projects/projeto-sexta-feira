# syntax=docker/dockerfile:1.7
# Image for the HTTP MCP server. EasyPanel-friendly.
#
# Build:
#   docker build -t agentclass:latest .
# Run (locally):
#   docker run --rm -p 3333:3333 \
#     -e PANDA_API_KEY=panda-... \
#     -e MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
#     agentclass:latest
#
# In EasyPanel: point at this Dockerfile, set the env vars listed above,
# expose port 3333, attach a domain.

FROM node:20-bookworm-slim

# ffmpeg is only needed if you re-run ingest:2-audio inside the container.
# Runtime (server-http.ts) does NOT need it — the pre-baked data/vectors.db
# is everything the server reads. Kept here so re-ingest works in-place.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      curl \
      tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps with cache-friendly layer ordering.
# better-sqlite3 and sqlite-vec download prebuilt Linux binaries via
# prebuild-install — no native toolchain needed.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# Source + pre-ingested course data
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY data ./data
COPY .env.example ./

# Default port; override with `-e PORT=...`
ENV PORT=3333 \
    MCP_ENDPOINT=/mcp \
    NODE_ENV=production
EXPOSE 3333

# tini reaps zombie processes and forwards signals (SIGTERM → graceful shutdown)
ENTRYPOINT ["/usr/bin/tini", "--"]

# Healthcheck — EasyPanel uses this to know when the container is live.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:${PORT}/health || exit 1

CMD ["npx", "tsx", "src/server-http.ts"]
