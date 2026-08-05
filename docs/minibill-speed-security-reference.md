# miniBill 速度与安全参照

本文只记录 miniBill 对 MMH 有参考价值的工程方法。结论不是迁移技术栈，而是吸收它在运行时边界、接口边界和部署边界上的克制设计。

## 可取原则

### 轻运行时边界

miniBill 的运行时边界很窄：静态前端、轻后端、明确数据目录。MMH 仍然保留 Next.js、Prisma 和 PostgreSQL，但应尽量做到：

- 页面组件只装配数据和交互。
- 复杂业务查询进入 `src/lib/server/*-page-data.ts` 或领域 service。
- 复杂写入进入明确的 server action / route service。
- Docker runtime 只包含运行所需文件，不包含源码构建工具链和临时调试资产。

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

miniBill 的发布物边界清楚。MMH 飞牛包应保持：

- 包内只放 Compose、env 模板、图标、manifest 和说明。
- 应用代码和运行时由 GHCR 镜像提供。
- 不在 NAS 上日常 build。
- 数据库卷独立持久化，升级只替换镜像和包元数据。
- Postgres 默认不暴露宿主端口。

## 不照搬内容

- 不把 MMH 改成 Go 后端。
- 不把 PostgreSQL 改成每用户 SQLite 文件。
- 不把复杂财务模型压回收入/支出单一模型。
- 不为了镜像大小牺牲 Prisma/Next 的可维护性。

## MMH 落地清单

### P0：安全默认值

- [x] 飞牛 Compose 不暴露 PostgreSQL 端口。
- [x] 飞牛 Compose 增加 `no-new-privileges`。
- [x] 飞牛 env 使用密码占位符，不提交真实密码。
- [ ] 系统更新页在 `MMH_DEPLOY_TARGET=fnos` 时显示 Docker socket / 手动更新提示。
- [ ] 更新器 token 不允许空值或默认弱值。
- [ ] API mutation 增加统一 Origin/CSRF 检查策略。

### P1：速度基线

- [ ] 信用卡账单页拆成小响应：账期摘要、当前页明细、统计聚合分离。
- [ ] 交易明细接口统一分页和稳定排序。
- [ ] 导入预览任务化，写入时显示进度并支持只导入无阻断记录。
- [ ] 系统设置页按模块懒加载，避免一次 render 所有设置模块。

### P2：发布包

- [x] 建立 `deploy/fnos/` 素材目录。
- [x] 建立 `npm run check:fnos` 离线验证脚本。
- [ ] 确认飞牛 `.fpk` 正式 manifest 字段。
- [ ] 增加 GitHub Actions 产物：飞牛包素材压缩包或 `.fpk`。
- [ ] 飞牛测试机验证安装、升级、重启、数据保留。
