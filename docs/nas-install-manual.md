# MMH NAS 安装说明

目标：把 Docker 基础镜像准备，和 MMH 项目安装/更新彻底分开。

适用场景：
- 从 GitHub 发布仓库安装
- 在普通 NAS 或 Linux 主机上运行 MMH

## 1. 项目来源

发布安装统一使用 GitHub 仓库：

```bash
REPO_URL="https://github.com/frankluise5220/MMH.git"
```

首次安装时需要一个 `REPO_URL` 用来 `git clone`。
安装完成后，系统更新默认跟随当前仓库的 `origin/main`，通常不需要单独再填“更新 URL”。

Android 客户端下载地址：

```text
https://github.com/frankluise5220/MMH/releases/download/android-v1.0.0/mmh-android-v1.0.0.apk
```

## 2. Docker 基础镜像准备

这一步属于 Docker 环境准备，不属于 MMH 项目安装。

先在 Docker 图形界面里确认下面两个镜像已经存在：

- `node:20-bookworm`
- `postgres:15-alpine`

如果界面里没有，也可以用命令行准备：

```bash
sudo docker pull node:20-bookworm
sudo docker pull postgres:15-alpine
```

如果 `postgres:15-alpine` 直连 Docker Hub 太慢，可以先拉备用镜像，再打回本地标准名：

```bash
sudo docker pull swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/postgres:15-alpine
sudo docker tag swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/postgres:15-alpine postgres:15-alpine
```

确认镜像：

```bash
sudo docker images | grep -E "node|postgres"
```

## 3. MMH 首次安装

确认基础镜像已经准备好后，再执行这一段：

```bash
sh -c 'set -e
APP_DIR="$HOME/mmh"
REPO_URL="https://github.com/frankluise5220/MMH.git"

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
MMH_APP_IMAGE="ghcr.io/frankluise5220/mmh:latest"
NODE_BUILD_IMAGE="node:20-bookworm"
NODE_RUNTIME_IMAGE="node:20-bookworm-slim"
POSTGRES_IMAGE="postgres:15-alpine"
EOF

sudo docker compose pull app
sudo docker compose up -d

echo "MMH 安装完成"
echo "访问地址: http://NAS_IP:7777/"
echo "也可以安装 https://github.com/frankluise5220/MMH/releases/download/android-v1.0.0/mmh-android-v1.0.0.apk"
echo "数据库密码: $POSTGRES_PASSWORD"
echo "请立即保存上面的数据库密码"
echo "数据库密码已写入 $APP_DIR/.env"
'
```

## 4. MMH 在线更新

```bash
cd ~/mmh
git pull
sudo docker compose pull app
sudo docker compose up -d app
```

这会先拉取最小 Git 差异，再拉取新的 `app` 镜像层并重启容器，不再在 NAS 本机执行 `npm ci` 和 `next build`。
第一次切到新镜像源时，可能会拉取较大的基础层；后续普通更新主要只会拉变动层。
如果是从本地 Git 安装，页面里的系统更新会直接跟随当前仓库的 `origin/main`。
`app` 服务默认使用的镜像是 `ghcr.io/frankluise5220/mmh:latest`，容器名仍然是 `mmh-app`。

如果确实需要在 NAS 本机构建调试版本，再手动运行：

```bash
sudo docker compose -f docker-compose.yml -f docker-compose.build.yml build --pull=false app
sudo docker compose up -d app
```

## 5. 常见问题

如果重装时看到：

```text
rm: cannot remove '/home/.../mmh/node_modules/...': Permission denied
```

说明旧版本把 `node_modules` 写成了 `root` 权限，先执行：

```bash
sudo rm -rf ~/mmh
```

如果以前的 Docker 镜像代理报过类似错误：

```text
docker.fnnas.com ... 401 Unauthorized
```

说明是 Docker 默认镜像代理有问题，不是 MMH 项目代码有问题。
