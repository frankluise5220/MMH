# 镜像交付的两个硬约束，二者一起决定了这一版的结构：
#
# 1. overlay2 最多 128 层。层数超过上限时 `docker pull` 直接
#    `failed to register layer: max depth exceeded`——0.1.89 就是这么坏掉的
#    （135 层），连带所有 Docker 用户都升不上去。
# 2. 国内镜像站按**单个 blob** 断线：实测 8.75 MB 的层能下到 100% 却不落盘。
#    所以每一层都要小，单层按 4.5 MB 控制。
#
# 0.1.82 起为了只让用户下载变化文件，改成「以上一版镜像为底座、把差异文件塞进
# 16 个分片」。它满足了约束 2，却让层数每版 +13，到 0.1.89 就撞死约束 1。
#
# 现在的做法把层的内容交给**文件路径**决定，而不是「这版改了什么」：
#   - 底座固定为 0.1.81（19 层，所有存量用户本地已有，按 digest 直接跳过）；
#   - 应用文件全量按 sha1(相对路径) % 96 分桶，每个桶一层；
#   - 某文件没改 → 它在同一桶、桶内容不变 → 层 digest 不变 → 用户跳过；
#   - 某文件改了 → 只有它所在的那一桶变化 → 用户只下这一桶（≤4.5 MB）。
#
# 于是层数恒为 19 + 96 = 115，不再随版本增长；增量复用靠内容寻址，不再靠堆叠层。
# 代价只有一次：切到这个结构的首版，96 个桶的 digest 全是新的，用户要完整下载
# 一遍应用文件（约 250 MB，但仍是 96 个小 blob，不会触发断线）。
#
# 96 是"层数上限"和"桶体积"之间的取中：应用树超过约 400 MB 时单桶会逼近 4.5 MB，
# 那时需要整体换桶数（+1 次全量下载），而不是逐版加桶。
ARG BASE_IMAGE=ghcr.io/frankluise5220/mmh:0.1.81
ARG NODE_BUILD_IMAGE=node:20-bookworm
# 兼容 CI 现有的 build-args；prisma 运行时整层复用 BASE_IMAGE，不再单独安装。
ARG PRISMA_CLI_VERSION=7.8.0
ARG DOTENV_VERSION=17.4.2
ARG APP_VERSION=0.1.0
ARG BUCKET_COUNT=96

FROM ${NODE_BUILD_IMAGE} AS build

ARG APP_COMMIT=unknown
ARG APP_COMMIT_MESSAGE=""
ARG APP_COMMIT_DATE=""
ARG APP_VERSION=0.1.0
ARG BUCKET_COUNT=96

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

