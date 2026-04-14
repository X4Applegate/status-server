FROM node:25-alpine

# Networking tools for ICMP ping checks, and wget for HEALTHCHECK probe.
RUN apk add --no-cache iputils wget

# Writable config directory owned by the built-in non-root `node` user.
RUN mkdir -p /config && chown node:node /config

WORKDIR /app

# Copy manifests first for layer-cache friendliness, then install *only*
# production deps from the committed lockfile for reproducible builds.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App source.
COPY --chown=node:node server.js ./
COPY --chown=node:node views ./views

ENV NODE_ENV=production
ENV PORT=3000
ENV CHECK_INTERVAL=30000
ENV CONFIG_PATH=/config/servers.json

EXPOSE 3000

# Drop privileges — runtime does not need root.
USER node

# Docker reports the container unhealthy if /healthz fails 3× in a row.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
