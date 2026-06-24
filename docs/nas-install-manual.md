# MMH NAS Docker 安装与更新

这份文档给最终用户使用。按顺序复制命令即可，不需要在 NAS 上构建源码。

## 1. 准备

NAS 上需要已经安装：

- Docker
- Docker Compose

登录 NAS 终端后，先检查：

```bash
docker --version
docker compose version
```

Git 不是必须项。安装命令会直接生成所需部署文件，不需要下载源码包。

如果 `docker` 提示没有权限，后面的命令会自动尝试使用 `sudo docker`。如果系统要求输入密码，输入当前 NAS 用户密码即可。

可以提前准备 PostgreSQL 基础镜像：

```text
postgres:15-alpine
```

如果 NAS 上还没有，首次安装会自动拉取。提前准备只是为了减少安装时等待。

如果使用 NAS 的 Docker 图形界面，可以在镜像管理里搜索并下载：

```text
postgres
```

选择：

```text
postgres:15-alpine
```

查看当前 Docker 配置了哪些镜像加速源：

```bash
docker info | grep -A 10 "Registry Mirrors"
```

如果 Docker 需要管理员权限：

```bash
sudo docker info | grep -A 10 "Registry Mirrors"
```

说明：

- `postgres:15-alpine` 来自 Docker Hub，使用 NAS Docker 自己配置的 `Registry Mirrors`。
- MMH 应用镜像来自 GHCR，使用安装命令里的 `MMH_IMAGE_SOURCE`，也可以安装后在 Web `系统设置 -> 系统更新 -> 镜像源` 切换。

也可以在终端提前安装。下面命令可在任意目录执行：

```bash
docker pull postgres:15-alpine
```

如果 NAS 的 Docker 已配置镜像加速，这条命令会自动通过加速源下载，命令本身不用改。

如果 Docker 拉取镜像需要管理员权限：

```bash
sudo docker pull postgres:15-alpine
```

如果当前 Docker Hub 加速源仍然很慢，可以临时试这些源。官方镜像需要带 `library/`：

```bash
docker pull docker.1panel.live/library/postgres:15-alpine
docker tag docker.1panel.live/library/postgres:15-alpine postgres:15-alpine
```

```bash
docker pull docker.m.daocloud.io/library/postgres:15-alpine
docker tag docker.m.daocloud.io/library/postgres:15-alpine postgres:15-alpine
```

```bash
docker pull hub.rat.dev/library/postgres:15-alpine
docker tag hub.rat.dev/library/postgres:15-alpine postgres:15-alpine
```

如果上面命令需要管理员权限，在每行前面加 `sudo`。

不需要单独拉取 `node:20-bookworm`。MMH 应用镜像会包含运行所需的 Node 层，安装时直接拉取 MMH 应用镜像即可。

## 2. 全新安装

复制整段执行：

