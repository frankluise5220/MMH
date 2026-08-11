# MMH 飞牛包与速度安全改造计划

本文记录 MMH 面向飞牛 fnOS 的专用 `.fpk` 落地方向。

现有 NAS 安装与更新主线仍然是 Docker，继续使用 `deploy/nas/` 和 `docs/nas-install-manual.md`。飞牛只新增一个专用应用：

```text
appname=mmh
```

飞牛 `.fpk` 内部使用 SQLite 原生运行方式，不再额外发布 `mmh-native.fpk`，也不把旧 Docker Compose FPK 作为飞牛用户安装包。因为包内包含 Node runtime 和 `better-sqlite3` 原生依赖，正式 Release 资产按架构分包：x86 保留 `mmh.fpk` 兼容旧下载地址，同时提供 `mmh-x86_64.fpk`；ARM64 提供 `mmh-arm64.fpk`。这些包的 `appname` 和 `version` 必须一致。

## 目标

- 用户安装飞牛版架构匹配的 `.fpk` 后，不需要理解 Node、Prisma、Next.js、Docker 或数据库构建流程。
- 飞牛版直接运行包内 Next standalone、Linux Node runtime、Prisma runtime 和 SQLite 数据库。
- 飞牛版没有 PostgreSQL 连接密码；安装向导中的系统密码用于系统初始化、删除账簿等敏感操作，并通过 `MMH_SYSTEM_PASSWORD` 注入运行时。
- 普通 NAS 安装与更新仍保持 Docker 路线，不被飞牛 SQLite 包替代。
- 飞牛包必须在 Linux/fnOS 构建环境生成，不能用 Windows 构建产物冒充正式包。
- 数据目录必须持久化，升级不得删除用户的 SQLite 数据库文件；SQLite 数据库必须位于飞牛应用数据目录，不允许回退到应用安装目录。
- 默认安全边界清楚：只暴露 Web 端口，不包含本机 `.env`、私有 token、SSH 信息、邮箱授权码、AI key 或数据库备份。

## 已落地

- `src/lib/db/prisma.ts` 可按 `DATABASE_URL` 自动选择 PostgreSQL 或 SQLite adapter。
- `prisma.config.ts` 可通过 `PRISMA_SCHEMA_PATH` 选择 native schema。
- `scripts/generate-native-sqlite-schema.cjs` 可从 PostgreSQL schema 生成 SQLite schema。
- `prisma/schema.native.prisma` 已能通过 `prisma validate`。
- `scripts/build-fnos-app.cjs` 定义 Linux SQLite standalone 构建流程。
- `scripts/build-fnos-package.cjs` 生成飞牛 FPK 工程，支持 `FNOS_TARGET_ARCH=x86|arm64`，写入对应 manifest 架构、`cmd/main`、图标、持久化数据目录解析、Prisma runtime 和 SQLite 启动链。
- `scripts/verify-fnos-package.cjs` 校验飞牛包素材，防止 `.env` 泄露、Docker resource 混入和第二个 `.fpk` 包出现。
- `.github/workflows/fnos-release.yml` 发布时用 x86/arm64 矩阵构建并上传正式 `release-artifacts/fnos/*.fpk`。
- `.github/workflows/fnos-stage.yml` 生成 x86/arm64 调试用 FPK 工程归档；该归档不能作为用户安装包。
- `deploy/fnos/repository/apps.example.json` 只保留一个应用条目，`download_url` 保留 x86 兼容包，`download_urls` 提供架构化下载地址。
- 系统更新页在 `MMH_DEPLOY_TARGET=fnos` 时显示飞牛应用包更新方式，并拒绝在飞牛版内执行 Git/Docker 更新。

## 启动链

1. fnOS 启动 `cmd/main start`。
2. 脚本定位应用目录和持久化数据目录；数据目录优先使用 `TRIM_DATADEST`，其次使用 `TRIM_PKGVAR/data`，再兜底到 `/vol*/@appdata/mmh/data`。
3. 设置 `DATABASE_URL=file:$DATA_DEST/mmh.db`。
4. 设置 `PRISMA_SCHEMA_PATH=$SERVER_DIR/prisma/schema.native.prisma`。
5. 读取持久环境文件 `mmh.env`，导出 `PORT` 和 `MMH_SYSTEM_PASSWORD`；如果未设置系统密码，首次启动随机生成一次并保存到 `mmh-system-password.txt`。
6. 使用包内 Node 运行 SQLite 初始化脚本；仅在数据库没有用户表时创建初始结构，已有数据库不会被重建。
7. 启动包内 Next standalone `server.js`，对外暴露 `7777`。

