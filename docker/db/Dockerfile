# ========================================
# Dependencies Stage: Install Dependencies
# ========================================
FROM oven/bun:1.3.11-alpine AS deps
WORKDIR /app

# Copy workspace configuration and package files
COPY package.json bun.lock bunfig.toml turbo.json ./
COPY apps/server/package.json ./apps/server/
COPY packages/ ./packages/
COPY patches/ ./patches/

# Install dependencies needed for migrations
RUN bun install --frozen-lockfile

# ========================================
# Runner Stage: Production Environment
# ========================================
FROM oven/bun:1.3.11-alpine AS runner
WORKDIR /app

# Copy workspace configuration and dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/bun.lock ./bun.lock
COPY --from=deps /app/bunfig.toml ./bunfig.toml

# Copy server app with database configuration
COPY apps/server/ ./apps/server/
COPY packages/ ./packages/

WORKDIR /app/apps/server