```bash
sh -c 'set -e

APP_DIR="$HOME/mmh"
REPO_URL="https://github.com/frankluise5220/MMH.git"

# 镜像源：dockerproxy / nju / ghcr / daocloud / custom
# 如果当前源很慢或不可用，只改这一行。
MMH_IMAGE_SOURCE="dockerproxy"
CUSTOM_MMH_APP_IMAGE=""
CUSTOM_MMH_UPDATER_IMAGE=""

if docker ps >/dev/null 2>&1; then
  DOCKER="docker"
elif command -v sudo >/dev/null 2>&1 && sudo docker ps >/dev/null 2>&1; then
  DOCKER="sudo docker"
else
  echo "当前用户没有 Docker 权限，请先在 NAS 上启用 Docker 权限后重试。"
  exit 1
fi

choose_images() {
  case "$MMH_IMAGE_SOURCE" in
    ghcr)
      MMH_APP_IMAGE="ghcr.io/frankluise5220/mmh:latest"
      MMH_UPDATER_IMAGE="ghcr.io/frankluise5220/mmh-updater:latest"
      ;;
    dockerproxy)
      MMH_APP_IMAGE="ghcr.dockerproxy.net/frankluise5220/mmh:latest"
      MMH_UPDATER_IMAGE="ghcr.dockerproxy.net/frankluise5220/mmh-updater:latest"
      ;;
    nju)
      MMH_APP_IMAGE="ghcr.nju.edu.cn/frankluise5220/mmh:latest"
      MMH_UPDATER_IMAGE="ghcr.nju.edu.cn/frankluise5220/mmh-updater:latest"
      ;;
    daocloud)
      MMH_APP_IMAGE="ghcr.m.daocloud.io/frankluise5220/mmh:latest"
      MMH_UPDATER_IMAGE="ghcr.m.daocloud.io/frankluise5220/mmh-updater:latest"
      ;;
    custom)
      if [ -z "$CUSTOM_MMH_APP_IMAGE" ]; then
        echo "MMH_IMAGE_SOURCE=custom 时必须填写 CUSTOM_MMH_APP_IMAGE。"
        exit 1
      fi
      MMH_APP_IMAGE="$CUSTOM_MMH_APP_IMAGE"
      MMH_UPDATER_IMAGE="${CUSTOM_MMH_UPDATER_IMAGE:-ghcr.io/frankluise5220/mmh-updater:latest}"
      ;;
    *)
      echo "未知镜像源：$MMH_IMAGE_SOURCE"
      exit 1
      ;;
  esac
}

if [ -d "$APP_DIR" ] || $DOCKER ps -a --format "{{.Names}}" | grep -Eq "^(mmh-app|mmh-db|mmh-updater)$" || $DOCKER volume inspect mmh_pgdata >/dev/null 2>&1; then
  echo "发现已有 MMH 安装目录、容器或数据库卷。"
  echo "如果是更新，请执行文档里的“一键更新”。"
  echo "如果要清空重装，请先执行文档里的“清空重装”。"
  exit 1
fi

choose_images

if $DOCKER image inspect postgres:15-alpine >/dev/null 2>&1; then
  echo "已存在 postgres:15-alpine，跳过拉取。"
else
  echo "正在拉取基础镜像 postgres:15-alpine。"
  $DOCKER pull postgres:15-alpine
fi

mkdir -p "$APP_DIR"
cd "$APP_DIR"

POSTGRES_DB="mmh"
POSTGRES_USER="mmh-fs"
POSTGRES_PASSWORD="$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | xxd -p)"

cat > docker-compose.yml <<\EOF
services:
  postgres:
    image: ${POSTGRES_IMAGE:-postgres:15-alpine}
    container_name: mmh-db
    restart: unless-stopped
    ports:
      - "5433:5432"
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-mmh}
      POSTGRES_USER: ${POSTGRES_USER:-mmh-fs}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgres-entrypoint.sh:/docker-entrypoint-initdb.d/init.sh
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-mmh-fs} -d ${POSTGRES_DB:-mmh}"]
      interval: 10s
      timeout: 5s
      retries: 5

  app:
    image: ${MMH_APP_IMAGE:-ghcr.io/frankluise5220/mmh:latest}
    container_name: mmh-app
    restart: unless-stopped
    ports:
      - "7777:7777"
    env_file:
      - .env
    environment:
      DOCKER_CONTAINER: "true"
      MMH_UPDATE_MODE: git
      MMH_GIT_REMOTE: ${MMH_GIT_REMOTE:-origin}
      MMH_GIT_BRANCH: ${MMH_GIT_BRANCH:-main}
      MMH_UPDATE_SOURCE_URL: ${MMH_UPDATE_SOURCE_URL:-https://github.com/frankluise5220/MMH.git}
      MMH_UPDATER_URL: ${MMH_UPDATER_URL:-http://updater:7788}
      MMH_UPDATE_TOKEN: ${POSTGRES_PASSWORD:-CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD}
      NODE_ENV: production
      POSTGRES_DB: ${POSTGRES_DB:-mmh}
      POSTGRES_USER: ${POSTGRES_USER:-mmh-fs}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD}
      DATABASE_URL: postgresql://${POSTGRES_USER:-mmh-fs}:${POSTGRES_PASSWORD:-CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD}@postgres:5432/${POSTGRES_DB:-mmh}?schema=public
      PGPASSWORD: ${POSTGRES_PASSWORD:-CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD}
    depends_on:
      - postgres
      - updater

  updater:
    image: ${MMH_UPDATER_IMAGE:-ghcr.io/frankluise5220/mmh-updater:latest}
    container_name: mmh-updater
    restart: unless-stopped
    working_dir: /workspace
    command: sh -lc "git config --global --add safe.directory /workspace >/dev/null 2>&1 || true; exec node /updater/mmh-updater-server.mjs"
    environment:
      MMH_UPDATE_TOKEN: ${POSTGRES_PASSWORD:-CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD}
      MMH_WORKDIR: /workspace
      MMH_COMPOSE_PROJECT: ${MMH_COMPOSE_PROJECT:-mmh}
      MMH_COMPOSE_FILE: /workspace/docker-compose.yml
      MMH_IMAGE_SOURCE: ${MMH_IMAGE_SOURCE:-dockerproxy}
      CUSTOM_MMH_APP_IMAGE: ${CUSTOM_MMH_APP_IMAGE:-}
      CUSTOM_MMH_UPDATER_IMAGE: ${CUSTOM_MMH_UPDATER_IMAGE:-}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./:/workspace

volumes:
  pgdata:
EOF

cat > postgres-entrypoint.sh <<\EOF
#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE SCHEMA IF NOT EXISTS public;
  GRANT ALL ON SCHEMA public TO "$POSTGRES_USER";
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";
EOSQL
EOF
chmod +x postgres-entrypoint.sh

cat > .env <<EOF
COMPOSE_PROJECT_NAME="mmh"
POSTGRES_DB="$POSTGRES_DB"
POSTGRES_USER="$POSTGRES_USER"
POSTGRES_PASSWORD="$POSTGRES_PASSWORD"
STATEMENT_API_KEY=""
MMH_UPDATER_URL="http://updater:7788"
MMH_UPDATE_SOURCE_URL="$REPO_URL"
MMH_GIT_REMOTE="origin"
MMH_GIT_BRANCH="main"
MMH_COMPOSE_PROJECT="mmh"
MMH_IMAGE_SOURCE="$MMH_IMAGE_SOURCE"
MMH_APP_IMAGE="$MMH_APP_IMAGE"
MMH_UPDATER_IMAGE="$MMH_UPDATER_IMAGE"
CUSTOM_MMH_APP_IMAGE="$CUSTOM_MMH_APP_IMAGE"
CUSTOM_MMH_UPDATER_IMAGE="$CUSTOM_MMH_UPDATER_IMAGE"
PRISMA_CLIENT_ENGINE_TYPE="binary"
POSTGRES_IMAGE="postgres:15-alpine"
EOF

$DOCKER compose -p mmh pull app updater postgres
$DOCKER compose -p mmh up -d

echo ""
echo "MMH 安装完成。"
echo "访问地址：http://NAS_IP:7777/"
echo "数据库密码已写入：$APP_DIR/.env"
echo "内部更新令牌会自动使用数据库密码。"
'
```

