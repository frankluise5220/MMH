# MMH 本地 NAS 安装说明

目标：安装和更新都走同一套 Git 流程，不再下载几百兆镜像。

适用场景：
- 你已经把仓库同步到 NAS 本地 Git 仓库
- 或者想先从 GitHub 克隆，再在 NAS 上长期更新

## 1. 选择仓库地址

二选一，保留一行即可：

```bash
# 本地 bare 仓库
REPO_URL="/vol1/1000/git/MMH.git"

# GitHub 仓库
# REPO_URL="https://github.com/frankluise5220/MMH.git"
```

## 2. 首次安装

在 NAS 的 SSH 里执行：

```bash
sh -c 'set -e
APP_DIR="$HOME/mmh"
REPO_URL="/vol1/1000/git/MMH.git"

cd "$HOME"
rm -rf "$APP_DIR"
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
MMH_GIT_REMOTE="origin"
MMH_GIT_BRANCH="main"
STATEMENT_API_KEY=""
PRISMA_CLIENT_ENGINE_TYPE="binary"
EOF

sudo docker compose up -d --build

echo "MMH 安装完成"
echo "访问地址: http://NAS_IP:7777/"
echo "数据库密码已写入 $APP_DIR/.env"
'
```

## 3. 在线更新

以后更新时，只需要在 NAS 上进入项目目录：

```bash
cd ~/mmh
git pull
sudo docker compose up -d --build
```

这会拉取最小 Git 差异，然后重新构建容器，不会重新下载整包镜像。