# 把运行时要用的文件摊平成"目标绝对路径"的镜像树，再按路径分桶。
# 之所以全量摊平而不是与上一版做 diff：diff 出来的分片每版都是新 digest，
# 层数只增不减；按路径分桶则是"文件没动，层就没动"。
#
# 分桶前先处理两个 16.6 MB 的 libvips：
#   - sharp 的预编译包同时带 glibc 与 musl 两套，本镜像跑 debian(glibc)，musl
#     那套永远加载不到，直接删掉（省 17 MB，也去掉一个必超体积上限的层）；
#   - 剩下的 glibc libvips 去掉静态符号表后再压，单文件才落得进 4.5 MB 的桶。
#     strip 只动静态符号，动态符号保留，所以随后用 node 实际 require 一次验证。
RUN set -eu; \
    rm -rf /app/tree /app/buckets; \
    mkdir -p /app/tree /app/buckets; \
    cp -a /app/.next/standalone/. /app/tree/; \
    mkdir -p /app/tree/.next; \
    cp -a /app/.next/static /app/tree/.next/static; \
    cp -a /app/public /app/tree/public; \
    cp -a /app/prisma /app/tree/prisma; \
    if [ -f /app/prisma.config.ts ]; then cp -a /app/prisma.config.ts /app/tree/prisma.config.ts; fi; \
    cp -a /app/scripts/docker-entrypoint.sh /app/tree/docker-entrypoint.sh; \
    chmod +x /app/tree/docker-entrypoint.sh; \
    rm -rf /app/tree/node_modules/@img/sharp-libvips-linuxmusl-x64 \
           /app/tree/node_modules/@img/sharp-linuxmusl-x64 \
           /app/tree/node_modules/@next/swc-linux-x64-musl \
           /app/tree/node_modules/@next/swc-linux-arm64-musl; \
    find /app/tree/node_modules/@img -name 'libvips-cpp.so.*' -exec strip --strip-unneeded {} + 2>/dev/null || true; \
    node -e "const s=require('/app/tree/node_modules/sharp'); if(!s.versions||!s.versions.vips){console.error('sharp/libvips 不可用');process.exit(1)} console.log('sharp vips', s.versions.vips)"; \
    i=0; while [ "$i" -lt "$BUCKET_COUNT" ]; do mkdir -p "/app/buckets/b$i"; i=$((i + 1)); done; \
    cd /app/tree; \
    find . -type f -print > /tmp/tree-files.txt; \
    while read -r f; do \
      rel="${f#./}"; \
      fhash="$(printf '%s' "$rel" | sha1sum | cut -c1-8)"; \
      b=$(( 0x$fhash % BUCKET_COUNT )); \
      mkdir -p "/app/buckets/b$b/$(dirname "$rel")"; \
      cp "$f" "/app/buckets/b$b/$rel"; \
    done < /tmp/tree-files.txt; \
    echo "--- bucket sizes (gzip, one tar per bucket) ---"; \
    worst=0; total=0; used=0; \
    i=0; while [ "$i" -lt "$BUCKET_COUNT" ]; do \
      sz=$(tar -C "/app/buckets/b$i" -cf - . 2>/dev/null | gzip -6 -c | wc -c); \
      kb=$(( sz / 1024 )); \
      if [ "$kb" -gt 0 ]; then used=$((used + 1)); fi; \
      total=$((total + kb)); \
      if [ "$kb" -gt "$worst" ]; then worst=$kb; fi; \
      i=$((i + 1)); \
    done; \
    echo "buckets: used=$used/$BUCKET_COUNT total=${total} KB worst=${worst} KB"; \
    huge_file=$(find /app/tree -type f -size +40000k -print -quit); \
    if [ -n "$huge_file" ]; then \
      echo "单个文件超过 40 MB，压不进任何安全层：$huge_file" >&2; \
      exit 1; \
    fi; \
    if [ "$worst" -gt 4608 ]; then \
      echo "最大桶压缩后 ${worst} KB 超过 4.5 MB（应用树 ${total} KB / ${BUCKET_COUNT} 桶），" >&2; \
      echo "镜像站会卡在 Download complete，需要调大 BUCKET_COUNT 并接受一次全量下载。" >&2; \
      find /app/buckets -type f -size +1500k -printf '%s %p\n' | sort -rn | head -5 >&2; \
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

