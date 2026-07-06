# MoneyMoneyHome

<p align="center">
  <a href="#中文">中文</a>
  ·
  <a href="#english">English</a>
  ·
  <a href="#日本語">日本語</a>
</p>

## 中文

### 产品定位

MoneyMoneyHome（MMH）是一个面向家庭和个人的本地优先智能财务系统。它把日常记账、账户资产、信用卡账单、基金投资、保险保单、房贷还款、往来款、计划任务、邮箱账单识别和多端 API 接入放进同一套可长期维护的家庭财务工作台。

MMH 不是把家庭账本交给外部平台托管的 SaaS。它更适合部署在自己的 NAS、家庭服务器或本地 Docker 环境中，让敏感财务数据留在自己掌握的地方。

### 核心能力

- **本地优先与自托管**：支持 Docker / NAS 部署，日常数据保存在自己的环境中。
- **完整账户视图**：统一管理现金、借记卡、信用卡、电子钱包、存款、基金、理财、保险和往来款。
- **信用卡账单管理**：支持账单日、还款日、交易日、入账日、账单期和还款状态。
- **基金投资工作流**：支持基金交易、净值缓存、持仓重算、确认日、到账日、定投计划和收益统计。
- **保险与保单管理**：维护保险产品、保单、投保记录、缴费计划、现金价值和保险概览。
- **计划任务自动化**：可处理基金定投、转账、还贷款、保险缴费等周期性任务。
- **AI 账单识别导入**：面向邮箱账单、文本账单、PDF 账单和截图账单，识别后进入可预览、可编辑、可批量导入的流程。
- **多端统一语义**：Web 是主要工作台，移动端和开放 API 共享同一套数据含义与计算口径。

### 它解决什么问题

家庭财务数据通常分散在银行卡、信用卡、基金平台、贷款合同、保险合同、邮箱账单和手工表格里。时间久了，最麻烦的并不是记一笔账，而是保持统一口径：

- 多账户、多家庭成员、多机构之间缺少统一资产视图。
- 信用卡账单、基金定投、房贷、保险缴费和往来款很难长期追踪。
- 普通记账工具可以录入流水，但很难稳定维护持仓、账单期、净值、还款计划和保单计划。
- 外部云平台虽然方便，但家庭财务数据不一定适合托管出去。

MMH 的目标是建立一个可以长期维护的家庭财务底座：高频录入要快，复杂资产要算得清楚，同一笔数据在不同页面和客户端看到的含义一致。

### 核心模块

| 模块 | 说明 |
| --- | --- |
| 概览 | 汇总日常账户、信用卡、投资、保险、往来款和关键指标。 |
| 账户 | 管理现金、借记卡、电子钱包、存款、投资账户和账户归属。 |
| 信用卡 | 维护信用卡账户、账单周期、交易明细、入账日期和还款记录。 |
| 投资基金 | 管理基金交易、净值缓存、持仓、份额、成本、收益和确认/到账规则。 |
| 保险 | 维护保险产品、保单、投保记录、缴费计划、现金价值和保险概览。 |
| 往来款 | 跟踪代付、借入、借出、还款和与往来对象相关的余额结果。 |
| 计划任务 | 管理定投、还款、转账、缴费等周期任务，减少重复录入。 |
| AI 导入 | 从邮箱、文本、PDF 或截图中识别账单，预览后批量写入标准记录。 |
| 系统设置 | 管理账簿、用户、账户、机构、往来对象、分类、标签、邮箱、AI 模型、显示和系统更新。 |

### 安全模型

MMH 面向自托管环境，但远程访问时仍需要明确的安全边界：

- 推荐通过 HTTPS 反向代理访问。
- 可使用 `MMH_ALLOWED_HOSTS` 限定允许访问的域名或 IP。
- 登录会话 Cookie 使用 `HttpOnly`、`SameSite=Lax`，生产环境默认 `Secure`。
- 数据库端口应只暴露给应用容器或本机网络。
- Prisma Studio 不作为正式功能暴露，因为它绕过应用权限和账簿隔离。
- 业务 API 应通过当前 session 解析账簿、用户和角色上下文，避免跨账簿访问。

