# 软件简介（正典：全渠道同一份正文）

**软件简介 ≠ 更新说明。**

- **软件简介**：对整个软件做整体介绍——它是什么、装在哪、数据存在哪、能做什么。跨版本基本稳定，只在出现重要模块（如新增债券、报销差旅）时调整。
- **更新说明**：「从旧版到新版」的功能更新与 Bug 修复清单，每个版本重写。

两者不许互相顶替：简介里不许出现 `v<ver> 更新：` 前缀和本版变化，更新说明里也不重复整篇简介。分工与落点见 `.skill/mmh-release/references/update-notes-surfaces.md` §2.5。

## 一份正文，全渠道共用（2026-10-15 用户决定）

- **不再「各平台各写各的」**：旧的三条规则（只讲本平台的安装形态 / 末尾点名其它版本 / 每平台一份）**作废**。理由：同一个软件在飞牛软仓、FnDepot、群晖套件中心、README 上出现四种措辞，维护要改五份还容易漂移；用户在不同渠道看到的介绍不一致。
- **只有一份中性正文**：不点名安装形态（说「你自己的设备或 NAS」而不是「飞牛原生应用包」），末尾一次列全五个版本（飞牛 fnOS / 群晖 DSM / Windows / Docker / Android）。
- **各渠道只做渲染适配，不改字**：
  - 单行载体（软仓 `desc` 的简介段、FnDepot `desc` / `i18n.*.desc`、`apps.example.json` / `api/apps` 的字段）：直接用下面的单行正文。
  - **群晖套件中心**：同一份正文按 `\n` + `【】` 小标题排成 6 行（DSM 是纯文本面板，只能靠真实 `\n` 分段；`<br>` 会原样显示成字面 `<br>`，**禁用**）。
  - **README**：「各版本软件简介」用同一份正文，另配一张「版本 / 安装形态与数据存放」对照表。
- 群晖的 `【其它版本】` 行会列出「群晖 DSM 套件」自己——这是统一正文的刻意结果，**不要为它开例外**、也不要给它单独写一份。

### 中文正典（单行 · 改简介只改这一段）

MMH 家庭财务工作台（MoneyMoneyHome）是本地优先的家庭记账与全资产管理工具，程序和账本数据都保存在你自己的设备或 NAS 上，不经过第三方云端。记账覆盖支出、收入、转账，以及代付、借入、借出、还款等往来款；支持多账本、多成员、多币种、分类、标签、机构、家庭成员和往来对象。资产与负债在同一套账里长期维护：信用卡账单周期与分期、房贷等贷款的还款计划与重算、基金净值与定投、股票买卖与持仓盈亏、存款与债券的存单与计息、理财与贵金属、房产估值、保险保单。另提供统计报表与余额校准、周期计划自动入账、账单导入导出、AI 识别与助手、流水附件、撤销与删除恢复、手动/自动备份。支持 PC 与手机浏览器、Windows 桌面端、Android App 和开放 API 多端访问。报销与差旅工作流正在开发中，已提供部分录入和查看能力。提供飞牛 fnOS 原生应用包、群晖 DSM 套件、Windows 桌面版、Docker 镜像与 Android App 多个版本可供选择。

### English（FnDepot `i18n.en-US.desc` / 群晖 `enu` 的正文）

MMH (MoneyMoneyHome) is a local-first home bookkeeping and full asset-management workspace. The app and your ledger data stay on your own device or NAS, without a third-party cloud. Daily entries cover expenses, income, transfers, and advances, borrowing, lending and repayments, with multiple ledgers, members, currencies, categories, tags, institutions, family members and contacts. Assets and liabilities share one ledger for the long run: credit-card billing cycles and installments; loans with repayment plans and recalculation; fund NAV and regular investing; stock trades, dividends and holding P/L; deposits and bonds with certificates and interest; wealth products and precious metals; property valuation; insurance policies. It also provides reports and balance reconciliation, scheduled entries, bill import and export, AI recognition and assistant, attachments, undo and restore, and manual or automatic backups. It is accessible from PC and mobile browsers, a Windows desktop app, an Android app, and an open API. Reimbursement and travel workflows are under development, with partial entry and viewing already available. Available as a Feiniu fnOS native package, a Synology DSM package, a Windows desktop app, a Docker image, and an Android app.

### 日本語（FnDepot `i18n.ja-JP.desc`）

