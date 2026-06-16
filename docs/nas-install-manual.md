# MMH NAS 安装操作手册（Docker 版）

仓库地址：`https://github.com/frankluise5220/MMH`

目标：在 NAS 上启动 3 个容器（数据库 + Web + Watchtower），局域网浏览器访问 `http://NAS_IP:7777/`，并且可在“系统更新”页面内触发更新。

## 1) 命令行安装（推荐）

适合：你能在 NAS 上打开 SSH/终端，并且有 `docker compose` 与 `git`。

你只需要做 3 件事：
1. SSH 登录 NAS，打开终端
2. 把下面整段命令一次性复制粘贴执行（不要逐行敲）
3. 等命令结束后，用浏览器打开 `http://NAS_IP:7777/`（把 NAS_IP 换成你的 NAS 局域网 IP）

说明：
- `rm -rf "$APP_DIR"` 只会删除你家目录下的 `~/mmh`，用于“重装/覆盖安装”
- 默认数据库名和用户名可自定义，密码会自动生成
- 如果执行过程中出现 `permission denied while trying to connect to the Docker daemon socket`：用 `sudo docker compose ...` 运行，或把当前用户加入 docker 组后重新登录
- 如果 `git clone` 报 `HTTP/2 stream ... was not closed cleanly`：先执行 `git config --global http.version HTTP/1.1`，再重试
- 应用镜像由 GitHub Actions 自动构建并推送到 ghcr.io，NAS 直接拉取，无需本地编译
- 系统更新只需要在页面点击确认，不需要用户输入更新密码
- 对账单外部接入密钥不在首次安装时生成，需要开放外部接入时再到系统设置里配置
- 复制粘贴要包含从 `sh -c 'set -e` 开始到最后一行单独的 `'` 结束（包含最后这个 `'`），不要只粘贴中间几行

```sh
sh -c 'set -e
APP_DIR="$HOME/mmh"
cd "$HOME"

# 注意：这行会删除旧目录后重装；不想删除就把这一行删掉，并确保目录为空
rm -rf "$APP_DIR"
git clone "https://github.com/frankluise5220/MMH" "$APP_DIR"
cd "$APP_DIR"

POSTGRES_DB="mmh" # 可改：数据库名
POSTGRES_USER="mmh-fs" # 可改：数据库用户名
POSTGRES_PASSWORD="$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | xxd -p)" # 自动生成；也可以改成你自己指定的密码（建议足够复杂）
cat > .env <<EOF
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public"
POSTGRES_DB="$POSTGRES_DB"
POSTGRES_USER="$POSTGRES_USER"
POSTGRES_PASSWORD="$POSTGRES_PASSWORD"
STATEMENT_API_KEY=""
PRISMA_CLIENT_ENGINE_TYPE="binary"
EOF

sudo docker compose pull
sudo docker compose up -d
echo ""
echo "============================================"
echo "  MMH 安装完成！"
echo "============================================"
echo "  访问地址: http://<NAS_IP>:7777/"
echo "  首次打开将引导设置管理员密码"
echo "  数据库密码（系统初始化验证用）: $POSTGRES_PASSWORD"
echo "============================================"
echo "  数据库密码已保存在 .env 文件中"
echo "  可通过 cat ~/mmh/.env 查看"
echo "============================================"
'
```

访问：
- `http://NAS_IP:7777/`

如果启动后反复出现 `P1000: Authentication failed against database server`，通常是旧的 PostgreSQL 数据卷还在，里面保存的是旧密码。确认不需要保留旧数据时，先执行：

```bash
cd ~/mmh
sudo docker compose down -v --remove-orphans
sudo docker rm -f mmh-app mmh-db mmh-watchtower 2>/dev/null || true
sudo docker volume rm mmh_pgdata 2>/dev/null || true
rm -rf ~/mmh
```

然后重新复制上面的完整安装命令执行。

---

