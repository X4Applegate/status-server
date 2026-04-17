# Node 24 is the current Active LTS (Oct 2025 → Apr 2028). Alpine 3.21 is the
# latest Alpine release paired with it — choosing an explicit pair means we
# pick up security patches from both streams on each rebuild and keeps Docker
# Scout's "outdated base image" check green.
FROM node:24-alpine3.21

# Pull the latest Alpine security patches into the base layer before adding
# anything else. `apk upgrade` picks up CVE fixes that land between base-image
# rebuilds, which is the main source of "Fixable critical or high" findings
# in Scout. Runs before we add our own packages so the cache invalidates
# whenever upstream publishes new patches.
RUN apk upgrade --no-cache \
 && apk add --no-cache iputils wget \
 && rm -rf /var/cache/apk/*

# Writable config directory owned by the built-in non-root `node` user.
RUN mkdir -p /config && chown node:node /config

WORKDIR /app

# Copy manifests first for layer-cache friendliness, then install *only*
# production deps from the committed lockfile for reproducible builds.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# App source.
COPY --chown=node:node server.js ./
COPY --chown=node:node views ./views

ENV NODE_ENV=production
ENV PORT=3000
ENV CHECK_INTERVAL=30000
ENV CONFIG_PATH=/config/servers.json
# Silences noisy npm telemetry nags at container start.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

EXPOSE 3000

# Drop privileges — runtime does not need root.
USER node

# Docker reports the container unhealthy if /healthz fails 3× in a row.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
