ARG NODE_BUILD_IMAGE=node:20-bookworm
FROM ${NODE_BUILD_IMAGE} AS build

ARG APP_COMMIT=unknown
ARG APP_COMMIT_MESSAGE=""
ARG APP_COMMIT_DATE=""

WORKDIR /app
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public
ENV NEXT_TELEMETRY_DISABLED=1
ENV APP_COMMIT=${APP_COMMIT}
ENV APP_COMMIT_MESSAGE=${APP_COMMIT_MESSAGE}
ENV APP_COMMIT_DATE=${APP_COMMIT_DATE}

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
RUN npx prisma generate \
  && test -x node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x

# 源码最后 copy（变更最频繁）
COPY . .
RUN npm run build

ARG NODE_RUNTIME_IMAGE=node:20-bookworm-slim
FROM ${NODE_RUNTIME_IMAGE} AS runtime

ARG APP_COMMIT=unknown
ARG APP_COMMIT_MESSAGE=""
ARG APP_COMMIT_DATE=""

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV APP_COMMIT=${APP_COMMIT}
ENV APP_COMMIT_MESSAGE=${APP_COMMIT_MESSAGE}
ENV APP_COMMIT_DATE=${APP_COMMIT_DATE}

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 只安装生产依赖，大幅减小镜像体积
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# 复用构建阶段已经生成的 Prisma Client 和下载好的 Linux schema-engine，避免容器启动时访问 binaries.prisma.sh
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/node_modules/@prisma/engines ./node_modules/@prisma/engines

COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/.next ./.next

ENV NODE_ENV=production
ENV PORT=7777
ENV PRISMA_SCHEMA_ENGINE_BINARY=/app/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x
ENV PRISMA_MIGRATION_ENGINE_BINARY=/app/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x

EXPOSE 7777

CMD ["sh", "-c", "PGHOST=\"${PGHOST:-postgres}\"; PGUSER=\"${POSTGRES_USER:-mmh-fs}\"; PGDATABASE=\"${POSTGRES_DB:-mmh}\"; until pg_isready -h \"$PGHOST\" -U \"$PGUSER\" -d \"$PGDATABASE\"; do echo \"[mmh] waiting for postgres...\"; sleep 1; done; echo '[mmh] postgres ready, running prisma db push...'; npx prisma db push --accept-data-loss && echo '[mmh] prisma setup complete, starting app...' && npm run start"]
