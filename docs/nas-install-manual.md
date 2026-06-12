# WiseMe NAS 安装操作手册（Docker 版）

仓库地址：`https://github.com/frankluise5220/Wiseme`

目标：在 NAS 上启动 2 个容器（数据库 + Web），局域网浏览器访问 `http://NAS_IP:7777/`。

## 1) 命令行安装（推荐）

适合：你能在 NAS 上打开 SSH/终端，并且有 `docker compose` 与 `git`。

你只需要做 3 件事：
1. SSH 登录 NAS，打开终端
2. 把下面整段命令一次性复制粘贴执行（不要逐行敲）
3. 等命令结束后，用浏览器打开 `http://NAS_IP:7777/`（把 NAS_IP 换成你的 NAS 局域网 IP）

说明：
- `rm -rf "$APP_DIR"` 只会删除你家目录下的 `~/wiseme`，用于“重装/覆盖安装”
- `openclaw` 是默认的数据库名/数据库用户名（可不改）；要改就同时改 `POSTGRES_DB/POSTGRES_USER`，密码 `POSTGRES_PASSWORD` 会自动生成（也可手填）
- 如果执行过程中出现 `permission denied while trying to connect to the Docker daemon socket`：用 `sudo docker compose ...` 运行，或把当前用户加入 docker 组后重新登录
- 如果 `git clone` 报 `HTTP/2 stream ... was not closed cleanly`：先执行 `git config --global http.version HTTP/1.1`，再重试
- 如果构建时报 `401 Unauthorized` 且 URL 类似 `https://docker.fnnas.com/.../library/node/...`：说明 NAS 配了需要登录的镜像加速/代理；先在 NAS Docker 设置里关闭该加速或改成可用镜像源，或执行 `sudo docker login docker.fnnas.com` 登录后再重试
- 第一次构建可能会看到 `apt-get install ...` 持续很久（NAS 性能/网络影响），这是正常现象；只要日志还在继续下载/安装就耐心等待即可
- 如果构建时报 `npm error ECONNRESET` / `npm error network aborted`：这是拉 npm 依赖时网络中断，通常重试一次即可；也可以先执行 `sudo docker builder prune -af` 清掉失败缓存后再重试
- 如果构建时报 `Could not find Prisma Schema`：说明旧镜像构建步骤有问题，先 `git pull` 更新到最新仓库，再重新执行 `sudo docker compose up -d --build`
- 复制粘贴要包含从 `sh -c 'set -e` 开始到最后一行单独的 `'` 结束（包含最后这个 `'`），不要只粘贴中间几行

```sh
sh -c 'set -e
APP_DIR="$HOME/wiseme"

# 注意：这行会删除旧目录后重装；不想删除就把这一行删掉，并确保目录为空
rm -rf "$APP_DIR"
git clone "https://github.com/frankluise5220/Wiseme" "$APP_DIR"
cd "$APP_DIR"

POSTGRES_DB="wiseme" # 可改：数据库名
POSTGRES_USER="wiseme-fs" # 可改：数据库用户名
POSTGRES_PASSWORD="$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | xxd -p)" # 自动生成；也可以改成你自己指定的密码（建议足够复杂）
ADMIN_PASSWORD="$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | xxd -p)" # 自动生成；也可以改成你自己指定的密码（建议足够复杂）
STATEMENT_API_KEY="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p)"

cat > .env <<EOF
POSTGRES_DB="$POSTGRES_DB"
POSTGRES_USER="$POSTGRES_USER"
POSTGRES_PASSWORD="$POSTGRES_PASSWORD"
ADMIN_PASSWORD="$ADMIN_PASSWORD"
STATEMENT_API_KEY="$STATEMENT_API_KEY"
PRISMA_CLIENT_ENGINE_TYPE="binary"
EOF

sudo docker compose up -d --build # 如果提示输入密码，输入 NAS 的 sudo 密码即可

echo "访问地址: http://<NAS_IP>:7777/" # 把 <NAS_IP> 换成你的 NAS 局域网 IP
echo "ADMIN_PASSWORD=$ADMIN_PASSWORD"
echo "STATEMENT_API_KEY=$STATEMENT_API_KEY"
echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD"
'
```

访问：
- `http://NAS_IP:7777/`

---

## 2) NAS 图形界面安装（Stack/Compose）

适合：只会在 NAS 网页界面里操作容器的人。

步骤：
1. 把项目文件放到 NAS 某个文件夹（例如 `docker/wiseme/`，路径随 NAS 不同而不同）
   - 推荐：从 GitHub Releases 下载 `wiseme-nas-<版本>.zip`，上传到 NAS 后解压到该文件夹
2. 在项目根目录创建 `.env`（与 `docker-compose.yml` 同级），内容如下，必须改密码：

```env
POSTGRES_DB=openclaw # 可改：数据库名
POSTGRES_USER=openclaw # 可改：数据库用户名
POSTGRES_PASSWORD=请换成很长的随机密码 # 必改

ADMIN_PASSWORD=请换成强密码 # 必改
STATEMENT_API_KEY=请换成很长的随机token # 建议改
PRISMA_CLIENT_ENGINE_TYPE=binary
```

3. 在 NAS 的容器管理界面，创建“Stack/Compose/项目”，选择该目录下的 `docker-compose.yml`（或直接粘贴文件内容）
4. 点击“部署/启动”

访问：
- `http://NAS_IP:7777/`