# 每条 COPY 是一层：b0..b95 合计 96 层，加上底座 19 层恒为 115 层。
# 桶的内容只由文件路径和文件内容决定，所以没改的桶在用户本地是 Already exists。
COPY --chown=node:node --from=build /app/buckets/b0/ /app/
COPY --chown=node:node --from=build /app/buckets/b1/ /app/
COPY --chown=node:node --from=build /app/buckets/b2/ /app/
COPY --chown=node:node --from=build /app/buckets/b3/ /app/
COPY --chown=node:node --from=build /app/buckets/b4/ /app/
COPY --chown=node:node --from=build /app/buckets/b5/ /app/
COPY --chown=node:node --from=build /app/buckets/b6/ /app/
COPY --chown=node:node --from=build /app/buckets/b7/ /app/
COPY --chown=node:node --from=build /app/buckets/b8/ /app/
COPY --chown=node:node --from=build /app/buckets/b9/ /app/
COPY --chown=node:node --from=build /app/buckets/b10/ /app/
COPY --chown=node:node --from=build /app/buckets/b11/ /app/
COPY --chown=node:node --from=build /app/buckets/b12/ /app/
COPY --chown=node:node --from=build /app/buckets/b13/ /app/
COPY --chown=node:node --from=build /app/buckets/b14/ /app/
COPY --chown=node:node --from=build /app/buckets/b15/ /app/
COPY --chown=node:node --from=build /app/buckets/b16/ /app/
COPY --chown=node:node --from=build /app/buckets/b17/ /app/
COPY --chown=node:node --from=build /app/buckets/b18/ /app/
COPY --chown=node:node --from=build /app/buckets/b19/ /app/
COPY --chown=node:node --from=build /app/buckets/b20/ /app/
COPY --chown=node:node --from=build /app/buckets/b21/ /app/
COPY --chown=node:node --from=build /app/buckets/b22/ /app/
COPY --chown=node:node --from=build /app/buckets/b23/ /app/
COPY --chown=node:node --from=build /app/buckets/b24/ /app/
COPY --chown=node:node --from=build /app/buckets/b25/ /app/
COPY --chown=node:node --from=build /app/buckets/b26/ /app/
COPY --chown=node:node --from=build /app/buckets/b27/ /app/
COPY --chown=node:node --from=build /app/buckets/b28/ /app/
COPY --chown=node:node --from=build /app/buckets/b29/ /app/
COPY --chown=node:node --from=build /app/buckets/b30/ /app/
COPY --chown=node:node --from=build /app/buckets/b31/ /app/
COPY --chown=node:node --from=build /app/buckets/b32/ /app/
COPY --chown=node:node --from=build /app/buckets/b33/ /app/
COPY --chown=node:node --from=build /app/buckets/b34/ /app/
COPY --chown=node:node --from=build /app/buckets/b35/ /app/
COPY --chown=node:node --from=build /app/buckets/b36/ /app/
COPY --chown=node:node --from=build /app/buckets/b37/ /app/
COPY --chown=node:node --from=build /app/buckets/b38/ /app/
COPY --chown=node:node --from=build /app/buckets/b39/ /app/
COPY --chown=node:node --from=build /app/buckets/b40/ /app/
COPY --chown=node:node --from=build /app/buckets/b41/ /app/
COPY --chown=node:node --from=build /app/buckets/b42/ /app/
COPY --chown=node:node --from=build /app/buckets/b43/ /app/
COPY --chown=node:node --from=build /app/buckets/b44/ /app/
COPY --chown=node:node --from=build /app/buckets/b45/ /app/
COPY --chown=node:node --from=build /app/buckets/b46/ /app/
COPY --chown=node:node --from=build /app/buckets/b47/ /app/
COPY --chown=node:node --from=build /app/buckets/b48/ /app/
COPY --chown=node:node --from=build /app/buckets/b49/ /app/
COPY --chown=node:node --from=build /app/buckets/b50/ /app/
COPY --chown=node:node --from=build /app/buckets/b51/ /app/
COPY --chown=node:node --from=build /app/buckets/b52/ /app/
COPY --chown=node:node --from=build /app/buckets/b53/ /app/
COPY --chown=node:node --from=build /app/buckets/b54/ /app/
COPY --chown=node:node --from=build /app/buckets/b55/ /app/
COPY --chown=node:node --from=build /app/buckets/b56/ /app/
COPY --chown=node:node --from=build /app/buckets/b57/ /app/
COPY --chown=node:node --from=build /app/buckets/b58/ /app/
COPY --chown=node:node --from=build /app/buckets/b59/ /app/
COPY --chown=node:node --from=build /app/buckets/b60/ /app/
COPY --chown=node:node --from=build /app/buckets/b61/ /app/
COPY --chown=node:node --from=build /app/buckets/b62/ /app/
COPY --chown=node:node --from=build /app/buckets/b63/ /app/
COPY --chown=node:node --from=build /app/buckets/b64/ /app/
COPY --chown=node:node --from=build /app/buckets/b65/ /app/
COPY --chown=node:node --from=build /app/buckets/b66/ /app/
COPY --chown=node:node --from=build /app/buckets/b67/ /app/
COPY --chown=node:node --from=build /app/buckets/b68/ /app/
COPY --chown=node:node --from=build /app/buckets/b69/ /app/
COPY --chown=node:node --from=build /app/buckets/b70/ /app/
COPY --chown=node:node --from=build /app/buckets/b71/ /app/
COPY --chown=node:node --from=build /app/buckets/b72/ /app/
COPY --chown=node:node --from=build /app/buckets/b73/ /app/
COPY --chown=node:node --from=build /app/buckets/b74/ /app/
COPY --chown=node:node --from=build /app/buckets/b75/ /app/
COPY --chown=node:node --from=build /app/buckets/b76/ /app/
COPY --chown=node:node --from=build /app/buckets/b77/ /app/
COPY --chown=node:node --from=build /app/buckets/b78/ /app/
COPY --chown=node:node --from=build /app/buckets/b79/ /app/
COPY --chown=node:node --from=build /app/buckets/b80/ /app/
COPY --chown=node:node --from=build /app/buckets/b81/ /app/
COPY --chown=node:node --from=build /app/buckets/b82/ /app/
COPY --chown=node:node --from=build /app/buckets/b83/ /app/
COPY --chown=node:node --from=build /app/buckets/b84/ /app/
COPY --chown=node:node --from=build /app/buckets/b85/ /app/
COPY --chown=node:node --from=build /app/buckets/b86/ /app/
COPY --chown=node:node --from=build /app/buckets/b87/ /app/
COPY --chown=node:node --from=build /app/buckets/b88/ /app/
COPY --chown=node:node --from=build /app/buckets/b89/ /app/
COPY --chown=node:node --from=build /app/buckets/b90/ /app/
COPY --chown=node:node --from=build /app/buckets/b91/ /app/
COPY --chown=node:node --from=build /app/buckets/b92/ /app/
COPY --chown=node:node --from=build /app/buckets/b93/ /app/
COPY --chown=node:node --from=build /app/buckets/b94/ /app/
COPY --chown=node:node --from=build /app/buckets/b95/ /app/

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
