# miniBill 速度与安全参照

本文记录 miniBill 对 MMH 有参考价值的工程方法，以及已经启动的飞牛 SQLite FPK 改造线。

## 结论

miniBill 的几 MB 安装包来自轻量运行时：静态前端、轻后端、SQLite、清楚数据目录。MMH 当前是 Next.js、Prisma 和复杂家庭财务业务模型，不能仅靠换打包脚本做到几 MB 完整包。

MMH 普通安装与更新主线仍然是 Docker。飞牛只新增一个专用应用 ID，但按架构发布两个 FPK：

```text
mmh-x86_64.fpk
mmh-arm64.fpk
```

这个飞牛包内部使用 SQLite 原生运行方式，包含 Next standalone、Linux Node runtime、Prisma runtime 和 SQLite 数据库初始化链，不依赖 Docker/PostgreSQL。不要再额外发布 `mmh-native.fpk`。

## 可取原则

### 轻运行时边界

- 页面组件只装配数据和交互。
- 复杂业务查询进入 `src/lib/server/*-page-data.ts` 或领域 service。
- 复杂写入进入明确的 server action / route service。
- Docker runtime 继续服务普通 NAS 安装，只包含运行所需文件，不包含源码构建工具链和临时调试资产。
- 飞牛 FPK runtime 只包含 Next standalone、必要 `node_modules`、Prisma runtime、Linux Node、SQLite schema 和数据目录。

### 小数据响应

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

- `/api/v1` mutation 统一走 session / household scope。
- API key 和 Bearer token 能力要有白名单和审计，不应无限绕过访问白名单。
- 登录、找回密码、AI 导入、邮箱导入需要限流。
- 关键操作需要审计日志：导入、删除、批量修改、系统更新、权限变更。

### 安装包边界

- 普通 NAS Docker 安装不变。
- 飞牛 `.fpk` 包内放应用运行体、Linux Node runtime、Prisma runtime 和 SQLite schema；数据保存在 fnOS 数据目录。
- 飞牛 `.fpk` 不得包含本机 `.env`、私有 token、SSH 信息、邮箱授权码、AI key 或数据库备份。
- 飞牛 `.fpk` 升级必须保留用户数据目录。
- `*-fpk-source.tgz` 只能用于调试包结构，不是用户安装包。

## 已落地

- [x] 建立 `deploy/fnos/` 飞牛包说明和发布源草案。
- [x] 建立 `npm run stage:fnos` 飞牛 FPK 工程生成脚本。
- [x] 建立 `npm run check:fnos` 飞牛 FPK 素材校验脚本。
- [x] 生成并校验 `prisma/schema.native.prisma`。
- [x] 数据库入口支持 PostgreSQL 和 SQLite adapter 自动切换。
- [x] 建立 `.github/workflows/fnos-release.yml`，发布时构建并上传 x86 / ARM64 SQLite 版 `.fpk`。

## 仍需验证

- [ ] 在安装了 `fnpack` 的 Linux/fnOS runner 上生成正式 x86 / ARM64 `.fpk`。
- [ ] 在 x86 与 ARM64 飞牛测试机安装对应 `.fpk`，验证启动、SQLite 数据保留、升级覆盖和日志查看。
- [ ] 系统更新页在 `MMH_DEPLOY_TARGET=fnos` 时显示飞牛包更新方式。
- [ ] API mutation 增加统一 Origin/CSRF 检查策略。
- [ ] 信用卡账单页拆成小响应：账期摘要、当前页明细、统计聚合分离。
- [ ] 交易明细接口统一分页和稳定排序。
- [ ] 导入预览任务化，写入时显示进度并支持只导入无阻断记录。
- [ ] 系统设置页按模块懒加载，避免一次 render 所有设置模块。