MMH（MoneyMoneyHome）は、ローカルファーストの家庭向け家計・資産管理ワークスペースです。アプリと帳簿データは自分のデバイスまたは NAS 上に保存され、第三者クラウドを経由しません。支出・収入・振替に加えて立替・借入・貸付・返済などの貸借取引の記録に対応し、複数帳簿・複数メンバー・多通貨・カテゴリ・タグ・金融機関・家族メンバー・取引先を管理できます。資産と負債は一つの帳簿で長期的に管理できます。クレジットカードの請求サイクルと分割払い、ローンの返済計画と再計算、投資信託の基準価額と積立、株式の売買と保有損益、預金と債券の証書と利息計算、理財商品と貴金属、不動産評価、保険証券に対応します。ほかに統計レポートと残高照合、定期タスクによる自動記帳、帳簿の取込と書出、AI 認識とアシスタント、添付ファイル、取消と復元、手動/自動バックアップを提供し、PC・モバイルブラウザ、Windows デスクトップアプリ、Android アプリ、オープン API から利用できます。精算・出張ワークフローは開発中で、一部の入力・閲覧機能を既に提供しています。飛牛 fnOS ネイティブパッケージ、Synology DSM パッケージ、Windows デスクトップ版、Docker イメージ、Android アプリの各版をご用意しています。

## 群晖渲染版（同一份正文 + `<br>` + 【】小标题）

载体是 `deploy/fnstore/app/app.py` 的 `_synology_catalog()['description']`，按 DSM 语言分 `chs` / `cht` / `enu`。**必须用 HTML `<br>` 分行**：2026-10-15 曾误以为写 `\n` 就能换行，2026-10-24 实测确认套件中心会把 `\n` 折叠成一个空格——旧正文里本来就有 5 个 `\n`，屏幕上仍是连成一整段（用户反馈「没有换行」），现已全部改成 `<br>`。行首的 `【】` 只是排版标签，正文逐字来自上面的中文正典——只有 `【记账】` 行把句首的「记账」二字换成了标签本身。

```
MMH 家庭财务工作台（MoneyMoneyHome）是本地优先的家庭记账与全资产管理工具，程序和账本数据都保存在你自己的设备或 NAS 上，不经过第三方云端。
【记账】覆盖支出、收入、转账，以及代付、借入、借出、还款等往来款；支持多账本、多成员、多币种、分类、标签、机构、家庭成员和往来对象。
【资产】资产与负债在同一套账里长期维护：信用卡账单周期与分期、房贷等贷款的还款计划与重算、基金净值与定投、股票买卖与持仓盈亏、存款与债券的存单与计息、理财与贵金属、房产估值、保险保单。
【功能】另提供统计报表与余额校准、周期计划自动入账、账单导入导出、AI 识别与助手、流水附件、撤销与删除恢复、手动/自动备份。报销与差旅工作流正在开发中，已提供部分录入和查看能力。
【多端】支持 PC 与手机浏览器、Windows 桌面端、Android App 和开放 API 多端访问。
【其它版本】提供飞牛 fnOS 原生应用包、群晖 DSM 套件、Windows 桌面版、Docker 镜像与 Android App 多个版本可供选择。
```

- `cht`：同结构（`【記賬】【資產】【功能】【多端】【其它版本】`），繁体见 `app.py`。
- `enu`：同结构，小标题为 `[Bookkeeping] [Assets] [Features] [Access] [Other editions]`，正文来自上面的 English 正典。

## 落点表（改简介要动的地方，一个都不能漏）

