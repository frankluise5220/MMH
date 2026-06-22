# MMH NAS 安装说明

目标：安装和更新只保留两个来源：GitHub 发布仓库，或 `192.168.5.149` 上的本地 bare 仓库。

适用场景：
- 你想从 GitHub 首次安装
- 或者想从 `192.168.5.149` 上的本地 bare 仓库安装

## 0. 已验证的 NAS 本地仓库

当前唯一保留的 NAS 本地仓库位置：

```bash
ssh -p 9022 jsbyfubin@192.168.5.149
REPO_URL="/vol2/1001/fs/mmh/MMH.git"
```

以后本地安装源统一指向这条路径，不再使用旧的 Windows 本地路径或旧 NAS 路径。

## 1. 选择仓库地址

二选一，保留一行即可：

```bash
# GitHub 仓库
REPO_URL="https://github.com/frankluise5220/MMH.git"

# 本地 bare 仓库（192.168.5.149）
# REPO_URL="/vol2/1001/fs/mmh/MMH.git"
```

说明：
- `E:\fs\mmh` 不再作为安装来源写入文档
- 旧的 `/vol1/1000/git/MMH.git` 已废弃
- 当前本地源只认 `192.168.5.149:/vol2/1001/fs/mmh/MMH.git`
- 如果 NAS 默认镜像代理拉取 `node:20-bookworm` / `postgres:15-alpine` 失败，可在 `.env` 里覆盖 `NODE_IMAGE` / `POSTGRES_IMAGE`

## 2. 首次安装

在 NAS 的 SSH 里执行：

```bash
sh -c 'set -e
APP_DIR="$HOME/mmh"
REPO_URL="/vol2/1001/fs/mmh/MMH.git"

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
NODE_IMAGE="node:20-bookworm"
POSTGRES_IMAGE="postgres:15-alpine"
EOF

sudo docker compose up -d --build

echo "MMH 安装完成"
echo "访问地址: http://NAS_IP:7777/"
echo "数据库密码: $POSTGRES_PASSWORD"
echo "请立即保存上面的数据库密码"
echo "数据库密码已写入 $APP_DIR/.env"
'
```

如果你想直接从 GitHub 安装，只需要把上面的：

```bash
REPO_URL="/vol2/1001/fs/mmh/MMH.git"
```

改成：

```bash
REPO_URL="https://github.com/frankluise5220/MMH.git"
```

## 3. 在线更新

以后更新时，只需要在 NAS 上进入项目目录：

```bash
cd ~/mmh
git pull
sudo docker compose up -d --build
```

这会拉取最小 Git 差异，然后重新构建容器，不会重新下载整包镜像。

## 4. 常用命令

先登录 NAS：

```bash
ssh -p 9022 jsbyfubin@192.168.5.149
```

查看本地 bare 仓库：

```bash
git --git-dir=/vol2/1001/fs/mmh/MMH.git branch
```

首次检出到工作目录：

```bash
git clone /vol2/1001/fs/mmh/MMH.git ~/mmh
```

## 5. 如果构建时报 401 Unauthorized

典型报错：

```text
failed to resolve source metadata for docker.io/library/node:20-bookworm
... docker.fnnas.com ... 401 Unauthorized
```

这通常不是项目代码问题，而是 NAS 默认 Docker 镜像代理无权限或不可用。

处理方式：

1. 编辑 `~/mmh/.env`
2. 显式指定可访问的基础镜像
3. 重新执行 `sudo docker compose up -d --build`

可用配置项：

```bash
NODE_IMAGE="node:20-bookworm"
POSTGRES_IMAGE="postgres:15-alpine"
```

如果你所在环境必须使用特定镜像站，就把上面两个值改成该镜像站对应地址。

