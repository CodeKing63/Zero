# ========================================
# Base Stage: Alpine Linux with Bun
# ========================================
FROM oven/bun:1.3.11-alpine AS base

# ========================================
# Dependencies Stage: Install Dependencies
# ========================================
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json bun.lock bunfig.toml turbo.json ./
RUN mkdir -p apps packages
COPY apps/*/package.json ./apps/
COPY packages/ ./packages/
COPY patches/ ./patches/

RUN bun install --production --frozen-lockfile --ignore-scripts


# ========================================
# Builder Stage: Build the Application
# ========================================
FROM base AS builder
WORKDIR /app

# Copy workspace configuration and source code
COPY package.json bun.lock bunfig.toml turbo.json ./
COPY . .

ENV CI=true

# Install all dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile

# Set environment variables for build
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    DOCKER_BUILD=true

# Build the application
RUN bun run --filter=@zero/mail build

# ========================================
# Runner Stage: Production Environment
# ========================================
FROM base AS runner
WORKDIR /app

RUN addgroup -S -g 1001 nodejs && \
    adduser -S -u 1001 nextjs -G nodejs

# Set environment variables for build
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME="0.0.0.0" \
    NEXT_TELEMETRY_DISABLED=1

# Copy entrypoint and run it
COPY scripts/docker/ /app/scripts
RUN chmod -R +x /app/scripts/*

# Copy the entire built application
COPY --from=builder --chown=nextjs:nodejs /app ./

# Switch to non-root user
USER nextjs

# Set server port and host
EXPOSE 3000

# Start the server
CMD ["/app/scripts/entrypoint.sh"]