更多说明见 [Security Hardening](docs/security-hardening.md)。

### 部署与更新

MMH 的 NAS 版本以 Docker 预构建镜像为主。日常更新流程应保持简单，并避免在低功耗 NAS 上反复构建应用：

```bash
cd ~/mmh
git pull
sudo docker compose pull app
sudo docker compose up -d app
```

完整说明见 [NAS Docker 安装与更新](docs/nas-install-manual.md)。

### 产品方向

- Web 是主要的细致工作台，负责复杂表格、资产核对、批量导入和系统设置。
- 移动端负责日常查看、快速录入、摘要浏览和轻量编辑。
- AI 识别、邮箱账单解析、批量记录、定期计划和开放 API 是长期重点能力。
- 财务计算、日期归属、金额正负、涨跌颜色、账户选择和基金计算应保持统一口径。
- 产品界面应紧凑、清晰、稳定，适合大量数字和大量记录的长期维护。

## English

### Product Positioning

MoneyMoneyHome (MMH) is a local-first intelligent finance system for households and individuals. It brings daily bookkeeping, account assets, credit card bills, fund investments, insurance policies, mortgage repayment, settlements, scheduled tasks, email bill recognition, and multi-client APIs into one durable household finance workspace.

MMH is not a SaaS product that asks you to hand your family ledger to an external platform. It is designed for your own NAS, home server, or local Docker environment, so sensitive financial data can stay under your control.

### Highlights

- **Local-first and self-hosted**: Run it with Docker on a NAS or home server while keeping daily data in your own environment.
- **Complete account view**: Manage cash, debit cards, credit cards, e-wallets, deposits, funds, wealth products, insurance, and settlements together.
- **Credit card bill management**: Track statement dates, due dates, transaction dates, posting dates, statement months, and repayment status.
- **Fund investment workflow**: Handle fund transactions, NAV cache, holding recalculation, confirmation dates, arrival dates, recurring investment plans, and return statistics.
- **Insurance and policy management**: Maintain insurance products, policies, purchase records, payment plans, cash value, and insurance overviews.
- **Scheduled automation**: Run recurring tasks such as fund investments, transfers, loan repayment, and insurance premium payments.
- **AI bill recognition and import**: Recognize email bills, text bills, PDF statements, and screenshots, then review, edit, and batch import structured records.
- **Unified meaning across clients**: The Web app is the main workspace, while mobile apps and open APIs share the same data meaning and calculation rules.

### What It Solves

Household finance data is often scattered across bank cards, credit cards, fund platforms, loan contracts, insurance contracts, email statements, and manual spreadsheets. Over time, the hard part is not simply recording one transaction. The hard part is keeping everything consistent:

- Multiple accounts, family members, and institutions need one coherent asset view.
- Credit card statements, recurring fund investments, mortgages, insurance payments, and settlements are difficult to track over the long term.
- Common bookkeeping tools can record cash flow, but they often cannot maintain holdings, statement periods, NAV data, repayment schedules, and policy plans consistently.
- Cloud services are convenient, but sensitive household finance data may not be suitable for external hosting.

MMH aims to become a long-term household finance foundation: frequent entry should be fast, complex assets should be calculated clearly, and the same data should carry the same meaning across pages and clients.

### Core Modules

| Module | Description |
| --- | --- |
| Overview | Summarizes daily accounts, credit cards, investments, insurance, settlements, and key indicators. |
| Accounts | Manages cash, debit cards, e-wallets, deposits, investment accounts, and ownership. |
| Credit Cards | Maintains credit card accounts, statement cycles, transaction details, posting dates, and repayments. |
| Fund Investments | Manages fund transactions, NAV cache, holdings, units, cost, returns, and confirmation/arrival rules. |
| Insurance | Maintains insurance products, policies, purchase records, payment plans, cash value, and insurance summaries. |
| Settlements | Tracks advance payments, borrowing, lending, repayment, and balances related to counterparties. |
| Scheduled Tasks | Manages recurring investments, repayments, transfers, and payments to reduce repeated entry. |
| AI Import | Recognizes bills from email, text, PDF, or screenshots, then imports reviewed records in batches. |
| System Settings | Manages ledgers, users, accounts, institutions, counterparties, categories, tags, email accounts, AI models, display, and updates. |

