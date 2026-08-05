# MMH 飞牛包与速度安全改造计划

本文记录 MMH 面向飞牛 fnOS / NAS 应用包的落地方向。目标是让用户通过飞牛应用入口安装和更新 MMH，同时保持现有 Docker/GHCR 发布链，不在 NAS 上日常编译源码。

## 目标

- 用户不需要理解 Node、Prisma、Next.js 或数据库构建流程。
- 飞牛包只负责安装入口、配置模板、Compose 编排、图标和说明。
- 应用运行仍使用预构建镜像：`ghcr.io/frankluise5220/mmh:latest` 或用户选择的镜像源。
- 数据目录和数据库卷必须可持久化，升级不得删除用户数据。
- 默认安全边界清楚：只暴露 Web 端口，不暴露数据库端口。
- 更新流程与 NAS Docker 安装保持一致：拉取新镜像并重启服务，不在 NAS 上 build。

## 速度参考

miniBill 的速度优势主要来自轻量运行时边界：前端构建后作为静态资源提供，后端是单二进制，运行时只保留必要文件。MMH 不适合直接改成 Go/SQLite，但可以吸收以下原则：

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

## 飞牛包内容

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

## Compose 策略

飞牛版与普通 NAS 版保持同一运行语义：

- `app`：MMH Web 应用。
- `postgres`：PostgreSQL 数据库。
- `updater`：系统更新助手。
- `pgdata`：数据库持久卷。
- 当前目录挂载到 updater 的 `/workspace`，用于读取 compose 和 `.env`。

飞牛版与普通 NAS 版的主要区别：

- Postgres 不映射到宿主机端口。
- 文档更偏向图形界面安装。
- 后续可加飞牛应用图标、应用中心元数据和一键更新入口。

## 发布链

建议发布顺序：

1. GitHub Actions 构建并推送 `mmh` 与 `mmh-updater` 镜像到 GHCR。
2. 发布 GitHub Release 时，`.github/workflows/fnos-release.yml` 会运行 `npm run check:fnos` 和 `npm run build:fnos`。
3. Release runner 必须已安装 `fnpack`；缺少 `fnpack` 时 workflow 会失败，不生成也不上传假包。
4. workflow 成功后会把 `release-artifacts/fnos/*.fpk` 上传为 GitHub Release asset。
5. 飞牛第三方源元数据更新 `version` 和 `download_url`，其中 `download_url` 必须指向该 Release 中的 `.fpk`。

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
