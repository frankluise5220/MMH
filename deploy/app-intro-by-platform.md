# 软件简介（正典：全渠道同一份正文）

**软件简介 ≠ 更新说明。**

- **软件简介**：对整个软件做整体介绍——它是什么、装在哪、数据存在哪、能做什么。跨版本基本稳定，只在出现重要模块（如新增债券、报销差旅）时调整。
- **更新说明**：「从旧版到新版」的功能更新与 Bug 修复清单，每个版本重写。

两者不许互相顶替：简介里不许出现 `v<ver> 更新：` 前缀和本版变化，更新说明里也不重复整篇简介。分工与落点见 `.skill/mmh-release/references/update-notes-surfaces.md` §2.5。

## 一份正文，全渠道共用

- **不再「各平台各写各的」**：旧的三条规则（只讲本平台的安装形态 / 末尾点名其它版本 / 每平台一份）**作废**。理由：同一个软件在飞牛软仓、FnDepot、群晖套件中心、README 上出现四种措辞，维护要改五份还容易漂移；用户在不同渠道看到的介绍不一致。
- **只有一份中性正文**：不点名安装形态（说「你自己的设备或 NAS」而不是「飞牛原生应用包」），末尾一次列全五个版本（飞牛 fnOS / 群晖 DSM / Windows / Docker / Android）。
- **各渠道只做渲染适配，不改字**：
  - 单行载体（软仓 `desc` 的简介段、FnDepot `desc` / `i18n.*.desc`、`apps.example.json` / `api/apps` 的字段）：直接用下面的正典。
  - **群晖套件中心**：同一份正典，在五个段首词（`记账：`/`资产：`/`功能：`/`多端：`/`版本：`）前各插一个 `▌` 和四个全角空格，用来分段——DSM 这块是纯文本面板，换行语法完全不可用。
  - **README**：用同一份口径复述（长文叙述 + 安装形态对照表），不另写一份商店简介。
- 群晖的「版本：」行会列出「群晖 DSM」自己——这是统一正文的刻意结果，**不要为它开例外**、也不要给它单独写一份。

### 中文正典（单行 · 改简介只改这一段）

MMH 家庭记账与全资产管理，本地优先，程序和账本数据只保存在你自己的设备或 NAS 上，不经过第三方云端。记账：支出、收入、转账、代付、借贷与还款，多账本、多币种、分类标签与成员。资产：信用卡分期、房贷重算、基金定投、股票盈亏、存款理财、房产保险。功能：报表对账、周期自动记账、导入导出、AI 识别、附件、撤销恢复与备份。多端：PC、手机浏览器、Windows、Android 与开放 API。版本：飞牛 fnOS、群晖 DSM、Windows、Docker、Android。

### English（FnDepot `i18n.en-US.desc` / 群晖 `enu` 的正文）

MMH is a local-first home bookkeeping and full asset-management tool; the app and your ledger data stay on your own device or NAS, never through a third-party cloud. Bookkeeping: expenses, income, transfers, advances, borrowing and repayments, with multiple books, currencies, categories, tags and members. Assets: credit-card instalments, mortgage recalculation, fund regular investing, stock profit and loss, deposits, wealth products, property and insurance. Features: reports and reconciliation, scheduled entries, import and export, AI recognition, attachments, undo and backups. Clients: PC and mobile browsers, Windows, Android and an open API. Packages: Feiniu fnOS, Synology DSM, Windows, Docker and Android.

### 日本語（FnDepot `i18n.ja-JP.desc`）

MMH はローカルファーストの家計・資産管理ツールです。アプリと帳簿データは自分のデバイスまたは NAS にのみ保存され、第三者クラウドを経由しません。記帳：支出・収入・振替・立替・借入・貸出・返済、複数帳簿・多通貨・カテゴリ・タグ・メンバー。資産：カード分割払い、ローンの返済再計算、投資信託の積立、株式の保有損益、預金、理財商品、不動産、保険。機能：レポートと残高照合、定期自動記帳、取込と書出、AI 認識、添付、取消と復元、バックアップ。多端：PC・モバイルブラウザ、Windows、Android、オープン API。各版：飛牛 fnOS、Synology DSM、Windows、Docker、Android。

## 群晖渲染版（正典 + `▌` 分段）

载体是 `deploy/fnstore/app/app.py` 的 `_synology_catalog()['description']`，按 DSM 语言分 `chs` / `cht` / `enu`。**套件中心把这串文字当纯文本渲染，没有可用的换行语法**：写 `\n` 会被折叠成一个空格（旧正文本来就带 5 个 `\n`，屏幕上仍连成一整段），写 `<br>` 会被转义并原样显示成字面量 `<br>`（2026-10-24 两次截图实测）。群晖源的包对象只有 `desc` 一个说明字段（没有 `description`），SynoCommunity 的 38 个包 `desc` 也全是单行、零换行——主流第三方源同样放弃了这个位置分行。

所以群晖版 = **正典原文一字不改**，只在五个段首词前插入 `四个全角空格 + ▌`（U+3000 不会被折叠）。整串 240 字左右，每段 25～45 字；再长整块又会读成一堵墙（2026-10-24 连缩两版后定稿，此前正典约 400 字）。

