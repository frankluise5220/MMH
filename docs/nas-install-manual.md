# MMH NAS Docker 安装与更新

这份文档给最终用户使用。推荐先用 NAS 自带的 Docker 图形界面安装；终端命令只作为备用方案。

安装只需要三件事：

1. 准备部署文件。
2. 修改 `.env` 里的数据库密码。
3. 在 Docker 图形界面创建项目并启动。

## 1. 推荐：图形界面安装

### 1.1 准备

NAS 上需要先安装 Docker、Container Manager、容器管理器或类似功能。

在 NAS 文件管理里新建一个目录，用来放 MMH 的部署文件。例如：

```text
docker/mmh
```

目录位置可以按 NAS 习惯选择，只要三个部署文件放在同一个目录里即可。

### 1.2 下载部署文件

下载下面三个文件，放进刚才创建的目录：

- `docker-compose.yml`：https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/docker-compose.yml
- `postgres-entrypoint.sh`：https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/postgres-entrypoint.sh
- `env.example`：https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/env.example

### 1.3 修改环境配置

把 `env.example` 改名为 `.env`。

打开 `.env`，只需要修改这一行：

```env
POSTGRES_PASSWORD="CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD"
```

图形界面安装使用的是静态 `.env` 文件，Docker 不会自动生成这个密码。

不修改也可以启动，系统会把 `CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD` 当成真实数据库密码使用。正式使用建议改成自己的密码，例如：

```env
POSTGRES_PASSWORD="mMh2026u7r9x4q2p8v6k3s5d1"
```

密码建议使用 24 位以上的字母和数字。改好后请保存；以后排查数据库问题时可能会用到。

其他内容先不用改。`DATABASE_URL` 和内部更新令牌会由部署文件自动处理。

### 1.4 创建 Docker 项目

打开 NAS 的 Docker 图形界面，找到 Compose、项目、应用栈或 Stack 功能。

创建新项目时：

- 项目名称填写 `mmh`。
- 项目目录选择刚才放部署文件的目录。
- Compose 文件选择 `docker-compose.yml`。
- 点击部署、创建或启动。

首次启动需要拉取镜像，等待时间取决于 NAS 网络和镜像源速度。

### 1.5 打开 MMH

部署完成后，在浏览器打开：

```text
http://NAS_IP:7777/
```

把 `NAS_IP` 换成 NAS 的实际 IP。

Android 客户端可以下载安装：

```text
https://github.com/frankluise5220/MMH/releases/download/android-v1.0.0/mmh-android-v1.0.0.apk
```

安装后，服务器地址填写：

```text
http://NAS_IP:7777/
```

## 2. 日常更新

优先在 MMH 网页里更新：

```text
系统设置 -> 系统更新 -> 刷新远端版本 -> 更新
```

网页更新会自动拉取新的应用镜像并重启服务。正常更新不需要重新安装，也不需要在 NAS 上重新构建源码。

如果使用 NAS 的 Docker 图形界面更新，也只需要更新 MMH 的应用镜像，然后重启 `mmh-app` 和 `mmh-updater`。数据库容器 `mmh-db` 不需要删除，也不要选择“源码重新构建”。

## 3. 镜像源说明

MMH 默认使用预构建镜像，不在 NAS 上编译项目。

`.env` 里默认镜像源是：

```env
MMH_IMAGE_SOURCE="dockerproxy"
MMH_APP_IMAGE="ghcr.dockerproxy.net/frankluise5220/mmh:latest"
MMH_UPDATER_IMAGE="ghcr.dockerproxy.net/frankluise5220/mmh-updater:latest"
```

如果这个源下载慢，可以在 MMH 网页里切换：

```text
系统设置 -> 系统更新 -> 镜像源
```

选择“自动选择”时，网页里的“刷新远端版本”和实际更新都会按镜像源顺序检测可用版本；不会只检查单一源。如果全部源都无法读取镜像版本，页面会显示失败原因。