## 2) NAS 图形界面安装（Stack/Compose）

适合：只会在 NAS 网页界面里操作容器的人。

步骤：
1. 把项目文件放到 NAS 某个文件夹（例如 `docker/mmh/`，路径随 NAS 不同而不同）
   - 推荐：从 GitHub Releases 下载 `mmh-nas-<版本>.zip`，上传到 NAS 后解压到该文件夹
2. 在项目根目录创建 `.env`（与 `docker-compose.yml` 同级），内容如下，必须改密码：

```env
DATABASE_URL="postgresql://mmh-fs:请换成很长的随机密码@postgres:5432/mmh?schema=public"
POSTGRES_DB=mmh
POSTGRES_USER=mmh-fs
POSTGRES_PASSWORD=请换成很长的随机密码 # 必改（同时用于系统初始化验证）

STATEMENT_API_KEY= # 可选；需要开放对账单/流水外部接入时再配置
PRISMA_CLIENT_ENGINE_TYPE=binary
```

3. 在 NAS 的容器管理界面，创建“Stack/Compose/项目”，选择该目录下的 `docker-compose.yml`（或直接粘贴文件内容）
4. 点击“部署/启动”（NAS 会自动拉取 ghcr.io 上的镜像，无需本地编译）
5. 打开 `系统更新` 页面，确认可以直接点击“确认更新”

访问：
- `http://NAS_IP:7777/`

---

## 3) 更新

推荐在页面内更新：
1. 打开 `设置` → `系统更新`
2. 点击 `确认更新`
3. 等待系统自动拉取新镜像并重启应用容器
4. 刷新浏览器页面

命令行更新备用方式：

```bash
cd ~/mmh
git pull
sudo docker compose pull
sudo docker compose up -d
```

---

## 4) 完全删除项目

适合：确认不再保留 MMH 数据，或需要彻底清空后重新安装。

注意：下面命令会删除：
- MMH 容器（Web、数据库、Watchtower）
- MMH Compose 项目相关容器、网络和孤儿容器
- MMH 数据库数据卷（账本数据会一起删除）
- MMH 应用镜像和 Watchtower 镜像
- `~/mmh` 项目目录

如果 NAS 图形界面里还有旧的 Stack/Compose 项目记录，命令行删除容器后，仍需要在 NAS 容器管理页面里把对应项目/Stack 记录手动删除；有些 NAS 会保留“创建时间”元数据，不代表容器和数据卷还在。

把下面整段命令一次性复制粘贴执行：

```bash
sh -c 'set -e
APP_DIR="$HOME/mmh"
PROJECT_NAME="mmh"

if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR"
  sudo docker compose -p "$PROJECT_NAME" down -v --remove-orphans 2>/dev/null || true
  sudo docker compose down -v --remove-orphans 2>/dev/null || true
fi

sudo docker rm -f mmh-app mmh-db mmh-watchtower 2>/dev/null || true
for id in $(sudo docker ps -aq --filter "label=com.docker.compose.project=$PROJECT_NAME" 2>/dev/null); do
  sudo docker rm -f "$id" 2>/dev/null || true
done
sudo docker volume rm mmh_pgdata 2>/dev/null || true
for vol in $(sudo docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT_NAME" 2>/dev/null); do
  sudo docker volume rm "$vol" 2>/dev/null || true
done
for net in $(sudo docker network ls -q --filter "label=com.docker.compose.project=$PROJECT_NAME" 2>/dev/null); do
  sudo docker network rm "$net" 2>/dev/null || true
done
sudo docker image rm ghcr.io/frankluise5220/mmh:latest containrrr/watchtower:latest 2>/dev/null || true

rm -rf "$APP_DIR"

echo "MMH 容器、Compose 项目资源、数据卷、镜像和项目目录已清理。"
echo "如果 NAS 图形界面仍显示旧 Stack/Compose，请在 NAS 容器管理页面手动删除该项目记录。"
'
```
