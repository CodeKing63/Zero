#!/bin/sh
set -e

# Build a docker-network-aware .dev.vars from the mounted /app/.env.
# Wrangler dev reads .dev.vars for secrets; we need DB/Redis URLs to point at
# in-network service names instead of the localhost defaults from the host.
if [ -f /app/.env ]; then
  sed -e 's|@localhost:5432/zerodotemail|@db:5432/zerodotemail|g' \
      -e 's|http://localhost:8079|http://upstash-proxy:80|g' \
      /app/.env > /app/apps/server/.dev.vars
fi

# Remote bindings (Vectorize + Workers AI) need CLOUDFLARE_API_TOKEN. If the
# token is missing, strip "remote": true AND the entire AI binding block (AI
# is always-remote in Cloudflare, so removing it is the only way to boot
# without auth). Cost: semantic search + Workers AI embedding fail at runtime
# but the worker stays up and the rest of the app works.
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "[entrypoint] No CLOUDFLARE_API_TOKEN — disabling remote bindings."
  sed -i '/"remote": true/d' /app/apps/server/wrangler.jsonc
  awk '
    /^[[:space:]]*"ai": \{/   { skip=1; next }
    skip && /^[[:space:]]*\},/ { skip=0; next }
    !skip
  ' /app/apps/server/wrangler.jsonc > /tmp/wrangler.jsonc
  mv /tmp/wrangler.jsonc /app/apps/server/wrangler.jsonc
fi

exec "$@"
