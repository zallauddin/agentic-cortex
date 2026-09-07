# agentic-cortex — reproducible development/production image
#
# Build:  docker build -t agentic-cortex .
# Run:    docker run --rm -p 37777:37777 -v cortex-data:/data agentic-cortex
#
# The SQLite vault lives in /data (override with AGENTIC_CORTEX_DB).
# Embeddings run fully offline via @xenova/transformers (optional dep,
# included here so the image has semantic memory out of the box).

FROM node:20-bookworm-slim

# build-essential + python3: only needed if better-sqlite3 has no prebuilt
# binary for the platform; kept so `npm ci` never fails on niche arches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=optional

COPY cli.js ./
COPY src ./src
COPY scripts ./scripts
COPY templates ./templates
COPY README.md LICENSE ./

# Vault location inside the container (AGENTIC_CORTEX_DB is the supported override).
ENV AGENTIC_CORTEX_DB=/data/agentic-cortex.db \
    NODE_ENV=production
RUN mkdir -p /data

# Auto-setup on first boot (db init, discovery files) then serve the dashboard API.
EXPOSE 37777
CMD ["node", "cli.js", "serve", "--port", "37777"]
