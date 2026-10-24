# MoneyMoneyHome（MMH）

<p align="center">
  <a href="#中文">中文</a>
  ·
  <a href="#english">English</a>
  ·
  <a href="#日本語">日本語</a>
</p>

> 本地优先的家庭记账与全资产管理工作台：程序和账本数据都保存在你自己的 NAS、家庭服务器或本机环境里，不经过第三方云端。

## 中文

### 这是什么

MMH（MoneyMoneyHome）是一套面向家庭和个人的本地优先智能财务工作台。它把日常记账、信用卡账单、基金、股票、债券、存款、理财、房产、保险、贷款和往来款放进同一套账，让家庭的资产和负债有同一个长期稳定的视图。

它不是把家庭账本交给外部平台的 SaaS。它部署在自己的 NAS、家庭服务器或本机，敏感财务数据留在自己掌握的地方。

### 快速开始

按你的情况选一条最短路径：

| 如果你是… | 这样做 |
| --- | --- |
| 飞牛 NAS 用户 | 打开应用中心搜索MMH，或者通过`FN软仓`OR`Fndepot`仓库客户端搜索 MMH 安装，再或从 [Releases](https://github.com/frankluise5220/MMH/releases) 下载 `.fpk` |
| 群晖 NAS 用户 | 在套件中心里添加源`https://synology.floatingice.win`后查找MMH,或者从 [Releases](https://github.com/frankluise5220/MMH/releases) 下载 `.spk`，在套件中心手动安装 |
| Windows 电脑用户 | 下载 Windows 桌面版安装包，双击安装即可使用，数据保存在本机 |
| 有 Docker 的用户 | 使用预构建镜像 `ghcr.io/frankluise5220/mmh` 部署，日常更新直接拉取新镜像 |

首次打开有使用向导引导初始化账簿。完整步骤见 [NAS / 飞牛 fnOS / 群晖 DSM 安装与更新](deploy/nas-install-manual.md)。

### 它能帮你解决什么

- **一张表看清全部资产和负债**：资金、信用卡、投资、房产、保险、贷款统一到一个视图，不用在多个 App 和表格之间来回看。
- **账单进来，账自动对好**：支付宝/微信 Excel、财智8、邮箱/PDF/截图 AI 识别，预览后批量导入；配合余额校准把记录与实际余额对齐。
- **周期的事不用反复记**：定投、还款、转账、缴费、存款取息、债券付息按计划自动入账；债券按存单计息，每期付息自动落账，到期提醒，可核销。
- **贷款变化随时重算**：LPR 调整、提前还款（月供不变缩短期限 / 期限不变减少月供）自动重算还款计划。
- **AI 助手聊天记账，也能远程管账**：对话式记账、查账、批量修改、恢复误删，账单文本或截图直接丢给它；另内置 MCP 服务端，Claude Desktop、Cursor 等助手可接入查账和记账。

### 真正花功夫的，是这些日常操作

基金、存款、贷款这些「条线」大家都有，MMH 更在意每天记账和对账时手是不是顺：

- **表格按你的习惯重排**：列宽直接拖、列序可调、点表头排序，表头有统一的列设置和下拉筛选；偏好存下来，下次打开还是你排好的样子，账户、分类、标签也能拖拽排序。
- **批量改账，误操作可撤销**：多选流水后批量改分类、换账户、加标签、删除；外部账单先预览、确认后批量入账，整批同样可撤销。
- **录入时少点几下**：「再记一笔」保留当前模式和常用默认值；可搜索下拉里能边选边新建账户、分类、标签；日期、金额、往来对象按历史智能补全。
- **改了哪里只刷哪里**：保存后只刷新受影响的记录和合计，不整页重绘；数字表紧凑、稳定、能扫。
- **一家人共用一本账**：账户所有人和家庭成员是同一批人，一边改名另一边同步；往来款能算清谁欠谁。

### 功能模块

| 模块 | 说明 |
| --- | --- |
| 概览 | 汇总资金、投资、固定资产、保险、负债等账户和关键指标。 |
| 日常记账 | 支出、收入、转账，以及代付、借入、借出、还款等往来款；支持多币种与汇率换算、二级收支分类、标签、机构、家庭成员和往来对象。 |
| 账户 | 管理现金、借记卡、电子钱包、存款、信用卡和各类投资账户，以及账户归属（家庭成员/所有人）。 |
| 信用卡 | 维护信用卡账户、账单周期、入账日期、交易明细、分期计划和还款记录。 |
| 投资基金 | 管理基金交易、净值缓存、持仓、份额、成本、收益和确认/到账规则，支持定投计划。 |
| 股票 | 管理股票账户、证券资金账户、买卖交易、分红、费用、收盘价和持仓盈亏。 |
| 债券 | 管理城投债、国债等债券：以存单为单位维护持仓，按存单计息，付息自动落账，到期提醒，支持核销。 |
| 存款 | 管理存款产品与存单，支持日均/月均计息、利息自动入账和取回。 |
| 理财与贵金属 | 维护理财产品和贵金属持仓。 |
| 固定资产 | 管理房产等固定资产、装修投入、资产估值、抵押关联和关联流水。 |
| 保险 | 维护保险产品、保单、投保记录、缴费计划、现金价值和续保。 |
| 贷款 | 管理房贷等贷款，支持还款计划、LPR 利率调整、提前还款（月供不变缩短期限 / 期限不变减少月供）和还款重算。 |
| 往来款 | 跟踪代付、借入、借出、还款和与往来对象相关的余额结果。 |
| 计划任务 | 管理定投、还款、转账、缴费、存款取息、债券付息等周期任务，自动入账。 |
| 报表与统计 | 收支统计、资产报表和余额校准对账，口径与账本明细一致。 |
| AI 识别与助手 | 从邮箱、文本、PDF、截图识别账单并批量导入；对话记账、查账、批量修改、恢复误删。 |
| AI 助手接入（MCP） | 内置 MCP 服务端，AI 助手可查账户、分类、流水、持仓、存单和收支统计，并可代为记账、删账。 |
| 数据安全 | 流水附件、误操作撤销与删除恢复、手动/自动备份（可导出备份文件）。 |
| 多语言 | 界面支持中文、English、日本語。 |

### 用 AI 助手管账（MCP）

MMH 内置 MCP（Model Context Protocol）服务端（0.1.71 起）。Claude Desktop、Claude Code、Cursor、CodeBuddy 等助手接入后，可以直接问「这个月花了多少」「定投投了多少」，或者说「记一笔 32 元的午饭支出」，由助手调用 MMH 完成。余额、合计、持仓盈亏由服务端计算，与 Web 界面同口径，助手不自行重算。

| 工具 | 用途 |
| --- | --- |
| `mmh_list_accounts` | 账户及余额（投资账户为市值，信用卡为当前账单周期） |
| `mmh_list_categories` | 三级分类树 |
| `mmh_list_transactions` | 按账户分页读流水 |
| `mmh_get_investment_shell` | 单个投资账户的持仓、明细、市值 / 成本 / 收益 |
| `mmh_list_deposit_lots` | 存款存单 |
| `mmh_list_bond_lots` | 债券存单 |
| `mmh_query_investment_flow` | 按日期区间汇总买入 / 卖出金额，定投单列 |
| `mmh_get_monthly_summary` | 年度收支统计，与「统计」页面同口径 |
| `mmh_create_transaction` | 记一笔支出 / 收入 / 转账 |
| `mmh_delete_transaction` | 删除一笔流水 |

接入只需两步：在「设置 → 外接 API Key」创建一把 Key（默认选只读，需要助手记账时选读写，完整 Key 只显示一次），再把客户端指向 `<MMH 地址>/api/v1/mcp`；只支持本机子进程的客户端用仓库自带的 `scripts/mmh-mcp-stdio.cjs` 桥接。参数、口径和一份可直接交给助手的提示词见 [MCP 接入指南](MCP.md)。

### 部署与更新

| 运行方式 | 说明 |
| --- | --- |
| 飞牛 fnOS 原生 | 原生 `.fpk` 应用包，不依赖 Docker 和 PostgreSQL，数据保存在飞牛应用数据目录。 |
| 群晖 DSM 原生 | 原生 `.spk` 套件包，数据保存在群晖套件数据目录。 |
| Docker | 预构建镜像，适合 NAS / 家庭服务器；日常更新直接拉取新镜像，不在 NAS 上反复构建。 |
| Windows 桌面端 | 桌面应用内置本地 SQLite，打开即用，无需额外服务。 |

完整的安装、更新、备份与升级说明见 [NAS / 飞牛 fnOS / 群晖 DSM 安装与更新](deploy/nas-install-manual.md)。最新版本和安装包见 [GitHub Releases](https://github.com/frankluise5220/MMH/releases)。

### 常见问题

| 问题 | 回答 |
| --- | --- |
| 数据会上传到云端吗？ | 不会。账本数据保存在你自己的环境里；只有获取基金净值、股票行情等公开数据，以及你主动配置的邮箱导入、AI 服务才需要联网。 |
| 需要什么硬件？ | 飞牛/群晖原生包不依赖 Docker 和 PostgreSQL，低内存 NAS 也能运行；Docker 版需要能跑 Docker 的 NAS 或服务器。 |
| 不会命令行能用吗？ | 可以。飞牛/群晖装应用包、Windows 装桌面版都不需要命令行。 |
| 支持手机使用吗？ | 支持。手机浏览器可直接访问 Web 版，另有 Android App。 |
| 数据丢了怎么办？ | 支持手动/自动备份，可导出备份文件；误删的记录可以撤销，或从回收站恢复。 |
| 有多种安装方式，选哪个？ | 飞牛用户优先装 `.fpk`，群晖用户装 `.spk`，Windows 用户装桌面版，已有 Docker 环境的用镜像部署。 |
| AI 助手能直接管账吗？ | 可以。MMH 内置 MCP 服务端，接入后助手可查账、记账，口径与 Web 一致；见 [MCP 接入指南](MCP.md)。 |

### 技术栈（给开发者）

- Web 端：Next.js + React + TypeScript + Prisma；Docker 版使用 PostgreSQL，飞牛/群晖/桌面版使用 SQLite。
- 客户端：响应式 Web、Windows 桌面端（Electron）、Android App；开放 API（`/api/v1`）和 MCP 端点（`/api/v1/mcp`）供多端、第三方与 AI 助手接入。
- 界面语言：中文、English、日本語，多端共享同一套业务口径。

### 安全模型

MMH 面向自托管环境，远程访问时需要注意明确的安全边界：

- 推荐通过 HTTPS 反向代理访问。
- 可用 `MMH_ALLOWED_HOSTS` 限定允许访问的域名或 IP。
- 登录会话 Cookie 使用 `HttpOnly`、`SameSite=Lax`，生产环境默认 `Secure`。
- 系统初始化、删除账簿等敏感操作会验证当前登录用户自己的密码。
- 数据库端口应只暴露给应用容器或本机网络；业务 API 会从当前会话解析账簿、用户和角色上下文，避免跨账簿访问。

### 参与与反馈

- 问题与建议：[GitHub Issues](https://github.com/frankluise5220/MMH/issues)
- 版本与安装包：[GitHub Releases](https://github.com/frankluise5220/MMH/releases)

## English

> English translation of the updated homepage is being prepared and will replace this placeholder.

## 日本語

> 更新後の日本語版は準備中です。このプレースホルダーはその際に置き換えられます。

## Developer Docs

Local developer guidance under `AGENTS.md`, `.skill/`, and `docs/` is intentionally ignored by Git in this workspace. Public documentation linked from this README should point only to tracked files, such as [NAS / 飞牛 fnOS / 群晖 DSM 安装与更新](deploy/nas-install-manual.md).
