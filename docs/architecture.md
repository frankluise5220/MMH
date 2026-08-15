# MMH 系统架构总览

> 面向非开发者的阅读版架构说明。本文件是 `docs/development-docs.md` 文档地图的一部分。

## 一句话概括

MMH（MoneyMoneyHome）是一个**本地优先的家庭财务系统**：用户通过网页或手机 App 记账，系统负责把账户、流水、基金持仓、保险、房贷、信用卡等算清楚，所有数据都保存在自己的 NAS / 服务器上，不交给外部平台托管。

## 技术栈速览

| 部分 | 技术 |
| --- | --- |
| Web 工作台 | Next.js 16（App Router）+ React 19 + TypeScript + Tailwind CSS 4 |
| 数据访问 | Prisma ORM，支持 SQLite（本地/原生包）与 PostgreSQL（Docker/NAS） |
| AI 识别 | AI SDK（OpenAI 兼容模型） |
| 邮件账单 | imapflow / mailparser / nodemailer，支持 IMAP 抓取与 SMTP 发送 |
| 文件解析 | pdf-parse（PDF）、xlsx（Excel） |
| 图表 | recharts |
| 手机端 | Android 原生 App（`android/`）；iOS 规划中 |
| 部署 | Docker / NAS、飞牛 fnOS 原生包、内置系统更新服务 |

## 一、分层架构图（总览）

```mermaid
flowchart TB
    subgraph CLIENT["① 使用端（谁能用）"]
        WEB["🖥️ Web 工作台<br/>功能最全的网页版"]
        ANDROID["📱 Android 手机端<br/>日常快速记账/看资产"]
        IOS["📱 iOS 手机端<br/>（规划中）"]
        EXT["🔌 开放 API 客户端<br/>第三方接入"]
    end

    subgraph API["② 统一接口层 ／api/v1<br/>网页与手机共用同一套接口"]
        API_AUTH["🔐 登录 · 账簿 · 用户 · 权限"]
        API_BOOK["📒 记账 · 账户 · 流水 · 分类 · 标签"]
        API_FUND["📈 基金 · 净值 · 定投"]
        API_STOCK["💹 股票持仓 · 交易"]
        API_INS["🛡️ 保险 · 保单"]
        API_CC["💳 信用卡账单 · 分期"]
        API_LOAN["🏠 房贷 · 贷款 · 房产"]
        API_AI["🤖 AI 识别 · 账单解析"]
        API_MAIL["📧 邮箱账单抓取"]
        API_SYS["⚙️ 系统设置 · 备份 · 更新"]
        API_MOB["📲 手机同步接口（移动端专属）"]
    end

    subgraph BIZ["③ 业务逻辑层<br/>统一计算口径：同一笔钱，各处算出来都一样"]
        B_FUND["基金模块<br/>净值缓存 · 费率 · 确认/到账日 · 持仓重算"]
        B_STOCK["股票模块<br/>持仓 · 费用规则 · 行情"]
        B_AI["AI 模块<br/>模型配置 · 账单识别"]
        B_MAIL["邮件模块<br/>IMAP 抓取 · PDF/账单解析"]
        B_SVC["核心服务<br/>余额 · 汇总 · 报表 · 计划任务"]
        B_OTHER["其他业务<br/>保险 · 信用卡 · 房产贷款 · 贵金属 · 理财"]
    end

    subgraph DATA["④ 数据层<br/>所有数字的最终来源"]
        ORM["Prisma 数据模型<br/>47 个模型：账户/交易/持仓/净值/保单…"]
        DB["数据库<br/>SQLite（本地）/ PostgreSQL（NAS）"]
    end

    subgraph DEPLOY["⑤ 部署与运行层<br/>装在哪、怎么更新"]
        DOCKER["🐳 Docker / NAS 部署"]
        FNOS["飞牛 fnOS 原生安装包"]
        UPD["🔄 系统更新服务"]
        TASK["⏰ 定时任务<br/>定投 · 还款 · 缴费自动执行"]
    end

    CLIENT -->|发请求| API
    API -->|调用统一业务模块| BIZ
    BIZ -->|读写数据模型| ORM
    ORM --> DB
    BIZ -.-> TASK
    DEPLOY -.->|运行环境| CLIENT

    B_AI -.->|调用| EXT_AI["外部 AI 模型服务"]
    B_FUND -.->|查询| EXT_NAV["外部基金净值数据源"]
    B_MAIL -.->|收取| EXT_MAIL["邮箱服务器（IMAP/SMTP）"]
```

### 怎么看这张图（阅读说明）

- **从上往下看**：用户先接触「使用端」，请求进入「接口层」，接口不自己算账，而是交给「业务逻辑层」统一计算，最终读写「数据层」。
- **关键设计点**：网页和手机 App 走的是**同一套接口、同一套计算逻辑**，所以手机上看的总资产和网页上一定一致，不会出现"两个地方算出两个数"。
- **虚线是外部依赖**：AI 识别要调用外部 AI 服务、基金净值要查外部数据源、邮箱账单要连你的邮箱服务器。这些是只读/只进的外部连接，核心账本数据不出自己的服务器。

## 二、Web 工作台包含哪些功能页

```mermaid
flowchart LR
    ROOT["Web 工作台<br/>（侧边栏导航）"] --> OV["概览<br/>全部资产一眼看"]
    ROOT --> AC["账户<br/>现金/借记/信用卡/存款/投资"]
    ROOT --> TX["交易<br/>日常流水记账"]
    ROOT --> AST["资产 / 负债<br/>总资产与债务"]
    ROOT --> FD["基金<br/>交易 · 持仓 · 净值 · 定投"]
    ROOT --> SK["股票<br/>持仓 · 交易明细"]
    ROOT --> INV["投资汇总<br/>基金+股票+理财收益"]
    ROOT --> IS["保险<br/>产品 · 保单 · 缴费"]
    ROOT --> RP["报表 / 统计<br/>收支 · 持仓盈亏"]
    ROOT --> BI["批量导入<br/>Excel · 邮件 · AI 识别"]
    ROOT --> ST["设置<br/>账簿 · 用户 · 机构 · 分类 · 邮箱 · AI · 更新"]
```

## 三、一个具体例子：基金交易怎么流动

以「购买一笔基金」为例，看各层如何协作：

```mermaid
flowchart LR
    U["👤 用户在网页<br/>填写购买记录"] --> P["基金页面"]
    P --> API["基金接口<br/>/api/v1/fund/entry"]
    API --> M["基金模块<br/>检查费率/确认日/到账日"]
    M --> R["持仓重算<br/>算份额、成本、收益"]
    R --> D["写入数据库<br/>交易记录 + 持仓 + 净值缓存"]
    D --> BACK["返回最新数字"]
    BACK --> UI["网页只刷新<br/>受影响的部分"]
    M -.-> NAV["必要时查询<br/>外部基金净值"]
```

---

_维护说明：本图反映的是代码仓库的模块划分与数据流。每次重构涉及模块归属或数据流变化时，请同步更新本文件。_
