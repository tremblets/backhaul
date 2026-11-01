FROM node:25-alpine AS base

FROM base AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsup.config.ts ./
COPY src/ ./src
RUN npm run build \
  && npm prune --omit=dev

FROM base AS runtime

ARG VERSION
ENV NODE_ENV=production \
    VERSION=${VERSION}

WORKDIR /app
COPY --from=builder --chown=1000:1000 /app/package.json ./
COPY --from=builder --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=builder --chown=1000:1000 /app/build ./build

RUN chmod +x /app/build/cli/index.js \
  && ln -s /app/build/cli/index.js /usr/local/bin/backup

USER 1000
VOLUME ["/config", "/data"]

CMD ["node", "build/index.js"]
