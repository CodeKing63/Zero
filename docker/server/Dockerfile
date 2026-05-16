FROM oven/bun:1.3.11-slim
WORKDIR /app

# workerd ships a glibc-linked binary so we need Debian (Alpine's musl can't load it).
# We also need Node because wrangler's internal ws/_http_client path expects
# Node's exact response handling — Bun mishandles the WebSocket 101 upgrade
# wrangler uses when the worker has Durable Objects / Hyperdrive / Workflows.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install all deps. Source is layered on after so install cache survives source edits.
COPY package.json bun.lock bunfig.toml turbo.json ./
COPY patches/ ./patches/
COPY apps/server/package.json ./apps/server/
COPY apps/mail/package.json ./apps/mail/
# cli source must exist for the root `bun nizzy sync` postinstall to resolve.
COPY packages/cli/ ./packages/cli/
COPY packages/eslint-config/package.json ./packages/eslint-config/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY packages/testing/package.json ./packages/testing/
COPY scripts/package.json ./scripts/

ENV HUSKY=0
# No --ignore-scripts: workerd is a trustedDependency and needs its install
# script to fetch the platform binary. Nizzy's postinstall no-ops without .env.
RUN bun install --frozen-lockfile

# Source
COPY . .

# wrangler.jsonc has localConnectionString=postgresql://postgres:postgres@localhost:5432/...
# Inside the docker network, postgres lives at host=db, not localhost.
RUN sed -i 's|@localhost:5432/zerodotemail|@db:5432/zerodotemail|g' apps/server/wrangler.jsonc

COPY docker/server/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8787
WORKDIR /app/apps/server
ENTRYPOINT ["/entrypoint.sh"]
# Run wrangler under Node (not Bun) — see comment near the apt install above.
CMD ["node", "/app/apps/server/node_modules/wrangler/bin/wrangler.js", "dev", "--env", "local", "--ip", "0.0.0.0", "--show-interactive-dev-session=false"]
