# miniBill 速度与安全参照

本文记录 miniBill 对 MMH 有参考价值的工程方法，以及已经启动的飞牛 Native-FPK 改造线。

## 结论

miniBill 的几 MB 安装包来自轻量运行时：静态前端、轻后端、SQLite、清楚数据目录。MMH 当前是 Next.js、Prisma 和复杂家庭财务业务模型，不能仅靠换打包脚本做到几 MB 完整包。

当前保留两条线：

- Docker-FPK：稳定主线，小 `.fpk` 只做飞牛安装入口和 Docker Compose 编排，完整功能来自预构建镜像。
- Native-FPK：新增 miniBill 方向，包内包含 Next standalone、Linux Node runtime、Prisma runtime 和 SQLite 数据库，不依赖 Docker。

Native-FPK 的目标是“安装一个包即可运行完整 MMH”，但短期包体会明显大于 miniBill。除非后续把服务端改成更轻的单二进制运行时，否则不承诺几 MB 级。

## 可取原则

### 轻运行时边界

miniBill 的运行时边界很窄：静态前端、轻后端、明确数据目录。MMH 应吸收这些原则：

- 页面组件只装配数据和交互。
- 复杂业务查询进入 `src/lib/server/*-page-data.ts` 或领域 service。
- 复杂写入进入明确的 server action / route service。
- Docker runtime 只包含运行所需文件，不包含源码构建工具链和临时调试资产。
- Native-FPK runtime 只包含 Next standalone、必要 `node_modules`、Prisma runtime、Linux Node 和数据目录。

### 小数据响应

miniBill 的列表接口更接近“按需取数”。MMH 在高数据量场景也应遵循：

- 大明细列表必须分页、游标或虚拟化。
- API 返回体不要超过 Next data cache 的安全范围。
- 导入预览只加载当前页和阻断摘要，不把几千条一次性塞进客户端主界面。
- 统计和余额使用专用聚合服务，避免页面重复计算。

优先处理的 MMH 页面：

1. 信用卡账单明细。
2. 借记卡交易明细。
3. 基金交易明细。
4. 导入预览和批量编辑。
5. 系统设置页中大型配置列表。

### 清楚权限边界

miniBill 的路由层把公开、登录后、管理员能力分开。MMH 后续应补齐：

- `/api/v1` mutation 统一走 session / household scope。
- API key 和 Bearer token 能力要有白名单和审计，不应无限绕过访问白名单。
- 登录、找回密码、AI 导入、邮箱导入需要限流。
- 更新器 token 必须强制非空，并在 UI 中明确状态。
- 关键操作需要审计日志：导入、删除、批量修改、系统更新、权限变更。

### 安装包边界

Docker-FPK 和 Native-FPK 的边界不同，不能混用说法：

- Docker-FPK 包内放 Compose、env 模板、图标、manifest 和说明；应用代码和运行时由 GHCR 镜像提供。
- Native-FPK 包内放应用运行体、Linux Node runtime、Prisma runtime 和 SQLite schema；数据保存在 fnOS 数据目录。
- 两种包都不得包含本机 `.env`、私有 token、SSH 信息、邮箱授权码、AI key 或数据库备份。
- 两种包升级都必须保留用户数据目录。

## 已落地

- [x] Docker-FPK 不暴露 PostgreSQL 端口。
- [x] Docker-FPK 增加 `no-new-privileges`。
- [x] Docker-FPK env 使用密码占位符，不提交真实密码。
- [x] 建立 `deploy/fnos/` 素材目录。
- [x] 建立 `npm run check:fnos` 离线验证脚本。
- [x] 建立 `npm run stage:fnos-native` 原生 FPK 工程生成脚本。
- [x] 建立 `npm run check:fnos-native` 原生 FPK 素材校验脚本。
- [x] 生成并校验 `prisma/schema.native.prisma`。
- [x] 数据库入口支持 PostgreSQL 和 SQLite adapter 自动切换。

## 仍需验证

- [ ] 在 Linux/fnOS 环境生成 native standalone，确保 `better-sqlite3` 等原生依赖为 Linux 产物。
- [ ] 提供 Linux x64 Node runtime 后生成正式 `mmh-native.fpk`。
- [ ] 在飞牛测试机安装 `mmh-native.fpk`，验证启动、SQLite 数据保留、升级覆盖和日志查看。
- [ ] 系统更新页在 `MMH_DEPLOY_TARGET=fnos` / `fnos-native` 时显示对应更新方式。
- [ ] 更新器 token 不允许空值或默认弱值。
- [ ] API mutation 增加统一 Origin/CSRF 检查策略。
- [ ] 信用卡账单页拆成小响应：账期摘要、当前页明细、统计聚合分离。
- [ ] 交易明细接口统一分页和稳定排序。
- [ ] 导入预览任务化，写入时显示进度并支持只导入无阻断记录。
- [ ] 系统设置页按模块懒加载，避免一次 render 所有设置模块。
