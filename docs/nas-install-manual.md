# MMH NAS Docker 安装与更新方向

这份文档记录当前确定的 NAS 部署方向。MMH 在 NAS 上就是 Docker 部署；测试环境和正式环境使用同一套安装、更新步骤，只替换来源地址。

## 1. 核心原则

NAS 上运行的是 Docker 容器，不是直接运行源码。因此 Docker 部署必须同时管理两个来源：

- `REPO_URL`：代码仓库来源
- `MMH_APP_IMAGE`：应用镜像来源

测试环境和正式环境的步骤必须保持一致，区别只应该是这两个地址不同。

安装来源只改这一行：

```bash
MMH_SOURCE="github"
```

可选值：

- `github`：正式发布源。
- `local`：本地测试源。

镜像源只改这一行；安装后也可以在 Web 的系统更新页切换：

```bash
MMH_IMAGE_SOURCE="auto"
```

可选值：

- `auto`：自动检测可用镜像源。
- `ghcr`：正式镜像源，`ghcr.io/frankluise5220/mmh:latest`。
- `dockerproxy`：GHCR 代理源，`ghcr.dockerproxy.net/frankluise5220/mmh:latest`。
- `daocloud`：GHCR 代理源，`ghcr.m.daocloud.io/frankluise5220/mmh:latest`。
- `nju`：GHCR 代理源，`ghcr.nju.edu.cn/frankluise5220/mmh:latest`。
- `custom`：自定义镜像源，填写 `CUSTOM_MMH_APP_IMAGE`。

不同网络环境下镜像源速度不同。代理源是第三方服务，可能有波动；正式源仍以 GHCR 为准。

安装完成后，可在 Web `系统设置 -> 系统更新` 中用列表选择镜像源，并点击 `测试速度` 查看各镜像源的清单响应时间。

来源展开：

```bash
if [ "$MMH_SOURCE" = "github" ]; then
  REPO_URL="https://github.com/frankluise5220/MMH.git"
fi

if [ "$MMH_SOURCE" = "local" ]; then
  REPO_URL="ssh://USER@LOCAL_NAS_HOST:PORT/path/to/MMH.git"
fi

if [ "$MMH_IMAGE_SOURCE" = "auto" ]; then
  MMH_APP_IMAGE="自动选择 ghcr.dockerproxy.net / ghcr.nju.edu.cn / ghcr.io / ghcr.m.daocloud.io"
elif [ "$MMH_IMAGE_SOURCE" = "ghcr" ]; then
  MMH_APP_IMAGE="ghcr.io/frankluise5220/mmh:latest"
elif [ "$MMH_IMAGE_SOURCE" = "dockerproxy" ]; then
  MMH_APP_IMAGE="ghcr.dockerproxy.net/frankluise5220/mmh:latest"
elif [ "$MMH_IMAGE_SOURCE" = "daocloud" ]; then
  MMH_APP_IMAGE="ghcr.m.daocloud.io/frankluise5220/mmh:latest"
elif [ "$MMH_IMAGE_SOURCE" = "nju" ]; then
  MMH_APP_IMAGE="ghcr.nju.edu.cn/frankluise5220/mmh:latest"
elif [ "$MMH_IMAGE_SOURCE" = "custom" ]; then
  MMH_APP_IMAGE="$CUSTOM_MMH_APP_IMAGE"
fi
```

## 2. Docker 权限

安装或更新前先确认当前 shell 有 Docker 权限：

```bash
docker ps
```

如果提示 `permission denied`，先进入 root shell，再继续执行安装或更新命令：

```bash
sudo -i
```

## 3. 更新流程

无论测试环境还是正式环境，更新步骤都相同：

```bash
cd ~/mmh
git pull
sudo docker compose pull app updater
sudo docker compose up -d
```

含义：

- `git pull`：从当前 `REPO_URL` 对应的代码源更新代码。
- `docker compose pull app updater`：从当前镜像源拉取应用镜像和更新执行器镜像。
- `docker compose up -d`：用新镜像重启相关容器。

日常更新不应该在 NAS 上运行：

```bash
sudo docker compose build --pull=false app
```

这条命令会在 NAS 本机执行依赖安装和应用构建，容易拖慢飞牛，只能作为临时调试手段。

## 4. 基础镜像处理

安装前不用手动判断基础镜像是否存在。Docker 会自动复用 NAS 上已有的镜像层，缺少时再按需要拉取。

需要确认或排障时再查看：

```bash
sudo docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep -E 'node:20-bookworm|postgres:15-alpine'
```

看到 `node:20-bookworm` 或 `postgres:15-alpine`，表示对应镜像已经在本机，后续安装和更新会直接复用。

## 5. 镜像策略

第一次安装或第一次切换到新的镜像源时，可能需要下载较大的基础层，这是可以接受的。

