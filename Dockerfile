ARG NODE_BUILD_IMAGE=node:20-bookworm
ARG NODE_RUNTIME_IMAGE=node:20-bookworm
ARG PRISMA_CLI_VERSION=7.8.0
ARG DOTENV_VERSION=17.4.2
ARG APP_VERSION=0.1.0
FROM ${NODE_BUILD_IMAGE} AS build

ARG APP_COMMIT=unknown
ARG APP_COMMIT_MESSAGE=""
ARG APP_COMMIT_DATE=""
ARG APP_VERSION=0.1.0

WORKDIR /app
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public
ENV NEXT_TELEMETRY_DISABLED=1
# Base-path contract: this image serves MMH from the ORIGIN ROOT. Only the fnOS
# gateway package carries a prefix (/app/mmh, see scripts/build-fnos-app.cjs).
# Declaring the empty value here (instead of relying on the default) stops a
# leftover MMH_BASE_PATH in the build host / CI environment from baking a
# prefix into this image -- that would break every route when the container is
# published as http://host:<port>/. Mounting MMH on a reverse-proxy sub-path
# needs a rebuild with this value changed; it can never differ at runtime,
# because Next inlines basePath into the build output.
ENV MMH_BASE_PATH=""
ENV APP_COMMIT=${APP_COMMIT}
ENV APP_COMMIT_MESSAGE=${APP_COMMIT_MESSAGE}
ENV APP_COMMIT_DATE=${APP_COMMIT_DATE}
ENV APP_VERSION=${APP_VERSION}

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
  && npx prisma db push --help >/dev/null \
  && test -x node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x

# 源码最后 copy（变更最频繁）
COPY . .
RUN npm run build

# standalone 里被打进来的类型声明、markdown 和 source map 在运行时不参与任何
# 代码路径（Next 只 require .js/.json/.node），却能占到未压缩体积的一成以上。
# 在 build 阶段删掉再 COPY，最终镜像里根本不会出现这些文件；放在 runtime 阶段
# 用 RUN rm 删除是无效的——那只会新增一个「删除层」，镜像反而更大。
RUN find .next/standalone -type f \( -name '*.d.ts' -o -name '*.map' -o -name '*.md' \) -delete 2>/dev/null || true