### Security Model

MMH is built for self-hosted environments, but remote access still needs clear security boundaries:

- HTTPS reverse proxy access is recommended.
- `MMH_ALLOWED_HOSTS` can restrict allowed domains or IP addresses.
- Login session cookies use `HttpOnly` and `SameSite=Lax`, with `Secure` enabled by default in production.
- Database ports should only be exposed to the app container or local network.
- Prisma Studio is not exposed as a production feature because it bypasses application permissions and ledger isolation.
- Business APIs should resolve ledger, user, and role context from the current session to avoid cross-ledger access.

See [Security Hardening](docs/security-hardening.md) for details.

### Deployment And Updates

The NAS version of MMH is designed to use prebuilt Docker images. Routine updates should stay simple and avoid repeated application builds on low-power NAS hardware:

```bash
cd ~/mmh
git pull
sudo docker compose pull app
sudo docker compose up -d app
```

See [NAS Docker Install And Update](docs/nas-install-manual.md) for the full guide.

### Product Direction

- Web is the primary detailed workspace for complex tables, asset reconciliation, batch import, and system settings.
- Mobile apps focus on daily viewing, quick entry, summary browsing, and lightweight edits.
- AI recognition, email bill parsing, batch record creation, recurring tasks, and open APIs are long-term strategic capabilities.
- Financial calculations, date ownership, amount signs, gain/loss colors, account selection, and fund calculations should follow one consistent rule set.
- The interface should be dense, clear, and stable enough for long-term maintenance of many numbers and records.

## 日本語

### 製品の位置づけ

MoneyMoneyHome（MMH）は、家庭と個人のためのローカルファーストなスマート財務システムです。日々の記帳、口座資産、クレジットカード明細、投資信託、保険契約、住宅ローン返済、立替・貸借、予定タスク、メール明細認識、複数クライアント向け API を、長く使える家庭向け財務ワークスペースにまとめます。

MMH は、家庭の帳簿を外部プラットフォームに預ける SaaS ではありません。自分の NAS、家庭サーバー、またはローカル Docker 環境で動かし、重要な財務データを自分の管理下に置くことを前提にしています。

### 主な機能

- **ローカルファーストと自ホスト**：Docker / NAS で運用でき、日々のデータを自分の環境に保存できます。
- **完全な口座ビュー**：現金、デビットカード、クレジットカード、電子ウォレット、預金、投資信託、理財商品、保険、立替・貸借をまとめて管理します。
- **クレジットカード明細管理**：締め日、支払日、取引日、入金日、明細月、返済状態を追跡できます。
- **投資信託ワークフロー**：取引、基準価額キャッシュ、保有再計算、約定日、入金日、積立計画、損益統計を扱います。
- **保険と契約管理**：保険商品、契約、加入記録、支払計画、解約返戻金、保険サマリーを管理します。
- **予定タスクの自動化**：積立、振替、ローン返済、保険料支払いなどの定期処理を扱います。
- **AI 明細認識と取込**：メール明細、テキスト明細、PDF 明細、スクリーンショットを認識し、確認、編集、一括取込の流れに進めます。
- **複数クライアントで同じ意味**：Web を主な作業台とし、モバイルアプリと公開 API は同じデータ意味と計算ルールを共有します。

### 解決する課題

家庭の財務データは、銀行カード、クレジットカード、投資信託プラットフォーム、ローン契約、保険契約、メール明細、手作業の表に分散しがちです。時間がたつほど難しくなるのは、単に一件の取引を記録することではなく、全体の口径をそろえることです。