后续普通更新的目标是只拉取变化的镜像层，不能每次都接近全量下载。

当前策略不是优先追求首次安装最小，而是优先保证后续更新稳定、简单、下载量小。用户首次安装时对较大下载量有心理预期；日常更新时则应尽量复用已经存在的 Node、PostgreSQL、Prisma/npm 依赖等基础层。

当前镜像优化方向：

- 使用 Next.js `standalone` 输出，减少运行镜像里的文件和依赖。
- 构建和运行默认都使用 `node:20-bookworm`，减少基础镜像种类。首次安装可能更大，但后续普通业务更新不会因为这个基础层已经存在而重复下载。
- Prisma 启动依赖单独分层，避免把完整构建环境放进运行镜像。
- 将不常变化的系统依赖、Prisma/npm 运行依赖放在更稳定的层，将经常变化的应用构建产物放在靠后的层。
- NAS 只拉镜像并重启容器，不在本机编译应用。
- 普通业务代码更新时，理想状态是只下载应用变化层，而不是重新下载 Node/PostgreSQL 基础层。

## 6. 测试与正式发布

测试链路和正式链路应保持同构。

测试时：

- 代码从本地/NAS 测试仓库取。
- 镜像从测试镜像源取。
- 命令仍然是 `git pull`、`docker compose pull app updater`、`docker compose up -d`。

正式发布时：

- 代码从 GitHub 取。
- 镜像从 GHCR 取。
- 命令仍然是同一组。

最终产品不依赖本地仓库。本地仓库只用于测试阶段提高迭代速度。

## 7. 首次安装模板