把 `NAS_IP` 换成 NAS 的实际 IP，例如：

```text
http://192.168.5.149:7777/
```

## 3. 图形界面安装

没有 Git，也可以用 NAS 的 Docker 图形界面安装。

1. 在 NAS 文件管理里新建一个目录，例如：

```text
/home/jsbyfubin/mmh
```

也可以使用 NAS 里的共享目录，例如：

```text
/volume1/docker/mmh
```

2. 下载下面三个文件，放到同一个目录里：

```text
deploy/nas/docker-compose.yml
deploy/nas/postgres-entrypoint.sh
deploy/nas/env.example
```

GitHub 下载地址：

```text
https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/docker-compose.yml
https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/postgres-entrypoint.sh
https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/env.example
```

3. 把 `env.example` 改名为 `.env`。

4. 打开 `.env`，只需要修改数据库密码：

```bash
POSTGRES_PASSWORD="CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD"
```

`DATABASE_URL` 会由 `docker-compose.yml` 根据 `POSTGRES_PASSWORD` 自动生成，不需要手工填写。
内部更新令牌也会默认使用 `POSTGRES_PASSWORD`，用户更新时不需要输入。

5. 打开 NAS 的 Docker 图形界面，进入 Compose、项目、应用栈或 Stack 功能。

如果界面要求填写项目名称、应用栈名称或 Stack 名称，直接填写：

