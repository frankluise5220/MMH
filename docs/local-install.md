# MMH 本地 Docker 安装与更新

本文档只说明本地安装模式。项目主入口和正式发布以 GitHub 项目及 NAS Docker 安装说明为准；其他项目文档不需要关心本地环境细节。

本地安装使用与正式发布相同的镜像更新思路：首次安装可以下载较大的基础层，后续更新通过预构建镜像复用稳定层。

安装来源只改这一行：

```bash
MMH_SOURCE="github"
```

需要测试本地源时改成：

```bash
MMH_SOURCE="local"
```

公开文档不写入具体内网地址。使用 `local` 时，在本机或测试环境把 local 预设替换为自己的 Git 地址和镜像地址。

## 1. 准备

先安装：

- Docker Desktop 或 Docker Engine
- Git

确认命令可用：

```bash
docker --version
git --version
```

## 2. 安装

拉取项目：

```bash
cd ~
MMH_SOURCE="github"

if [ "$MMH_SOURCE" = "github" ]; then
  REPO_URL="https://github.com/frankluise5220/MMH.git"
  MMH_APP_IMAGE="ghcr.io/frankluise5220/mmh:latest"
elif [ "$MMH_SOURCE" = "local" ]; then
  REPO_URL="ssh://USER@LOCAL_NAS_HOST:PORT/path/to/MMH.git"
  MMH_APP_IMAGE="LOCAL_IMAGE_SOURCE/mmh:latest"
else
  echo "未知 MMH_SOURCE: $MMH_SOURCE"
  exit 1
fi

git clone "$REPO_URL" mmh
cd mmh
```

创建 `.env`：

```bash
POSTGRES_DB="mmh"
POSTGRES_USER="mmh-fs"
POSTGRES_PASSWORD="CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD"
STATEMENT_API_KEY=""
PRISMA_CLIENT_ENGINE_TYPE="binary"
MMH_APP_IMAGE="$MMH_APP_IMAGE"
NODE_BUILD_IMAGE="node:20-bookworm"
NODE_RUNTIME_IMAGE="node:20-bookworm"
POSTGRES_IMAGE="postgres:15-alpine"
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public"
```

启动：

```bash
docker compose pull app
docker compose up -d
```

打开：

```text
http://localhost:7777/
```

## 3. 更新

在项目目录执行：

```bash
cd ~/mmh
git pull
docker compose pull app
docker compose up -d app
```

## 4. 镜像策略

本地安装和 NAS 安装使用同一套模式：

- 首次安装允许下载较大的基础层。
- 日常更新主要优化下载量。
- 构建和运行默认使用 `node:20-bookworm`，减少基础镜像种类。
- PostgreSQL 镜像独立，普通应用更新不应重新下载数据库镜像。
- 普通用户安装和更新不在本机 build 应用。

日常安装/更新不要运行：

```bash
docker compose up -d --build
docker compose build app
```

这些命令只用于开发者调试 Dockerfile 或本地预览当前工作区代码。

## 5. 停止和重启

停止：

```bash
docker compose stop
```

启动：

```bash
docker compose up -d
```

查看日志：

```bash
docker compose logs -f app
```

## 6. 本地开发预览

如果要预览当前工作区代码，而不是使用发布镜像，使用：

```bash
docker compose -f docker-compose.preview.yml up --build
```

预览环境会在本机 build，适合开发者，不适合普通安装更新。
