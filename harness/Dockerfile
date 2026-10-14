# MMH Bug Harness —— 常驻检测服务
# 基础镜像刻意用 148 上已存在的 node:20-bookworm，避免群晖拉取 Docker Hub 失败。
FROM node:20-bookworm

WORKDIR /app

# 先复制依赖清单，利用 Docker 层缓存（改源码不必重装依赖）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production \
    HARNESS_DATA_DIR=/data \
    HARNESS_TASKS_DIR=/tasks \
    HARNESS_PORT=7788

RUN mkdir -p /data /tasks
VOLUME ["/data", "/tasks"]

EXPOSE 7788

HEALTHCHECK --interval=60s --timeout=8s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HARNESS_PORT||7788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.mjs"]
