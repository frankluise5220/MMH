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

来源展开：

```bash
if [ "$MMH_SOURCE" = "github" ]; then
  REPO_URL="https://github.com/frankluise5220/MMH.git"
  MMH_APP_IMAGE="ghcr.io/frankluise5220/mmh:latest"
fi

if [ "$MMH_SOURCE" = "local" ]; then
  REPO_URL="ssh://USER@LOCAL_NAS_HOST:PORT/path/to/MMH.git"
  MMH_APP_IMAGE="LOCAL_IMAGE_SOURCE/mmh:latest"
fi
```

## 2. 更新流程

无论测试环境还是正式环境，更新步骤都相同：

```bash
cd ~/mmh
git pull
sudo docker compose pull app
sudo docker compose up -d app
```

含义：

- `git pull`：从当前 `REPO_URL` 对应的代码源更新代码。
- `docker compose pull app`：从当前 `MMH_APP_IMAGE` 对应的镜像源拉取应用镜像。
- `docker compose up -d app`：用新镜像重启 `app` 容器。

日常更新不应该在 NAS 上运行：

```bash
sudo docker compose build --pull=false app
```

这条命令会在 NAS 本机执行依赖安装和应用构建，容易拖慢飞牛，只能作为临时调试手段。

## 3. 镜像策略

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

## 4. 测试与正式发布

测试链路和正式链路应保持同构。

测试时：

- 代码从本地/NAS 测试仓库取。
- 镜像从测试镜像源取。
- 命令仍然是 `git pull`、`docker compose pull app`、`docker compose up -d app`。

正式发布时：

- 代码从 GitHub 取。
- 镜像从 GHCR 取。
- 命令仍然是同一组。

最终产品不依赖本地仓库。本地仓库只用于测试阶段提高迭代速度。

## 5. 首次安装模板

安装时先确定来源：

```bash
MMH_SOURCE="github"
```

然后执行：

```bash
sh -c 'set -e
APP_DIR="$HOME/mmh"
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

cd "$HOME"
if [ -d "$APP_DIR" ]; then
  echo "发现旧安装目录，先删除: $APP_DIR"
  sudo rm -rf "$APP_DIR"
fi

git clone "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"

POSTGRES_DB="mmh"
POSTGRES_USER="mmh-fs"
POSTGRES_PASSWORD="$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | xxd -p)"

cat > .env <<EOF
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public"
POSTGRES_DB="$POSTGRES_DB"
POSTGRES_USER="$POSTGRES_USER"
POSTGRES_PASSWORD="$POSTGRES_PASSWORD"
STATEMENT_API_KEY=""
PRISMA_CLIENT_ENGINE_TYPE="binary"
MMH_APP_IMAGE="$MMH_APP_IMAGE"
NODE_BUILD_IMAGE="node:20-bookworm"
NODE_RUNTIME_IMAGE="node:20-bookworm"
POSTGRES_IMAGE="postgres:15-alpine"
EOF

sudo docker compose pull app
sudo docker compose up -d

echo "MMH 安装完成"
echo "访问地址: http://NAS_IP:7777/"
echo "数据库密码: $POSTGRES_PASSWORD"
echo "数据库密码已写入 $APP_DIR/.env"
'
```

## 6. 本机构建只作兜底

只有在需要临时验证 Dockerfile 或镜像结构时，才在 NAS 上执行本机构建：

```bash
sudo docker compose -f docker-compose.yml -f docker-compose.build.yml build --pull=false app
sudo docker compose up -d app
```

这不是日常更新路径。
