# MMH 本地 NAS 安装说明

目标：本地安装源只保留一个，就是 `192.168.5.149` 上的 bare 仓库；和它并列的另一个来源是 GitHub 发布仓库。

## 1. 保留的两个来源

```bash
# GitHub 发布仓库
REPO_URL="https://github.com/frankluise5220/MMH.git"

# NAS 本地 bare 仓库
REPO_URL="/vol2/1001/fs/mmh/MMH.git"
```

说明：
- 旧的 Windows 本地路径 `E:\fs\mmh` 不再作为安装来源说明的一部分
- 旧的 `/vol1/1000/git/MMH.git` 已废弃，不再使用
- 当前本地安装源统一指向 `192.168.5.149:9022`

## 2. 登录 NAS

```bash
ssh -p 9022 jsbyfubin@192.168.5.149
```

## 3. 首次安装

默认走 NAS 本地 bare 仓库：

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
EOF

sudo docker compose up -d --build

echo "MMH 安装完成"
echo "访问地址: http://NAS_IP:7777/"
echo "数据库密码已写入 $APP_DIR/.env"
'
```

如果你要改成 GitHub 发布源，只改这一行：

```bash
REPO_URL="https://github.com/frankluise5220/MMH.git"
```

## 4. 在线更新

```bash
cd ~/mmh
git pull
sudo docker compose up -d --build
```

## 5. 检查本地仓库

```bash
git --git-dir=/vol2/1001/fs/mmh/MMH.git branch
git --git-dir=/vol2/1001/fs/mmh/MMH.git log -1 --oneline
```