```bash
sh -c 'set -e
INSTALL_HOME="$HOME"
if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  INSTALL_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
fi
APP_DIR="$INSTALL_HOME/mmh"

# 只需要改这里：github 使用正式源，local 使用局域网测试源。
MMH_SOURCE="github"
# 默认 auto；安装后可在 Web 系统更新页切换。
MMH_IMAGE_SOURCE="auto"
CUSTOM_MMH_APP_IMAGE=""
CUSTOM_MMH_UPDATER_IMAGE=""

if [ "$MMH_SOURCE" = "github" ]; then
  REPO_URL="https://github.com/frankluise5220/MMH.git"
elif [ "$MMH_SOURCE" = "local" ]; then
  REPO_URL="ssh://USER@LOCAL_NAS_HOST:PORT/path/to/MMH.git"
else
  echo "未知 MMH_SOURCE: $MMH_SOURCE"
  exit 1
fi

if [ "$MMH_IMAGE_SOURCE" = "auto" ]; then
  for source in \
    "ghcr.dockerproxy.net/frankluise5220/mmh:latest|ghcr.dockerproxy.net/frankluise5220/mmh-updater:latest|dockerproxy" \
    "ghcr.nju.edu.cn/frankluise5220/mmh:latest|ghcr.nju.edu.cn/frankluise5220/mmh-updater:latest|NJU" \
    "ghcr.io/frankluise5220/mmh:latest|ghcr.io/frankluise5220/mmh-updater:latest|GHCR" \
    "ghcr.m.daocloud.io/frankluise5220/mmh:latest|ghcr.m.daocloud.io/frankluise5220/mmh-updater:latest|DaoCloud"; do
    APP_CANDIDATE="$(echo "$source" | cut -d "|" -f 1)"
    UPDATER_CANDIDATE="$(echo "$source" | cut -d "|" -f 2)"
    SOURCE_NAME="$(echo "$source" | cut -d "|" -f 3)"
    if timeout 8 docker manifest inspect "$APP_CANDIDATE" >/dev/null 2>&1; then
      echo "使用 $SOURCE_NAME 镜像源"
      MMH_APP_IMAGE="$APP_CANDIDATE"
      MMH_UPDATER_IMAGE="$UPDATER_CANDIDATE"
      break
    fi
  done
  if [ -z "${MMH_APP_IMAGE:-}" ]; then
    echo "未找到可用镜像源"
    exit 1
  fi
elif [ "$MMH_IMAGE_SOURCE" = "ghcr" ]; then
  MMH_APP_IMAGE="ghcr.io/frankluise5220/mmh:latest"
  MMH_UPDATER_IMAGE="ghcr.io/frankluise5220/mmh-updater:latest"
elif [ "$MMH_IMAGE_SOURCE" = "dockerproxy" ]; then
  MMH_APP_IMAGE="ghcr.dockerproxy.net/frankluise5220/mmh:latest"
  MMH_UPDATER_IMAGE="ghcr.dockerproxy.net/frankluise5220/mmh-updater:latest"
elif [ "$MMH_IMAGE_SOURCE" = "daocloud" ]; then
  MMH_APP_IMAGE="ghcr.m.daocloud.io/frankluise5220/mmh:latest"
  MMH_UPDATER_IMAGE="ghcr.m.daocloud.io/frankluise5220/mmh-updater:latest"
elif [ "$MMH_IMAGE_SOURCE" = "nju" ]; then
  MMH_APP_IMAGE="ghcr.nju.edu.cn/frankluise5220/mmh:latest"
  MMH_UPDATER_IMAGE="ghcr.nju.edu.cn/frankluise5220/mmh-updater:latest"
elif [ "$MMH_IMAGE_SOURCE" = "custom" ]; then
  if [ -z "$CUSTOM_MMH_APP_IMAGE" ]; then
    echo "MMH_IMAGE_SOURCE=custom 时必须填写 CUSTOM_MMH_APP_IMAGE"
    exit 1
  fi
  MMH_APP_IMAGE="$CUSTOM_MMH_APP_IMAGE"
  MMH_UPDATER_IMAGE="${CUSTOM_MMH_UPDATER_IMAGE:-ghcr.io/frankluise5220/mmh-updater:latest}"
else
  echo "未知 MMH_IMAGE_SOURCE: $MMH_IMAGE_SOURCE"
  exit 1
fi

if ! docker ps >/dev/null 2>&1; then
  echo "当前 shell 没有 Docker 权限。请先执行 sudo -i，然后重新运行安装命令。"
  exit 1
fi

cd "$INSTALL_HOME"
if [ -d "$APP_DIR" ] || docker ps -a --format "{{.Names}}" | grep -Eq "^(mmh-app|mmh-db)$" || docker volume inspect mmh_pgdata >/dev/null 2>&1; then
  echo "发现已有 MMH 安装目录、容器或数据库卷。"
  echo "安装脚本已停止，避免生成新数据库密码后连接旧数据库失败。"
  echo ""
  echo "如果是更新，请执行:"
  echo "cd $APP_DIR && git pull && docker compose pull app updater && docker compose up -d"
  echo ""
  echo "如果要清空重装，会删除 MMH 数据库数据，请先执行:"
  echo "if [ -d $APP_DIR ]; then cd $APP_DIR && docker compose down -v; fi"
  echo "docker rm -f mmh-app mmh-db 2>/dev/null || true"
  echo "docker volume rm mmh_pgdata 2>/dev/null || true"
  echo "rm -rf $APP_DIR"
  echo ""
  echo "清理后重新执行安装命令。"
  exit 1
fi

if docker image inspect node:20-bookworm >/dev/null 2>&1; then
  echo "已存在 node:20-bookworm，跳过拉取"
else
  docker pull node:20-bookworm
fi

if docker image inspect postgres:15-alpine >/dev/null 2>&1; then
  echo "已存在 postgres:15-alpine，跳过拉取"
else
  docker pull postgres:15-alpine
fi

git clone "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"

POSTGRES_DB="mmh"
POSTGRES_USER="mmh-fs"
POSTGRES_PASSWORD="$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | xxd -p)"
MMH_UPDATE_TOKEN="$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | xxd -p)"

cat > .env <<EOF
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public"
POSTGRES_DB="$POSTGRES_DB"
POSTGRES_USER="$POSTGRES_USER"
POSTGRES_PASSWORD="$POSTGRES_PASSWORD"
STATEMENT_API_KEY=""
MMH_UPDATE_TOKEN="$MMH_UPDATE_TOKEN"
MMH_UPDATER_URL="http://updater:7788"
MMH_IMAGE_SOURCE="$MMH_IMAGE_SOURCE"
MMH_UPDATER_IMAGE="$MMH_UPDATER_IMAGE"
CUSTOM_MMH_APP_IMAGE="$CUSTOM_MMH_APP_IMAGE"
CUSTOM_MMH_UPDATER_IMAGE="$CUSTOM_MMH_UPDATER_IMAGE"
PRISMA_CLIENT_ENGINE_TYPE="binary"
MMH_APP_IMAGE="$MMH_APP_IMAGE"
NODE_BUILD_IMAGE="node:20-bookworm"
NODE_RUNTIME_IMAGE="node:20-bookworm"
POSTGRES_IMAGE="postgres:15-alpine"
EOF

docker compose pull app updater
docker compose up -d

echo "MMH 安装完成"
echo "访问地址: http://NAS_IP:7777/"
echo "数据库密码: $POSTGRES_PASSWORD"
echo "数据库密码已写入 $APP_DIR/.env"
echo "在线更新令牌已写入 $APP_DIR/.env"
'
```

## 8. 本机构建只作兜底

只有在需要临时验证 Dockerfile 或镜像结构时，才在 NAS 上执行本机构建：

```bash
sudo docker compose -f docker-compose.yml -f docker-compose.build.yml build --pull=false app
sudo docker compose up -d
```

这不是日常更新路径。