| # | 载体 | 文件 · 字段 | 内容 |
| --- | --- | --- | --- |
| 1 | 软仓主清单 | `fn-appstores.json` · `_manual.desc` | `【本版更新】…<br><br>【软件简介】` + 中文正典（**一整行，无真实 `\n`**） |
| 2 | 软仓静态源 | `deploy/fnos/repository/api/apps` · `data[].desc` | 同上（GitHub raw 静态应用源） |
| 3 | 软仓字段草案 | `deploy/fnos/repository/apps.example.json` · `apps[].description` | 同上 |
| 4 | FnDepot / 飞牛应用源 | `deploy/fnos/repository/fnpack.json` · `apps.mmh.desc` + `i18n.zh-CN/en-US/ja-JP.desc` | **纯简介**（无 `【本版更新】` 段）：中/英/日正典各一份 |
| 5 | 软仓 VPS 种子 | `deploy/fnos/selfhosted-source/data/fn-appstores.json` · `_manual.desc` | 同 #1（该目录被 `.gitignore` 忽略，但 `deploy.sh` 会把它推到 VPS 作种子） |
| 6 | 群晖套件中心「说明」（**未安装**时，及「套件来源」列表） | `deploy/fnstore/app/app.py` · `description.chs/cht/enu` | 群晖渲染版（`<br>` + `【】`） |
| 6b | 群晖套件中心「说明」（**已安装**后，用户实际看到的那一页） | `scripts/build-synology-package.cjs` · `writeInfoFile()` 的 `description="…"` | 同一份简介压成**单行**：INFO 是 shell 键值对，值不能跨行。**改这一行必须重出 SPK 才生效**，服务端 `app.py` 改了也不会影响已安装套件的说明 |
| 7 | README「各版本软件简介」 | `README.md` | 中文正典 + 安装形态对照表 |
| 8 | 软仓 VPS 线上文件 | `/opt/fn-appstores-server/data/fn-appstores.json` · `_manual.desc` | 手工同步（见下） |

> Windows / Docker 没有应用商店页，用户在 **GitHub Release 页面** 与 README 上读简介：以 README 为准，Release 说明引用同一段。

## 同步步骤（改完仓库 ≠ 上线）

1. 先改本文档（正典），再改上面 8 处。
2. 仓库 4 个 JSON（#1–#3、#5）+ FnDepot `fnpack.json`（#4）改完，用 `JSON.parse` / `python -c "import json;json.load(open(...))"` 逐个验合法性（`api/apps` 是无扩展名 JSON，也要验）。
3. 群晖：把 `app.py` **就地覆盖**到 fnVPS 的 `/opt/fn-appstores-server/app.py`（`cat new > old`，别用 `install`/`mv`——会换 inode，容器继续读旧内容），然后 `docker restart mmh-fnstore-admin`。
4. 软仓 VPS：改 `/opt/fn-appstores-server/data/fn-appstores.json` 的简介正文，再 `docker restart fn-appstores-server` **和** `docker restart mmh-fnstore-admin`（5660 Go 版有 app 列表缓存，5661 的 app 列表缓存 TTL 是 24 小时）。`changelog_short` 与「本版更新」段由 `sync.sh` 自动滚动，不用手工。
5. 提交并推送 `main`：FnDepot 仓库靠 hourly cron 镜像本仓库的 `fnpack.json`，平台每天 UTC+8 00:00 读一次；必要时用 `fnos-fndepot-sync.yml` 的 workflow_dispatch 立即触发镜像。
6. 验证：
   - 软仓：`curl -s http://fnapp.floatingice.win/api/apps` → `desc` 是**一整行**（`【本版更新】…<br><br>【软件简介】` + 统一正文，**不含真实 `\n`**）；客户端详情页应**不显示**「更新内容」面板，文案只在「应用介绍」出现一次；
   - 群晖：`curl 'https://synology.floatingice.win/?arch=x86_64&build=64570&language=chs'` → 条目的 `desc` 是 6 行；
   - FnDepot：`gh api repos/frankluise5220/FnDepot/contents/fnpack.json --jq '.content' | base64 -d` → `apps.mmh.desc` 与 `i18n.*.desc` 是统一正文。

## 纪律

1. **简介字段只放简介**：不带版本号、不带 `v<ver> 更新：` 前缀、不写本版功能清单。版本信息只进更新说明字段（`mmhFnosManifestChangelog` / 派生 `changelog_short` / `changelog` / `releases[].changelog` / `mmhReleaseNotes`）。唯一例外是软仓 `desc`——客户端只认它，所以把更新说明也写进这一段（`【本版更新】…<br><br>【软件简介】…`，**一整行**），让它在页面上只出现一次（见 `deploy/fnos/app-intro.md`）。
2. **功能宣称必须能在代码库验证**（`prisma/schema.prisma` 的 model 列表 + `(sidebar)` 路由 + README 功能模块表是权威来源）。**无预算、无语音记账、无日历记账**，勿仿照 88jizhang.com 文案照搬。
3. **长度按这一份定，别再膨胀**：中文正典约 400 字。软仓把「更新说明 + 简介」挤在同一个 `desc` 里（一整行），写长了「应用介绍」会变成一堵墙；要加内容先删旧内容。
4. **三语口径一致**：英/日不是机翻，是同一份文案的对应版本；没有译文时回落中文，别放空字符串。
