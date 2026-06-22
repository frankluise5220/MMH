# MMH NAS 安装说明

目标：把 Docker 基础镜像准备，和 MMH 项目安装/更新彻底分开。

适用场景：
- 从 `192.168.5.149` 上的本地 bare 仓库安装
- 或从 GitHub 发布仓库安装

## 1. 仓库来源

当前保留的两个来源：

```bash
# 本地 bare 仓库
REPO_URL="/vol2/1001/fs/mmh/MMH.git"

# GitHub 仓库
REPO_URL="https://github.com/frankluise5220/MMH.git"
```

说明：
- `149` 本机安装，优先用 `/vol2/1001/fs/mmh/MMH.git`
- 旧的 `E:\fs\mmh` 不再作为安装来源
- 旧的 `/vol1/1000/git/MMH.git` 已废弃

## 2. Docker 基础镜像准备

这一步属于 Docker 环境，不属于 MMH 项目安装。

先在飞牛 Docker 图形界面里确认下面两个镜像已经存在：

- `node:20-bookworm`
- `postgres:15-alpine`

如果图形界面里没有，也可以用命令行准备：

```bash
sudo docker pull node:20-bookworm
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

确认基础镜像已经准备好后，再执行这一段。

先登录 NAS：

```bash
ssh -p 9022 jsbyfubin@192.168.5.149
```

默认走 NAS 本地 bare 仓库：

```bash
sh -c 'set -e
APP_DIR="$HOME/mmh"
REPO_URL="/vol2/1001/fs/mmh/MMH.git"

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
MMH_GIT_REMOTE="origin"
MMH_GIT_BRANCH="main"
STATEMENT_API_KEY=""
PRISMA_CLIENT_ENGINE_TYPE="binary"
NODE_BUILD_IMAGE="node:20-bookworm"
NODE_RUNTIME_IMAGE="node:20-bookworm-slim"
POSTGRES_IMAGE="postgres:15-alpine"
EOF

sudo docker compose build --pull=false app
sudo docker compose up -d

echo "MMH 安装完成"
echo "访问地址: http://NAS_IP:7777/"
echo "也可以安装https://github.com/frankluise5220/MMH/releases/download/android-v1.0.0/mmh-android-v1.0.0.apk，在安卓设备上访问http://NAS_IP:7777/"
echo "数据库密码: $POSTGRES_PASSWORD"
echo "请立即保存上面的数据库密码"
echo "数据库密码已写入 $APP_DIR/.env"
'
```

如果要改成 GitHub 发布源，只改这一行：

```bash
REPO_URL="https://github.com/frankluise5220/MMH.git"
```

## 4. MMH 在线更新

```bash
cd ~/mmh
git pull
sudo docker compose build --pull=false app
sudo docker compose up -d app
```

这会先拉取最小 Git 差异，再用本地 Docker 缓存重建 `app`。基础镜像不变时，不会重新下载整包镜像。

## 5. 常见问题

如果重装时看到：

```text
rm: cannot remove '/home/jsbyfubin/mmh/node_modules/...': Permission denied
```

说明旧版本把 `node_modules` 写成了 `root` 权限，先执行：

```bash
sudo rm -rf ~/mmh
```

如果以前的 Docker 镜像代理报过类似错误：

```text
docker.fnnas.com ... 401 Unauthorized
```

说明是 NAS 默认 Docker 镜像代理有问题，不是 MMH 项目代码有问题。

## 6. 常用检查命令

```bash
git --git-dir=/vol2/1001/fs/mmh/MMH.git branch
git --git-dir=/vol2/1001/fs/mmh/MMH.git log -1 --oneline
```