- 複数の口座、家族メンバー、金融機関をまたいだ統一的な資産ビューが必要です。
- クレジットカード明細、積立投資、住宅ローン、保険料支払い、立替・貸借は長期的に追跡しにくいものです。
- 一般的な家計簿ツールは入出金を記録できますが、保有、明細期間、基準価額、返済計画、保険計画まで一貫して管理するのは難しい場合があります。
- クラウドサービスは便利ですが、家庭の重要な財務データを外部に預けることが常に適切とは限りません。

MMH の目標は、長く維持できる家庭財務の土台を作ることです。よく使う入力は速く、複雑な資産は明確に計算され、同じデータはどの画面やクライアントでも同じ意味を持つべきです。

### コアモジュール

| モジュール | 説明 |
| --- | --- |
| 概要 | 日常口座、クレジットカード、投資、保険、立替・貸借、主要指標を集計します。 |
| 口座 | 現金、デビットカード、電子ウォレット、預金、投資口座、所有者を管理します。 |
| クレジットカード | カード口座、明細周期、取引明細、入金日、返済記録を管理します。 |
| 投資信託 | 取引、基準価額キャッシュ、保有、口数、コスト、損益、約定/入金ルールを管理します。 |
| 保険 | 保険商品、契約、加入記録、支払計画、解約返戻金、保険サマリーを管理します。 |
| 立替・貸借 | 立替払い、借入、貸付、返済、取引先に関係する残高を追跡します。 |
| 予定タスク | 積立、返済、振替、支払いなどの定期処理を管理し、繰り返し入力を減らします。 |
| AI 取込 | メール、テキスト、PDF、スクリーンショットから明細を認識し、確認後にまとめて取り込みます。 |
| システム設定 | 帳簿、ユーザー、口座、金融機関、取引先、カテゴリ、タグ、メールアカウント、AI モデル、表示、更新を管理します。 |

### セキュリティモデル

MMH は自ホスト環境向けですが、リモートアクセスには明確な安全境界が必要です。

- HTTPS リバースプロキシ経由のアクセスを推奨します。
- `MMH_ALLOWED_HOSTS` で許可するドメインまたは IP を制限できます。
- ログインセッション Cookie は `HttpOnly`、`SameSite=Lax` を使い、本番環境では既定で `Secure` になります。
- データベースポートはアプリコンテナまたはローカルネットワークにだけ公開するべきです。
- Prisma Studio はアプリ権限と帳簿分離を迂回するため、本番機能として公開しません。
- 業務 API は現在の session から帳簿、ユーザー、ロールの文脈を解決し、帳簿をまたぐアクセスを防ぐべきです。

詳細は [Security Hardening](docs/security-hardening.md) を参照してください。

### デプロイと更新

MMH の NAS 版は、事前ビルド済み Docker イメージを使う方針です。日常更新は簡単に保ち、低消費電力 NAS 上でアプリを繰り返しビルドしないようにします。

```bash
cd ~/mmh
git pull
sudo docker compose pull app
sudo docker compose up -d app
```

詳しくは [NAS Docker インストールと更新](docs/nas-install-manual.md) を参照してください。

### 製品方針

- Web は、複雑な表、資産照合、一括取込、システム設定を扱う主要な詳細ワークスペースです。
- モバイルアプリは、日常確認、素早い入力、サマリー閲覧、軽い編集に重点を置きます。
- AI 認識、メール明細解析、一括記録、予定タスク、公開 API は長期的に重要な機能です。
- 財務計算、日付の帰属、金額の符号、損益色、口座選択、基金計算は一つの統一ルールに従うべきです。
- 画面は、大量の数字と記録を長期管理できるよう、密度が高く、明確で、安定しているべきです。

## Developer Docs

- [Development Docs](docs/development-docs.md)
- [Client API](docs/client-api.md)
- [Agent API](docs/agent-api.md)
- [Android Release](docs/android-release.md)
- [Edit Window Checklist](docs/edit-window-checklist.md)
- [Investment Data Check](docs/check-investment-data.md)
