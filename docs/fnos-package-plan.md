# MMH 飞牛包与速度安全改造计划

本文记录 MMH 面向飞牛 fnOS / NAS 应用包的落地方向。当前保留两条发布线：Docker-FPK 是稳定主线，Native-FPK 是参考 miniBill 后新增的原生包方向。

## 目标

- 用户不需要理解 Node、Prisma、Next.js 或数据库构建流程。
- 用户安装 Docker 版 `mmh.fpk` 后应得到完整 MMH 功能栈：Web 应用、PostgreSQL 数据库、Prisma 初始化、系统更新助手。
- 用户安装 Native 版 `mmh-native.fpk` 后应不依赖 Docker，直接运行内置 Next standalone、Linux Node runtime、Prisma runtime 和 SQLite 数据库。
- 飞牛包负责安装入口、Compose 编排、图标、权限和应用中心元数据；不让用户手工导入 Compose。
- Docker 版应用运行使用预构建镜像：`ghcr.io/frankluise5220/mmh:latest` 或用户选择的镜像源。
- Native 版应用运行使用包内文件，不拉 Docker 镜像；它必须在 Linux/fnOS 构建环境生成，不能用 Windows 构建产物冒充正式包。
- Next.js standalone、Prisma Client、Prisma schema、Prisma CLI/runtime 依赖和启动初始化脚本属于应用 Docker 镜像，不散装进 `.fpk`。
- 数据目录和数据库卷必须可持久化，升级不得删除用户数据。
- 默认安全边界清楚：只暴露 Web 端口，不暴露数据库端口。
- Docker 版更新流程与 NAS Docker 安装保持一致：拉取新镜像并重启服务，不在 NAS 上 build。
- Native 版更新流程以后应替换包内程序文件并保留 SQLite 数据目录；该能力需要单独验证。

## 速度参考

miniBill 的速度优势主要来自轻量运行时边界：前端构建后作为静态资源提供，后端是单二进制，运行时只保留必要文件。MMH 仍保留 Next.js/Prisma 业务栈，但 Native-FPK 方向会把数据库从 PostgreSQL 切到 SQLite，以减少飞牛安装依赖。

- 页面只做装配，复杂查询和计算沉到 `src/lib/server/*` 与领域 service。
- 大明细列表使用分页、游标或虚拟化，避免一次返回几千条进入 Next data cache。
- 导入预览和批量写入转为任务化，长耗时操作显示进度。
- 统计、余额、账单金额、基金持仓优先走统一服务层和缓存，而不是页面重复计算。
- Docker 镜像保持稳定层：依赖层、Prisma generate 层、Next standalone 输出层分开。

具体执行原则见 `docs/minibill-speed-security-reference.md`。该文档是 miniBill 参照的长期归属，避免把“学习速度/安全边界”误解为“照搬技术栈”。

## 安全参考

飞牛包第一版应先落实部署安全边界：

- Postgres 不映射宿主端口，应用通过 Docker 内网访问数据库。
- Web 端口默认映射 `7777:7777`，用户需要公网访问时应走 HTTPS 反向代理。
- `.env` 必须要求用户修改 `POSTGRES_PASSWORD`；该密码同时作为第一版内部 updater token 的默认来源。
- 更新器只通过 Docker socket 管理本项目容器，不提供任意命令执行入口。
- Compose 中普通服务使用 `no-new-privileges`，降低容器内进程提权风险。
- API mutation 后续补充统一 Origin/CSRF 校验、登录失败限流和关键操作审计。
- 不把本地测试地址、SSH 信息、私有 token、邮箱授权码、AI key 写进包内文件。

## Docker-FPK 内容

第一版 `deploy/fnos/` 只维护可打包素材：

- `docker-compose.yml`：飞牛 Docker 应用使用的 Compose。
- `env.example`：安装时复制为 `.env`。
- `README.md`：飞牛图形界面安装和更新说明。
- `manifest.example.json`：应用包元数据草案，等待实际 fpk 规范确认后改成正式字段。
- `npm run build:fnos`：在安装了 `fnpack` 的环境中生成正式 `.fpk` 单文件。
- `npm run stage:fnos`：仅生成 FPK 工程调试归档，不是正式用户安装包。
- `deploy/fnos/repository/apps.example.json`：持续更新源索引草案，下载地址必须指向 `.fpk`。

飞牛包不包含：

- 源码构建步骤。
- `node_modules`。
- 本机 `.env`。
- 私有调试脚本。
- 数据库备份。
- Docker 镜像层离线包。

如果要求无网络离线安装，Docker 版需要单独设计包含镜像层的离线分发包；这会显著增大包体积，并改变更新策略。当前 Docker 版目标是 `fpk` 一键安装并从镜像源拉取预构建镜像。

## Native-FPK 内容

Native-FPK 是 miniBill 方向的新增工程线，目标是让用户安装一个 `mmh-native.fpk` 后直接得到完整运行能力，不依赖 Docker。

当前已落地：

- `src/lib/db/prisma.ts` 可按 `DATABASE_URL` 自动选择 PostgreSQL 或 SQLite adapter。
- `prisma.config.ts` 可通过 `PRISMA_SCHEMA_PATH` 选择 native schema。
- `scripts/generate-native-sqlite-schema.cjs` 可从 PostgreSQL schema 生成 SQLite schema。
- `prisma/schema.native.prisma` 已能通过 `prisma validate`。
- `scripts/build-fnos-native-app.cjs` 定义 Linux native standalone 构建流程。
- `scripts/build-fnos-native-package.cjs` 生成原生 FPK 工程，写入 `cmd/main`、manifest、图标、数据目录、Prisma runtime 和 SQLite 启动链。
- `scripts/verify-fnos-native-package.cjs` 校验 native 包素材，防止 `.env` 泄露和 Docker resource 混入。

