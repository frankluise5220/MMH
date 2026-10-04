# MMH NAS / 飞牛 fnOS / 群晖 DSM 安装与更新

| 运行方式 | 适合谁 | 入口 |
| --- | --- | --- |
| 飞牛 fnOS 原生 | 飞牛 NAS 用户，想直接用原生应用包 | [查看飞牛 fnOS 原生](#飞牛-fnos-原生) |
| 群晖 DSM 原生 | 群晖 NAS 用户，想直接用套件中心安装包 | [查看群晖 DSM 原生](#群晖-dsm-原生) |
| Docker 图形界面 | 普通 NAS 用户，习惯用容器管理器界面 | [查看 Docker 图形界面](#docker-图形界面) |
| Docker 命令行 | 需要 SSH / 终端部署或远程协助 | [查看 Docker 命令行](#docker-命令行) |

## 飞牛 fnOS 原生

飞牛版是原生 `.fpk` 应用包，不依赖 Docker 和 PostgreSQL。安装后使用 SQLite 数据库，数据保存在飞牛应用数据目录里。

| 操作 | 你要做什么 |
| --- | --- |
| [1. 安装](#1-安装) | 第一次在飞牛上安装 MMH。 |
| [2. 更新](#2-更新) | 已经安装 MMH 后升级到新版本。 |
| [3. 使用](#3-使用) | 安装完成后打开 MMH，并了解数据保存位置。 |

### 1. 安装

推荐使用 FN 软仓安装：

1. 如果飞牛里还没有 FN 软仓客户端，先按 FN 软仓项目说明安装客户端：

```text
https://gitee.com/hhxs2025/fn-appstores/releases
```

2. 打开 FN 软仓客户端，搜索 `MMH` 。
3. 点击安装。
4. `0.1.47` 起安装过程没有向导，直接安装完成；服务端口默认 `7777`，如被占用会在安装前拦截提示。旧版本包在安装时会弹一次端口确认页。

也可以手动安装 `.fpk`：

1. 打开 GitHub Release 页面：

```text
https://github.com/frankluise5220/MMH/releases
```

2. 下载适合当前飞牛设备架构的安装包：
   - x86_64 设备：`mmh-fnos-v0.1.x-x86_64.fpk`
   - ARM64 设备：`mmh-fnos-v0.1.x-arm64.fpk`
3. 在飞牛应用中心或支持手动安装 `.fpk` 的入口上传安装包。

### 2. 更新

推荐在 FN 软仓客户端里更新：

1. 打开 FN 软仓客户端，查看 MMH。
2. 看到新版本后点击更新；如果入口显示覆盖安装，也应当走更新/覆盖升级流程。
3. 更新过程应静默执行，并沿用已安装 MMH 的在用端口；更新完成后重新打开 MMH。

**注意：在已经装好 MMH 的机器上，飞牛应用中心会拒绝「手动安装 `.fpk`」**，提示「无法安装 MMH，请卸载应用中心版本的 MMH 后再进行手动安装」。原因是 MMH 不在飞牛官方应用中心里，应用中心判定「没有可升级的版本」——**与你要装的版本号高低无关**，装更高版本也会被拒。

要用本地 `.fpk` 覆盖安装，只能先在飞牛应用中心卸载 MMH：卸载时选「保留用户数据（推荐）」，数据目录会原样保留（含账簿数据库与在用的端口记录），再手动安装即可继续使用原来的账簿与端口。命令行卸载不会删数据。

> 为什么旧版本会弹“服务端口”：FN 软仓客户端只读取包内的 `wizard/install`，只要该文件存在，更新时就会把它当安装向导渲染并要求输入端口。`0.1.47` 起包内不再包含 `wizard/install`、`wizard/upgrade`，更新才是真正静默的。
>
> 想改端口怎么办：装好后打开飞牛应用中心里的 MMH 设置页修改“服务端口”再保存即可。这个设置页来自 `wizard/config`，软仓客户端不会解析它，所以不会让更新重新弹向导；保存后 MMH 会自动停服、写入新端口并重启。首次安装不提供端口输入，端口从 `7777` 开始自动探测，被占用则顺延到下一个空闲端口。
>
> 卸载时选什么：从飞牛系统应用中心手动卸载 MMH 时，会弹出「是否删除用户数据」选择。默认「保留用户数据（推荐）」——只卸载软件，账簿数据留在原处，重新安装后可继续使用；只有明确选择「删除用户数据」才会直接清空数据目录，不会再先写一份目录外备份。软仓客户端的更新走静默卸载重装，不会弹这个向导，更新始终保留数据。

覆盖升级会保留飞牛应用数据目录里的 `mmh.db` 数据库。高风险操作前，仍建议先在 MMH 里导出备份。

### 3. 使用

安装完成后，在浏览器打开：

```text
http://飞牛IP:7777/
```
首次启动会在飞牛应用数据目录创建并初始化 SQLite 数据库 `mmh.db`。

通过飞牛统一网关的 `/app/mmh` 入口访问时，飞牛先完成飞牛账号认证，再由网关向 MMH 转发 `X-Trim-Userid`、`X-Trim-Username`、`X-Trim-Isadmin` 身份头。MMH 不再要求填写第二套用户名和密码；绑定标识是**飞牛用户名**（`X-Trim-Username`，例如 `jsbyfubin`），不是额外的登录密码，也不是 FN Connect 的 FN ID。绑定入口为“系统设置 → 用户”。直接访问 `http://飞牛IP:端口/` 不经过统一网关，因此仍使用 MMH 本地账号登录。MMH 退出只清理 MMH 会话，不会退出飞牛账号；从飞牛应用入口重新打开时，网关仍负责提供免密身份。

系统初始化、删除账簿等敏感操作验证当前登录用户自己的密码，操作仅管理员可见。

飞牛原生包默认给 MMH 的 Node 服务设置 `MMH_NODE_MAX_OLD_SPACE_MB=auto`，启动时会按宿主机内存自动分档：低内存机器保守运行，内存更大的机器给 Node 留出更多 old-space；如果正常导入或识别任务频繁触顶，可在应用数据目录的 `mmh.env` 中写成明确数字后重启应用。`/api/health` 会返回宿主内存、运行限制和内存压力，方便判断是数据库不可用、应用未启动，还是内存接近阈值。

## 群晖 DSM 原生

群晖版是原生 `.spk` 套件包，不依赖 Docker 和 PostgreSQL，套件元数据尽量保持 DSM 7.0 及更新版本可安装，当前优先面向 DSM 7.2 及更新版本做实际测试。安装后使用 SQLite 数据库，数据保存在群晖套件数据目录里。

| 操作 | 你要做什么 |
| --- | --- |
| [1. 安装](#1-安装-1) | 第一次在群晖 DSM 上安装 MMH。 |
| [2. 更新](#2-更新-1) | 已经安装 MMH 后升级到新版本。 |
| [3. 使用](#3-使用-1) | 安装完成后打开 MMH，并了解数据保存位置。 |

### 1. 安装

1. 打开 GitHub Release 页面：

```text
https://github.com/frankluise5220/MMH/releases
```

2. 下载适合当前群晖设备架构的安装包：
   - x86_64 设备：`mmh-synology-v0.1.x-x86_64.spk`
   - ARM64 设备：`mmh-synology-v0.1.x-arm64.spk`
3. 打开 DSM 套件中心。
4. 选择手动安装，上传刚下载的 `.spk` 文件。
5. DSM 显示安装向导时，可在“服务端口”文本框输入端口号，默认值为 `7777`，范围为 `1`–`65535`。这不是端口列表或可点击选择器。**向导弹出之前**安装包就会探测该端口：如果端口正被**本套件自己**的旧版本占用（升级时的常态），字段描述会写成「端口 7779 由 MMH 自身占用，升级后会继续沿用。」，默认值保持原端口不变；只有被**别的程序**占用时才会写出占用者（短形式，例如「端口 7777 被占用（Docker 映射），已预填 7780。」）并把默认值预填成后面第一个空闲端口。提交向导后、套件解包之前，安装脚本会再核一次：若仍被其他程序占用，会给出提示（安装**不会**因此中断），安装完成后自动改用后面第一个空闲端口，并把最终端口写进套件数据目录。

> 什么叫“其他程序”：只有当前这个套件自己的 MMH 进程（升级时旧进程还没退出的情况）才算“自己”，判定依据是进程所属的 DSM cgroup（`pkgctl-mmh`），不看命令行也不看可执行文件路径。**Docker 版 MMH、另一个群晖套件（哪怕名字也叫 mmh）、任意其他服务都算“其他程序”**，都会被识别出来并触发自动顺延。完整的占用者信息（PID、进程名、类型：Docker 端口映射 / 容器进程 / 普通进程）会写进 `/var/log/packages/mmh.log`；向导里只显示一个短标签（如 `pid=1234`），因为 DSM 的向导描述区在标题下方整行渲染、对话框高度固定，写长了会被裁掉半截。

```text
7777
```

首次安装向导填写的端口会保存到套件数据目录；若 DSM 安装入口未显示向导，则默认使用 `7777`。更新或重装会清理旧的运行痕迹，只保留数据库文件 `data/mmh.db`、`data/mmh.db-wal` 和 `data/mmh.db-shm`。端口优先级是：**① 在升级向导里把预填端口改成了别的值 → 用向导值；② 否则沿用 `mmh.env` 里已保存的 `PORT`；③ 全新安装用向导填写值；④ 兜底包内默认 `7777`**——也就是说**升级/重装不动那个字段就是沿用原端口，真的改了就会生效**。判定「用户有没有改过」靠向导脚本写下的记录文件 `<套件数据目录>/mmh-wizard-port`：动态向导把它自己预填的端口写进去，`preinst`/`postinst` 只在「记录存在且提交值与之不同」时才采用向导值，读完即删；记录不存在（向导脚本没执行、退回静态默认 `7777`）时一律沿用已保存端口，避免静态默认把在用端口静默挪走（见 `docs/product-todos.md` 的「精确版 A」）。若该端口被其他程序占用（同样包括 Docker 版 MMH 和别的套件），升级向导会先显示占用者并预填空闲端口，`postinst` 最后**自动顺延**到后面第一个空闲端口并把新端口写回 `mmh.env`，安装不会因此失败；确认监听者是本套件自己的旧 MMH 进程时则继续使用原端口，不会顺延。装好后 DSM 套件中心会显示 MMH 图标和「打开」按钮，指向的端口以 `mmh.env` 为准。**DSM 官方没有给第三方套件提供「设置」向导**（`config_uifile` 这个名字在官方文档里不存在，实测也不会出现入口），所以要改端口只有两条路：① 停用套件 → 编辑 `/var/packages/mmh/var/mmh.env` 的 `PORT=端口号` → 启用套件（启动脚本会自动把新端口同步到 DSM 的「打开」入口，不需要手工改 `ui/config`）；② 卸载后重新安装，在安装向导里指定端口。

卸载时，DSM 会提供“删除数据库和设置”的复选项，默认不勾选并保留数据。只有主动勾选后才会清空 MMH 套件数据目录中的数据库和设置；DSM 的数据目录本身会保留为空目录，以避免卸载钩子因套件用户无权删除父级目录而失败。需要保留账簿以便重装时，不要勾选。

**注意：只有从 DSM 套件中心界面卸载才会弹出这个向导。** 命令行 `synopkg uninstall mmh`（脚本化卸载，以及部分第三方客户端的“卸载重装”流程）不会渲染向导，`preuninst` 收不到 `wizard_delete_data`，于是**一律保留数据**——此时重装会把原来的账簿原样带回来，看起来就像“新装完却不空”。

想确认某次卸载到底做了什么，看 `/var/log/packages/mmh.log` 里 `preuninst` 打印的那一行：

- `... retained (wizard_delete_data=<unset>).` —— 没弹向导（命令行卸载），数据被保留
- `... retained (wizard_delete_data=false).` —— 弹了向导，用户选了保留
- `... deleted (wizard_delete_data=true).` —— 弹了向导，用户选了删除

0.1.70 及更早的版本只打印 `retained.` / `deleted.`，看不出是哪一种；本次改动起会带上实际收到的值。

因此「卸载重装」不是清空数据的可靠手段。要确保彻底清空，请走套件中心卸载并勾选删除，或卸载后手动清空 `/volume1/@appdata/mmh`（务必先备份）。

请下载同一个 Release 里的正式 `.spk` 文件，不要下载 `*-spk-source.tgz`，那只是调试包结构用的归档。

### 2. 更新

下载更高版本、同架构的 `.spk`，然后在 DSM 套件中心里对已安装的 MMH 直接覆盖安装。

不要把“卸载旧版再安装新版”当作日常更新方式。覆盖升级会保留群晖套件数据目录里的 `mmh.db` 数据库。高风险操作前，仍建议先在 MMH 里导出备份。

### 3. 使用

安装完成后，在浏览器打开：

```text
http://群晖IP:7777/
```

把 `群晖IP` 换成群晖设备的实际 IP；如果安装时端口冲突，安装向导会先显示占用者并预填下一个空闲端口，最终端口以套件中心 MMH 卡片的「打开」按钮指向的地址为准（也可查看 `/var/packages/mmh/var/mmh.env`）。已安装后想改端口，按上一节的两条路径操作（重新安装时改，或停用套件后改 `mmh.env`）——DSM 没有第三方套件的设置向导。

群晖版没有 PostgreSQL 连接密码。首次启动会在群晖套件数据目录创建并初始化 SQLite 数据库 `mmh.db`。系统初始化、删除账簿等敏感操作验证当前登录用户自己的密码，操作仅管理员可见。

群晖原生包默认给 MMH 的 Node 服务设置 `MMH_NODE_MAX_OLD_SPACE_MB=auto`，启动时会按宿主机内存自动分档：低内存机器保守运行，内存更大的机器给 Node 留出更多 old-space；如果正常导入或识别任务频繁触顶，可在套件数据目录的 `mmh.env` 中写成明确数字后重启套件。`/api/health` 会返回宿主内存、运行限制和内存压力，方便判断是数据库不可用、应用未启动，还是内存接近阈值。

## Docker 图形界面

普通 NAS 用户优先使用 Docker、Container Manager、容器管理器、Compose、项目、应用栈或 Stack 的图形界面安装。

| 操作 | 你要做什么 |
| --- | --- |
| [1. 安装](#1-安装-2) | 用 NAS 的 Docker 图形界面创建 MMH 项目。 |
| [2. 更新](#2-更新-2) | 通过 MMH 网页或 Docker 图形界面更新容器。 |
| [3. 使用](#3-使用-2) | 安装完成后打开 MMH，并连接 Android 客户端。 |

### 1. 安装

普通用户只需要完成下面 5 步：

1. 在 NAS 上安装 Docker、Container Manager、容器管理器或类似功能。
2. 在 NAS 文件管理里新建一个目录，用来放 MMH 的部署文件，例如：

```text
docker/mmh
```

3. 下载下面三个文件，放进刚才创建的目录：
   - `docker-compose.yml`：https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/docker-compose.yml
   - `postgres-entrypoint.sh`：https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/postgres-entrypoint.sh
   - `env.example`：https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/env.example
4. 把 `env.example` 改名为 `.env`，打开 `.env`，只修改数据库密码：

```env
POSTGRES_PASSWORD="REPLACE_WITH_YOUR_OWN_LONG_RANDOM_PASSWORD"
```

密码建议使用 24 位以上的字母和数字。图形界面安装使用静态 `.env` 文件，Docker 不会自动生成这个密码。

5. 在 NAS 的 Docker 图形界面里运行项目：
   - 如果项目提示已经存在 `docker-compose.yml`，选择使用已有文件继续。
   - 选择刚才的部署目录和 `docker-compose.yml`，项目名称填写 `mmh`，然后点击运行、部署或启动。
   - 等待日志中出现 `starting app...` 后即可退出日志窗口；首次启动需要拉取镜像，等待时间取决于 NAS 网络和镜像下载速度。
   - 回到桌面，点击 `MMH` 图标打开系统。

如果界面提示“已经有 Docker Compose 文件”，这是正常提示，不需要重新创建 Compose 文件。应用启动完成后，浏览器地址通常是 `http://NAS_IP:7777/`，其中 `NAS_IP` 换成 NAS 的实际 IP。

### 安装完成后的注意事项

以下内容只在遇到对应问题时处理，普通安装不需要操作。

**7777 端口已被占用**

如果 NAS 宿主机的 `7777` 已被其他服务占用，修改 `.env` 中的宿主机端口；容器内部端口始终保持 `7777`：

```env
MMH_HOST_PORT="7780"
```

对应的端口映射是 `7780:7777`，浏览器访问 `http://NAS_IP:7780/`。Docker 图形界面中如果分别填写“主机端口”和“容器端口”，应填写 `7780` 和 `7777`，不要把容器端口改成 `7780`。修改端口后必须重新部署整个 Compose 项目，不能只重启旧容器：

```bash
docker compose -p mmh up -d --force-recreate
```

**文件权限错误**

如果容器日志出现 `init.sh: Permission denied`，在 NAS 终端执行：

```bash
cd /你的实际部署目录
chmod 755 postgres-entrypoint.sh
chmod 644 docker-compose.yml .env
```

**网络或镜像拉取失败**

如果 NAS 不能稳定访问默认的 Docker Proxy 或 Docker Hub，需要同时为 MMH 应用、更新器和 PostgreSQL 选择可用镜像源。比如：

```env
MMH_IMAGE_SOURCE="nju"
MMH_APP_IMAGE="ghcr.nju.edu.cn/frankluise5220/mmh:latest"
MMH_UPDATER_IMAGE="ghcr.nju.edu.cn/frankluise5220/mmh-updater:latest"
POSTGRES_IMAGE="docker.m.daocloud.io/library/postgres:15-alpine"
```

不要只替换应用镜像和更新器镜像，否则 PostgreSQL 仍会从 Docker Hub 拉取。应用镜像还必须包含 Prisma schema engine；如果日志停在 `ensured ... unique index`、数据库只有 `_mmh_schema_meta`，并且诊断显示正在访问 `binaries.prisma.sh`，请先拉取包含离线 schema engine 修复的新版镜像：

```bash
cd /你的实际部署目录
docker compose -p mmh pull app updater
docker compose -p mmh up -d app updater
```

**网页更新不可用**

如果 `docker-compose.yml` 里 `MMH_UPDATE_TOKEN` 是 `${MMH_UPDATE_TOKEN:-...}` 形式，在 `.env` 中设置网页更新令牌；如果是 `${POSTGRES_PASSWORD:-...}` 形式，则不需要设置：

```env
MMH_UPDATE_TOKEN="REPLACE_WITH_YOUR_OWN_LONG_RANDOM_TOKEN"
```

默认 `.env` 已包含 NAS 资源保护参数：

```env
MMH_APP_MEMORY_LIMIT="1536m"
MMH_NODE_MAX_OLD_SPACE_MB="auto"
PG_POOL_MAX="4"
```

这些参数通常不需要修改。2GB 内存设备如需更保守可下调 `MMH_APP_MEMORY_LIMIT`；4GB 及以上设备如有大文件导入或 AI 识别任务，可以按需调大。

### 2. 更新

优先在 MMH 网页里更新：

```text
系统设置 -> 系统更新 -> 刷新远端版本 -> 更新
```

网页更新会自动拉取新的应用镜像并重启服务。更新成功后，更新器只会删除自己记录过的旧 MMH 应用/更新器镜像，不会清理宿主机上其它项目的镜像。正常更新不需要重新安装，也不需要在 NAS 上重新构建源码。更新器会保留部署目录中已有的 `docker-compose.yml`，不会覆盖用户设置的 `MMH_HOST_PORT`、端口映射、PostgreSQL 镜像源或其他本地配置；只有首次部署目录没有 Compose 文件时才会写入内置模板。

如果使用 NAS 的 Docker 图形界面更新，只需要更新 MMH 的应用镜像，然后重新部署整个 Compose 项目。数据库容器 `mmh-db` 不需要删除，也不要选择“源码重新构建”。如果改过 `MMH_HOST_PORT` 或发生端口冲突，必须重新部署项目，不能只点旧容器的“重启”。

> Docker 安装不需要、也不要用 `git pull` 更新：宿主机部署目录里只有 `docker-compose.yml`、`.env` 等部署文件，不是源码仓库，执行 `git pull` 会直接报错。普通镜像更新可以拉取镜像后重新部署项目；如果修改了 `MMH_HOST_PORT` 或发生端口冲突，必须使用 `--force-recreate` 重新部署整个 Compose 项目。

### 3. 使用

部署完成后，在浏览器打开：

```text
http://NAS_IP:7777/
```

把 `NAS_IP` 换成 NAS 的实际 IP。

Android 客户端可以到同一个 GitHub Release 页面下载安装：

```text
https://github.com/frankluise5220/MMH/releases
```

文件名通常是 `mmh-android-v0.1.x.apk`，其中 `0.1.x` 与服务端版本一致。安装后，服务器地址填写 `http://NAS_IP:7777/`。

## Docker 命令行

只有在 NAS 图形界面不支持 Compose、无法上传 `.env`、或需要远程协助时，才使用命令行。

| 操作 | 你要做什么 |
| --- | --- |
| [1. 安装](#1-安装-3) | 用终端命令下载部署文件、生成密码并启动服务。 |
| [2. 更新](#2-更新-3) | 可用 MMH 网页、Docker 图形界面或终端命令更新。 |
| [3. 使用](#3-使用-3) | 安装完成后打开 MMH，并记住实际安装目录。 |

### 1. 安装
ssh user_name@NAS_IP

```bash
mkdir -p ~/mmh
cd ~/mmh

curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/docker-compose.yml
curl -fsSL -o postgres-entrypoint.sh https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/postgres-entrypoint.sh
curl -fsSL -o .env https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/env.example

chmod +x postgres-entrypoint.sh

POSTGRES_PASSWORD="$(openssl rand -hex 24 2>/dev/null || date +%s%N | sha256sum | cut -c1-48)"
sed -i "s/CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD/$POSTGRES_PASSWORD/g" .env

# 网页更新令牌：新部署文件用独立的 MMH_UPDATE_TOKEN；旧部署文件由
# POSTGRES_PASSWORD 自动派生，无需此行（保留也无害，升级到新部署文件后即生效）。
MMH_UPDATE_TOKEN="$(openssl rand -hex 24 2>/dev/null || date +%s%N | sha256sum | cut -c1-48)"
if grep -qE '^MMH_UPDATE_TOKEN=..*' .env; then
  sed -i "s|^MMH_UPDATE_TOKEN=.*|MMH_UPDATE_TOKEN=\"$MMH_UPDATE_TOKEN\"|" .env
else
  echo "MMH_UPDATE_TOKEN=\"$MMH_UPDATE_TOKEN\"" >> .env
fi
echo "网页更新令牌: $MMH_UPDATE_TOKEN"

# 默认资源保护：1.5GB app 容器、auto Node old-space、4 个 PostgreSQL 连接。
# auto 会按容器/宿主内存分档；高内存设备可在 .env 中按需调大。

sudo docker compose -p mmh up -d

echo "MMH 安装完成"
echo "访问地址: http://NAS_IP:${MMH_HOST_PORT:-7777}/"
echo "数据库密码: $POSTGRES_PASSWORD"
echo "配置文件: ~/mmh/.env"
```

安装完成后，请把输出的数据库密码保存下来。`.env` 里也会保留同一个密码。

### 2. 更新

命令行安装完成后，日常更新不一定要继续用命令行。你可以优先在 MMH 网页里更新：

```text
系统设置 -> 系统更新 -> 刷新远端版本 -> 更新
```

也可以在 NAS 的 Docker 图形界面里更新 MMH 的应用镜像，然后重新部署整个 Compose 项目。数据库容器 `mmh-db` 不需要删除。

只有在网页打不开、图形界面不方便操作或更新异常中断时，才进入安装目录执行终端更新：

```bash
cd ~/mmh
sudo docker compose -p mmh pull app updater
sudo docker compose -p mmh up -d app updater
```

如果修改过 `MMH_HOST_PORT`，或遇到端口冲突，必须重新部署整个项目：

```bash
sudo docker compose -p mmh up -d --force-recreate
```

这个过程不会删除数据库卷。

### 3. 使用

安装完成后，在浏览器打开：

```text
http://NAS_IP:7777/
```

把 `NAS_IP` 换成 NAS 的实际 IP。如果你的安装目录不是 `~/mmh`，后续更新和排查时请进入实际安装目录再执行命令。

Android 客户端可以到 GitHub Release 页面下载安装：

```text
https://github.com/frankluise5220/MMH/releases
```

安装后，服务器地址填写 `http://NAS_IP:7777/`。

## 通用操作

### 清空重装

清空重装会删除 MMH 数据库数据。确认不需要旧数据后再执行。

**注意：Docker 版「重装」不会清数据。** 更新镜像、`docker compose up -d --force-recreate`、删掉安装目录再重新 `git clone` 部署，都不会动数据库——数据在命名卷 `mmh_pgdata` 里，只要不删卷就一直在，重装后打开会看到原来的账簿（这不是“没装干净”，是数据本来就被保留）。Docker 版**没有**套件版那种「卸载时是否删除数据」的向导，`down -v` 是唯一的清空手段。

Docker 用户：

```bash
cd ~/mmh
sudo docker compose -p mmh down -v
```

如果还需要删除安装目录：

```bash
cd ~
rm -rf ~/mmh
```

飞牛用户请优先在飞牛应用中心卸载应用，并按飞牛系统界面确认是否保留应用数据。

群晖用户请优先在 DSM 套件中心卸载套件，并按套件中心提示确认是否保留套件数据。注意命令行 `synopkg uninstall mmh` 不会弹出该向导，数据会一律保留（详见上文“卸载”一节）。

### 常见问题

飞牛软仓安装后找不到应用或打不开：

先在飞牛应用中心确认 MMH 是否已经安装并正在运行。如果 FN 软仓客户端很快提示安装成功，但应用中心里没有 MMH，或 MMH 没有真正启动，可能是飞牛没有设置默认安装卷。可以在飞牛终端里设置默认卷后重试：

```bash
sudo appcenter-cli default-volume 1
```

如果你的应用安装卷不是 `1`，请换成当前飞牛设备实际使用的卷索引。排查时也可以查看飞牛应用中心日志和 FN 软仓客户端日志。

Docker 页面打不开：

先在 Docker 图形界面确认：

- `mmh-app` 是运行中。
- `mmh-db` 是运行中。
- `mmh-updater` 是运行中。
- `7777` 端口没有被其他服务占用。

如果容器在反复重启，查看 `mmh-app` 和 `mmh-db` 的日志。

手机登录提示“Cross-origin browser API requests are not allowed”：

先确认手机访问的是电脑正在使用的同一个 NAS 地址，例如 `http://192.168.3.26:7777/`。直接使用同一局域网 IP 访问时，不需要额外配置。如果手机通过反向代理、网关、域名或其他中转地址访问，需要在电脑上登录 MMH，进入 系统设置 -> 数据库 -> 访问白名单，添加手机实际访问的域名或 IP 后重试。这个错误表示请求来源与 MMH 收到的访问地址不一致，不是账号或密码错误。

群晖提示“套件文件格式不正确，请联系套件开发人员”：

先确认上传的是正式 `.spk` 文件，例如 `mmh-synology-v0.1.x-x86_64.spk` 或 `mmh-synology-v0.1.x-arm64.spk`，不要上传 `*-spk-source.tgz`。如果正式 `.spk` 仍提示格式不正确，说明该 Release 的群晖包需要重新发布修复版；修复包应包含 `checksum`、`extractsize`、正确的 `conf/privilege`，并确保 `scripts/` 下的生命周期脚本在 tar header 中是可执行文件。请改用下一个补丁版本的同架构 `.spk`。

群晖提示“MMH 以 root 权限运行，因此无法安装”：

这是套件权限配置没有被 DSM 正确识别。请改用修复后的同架构 `.spk`；修复包的 `conf/privilege` 会使用 Synology 认可的 `"run-as": "package"`，让 MMH 以套件用户运行，而不是 root。

群晖提示“System failed to start [MMH]”：

这通常需要查看套件自己的启动日志，而不是只看 DSM 通知中心。修复包会把 SQLite 数据库、日志、pid 和运行环境文件写到 DSM 的 `SYNOPKG_PKGVAR` 持久数据目录，而不是只读/受限的套件程序目录。启动脚本会先执行 bundled Node 自检；若 Node/glibc、SQLite 初始化、端口占用或权限失败，错误会写入日志。若仍失败，请在 DSM SSH 里查看 `/var/packages/mmh/var/mmh.log` 和 `/var/log/synopkg.log`。

数据库密码错误：

如果是全新安装，最简单的处理方式是清空重装。如果已有重要数据，不要删除数据库卷。先备份，再排查 `.env` 里的 `POSTGRES_PASSWORD` 是否和数据库初始化时一致。

更新页面提示“未配置宿主机更新执行器”或“获取远端版本失败：spawnSync /bin/sh ETIMEDOUT”：

网页检查/更新依赖应用与更新器（`mmh-updater`）之间的共享令牌。旧部署文件由 `POSTGRES_PASSWORD` 自动派生令牌；新部署文件（`MMH_UPDATE_TOKEN` 行为 `${MMH_UPDATE_TOKEN:-...}` 形式）需要在部署目录的 `.env` 里显式设置。注意：复制 `env.example` 生成的 `.env` 里会有一行空占位 `MMH_UPDATE_TOKEN=""`，命令的守卫按"非空"判断（`grep -E '^MMH_UPDATE_TOKEN=..*'`），空占位会被正确替换：

```bash
cd ~/mmh
grep -qE '^MMH_UPDATE_TOKEN=..*' .env || echo 'MMH_UPDATE_TOKEN="'$(openssl rand -hex 24)'"' >> .env
sudo docker compose -p mmh up -d app updater
```

该命令幂等：令牌已配置（非空）时跳过写入，重复执行无副作用。若 `.env` 里是空占位行 `MMH_UPDATE_TOKEN=""`，追加的新行会在 Compose 读取时覆盖空值（同名键后者生效），无需手动删除旧行。

同时确认 `mmh-updater` 容器在运行。设置后回到 系统设置 -> 系统更新 重新刷新远端版本；版本检查会改走镜像源测速（国内网络更稳），“更新”按钮也会可用。如果只想手动更新一次，也可以直接执行：

```bash
cd ~/mmh
sudo docker compose -p mmh pull app updater
sudo docker compose -p mmh up -d app updater
```

`docker compose pull` 拉不到镜像、报 404 或 `manifest unknown`：

镜像加速源可能临时不可用，先在宿主机确认网络和该源是否可用，再换一个源重试。下面的命令把 `.env` 里的镜像源替换成南大镜像站（`ghcr.nju.edu.cn`），也可以换成 `ghcr.io` 直连或你本地已配置的其他加速源：

```bash
cd ~/mmh
sed -i '/^MMH_APP_IMAGE=/d; /^MMH_UPDATER_IMAGE=/d; /^MMH_IMAGE_SOURCE=/d' .env
cat >> .env <<'EOF'
MMH_IMAGE_SOURCE="nju"
MMH_APP_IMAGE="ghcr.nju.edu.cn/frankluise5220/mmh:latest"
MMH_UPDATER_IMAGE="ghcr.nju.edu.cn/frankluise5220/mmh-updater:latest"
EOF
sudo docker compose -p mmh pull app updater
sudo docker compose -p mmh up -d app updater
```

该命令幂等：先删除旧的镜像源行再追加新行，重复执行无副作用。换源前建议先在宿主机验证目标源确实提供这些镜像：

```bash
docker manifest inspect ghcr.nju.edu.cn/frankluise5220/mmh:latest
docker manifest inspect ghcr.nju.edu.cn/frankluise5220/mmh-updater:latest
```

也可以把 `MMH_IMAGE_SOURCE` 设为 `auto`，由更新器自动测速选源；若 Docker Hub 拉取 `postgres:15-alpine` 也失败，请为该镜像配置 NAS 本地的 registry 镜像加速。

更新页面提示“更新失败 / Failed to fetch”，但系统实际已更新：

网页更新会拉取新镜像并重启 `mmh-app`。应用冷启动在低功耗 NAS 上可能超过一分钟，期间页面会显示“服务正在重启，正在重新连接...”。

如果页面在应用恢复之前就提示失败，先不要急着重试：

1. 等 1 分钟，重新打开 `http://NAS_IP:7777/`。
2. 进入 系统设置 -> 系统更新，看“当前版本”是否已经是新版本；如果是，说明更新实际已经成功，直接使用即可。
3. 如果应用仍然打不开，在 NAS 终端检查：

```bash
cd ~/mmh
sudo docker compose -p mmh ps
sudo docker compose -p mmh logs --tail 50 app
sudo docker compose -p mmh up -d app
```
