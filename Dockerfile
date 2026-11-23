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
# 构建时先按原版 Dockerfile 的完全相同命令编译出 standalone，再与上一版镜像的
# /app 逐文件比对，只把变化的文件按体积从大到小装进当前最轻的桶（贪心均衡）；
# 最终镜像每条 COPY 是一层，单层未压缩 < 4.5 MB。国内镜像站实测卡在 8.75 MB
# 的 blob（下到 100% 后不落盘），4.5 MB 留了一倍余量；层本身还会再 gzip，实际
# 下载的 blob 通常只有 1–2 MB。单文件阈值取 3.5 MB，而不是之前拍的 10 MB。
# 分片数 16（0.1.87 起，此前 12）：每个分片是独立 blob，多几个小 blob 比一个大
# blob 安全。16 档 × 4.5 MB = 72 MB 容量；0.1.87 实测 1428 个变化文件共 64.4 MB
# （业务大改导致 Next chunk 全量重编），每片约 4.03 MB，正好落在 4 MB 与 4.5 MB 之间
# ——所以阈值是 4608 KB 而不是 4096 KB，否则每片都差几十 KB。
# 0.1.84 教训：原来是 `n % 12` 轮转，最大的 1/13/25… 个文件全部落进 p0，
# 752 个变化文件时 p0 达 4168 KB 越限、App 镜像直接构建失败（GHCR 无 0.1.84）。
# 0.1.87 教训：pdf-parse 的 *.map 单个 5.27 MB，绕过贪心分块直接撞上单文件阈值。
# 源码映射运行时不加载，构建后从 standalone / static 里删掉，而不是放大 3.5 MB 上限。
# 本版（0.1.89）以 0.1.88 镜像为底座：0.1.88 已公开，用户实际在跑的上一版就是它，
# 层 digest 必须与 0.1.88 完全一致才能被旧 updater 本地跳过（旧二进制没有超时重试）。
ARG BASE_IMAGE=ghcr.io/frankluise5220/mmh:0.1.88
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
# 源码映射（*.map）只是调试产物，运行时不加载，但 npm 包会带上很多：pdf-parse 一个包
# 就有 10.6 MB 的 map，其中 dist/pdf-parse/web/pdf.worker.mjs.map 单个 5.27 MB，越过
# 「单文件 ≤ 3.5 MB」的分层上限，0.1.87 的 Build and push 正是死在这里。构建后统一
# 清掉，standalone 里不再出现 map，既不产生超大层，也不把调试垃圾塞进用户镜像。
# 注意 `A && B || true` 会连 npm run build 的失败一起吞掉，所以这里不加 `|| true`：
# 两个目录在构建后必然存在，缺了就应该构建失败。
RUN npm run build \
  && find .next/standalone .next/static -type f -name '*.map' -delete

# 与上一版镜像（BASE_IMAGE）的 /app 逐文件比较，只保留真正变化的文件。
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
    echo "changed files: $(find /app/delta -type f | wc -l), delta total: $(du -sk /app/delta | cut -f1) KB"; \
    oversize=$(find /app/delta -type f -size +3500k -print -quit); \
    if [ -n "$oversize" ]; then \
      echo "单个变化文件超过 3.5 MB，无法切成安全层：$oversize" >&2; \
      find /app/delta -type f -size +3500k -printf '%s %p\n' | sort -rn | head -5 >&2; \
      exit 1; \
    fi; \
    for i in $(seq 0 15); do mkdir -p "/app/parts/p$i"; echo 0 > "/tmp/load$i"; done; \
    find /app/delta -type f -printf '%s %p\n' | sort -rn | while read -r size f; do \
      rel="${f#/app/delta/}"; \
      g=0; smallest=$(cat /tmp/load0); \
      for i in $(seq 1 15); do \
        v=$(cat "/tmp/load$i"); \
        if [ "$v" -lt "$smallest" ]; then g=$i; smallest=$v; fi; \
      done; \
      mkdir -p "/app/parts/p$g/$(dirname "$rel")"; \
      cp "$f" "/app/parts/p$g/$rel"; \
      echo $((smallest + (size + 1023) / 1024)) > "/tmp/load$g"; \
    done; \
    worst=0; \
    for i in $(seq 0 15); do \
      sz=$(du -sk "/app/parts/p$i" | cut -f1); \
      echo "part p$i: ${sz} KB (uncompressed)"; \
      if [ "$sz" -gt "$worst" ]; then worst=$sz; fi; \
    done; \
    if [ "$worst" -gt 4608 ]; then \
      echo "最大分片 ${worst} KB 超过 4.5 MB：16 个分片装不下 $(du -sk /app/delta | cut -f1) KB 变化文件，需要继续裁体积（先看是不是又混进了 *.map）" >&2; \
      exit 1; \
    fi

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
COPY --chown=node:node --from=build /app/parts/p12/ /app/
COPY --chown=node:node --from=build /app/parts/p13/ /app/
COPY --chown=node:node --from=build /app/parts/p14/ /app/
COPY --chown=node:node --from=build /app/parts/p15/ /app/

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
