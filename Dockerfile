# =============================================================================
# Dockerfile - builds a small, locked-down image for Make Kevin Not Broke.
# -----------------------------------------------------------------------------
#  Stage 1 (deps): install ONLY production dependencies with `npm ci`
#                  (exact versions from package-lock.json = reproducible).
#  Stage 2 (run):  copy app + deps into a clean image, run as the non-root
#                  "node" user, with a health check.
# =============================================================================
ARG NODE_VERSION=22-alpine

# ---------- Stage 1: dependencies ----------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=dev: no test/dev tools in production; --ignore-scripts: don't run
# install scripts from third-party packages (supply-chain hardening).
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---------- Stage 2: runtime ----------
FROM node:${NODE_VERSION}
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data
WORKDIR /app

# Apply the latest Alpine security patches to the base image.
# (Build with --build-arg APK_UPGRADE=false only if your network blocks the Alpine CDN.)
ARG APK_UPGRADE=true
RUN if [ "$APK_UPGRADE" = "true" ]; then apk upgrade --no-cache; fi

# Copy dependencies and source code, owned by root (read-only for the app user).
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# The only writable folder: where the watchdog stores its state.
RUN mkdir -p /app/data && chown node:node /app/data

# Never run as root inside the container.
USER node

EXPOSE 8080

# Docker marks the container "unhealthy" if /healthz stops answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