```text
mmh
```

6. 选择这个目录里的 `docker-compose.yml`，点击部署。

7. 部署完成后访问：

```text
http://NAS_IP:7777/
```

把 `NAS_IP` 换成 NAS 的实际 IP。

## 4. 日常更新

日常更新在 Web 页面完成，不需要 SSH 到 NAS 执行命令。

```text
系统设置 -> 系统更新 -> 刷新远端版本 -> 更新
```

页面会完成：

- 检查远端版本
- 拉取应用镜像
- 重启应用服务

只有在 Web 页面打不开、系统更新页无法进入、或更新被异常中断时，才使用终端备用恢复命令：

```bash
sh -c 'set -e

APP_DIR="$HOME/mmh"
cd "$APP_DIR"

if docker ps >/dev/null 2>&1; then
  DOCKER="docker"
elif command -v sudo >/dev/null 2>&1 && sudo docker ps >/dev/null 2>&1; then
  DOCKER="sudo docker"
else
  echo "当前用户没有 Docker 权限，请先在 NAS 上启用 Docker 权限后重试。"
  exit 1
fi

if [ -d .git ] && command -v git >/dev/null 2>&1; then
  git pull --ff-only
else
  echo "当前安装目录没有 Git 仓库或系统未安装 Git，跳过部署文件同步。"
fi

$DOCKER compose -p mmh pull app updater
$DOCKER compose -p mmh up -d

echo "MMH 更新完成。"
'
```

## 5. 切换镜像源

如果当前镜像源下载很慢，在 Web 页面切换：

```text
系统设置 -> 系统更新 -> 镜像源
```

切换后再点击更新即可。

只有在 Web 页面打不开时，才用终端修改 `.env`：

```bash
cd ~/mmh
sed -i 's#^MMH_IMAGE_SOURCE=.*#MMH_IMAGE_SOURCE="dockerproxy"#' .env
sed -i 's#^MMH_APP_IMAGE=.*#MMH_APP_IMAGE="ghcr.dockerproxy.net/frankluise5220/mmh:latest"#' .env
sed -i 's#^MMH_UPDATER_IMAGE=.*#MMH_UPDATER_IMAGE="ghcr.dockerproxy.net/frankluise5220/mmh-updater:latest"#' .env
```

可用值：

- `ghcr`：`ghcr.io/frankluise5220/mmh:latest`
- `dockerproxy`：`ghcr.dockerproxy.net/frankluise5220/mmh:latest`
- `nju`：`ghcr.nju.edu.cn/frankluise5220/mmh:latest`
- `daocloud`：`ghcr.m.daocloud.io/frankluise5220/mmh:latest`

## 6. 清空重装

清空重装会删除 MMH 数据库数据。确认要删除后再执行：

```bash
sh -c 'set -e

APP_DIR="$HOME/mmh"

if docker ps >/dev/null 2>&1; then
  DOCKER="docker"
elif command -v sudo >/dev/null 2>&1 && sudo docker ps >/dev/null 2>&1; then
  DOCKER="sudo docker"
else
  echo "当前用户没有 Docker 权限，请先在 NAS 上启用 Docker 权限后重试。"
  exit 1
fi

if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR"
  $DOCKER compose -p mmh down -v
fi

$DOCKER rm -f mmh-app mmh-db mmh-updater 2>/dev/null || true
$DOCKER volume rm mmh_pgdata 2>/dev/null || true
rm -rf "$APP_DIR"

echo "MMH 已清空。需要重新安装时，再执行“全新安装”。"
'
```

## 7. 基础镜像

第一次安装可能会下载较大的基础层。以后更新会复用已有层，正常情况下只拉取变化的应用层。

需要查看本机是否已有 PostgreSQL 基础镜像时执行：

```bash
docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep 'postgres:15-alpine'
```

看到 `postgres:15-alpine`，表示 PostgreSQL 基础镜像已经在本机，后续安装会复用。