## 发布链

1. 发布 GitHub Release 时，`.github/workflows/fnos-release.yml` 运行 `npm run check:fnos`。
2. workflow 矩阵分别运行 x86 和 arm64 runner，下载与当前 Node 版本匹配的 Linux x64 / arm64 Node runtime。
3. workflow 执行 `npm run build:fnos:app`，确保 standalone 和原生依赖都是当前 runner 架构的 Linux 产物。
4. workflow 执行 `npm run build:fnos`，x86 生成 `mmh.fpk`、`mmh-x86_64.fpk` 和版本化 `.fpk`，ARM64 生成 `mmh-arm64.fpk` 和版本化 `.fpk`。
5. workflow 上传 `release-artifacts/fnos/*.fpk` 到 Release。
6. 飞牛第三方源元数据更新 `version`、`download_url` 和 `download_urls`，其中 `version` 必须等于 `package.json` 的 `0.1.x`，下载地址必须指向同一个 `v0.1.x` Release 中的对应架构 `.fpk`。

## 限制

- 正式 `.fpk` 必须在 Linux/fnOS 环境构建，因为 `better-sqlite3` 等原生依赖必须匹配目标平台。
- 构建正式包必须提供对应架构的 Linux Node runtime；x86 使用 `node-v20.x-linux-x64.tar.gz`，ARM64 使用 `node-v20.x-linux-arm64.tar.gz`。workflow 会自动下载，手动构建时通过 `FNOS_TARGET_ARCH` 与 `FNOS_NODE_TARBALL` 显式指定。
- Windows 本地只能生成调试 stage 包，不能产出可安装的正式包。
- 当前包包含 Linux Node runtime、Next standalone、Prisma runtime 和必要依赖，体积会明显大于 miniBill；除非后续把服务端重写为更轻的单二进制运行时，否则不承诺几 MB 级。
- 飞牛包安装/配置向导必须提供系统密码设置项；留空时由启动脚本生成随机密码并写入持久应用数据目录。
- 飞牛包不使用独立 `-fnos` 版本号；正式发布前用 `npm run release:version` 递增一次 `package.json` 的 `0.1.x`，并保持 GitHub Release、GHCR 镜像和所有架构 `.fpk` 同号。

## 待确认

- 飞牛 `.fpk` 的正式 manifest 字段、签名方式和目录结构。
- 飞牛安装/升级时的数据目录保留行为。
- 系统更新页在 `MMH_DEPLOY_TARGET=fnos` 时显示飞牛包更新方式，而不是 Docker updater。

## 下一步清单

- [x] 生成并校验 `prisma/schema.native.prisma`。
- [x] 建立 `npm run build:fnos:app` Linux SQLite standalone 构建脚本。
- [x] 建立 `npm run build:fnos` 正式飞牛包脚本，x86 产物包含 `release-artifacts/fnos/mmh.fpk` / `mmh-x86_64.fpk`，ARM64 产物包含 `release-artifacts/fnos/mmh-arm64.fpk`。
- [x] 建立 `npm run stage:fnos` 调试归档脚本。
- [x] 建立 `npm run check:fnos` 飞牛包素材校验。
- [x] 增加 GitHub Release workflow，发布时自动下载对应架构的 Linux Node runtime、安装对应架构官方 `fnpack` 并构建正式 `.fpk`。
- [ ] 执行 `.github/workflows/fnos-release.yml`，确认正式 x86/arm64 `.fpk` 产出并通过内置校验。
- [ ] 在 x86 与 ARM64 飞牛测试机安装对应 `.fpk`，验证启动、SQLite 数据保留、升级覆盖和日志查看。
- [x] 给系统更新页增加飞牛环境提示。
- [ ] 将大列表接口改成分页或游标，优先处理账单、明细、导入预览。
- [ ] 补 API mutation 的 Origin/CSRF 与登录失败限流。