# 2026-11-06 生产实测（NAS 2.148 拉 0.1.82）：镜像站的断开线不是 27 MB，而是约
# 12 MB —— ≤11.48 MB 的层一次成功，14.25 / 15.64 / 16.21 / 20.18 MB 四层每次都
# 「下到 100% 后 Retrying」（blob 不完整，没有 Verifying Checksum），25 次重试后
# 整次升级卡死。按 27 MB 估出来的「19 MB 已经安全」是错的。
# 所以这里不再手写固定的两组（next / @img），而是把 standalone 的 node_modules
# 顶层条目按体积降序 round-robin 分到若干组，每组压缩后约 5 MB。
# 只是移动位置，runtime 阶段原样 COPY 回同一个 node_modules，路径结构不变。
RUN set -eu; \
    split_into() { \
      src="$1"; groups="$2"; out="$3"; i=0; j=0; \
      mkdir -p "$out"; \
      while [ "$j" -lt "$groups" ]; do mkdir -p "$out/g$j"; j=$((j+1)); done; \
      for d in $( (du -sk "$src"/* "$src"/.[!.]* 2>/dev/null || true) | sort -rn | awk '{print $2}' ); do \
        i=$((i+1)); g=$((i % groups)); mkdir -p "$out/g$g"; mv "$d" "$out/g$g/"; \
      done; \
    }; \
    mkdir -p .next/standalone-next; \
    mv .next/standalone/node_modules/next .next/standalone-next/next; \
    if [ -d .next/standalone/node_modules/@next ]; then \
      mv .next/standalone/node_modules/@next .next/standalone-next/@next; \
    fi; \
    if [ -d .next/standalone/node_modules/@img ]; then \
      mkdir -p .next/standalone-img/sharp .next/standalone-img/vips-lib; \
      for p in .next/standalone/node_modules/@img/*; do \
        case "$(basename "$p")" in \
          *libvips*) mv "$p" .next/standalone-img/vips-pkg; \
                     big=$( (du -k .next/standalone-img/vips-pkg/lib/* 2>/dev/null || true) \
                             | sort -rn | awk 'NR==1{print $2}' ); \
                     if [ -n "$big" ]; then mv "$big" .next/standalone-img/vips-lib/; fi ;; \
          *)         mv "$p" .next/standalone-img/sharp/ ;; \
        esac; \
      done; \
      rmdir .next/standalone/node_modules/@img 2>/dev/null || true; \
    fi; \
    split_into .next/standalone/node_modules 3 .next/standalone-split

FROM ${NODE_RUNTIME_IMAGE} AS prisma-deps

ARG PRISMA_CLI_VERSION
ARG DOTENV_VERSION

WORKDIR /opt/prisma-runtime
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# CI 的 build-args 曾经没传 PRISMA_CLI_VERSION，`prisma@` 于是退化成
# `prisma@latest`：每次构建装的是当天最新版，这一层（未压缩 190 MB、压缩后
# 50.65 MB）每次发版都换 digest，用户每次升级都必须重下 —— 90 KB/s 下必然
# 越过镜像站单层 5 分钟的断开线。空值直接让构建失败，避免再次悄悄退化。
RUN [ -n "${PRISMA_CLI_VERSION}" ] || { \
      echo "PRISMA_CLI_VERSION 为空：prisma@ 会被解析成 latest，导致该层每次发版都变。" >&2; \
      exit 1; \
    }

RUN set -eu; \
    split_into() { \
      src="$1"; groups="$2"; out="$3"; i=0; j=0; \
      mkdir -p "$out"; \
      while [ "$j" -lt "$groups" ]; do mkdir -p "$out/g$j"; j=$((j+1)); done; \
      for d in $( (du -sk "$src"/* "$src"/.[!.]* 2>/dev/null || true) | sort -rn | awk '{print $2}' ); do \
        i=$((i+1)); g=$((i % groups)); mkdir -p "$out/g$g"; mv "$d" "$out/g$g/"; \
      done; \
    }; \
    printf "{\n  \"name\": \"prisma-runtime\",\n  \"private\": true\n}\n" > package.json; \
    npm config set fetch-retries 5; \
    npm config set fetch-retry-factor 2; \
    npm config set fetch-retry-mintimeout 20000; \
    npm config set fetch-retry-maxtimeout 120000; \
    npm config set fetch-timeout 1200000; \
    npm config set audit false; \
    npm config set fund false; \
    npm install --omit=dev --ignore-scripts --no-package-lock "prisma@${PRISMA_CLI_VERSION}" "dotenv@${DOTENV_VERSION}"; \
    mkdir -p /opt/prisma-split; \
    mv node_modules/prisma /opt/prisma-split/cli; \
    mv node_modules/@prisma /opt/prisma-split/scope; \
    split_into /opt/prisma-split/cli/build 2 /opt/prisma-split/cli-build; \
    split_into /opt/prisma-split/scope 2 /opt/prisma-split/scope-split; \
    split_into node_modules 3 /opt/prisma-split/rest

FROM ${NODE_RUNTIME_IMAGE} AS runtime

ARG APP_COMMIT=unknown
ARG APP_COMMIT_MESSAGE=""
ARG APP_COMMIT_DATE=""
ARG APP_VERSION=0.1.0

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV APP_COMMIT=${APP_COMMIT}
ENV APP_COMMIT_MESSAGE=${APP_COMMIT_MESSAGE}
ENV APP_COMMIT_DATE=${APP_COMMIT_DATE}
ENV APP_VERSION=${APP_VERSION}
ENV NODE_ENV=production
ENV MMH_NODE_MAX_OLD_SPACE_MB=auto
ENV PG_POOL_MAX=4
ENV PORT=7777
ENV HOSTNAME=0.0.0.0
# 容器默认时区是 UTC：北京时间 00:00–08:00 期间「今天」会比本地日期晚一天，
# 导致当天刚记的流水被明细页当成未来行隐藏、表单默认日期变成昨天。
# 代码侧已用显式业务时区（date-utils.todayDateBusinessYmd），这里统一进程时区做双保险。
ENV TZ=Asia/Shanghai

# psql 是启动必需：docker-entrypoint.sh 用它跑兼容迁移，不能像其它工具那样删掉。
# 但整包 postgresql-client 会在 /usr/lib/postgresql/*/bin 下装 25 个二进制
# （initdb/pg_ctl/pgbench/vacuumdb/basebackup…），容器里一个都用不到，
# /usr/share/postgresql/* 下的 extension/tsearch_data 也只有 CREATE EXTENSION
# 时才读 —— 那是 postgres 容器的事，不是本镜像。全部清掉后这一层从 50.65 MB
# 降到 25 MB 上下，才可能压在镜像站单层约 5 分钟、约 27 MB 的断开线以内。
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client openssl ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /usr/share/postgresql/*/man \
       /usr/share/postgresql/*/extension /usr/share/postgresql/*/tsearch_data \
  && for b in initdb pg_amcheck pg_basebackup pg_ctl pg_isready pg_receivewal \
       pg_recvlogical pg_resetwal pg_rewrite pg_test_fsync pg_test_timing \
       pg_upgrade pg_waldump pg_walsummary clusterdb createdb createuser \
       dropdb dropuser oid2name pgbench reindexdb vacuumdb; do \
       rm -f /usr/lib/postgresql/*/bin/$b; \
     done \
  && test -x /usr/lib/postgresql/*/bin/psql

# standalone 拆成多条 COPY：node_modules 在两次发版之间是稳定的（next/react/prisma/sharp
# 的版本不变就不变），业务代码每次都变。合成一条时两者被绑进同一个层，代码改一行就
# 整层重建，用户每次升级都被迫重下约 39 MB；拆开后增量只剩 .next 那一层（约 7 MB）。
# 注意：standalone 顶层必须只有这四项（Next 15 的输出形态）。新增顶层文件时要同步加 COPY，
# 否则运行时才报 module not found —— 下面的 RUN 会先把它拦在构建期。
# 分组由 build 阶段按体积 round-robin 算出来，每层压缩后约 5 MB；镜像站实测约 12 MB
# 的 blob 断开线就是这么绕开的。只是移动位置，文件一个不少。
COPY --chown=node:node --from=build /app/.next/standalone-next ./node_modules
# sharp 的 libvips 是整条链上最难压的一层：.so 本身几乎不可压缩，单包就顶到镜像站
# 的断开线上。所以 libvips 包拆成三份落下：包骨架 + 其余 .so（vips-pkg）、最大的那个
# .so（vips-lib）、sharp 的 .node 插件（sharp/）。
COPY --chown=node:node --from=build /app/.next/standalone-img/sharp/* ./node_modules/@img/
COPY --chown=node:node --from=build /app/.next/standalone-img/vips-pkg ./node_modules/@img/sharp-libvips-linux-x64
COPY --chown=node:node --from=build /app/.next/standalone-img/vips-lib ./node_modules/@img/sharp-libvips-linux-x64/lib
COPY --chown=node:node --from=build /app/.next/standalone-split/g0 ./node_modules
COPY --chown=node:node --from=build /app/.next/standalone-split/g1 ./node_modules
COPY --chown=node:node --from=build /app/.next/standalone-split/g2 ./node_modules
COPY --chown=node:node --from=build /app/.next/standalone/.next ./.next
COPY --chown=node:node --from=build /app/.next/standalone/package.json ./package.json
COPY --chown=node:node --from=build /app/.next/standalone/server.js ./server.js
RUN set -eu; \
    echo "=== @img ==="; ls -la ./node_modules/@img || true; \
    for d in ./node_modules/@img/*/; do \
      echo "== pkg $d"; ls -A "$d" || true; \
      echo "-- lib"; ls -A "${d}lib" 2>/dev/null || true; \
    done; \
    test -f ./server.js && test -f ./package.json && test -d ./.next/server \
 && test -d ./node_modules/next \
 && test -n "$(ls -A ./node_modules/@img)"
COPY --chown=node:node --from=build /app/.next/static ./.next/static
COPY --chown=node:node --from=build /app/public ./public
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node --from=build /app/prisma.config.ts ./prisma.config.ts
# prisma 运行时（未压缩 190 MB）同样按体积分组：CLI 的 build 目录 2 组、@prisma 作用域
# 2 组、其余依赖 3 组，每组压缩后 5-8 MB。文件仍然落在原来的路径上，require 不受影响。
COPY --chown=node:node --from=prisma-deps /opt/prisma-split/cli ./node_modules/prisma
COPY --chown=node:node --from=prisma-deps /opt/prisma-split/cli-build/g0 ./node_modules/prisma/build
COPY --chown=node:node --from=prisma-deps /opt/prisma-split/cli-build/g1 ./node_modules/prisma/build
COPY --chown=node:node --from=prisma-deps /opt/prisma-split/scope-split/g0 ./node_modules/@prisma
COPY --chown=node:node --from=prisma-deps /opt/prisma-split/scope-split/g1 ./node_modules/@prisma
COPY --chown=node:node --from=prisma-deps /opt/prisma-split/rest/g0 ./node_modules
COPY --chown=node:node --from=prisma-deps /opt/prisma-split/rest/g1 ./node_modules
COPY --chown=node:node --from=prisma-deps /opt/prisma-split/rest/g2 ./node_modules
# 这些组是从同一个 node_modules 移出去、再分批 COPY 回来的，路径必须严丝合缝。
# 少一个 @prisma/dev，`prisma db push` 会在容器启动时直接抛 MODULE_NOT_FOUND，
# 而那时已经没法回退到构建日志了 —— 所以在构建期就拦住。
RUN test -x ./node_modules/.bin/prisma \
 && test -f ./node_modules/prisma/build/index.js \
 && test -f ./node_modules/@prisma/dev/package.json \
 && test -d ./node_modules/@prisma/engines
# The runtime runs `prisma db push` during startup. Keep the schema engine in
# the image so offline/restricted NAS hosts do not need binaries.prisma.sh.
COPY --chown=node:node --from=build /app/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x ./node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x
COPY scripts/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh \
  && mkdir -p /app/data \
  && chown -R node:node /app/data

EXPOSE 7777

CMD ["./docker-entrypoint.sh"]

LABEL org.opencontainers.image.title="MMH"
LABEL org.opencontainers.image.source="https://github.com/frankluise5220/MMH"
LABEL org.opencontainers.image.revision=${APP_COMMIT}
LABEL org.opencontainers.image.created=${APP_COMMIT_DATE}
LABEL org.opencontainers.image.description=${APP_COMMIT_MESSAGE}
LABEL org.opencontainers.image.version=${APP_VERSION}
