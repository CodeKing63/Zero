FROM oven/bun:1.3.11-slim
WORKDIR /app

# workerd ships a glibc-linked binary so we need Debian (Alpine's musl can't load it).
# Wrangler dev under Bun mishandles workerd's request stream (responses hang),
# so we run wrangler under Node 22+. See docker/server/Dockerfile for context.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install all deps first for layer cache.
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

# VITE_PUBLIC_* are inlined at build time. These are the URLs the *browser*
# uses, so they stay localhost (not docker service names).
ARG VITE_PUBLIC_BACKEND_URL=http://localhost:8787
ARG VITE_PUBLIC_APP_URL=http://localhost:3000
ENV VITE_PUBLIC_BACKEND_URL=$VITE_PUBLIC_BACKEND_URL
ENV VITE_PUBLIC_APP_URL=$VITE_PUBLIC_APP_URL

RUN bun run --filter=@zero/mail build

EXPOSE 3000
WORKDIR /app/apps/mail
CMD ["node", "/app/apps/mail/node_modules/wrangler/bin/wrangler.js", "dev", "--env", "local", "--ip", "0.0.0.0", "--port", "3000", "--show-interactive-dev-session=false"]
