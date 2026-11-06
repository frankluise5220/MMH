# 存量 Docker 用户跑的是原版 0.1.81（含它自己的旧 updater）。这一版能否升级，
# 只取决于旧执行器 `compose pull` 能不能把新镜像的层从镜像站拉全：新写进
# 0.1.82/0.1.83 的 updater 代码要升级成功后才生效，对这次升级毫无帮助。
#
# 所以这里直接以已发布的 0.1.81 镜像为底座。它的 19 个层按 blob digest 原样
# 保留，用户本地全部跳过后只需下载下面几条差异层。**任何对 apt / npm ci /
# prisma 运行时 / standalone 结构早期层的改写都会让 digest 变化**，把用户拖回
# 「重下几十个层」的坑；0.1.82 第一版就是这样把 19 层变成 38 层的。
#
# 0.1.81 → 本版之间 package.json 的依赖没有变化（只有 version 与业务代码），
# 因此 node_modules、prisma CLI、schema-engine、基础镜像都可以整层复用。
# 构建时先按原版 Dockerfile 的完全相同命令编译出 standalone，再与 0.1.81 的
# /app 逐文件比对，只把变化的文件按体积轮转分到 12 个目录；最终镜像每条 COPY
# 是一层，单层 < 4 MB。国内镜像站对 8.75 MB 的 blob 也会「下到 100% 后不落盘」，
# 所以单文件阈值取 3.5 MB，而不是之前拍的 10 MB。
ARG BASE_IMAGE=ghcr.io/frankluise5220/mmh:0.1.81
ARG NODE_BUILD_IMAGE=node:20-bookworm
# 兼容 CI 现有的 build-args；prisma 运行时现在整层复用 BASE_IMAGE，不再单独安装。
ARG PRISMA_CLI_VERSION=7.8.0
ARG DOTENV_VERSION=17.4.2
ARG APP_VERSION=0.1.0

FROM ${BASE_IMAGE} AS previous

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

COPY prisma ./prisma/
COPY next.config.ts tsconfig.json ./
RUN npx prisma generate \
  && npx prisma db push --help >/dev/null \
  && test -x node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x

COPY . .
RUN npm run build

# 与 0.1.81 的 /app 逐文件比较，只保留真正变化的文件。
# .next/standalone 在 0.1.81 里是被 COPY 到 /app 根目录的，所以它的相对路径
# 与 prev 的 /app 一一对应；其余资源按各自的目标目录对应。
COPY --from=previous /app /app/prev
RUN set -eu; \
    mkdir -p /app/delta; \
    copy_changed() { \
      src="$1"; dst="$2"; \
      [ -e "/app/$src" ] || return 0; \
      if [ -d "/app/$src" ]; then \
        (cd "/app/$src" && find . -type f) | while read -r f; do \
          if [ ! -f "/app/prev/$dst/$f" ] || ! cmp -s "/app/$src/$f" "/app/prev/$dst/$f"; then \
            mkdir -p "/app/delta/$dst/$(dirname "$f")"; \
            cp "/app/$src/$f" "/app/delta/$dst/$f"; \
          fi; \
        done; \
      elif [ ! -f "/app/prev/$dst" ] || ! cmp -s "/app/$src" "/app/prev/$dst"; then \
        mkdir -p "/app/delta/$(dirname "$dst")"; \
        cp "/app/$src" "/app/delta/$dst"; \
      fi; \
    }; \
    copy_changed .next/standalone .; \
    copy_changed .next/static .next/static; \
    copy_changed public public; \
    copy_changed prisma prisma; \
    copy_changed prisma.config.ts prisma.config.ts; \
    copy_changed scripts/docker-entrypoint.sh docker-entrypoint.sh; \
    test -n "$(find /app/delta -type f -print -quit)" || { \
      echo "与 ${BASE_IMAGE} 没有任何文件差异，拒绝发布空更新" >&2; exit 1; \
    }; \
    chmod +x /app/delta/docker-entrypoint.sh 2>/dev/null || true; \
    echo "changed files: $(find /app/delta -type f | wc -l)"; \
    oversize=$(find /app/delta -type f -size +3500k -print -quit); \
    if [ -n "$oversize" ]; then \
      echo "单个变化文件超过 3.5 MB，无法切成安全层：$oversize" >&2; exit 1; \
    fi; \
    for i in 0 1 2 3 4 5 6 7 8 9 10 11; do mkdir -p "/app/parts/p$i"; done; \
    n=0; \
    find /app/delta -type f -printf '%s %p\n' | sort -rn | while read -r size f; do \
      rel="${f#/app/delta/}"; \
      g=$((n % 12)); n=$((n + 1)); \
      mkdir -p "/app/parts/p$g/$(dirname "$rel")"; \
      cp "$f" "/app/parts/p$g/$rel"; \
    done; \
    for i in 0 1 2 3 4 5 6 7 8 9 10 11; do \
      sz=$(du -sk "/app/parts/p$i" | cut -f1); \
      echo "part p$i: ${sz} KB (uncompressed)"; \
      if [ "$sz" -gt 4096 ]; then echo "part p$i exceeds 4 MB" >&2; exit 1; fi; \
    done

FROM ${BASE_IMAGE}

ARG APP_COMMIT=unknown
ARG APP_COMMIT_MESSAGE=""
ARG APP_COMMIT_DATE=""
ARG APP_VERSION=0.1.0

ENV APP_COMMIT=${APP_COMMIT}
ENV APP_COMMIT_MESSAGE=${APP_COMMIT_MESSAGE}
ENV APP_COMMIT_DATE=${APP_COMMIT_DATE}
ENV APP_VERSION=${APP_VERSION}
ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

# 每一条 COPY 都是一层 < 4 MB；0.1.81 的 19 层在用户本地全部 Already exists。
COPY --chown=node:node --from=build /app/parts/p0/ /app/
COPY --chown=node:node --from=build /app/parts/p1/ /app/
COPY --chown=node:node --from=build /app/parts/p2/ /app/
COPY --chown=node:node --from=build /app/parts/p3/ /app/
COPY --chown=node:node --from=build /app/parts/p4/ /app/
COPY --chown=node:node --from=build /app/parts/p5/ /app/
COPY --chown=node:node --from=build /app/parts/p6/ /app/
COPY --chown=node:node --from=build /app/parts/p7/ /app/
COPY --chown=node:node --from=build /app/parts/p8/ /app/
COPY --chown=node:node --from=build /app/parts/p9/ /app/
COPY --chown=node:node --from=build /app/parts/p10/ /app/
COPY --chown=node:node --from=build /app/parts/p11/ /app/

RUN test -x ./docker-entrypoint.sh \
  && test -f ./server.js \
  && test -f ./package.json \
  && test -d ./.next/server \
  && test -d ./node_modules/next \
  && test -x ./node_modules/.bin/prisma \
  && test -n "$(ls -A ./node_modules/@prisma/engines/schema-engine-* 2>/dev/null)"

EXPOSE 7777

CMD ["./docker-entrypoint.sh"]

LABEL org.opencontainers.image.title="MMH"
LABEL org.opencontainers.image.source="https://github.com/frankluise5220/MMH"
LABEL org.opencontainers.image.revision=${APP_COMMIT}
LABEL org.opencontainers.image.created=${APP_COMMIT_DATE}
LABEL org.opencontainers.image.description=${APP_COMMIT_MESSAGE}
LABEL org.opencontainers.image.version=${APP_VERSION}
