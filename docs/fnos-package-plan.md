# MMH 飞牛包与速度安全改造计划

本文记录 MMH 面向飞牛 fnOS 的专用 `.fpk` 落地方向。

现有 NAS 安装与更新主线仍然是 Docker，继续使用 `deploy/nas/` 和 `docs/nas-install-manual.md`。飞牛只新增一个专用安装包：

```text
mmh.fpk
```

`mmh.fpk` 内部使用 SQLite 原生运行方式，不再额外发布 `mmh-native.fpk`，也不把旧 Docker Compose FPK 作为飞牛用户安装包。

## 目标

- 用户安装飞牛版 `mmh.fpk` 后，不需要理解 Node、Prisma、Next.js、Docker 或数据库构建流程。
- 飞牛版直接运行包内 Next standalone、Linux Node runtime、Prisma runtime 和 SQLite 数据库。
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
- `scripts/build-fnos-package.cjs` 生成飞牛 FPK 工程，写入 `cmd/main`、manifest、图标、持久化数据目录解析、Prisma runtime 和 SQLite 启动链。
- `scripts/verify-fnos-package.cjs` 校验飞牛包素材，防止 `.env` 泄露、Docker resource 混入和第二个 `.fpk` 包出现。
- `.github/workflows/fnos-release.yml` 发布时构建并上传正式 `release-artifacts/fnos/mmh.fpk`。
- `.github/workflows/fnos-stage.yml` 生成调试用 FPK 工程归档；该归档不能作为用户安装包。
- `deploy/fnos/repository/apps.example.json` 只保留一个应用条目，下载地址指向 `mmh.fpk`。
- 系统更新页在 `MMH_DEPLOY_TARGET=fnos` 时显示飞牛应用包更新方式，并拒绝在飞牛版内执行 Git/Docker 更新。

## 启动链

1. fnOS 启动 `cmd/main start`。
2. 脚本定位应用目录和持久化数据目录；数据目录优先使用 `TRIM_DATADEST`，其次使用 `TRIM_PKGVAR/data`，再兜底到 `/vol*/@appdata/mmh/data`。
3. 设置 `DATABASE_URL=file:$DATA_DEST/mmh.db`。
4. 设置 `PRISMA_SCHEMA_PATH=$SERVER_DIR/prisma/schema.native.prisma`。
5. 使用包内 Node 运行 SQLite 初始化脚本；仅在数据库没有用户表时创建初始结构，已有数据库不会被重建。
6. 启动包内 Next standalone `server.js`，对外暴露 `7777`。

## 发布链

1. 发布 GitHub Release 时，`.github/workflows/fnos-release.yml` 运行 `npm run check:fnos`。
2. workflow 下载与当前 Node 版本匹配的 Linux x64 Node runtime。
3. workflow 执行 `npm run build:fnos:app`，确保 standalone 和原生依赖都是 Linux 产物。
4. workflow 执行 `npm run build:fnos`，生成 `release-artifacts/fnos/mmh.fpk` 和版本化 `.fpk`。
5. workflow 上传 `release-artifacts/fnos/*.fpk` 到 Release。
6. 飞牛第三方源元数据更新 `version` 和 `download_url`，其中 `download_url` 必须指向该 Release 中的 `mmh.fpk`。

## 限制

- 正式 `.fpk` 必须在 Linux/fnOS 环境构建，因为 `better-sqlite3` 等原生依赖必须匹配目标平台。
- 构建正式包必须提供 Linux x64 Node runtime；workflow 会自动下载，手动构建时使用 `FNOS_NODE_TARBALL=/path/to/node-v20.x-linux-x64.tar.gz`。
- Windows 本地只能生成调试 stage 包，不能产出可安装的正式包。
- 当前包包含 Linux Node runtime、Next standalone、Prisma runtime 和必要依赖，体积会明显大于 miniBill；除非后续把服务端重写为更轻的单二进制运行时，否则不承诺几 MB 级。

## 待确认

- 飞牛 `.fpk` 的正式 manifest 字段、签名方式和目录结构。
- 飞牛包是否要求区分 `amd64` / `arm64`；当前按 x86/x86_64 处理。
- 飞牛安装/升级时的数据目录保留行为。
- 系统更新页在 `MMH_DEPLOY_TARGET=fnos` 时显示飞牛包更新方式，而不是 Docker updater。

## 下一步清单

- [x] 生成并校验 `prisma/schema.native.prisma`。
- [x] 建立 `npm run build:fnos:app` Linux SQLite standalone 构建脚本。
- [x] 建立 `npm run build:fnos` 正式飞牛包脚本，产物为 `release-artifacts/fnos/mmh.fpk`。
- [x] 建立 `npm run stage:fnos` 调试归档脚本。
- [x] 建立 `npm run check:fnos` 飞牛包素材校验。
- [x] 增加 GitHub Release workflow，发布时自动下载 Linux x64 Node runtime 并构建正式 `mmh.fpk`。
- [ ] 在安装了 `fnpack` 的 Linux/fnOS runner 上执行 `.github/workflows/fnos-release.yml`，确认正式 `mmh.fpk` 产出。
- [ ] 在飞牛测试机安装 `mmh.fpk`，验证启动、SQLite 数据保留、升级覆盖和日志查看。
- [x] 给系统更新页增加飞牛环境提示。
- [ ] 将大列表接口改成分页或游标，优先处理账单、明细、导入预览。
- [ ] 补 API mutation 的 Origin/CSRF 与登录失败限流。
