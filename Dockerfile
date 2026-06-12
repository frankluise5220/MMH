FROM node:20-bookworm AS build

WORKDIR /app
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-factor 2 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm config set fetch-timeout 1200000 \
  && npm config set audit false \
  && npm config set fund false \
  && npm ci --ignore-scripts

# 先 copy prisma schema 和 config，让 generate 层能被缓存
COPY prisma ./prisma/
COPY next.config.ts tsconfig.json ./
RUN npx prisma generate

# 源码最后 copy（变更最频繁）
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 只安装生产依赖，大幅减小镜像体积
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/.next ./.next

ENV NODE_ENV=production
ENV PORT=7777

EXPOSE 7777

CMD ["sh", "-c", "PGHOST=\"${PGHOST:-postgres}\"; PGUSER=\"${POSTGRES_USER:-openclaw}\"; PGDATABASE=\"${POSTGRES_DB:-openclaw}\"; until pg_isready -h \"$PGHOST\" -U \"$PGUSER\" -d \"$PGDATABASE\"; do echo \"[wiseme] waiting for postgres...\"; sleep 1; done; echo '[wiseme] postgres ready, running prisma db push...'; npx prisma db push --accept-data-loss && npx prisma generate && echo '[wiseme] prisma setup complete, starting app...' && npm run start"]