```
MMH 家庭记账与全资产管理，本地优先，程序和账本数据只保存在你自己的设备或 NAS 上，不经过第三方云端。　　▌记账：支出、收入、转账、代付、借贷与还款，多账本、多币种、分类标签与成员。　　▌资产：信用卡分期、房贷重算、基金定投、股票盈亏、存款理财、房产保险。　　▌功能：报表对账、周期自动记账、导入导出、AI 识别、附件、撤销恢复与备份。　　▌多端：PC、手机浏览器、Windows、Android 与开放 API。　　▌版本：飞牛 fnOS、群晖 DSM、Windows、Docker、Android。
```

- `cht`：繁体正典（`記賬/資產/功能/多端/版本`）加同样的标记，见 `app.py`。
- `enu`：英文正典加 `Bookkeeping: / Assets: / Features: / Clients: / Packages:` 前的标记。

「新增功能」（`changelog`）是**另一个渲染区，按 HTML 渲染**：`<br/>` 生效，官方套件在这里还用了 `<b>` 小标题和有序列表；SynoCommunity 的 38 个包里有 13 个正是用 `1. …<br/>2. …` 断行的（2026-10-24 抓源确认）。所以 `app.py` 的 `_synology_plain_changelog()` 会按分号拆条，把「修复…」开头的条目归到 `<b>问题修复</b>`、其余归 `<b>功能更新</b>`，两组各自编号并用 `<br/>` 连接（官方套件同样是加粗小标题 + 有序列表）。不要把「说明」区和「新增功能」区的排版手段混用：前者纯文本，后者 HTML。

## 落点表（改简介要动的地方，一个都不能漏）

| # | 载体 | 文件 · 字段 | 内容 |
| --- | --- | --- | --- |
| 1 | 软仓主清单 | `fn-appstores.json` · `_manual.desc` | `【本版更新】…<br><br>【软件简介】` + 中文正典（**一整行，无真实 `\n`**） |
| 2 | 软仓静态源 | `deploy/fnos/repository/api/apps` · `data[].desc` | 同上（GitHub raw 静态应用源） |
| 3 | 软仓字段草案 | `deploy/fnos/repository/apps.example.json` · `apps[].description` | 同上 |
| 4 | FnDepot / 飞牛应用源 | `deploy/fnos/repository/fnpack.json` · `apps.mmh.desc` + `i18n.zh-CN/en-US/ja-JP.desc` | **纯简介**（无 `【本版更新】` 段）：中/英/日正典各一份 |
| 5 | 软仓 VPS 种子 | `deploy/fnos/selfhosted-source/data/fn-appstores.json` · `_manual.desc` | 同 #1（该目录被 `.gitignore` 忽略，但 `deploy.sh` 会把它推到 VPS 作种子） |
| 6 | 群晖套件中心「说明」（**未安装**时，及「套件来源」列表） | `deploy/fnstore/app/app.py` · `description.chs/cht/enu` | 群晖渲染版（正典 + `▌` + 四个全角空格） |
| 6b | 群晖套件中心「说明」（**已安装**后，用户实际看到的那一页） | `scripts/build-synology-package.cjs` · `writeInfoFile()` 的 `description="…"` | 同一份中文正典压成**单行**（INFO 是 shell 键值对，值不能跨行）。**改这一行必须重出 SPK 才生效**，服务端 `app.py` 改了也不会影响已安装套件的说明 |
| 7 | README | `README.md` | 同一份口径的叙述 + 安装形态对照表（无独立「商店简介」章节，不必逐字复制） |
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
   - 群晖：`curl 'https://synology.floatingice.win/?arch=x86_64&build=64570&language=chs'` → 条目的 `desc` 是**单行**、含 5 个 `▌`、不含 `\n` 和 `<br>`；
   - FnDepot：`gh api repos/frankluise5220/FnDepot/contents/fnpack.json --jq '.content' | base64 -d` → `apps.mmh.desc` 与 `i18n.*.desc` 是统一正文。

## 纪律

1. **简介字段只放简介**：不带版本号、不带 `v<ver> 更新：` 前缀、不写本版功能清单。版本信息只进更新说明字段（`mmhFnosManifestChangelog` / 派生 `changelog_short` / `changelog` / `releases[].changelog` / `mmhReleaseNotes`）。唯一例外是软仓 `desc`——客户端只认它，所以把更新说明也写进这一段（`【本版更新】…<br><br>【软件简介】…`，**一整行**），让它在页面上只出现一次（见 `deploy/fnos/app-intro.md`）。
2. **功能宣称必须能在代码库验证**（`prisma/schema.prisma` 的 model 列表 + `(sidebar)` 路由 + README 功能模块表是权威来源）。**无预算、无语音记账、无日历记账**，勿仿照 88jizhang.com 文案照搬。
3. **长度按这一份定，别再膨胀**：中文正典约 240 字（2026-10-24 由 400 字连缩两版）。软仓把「更新说明 + 简介」挤在同一个 `desc` 里（一整行），写长了「应用介绍」会变成一堵墙；要加内容先删旧内容。
4. **三语口径一致**：英/日不是机翻，是同一份文案的对应版本；没有译文时回落中文，别放空字符串。