固定选择 GHCR、dockerproxy、NJU、DaoCloud 或自定义源时，版本检查、`mmh-app` 和 `mmh-updater` 都统一使用用户选择的源。切换源后执行一次更新，两个容器会一起拉取并切换；不会把 NJU 或其他单一镜像源写死为所有用户的默认选择。

常用可选源：

- `ghcr`：`ghcr.io/frankluise5220/mmh:latest`
- `dockerproxy`：`ghcr.dockerproxy.net/frankluise5220/mmh:latest`
- `nju`：`ghcr.nju.edu.cn/frankluise5220/mmh:latest`
- `daocloud`：`ghcr.m.daocloud.io/frankluise5220/mmh:latest`

PostgreSQL 使用官方镜像：

```text
postgres:15-alpine
```

如果 Docker Hub 下载失败，可以先在 NAS 的镜像管理里搜索并下载 `postgres:15-alpine`。也可以用备用源下载后打标签：

```bash
sudo docker pull swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/postgres:15-alpine
sudo docker tag swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/postgres:15-alpine postgres:15-alpine
```

## 4. 终端安装（备用）

只有在 NAS 图形界面不支持 Compose、无法上传 `.env`、或需要远程协助时，才使用终端安装。

```bash
mkdir -p ~/mmh
cd ~/mmh

curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/docker-compose.yml
curl -fsSL -o postgres-entrypoint.sh https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/postgres-entrypoint.sh
curl -fsSL -o .env https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/env.example

chmod +x postgres-entrypoint.sh

POSTGRES_PASSWORD="$(openssl rand -hex 24 2>/dev/null || date +%s%N | sha256sum | cut -c1-48)"
sed -i "s/CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD/$POSTGRES_PASSWORD/g" .env

sudo docker compose -p mmh up -d

echo "MMH 安装完成"
echo "访问地址: http://NAS_IP:7777/"
echo "数据库密码: $POSTGRES_PASSWORD"
echo "配置文件: ~/mmh/.env"
```

安装完成后，请把输出的数据库密码保存下来。`.env` 里也会保留同一个密码。

终端安装会自动生成数据库密码；图形界面安装不修改默认值也能运行，但正式使用建议手动修改 `.env` 里的 `POSTGRES_PASSWORD`。

## 5. 终端更新（备用）

只有在网页打不开或更新异常中断时，才使用终端更新：

```bash
cd ~/mmh
sudo docker compose -p mmh pull app updater
sudo docker compose -p mmh up -d app updater
```

这个过程只更新应用和更新器，不会删除数据库。

## 6. 清空重装

清空重装会删除 MMH 数据库数据。确认不需要旧数据后再执行：

```bash
cd ~/mmh
sudo docker compose -p mmh down -v
```

如果还需要删除安装目录：

```bash
cd ~
rm -rf ~/mmh
```

然后重新按“图形界面安装”操作。

## 7. 常见问题

### 7.1 打不开 `http://NAS_IP:7777/`

先在 Docker 图形界面确认：

- `mmh-app` 是运行中。
- `mmh-db` 是运行中。
- `mmh-updater` 是运行中。
- `7777` 端口没有被其他服务占用。

如果容器在反复重启，查看 `mmh-app` 和 `mmh-db` 的日志。

### 7.2 数据库密码错误

如果是全新安装，最简单的处理方式是清空重装。

如果已有重要数据，不要删除数据库卷。先备份，再排查 `.env` 里的 `POSTGRES_PASSWORD` 是否和数据库初始化时一致。

### 7.3 Docker Hub 下载失败

优先在 NAS 的 Docker 图形界面里配置镜像加速源，或手动提前准备 `postgres:15-alpine`。

MMH 应用镜像可以在网页的系统更新页切换镜像源。

### 7.4 更新是不是每次下载全部镜像

正常情况下不是。Docker 会复用已有镜像层，更新时只下载变化的层。

第一次安装或第一次切换镜像源时，可能需要下载较大的基础层，这是正常现象。