当前限制：

- 正式 native `.fpk` 必须在 Linux/fnOS 环境构建，因为 `better-sqlite3` 等原生依赖必须匹配目标平台。
- 构建正式包必须提供 Linux x64 Node runtime，例如通过 `FNOS_NATIVE_NODE_TARBALL=/path/to/node-v20.x-linux-x64.tar.gz`。
- Windows 本地只能生成调试 stage 包，不能产出可安装的 native 发布包。
- 当前 native stage 压缩包约 100MB 以上，且还没包含 Linux Node runtime；MMH 现阶段无法做到 miniBill 几 MB 级，除非后续把服务端重写为更轻的单二进制运行时。

Native 版启动链：

1. fnOS 启动 `cmd/main start`。
2. 脚本定位应用目录和数据目录。
3. 设置 `DATABASE_URL=file:$DATA_DEST/mmh.db`。
4. 使用包内 Node 运行 Prisma CLI，对 `prisma/schema.native.prisma` 执行 `db push`。
5. 启动包内 Next standalone `server.js`，对外暴露 `7777`。

## Compose 策略

飞牛版与普通 NAS 版保持同一运行语义：

- `app`：MMH Web 应用。
- `postgres`：PostgreSQL 数据库。
- `updater`：系统更新助手。
- `pgdata`：数据库持久卷。
- 当前目录挂载到 updater 的 `/workspace`，用于读取 compose。

完整启动链：

1. 飞牛应用中心按 `docker-project` 资源启动 Compose 项目。
2. `postgres` 初始化数据库、`public` schema 和必要扩展。
3. `app` 等待 PostgreSQL healthcheck 通过。
4. `app` 容器入口执行 `prisma db push`，创建或同步数据库结构。
5. `app` 启动 Next.js standalone server，对外暴露 `7777`。
6. `updater` 提供网页更新能力，后续只拉取新镜像，不在 NAS 上编译。

飞牛版与普通 NAS 版的主要区别：

- Postgres 不映射到宿主机端口。
- 文档更偏向图形界面安装。
- 后续可加飞牛应用图标、应用中心元数据和一键更新入口。

## 发布链

建议发布顺序：

1. GitHub Actions 构建并推送 `mmh` 与 `mmh-updater` 镜像到 GHCR。
2. 发布 GitHub Release 时，`.github/workflows/fnos-release.yml` 会运行 `npm run check:fnos` 和 `npm run build:fnos`。
3. 如果 Release 已经手动附带 `.fpk`，workflow 会检测到并跳过重复构建。
4. 如果 Release 尚未附带 `.fpk`，Release runner 必须已安装 `fnpack`；缺少 `fnpack` 时 workflow 会失败，不生成也不上传假包。
5. workflow 成功后会把 `release-artifacts/fnos/*.fpk` 上传为 GitHub Release asset。
6. 飞牛第三方源元数据更新 `version` 和 `download_url`，其中 `download_url` 必须指向该 Release 中的 `.fpk`。

## 待确认

- 飞牛 `.fpk` 的正式 manifest 字段、签名方式和目录结构。
- 飞牛应用中心是否允许安装时编辑 `.env`，以及是否支持自动生成随机密码。
- 飞牛 Docker 应用是否允许挂载 `/var/run/docker.sock`；若不允许，系统更新页需要在飞牛包模式下隐藏自动更新器，只保留人工更新说明。
- 飞牛包是否要求区分 `amd64` / `arm64`；如果要求，Release 需要按架构生成包。

## 下一步清单

- [ ] 验证 `deploy/fnos/docker-compose.yml` 可在普通 Docker Compose 中启动。
- [x] 提供 `npm run check:fnos` 离线检查飞牛包素材的安全默认值。
- [x] 建立 `npm run build:fnos` 正式打包脚本；缺少 `fnpack` 时失败，避免误把归档当包。
- [x] 建立 `npm run stage:fnos` 调试脚本，用于检查 FPK 工程结构。
- [x] 增加持续更新源索引草案，要求下载地址指向 `.fpk`。
- [x] 增加 GitHub Release workflow，发布时上传 `.fpk` Release asset。
- [ ] 在飞牛测试机上确认 `.fpk` 安装、端口映射、卷持久化和日志查看。
- [ ] 确认 Docker socket 权限；决定飞牛包是否默认启用 updater。
- [ ] 给系统更新页增加飞牛环境提示。
- [ ] 将大列表接口改成分页或游标，优先处理账单、明细、导入预览。
- [ ] 补 API mutation 的 Origin/CSRF 与登录失败限流。
- [x] 建立 `npm run stage:fnos-native` 原生 FPK 工程生成脚本。
- [x] 建立 `npm run check:fnos-native` 原生 FPK 素材校验。
- [x] 生成并校验 `prisma/schema.native.prisma`。
- [ ] 在 Linux/fnOS 构建环境执行 `npm run build:fnos-native:app`，确保 standalone 和原生依赖都是 Linux 产物。
- [ ] 提供或自动下载 Linux x64 Node runtime，并执行 `npm run build:fnos-native` 生成正式 `mmh-native.fpk`。
- [ ] 在飞牛测试机安装 `mmh-native.fpk`，验证启动、SQLite 数据保留、升级覆盖和日志查看。
