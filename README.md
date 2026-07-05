# MoneyMoneyHome

<p align="center">
  <a href="#中文版">中文版</a>
  ·
  <a href="#english">English</a>
  ·
  <a href="#日本語">日本語</a>
</p>

## 中文版

哦嘛呢嘛呢吽。把家庭财务安放好的本地化智能系统。

MoneyMoneyHome（MMH）是一个面向家庭和个人的自托管财务工作台。它以本地数据安全存储为基础，把日常记账、资产负债、房贷还款、基金定投、保险保单、邮箱账单 AI 识别和多端接入整合到同一套账簿体系里。

MMH 不是把家庭账本交给外部平台托管的 SaaS，而是让数据留在你自己的 NAS、服务器或本地 Docker 环境中。

## Highlights

- **本地优先**：适合 NAS / Docker 自托管，数据掌握在自己手里。
- **房贷自动计算**：支持本金、利息、余额、利率调整、提前还款和后续还款计划重算。
- **基金定投自动执行**：按周期生成基金投资任务，关联交易、持仓、净值和收益计算。
- **保险保单管理**：维护保险产品、保单、缴费计划和投保记录，减少重复录入。
- **邮箱账单 AI 识别**：面向邮箱账单、文本账单和截图账单的结构化识别导入流程。
- **多视图工作台**：账户、信用卡账单、基金、理财、存款、保险、往来款和计划任务统一管理。
- **安全访问边界**：支持 HTTPS 部署、Host 白名单、HttpOnly Cookie、账簿隔离和数据库端口收紧。
- **多语言入口**：界面开始支持中文、英文、日文切换。

## What It Solves

家庭财务数据天然敏感，却又常常分散在银行卡、信用卡、基金平台、贷款合同、保险合同和邮箱账单里。时间一长，最麻烦的不是“记一笔账”，而是：

- 多账户、多资产、多家庭成员之间缺少统一口径。
- 房贷、利率调整、提前还款、保险缴费、基金定投很难长期追踪。
- 普通记账工具能录入流水，但不能形成完整资产负债视图。
- 外部云平台方便，但家庭财务数据不一定适合托管出去。

MMH 的目标是建立一个可以长期维护的家庭财务底座：日常录入要快，复杂资产要算得清楚，不同界面看到的是同一套数据。

## Core Modules

| Module | Description |
| --- | --- |
| Overview | 家庭资产、负债、现金流和关键指标概览 |
| Accounts | 现金、借记卡、信用卡、电子钱包、存款和投资账户 |
| Credit Bills | 信用卡账单周期、还款日、账单明细和已还状态 |
| Funds | 基金交易、净值缓存、持仓、份额、收益和确认/到账规则 |
| Scheduled Tasks | 基金定投、转账、还贷款、保险缴费等周期任务 |
| Loans & Debts | 借入借出、房贷计划、利率调整、提前还款和还款明细 |
| Insurance | 保险产品库、保单、投保记录、缴费计划和现金价值 |
| AI Bill Import | 邮箱账单、文本账单、截图账单识别为标准记账数据 |
| Settings | 用户、账簿、账户显示、安全访问、系统更新和 API 设置 |

## Security Model

MMH 面向自托管环境，但远程访问时仍然需要明确的安全边界：

- 推荐通过 HTTPS 反向代理访问。
- 应用支持 `MMH_ALLOWED_HOSTS` 限定可访问域名/IP。
- 登录会话 Cookie 使用 `HttpOnly`、`SameSite=Lax`，生产环境默认 `Secure`。
- 数据库默认只绑定本机端口，应用容器通过 Docker 内网访问。
- Prisma Studio 不作为正式功能暴露，因为它绕过应用权限和账簿隔离。
- 业务 API 应通过当前 session 解析账簿上下文，避免跨账簿访问。

更多说明见 [Security Hardening](docs/security-hardening.md)。

## Deployment

MMH 的正式安装与更新以 Docker 预构建镜像为主，适合部署到 NAS 或家用服务器。

```bash
cd ~/mmh
git pull
sudo docker compose pull app
sudo docker compose up -d app
```

完整说明见 [NAS Docker 安装与更新](docs/nas-install-manual.md)。

## Product Direction

- Web 是主要的细致工作台，适合处理复杂表格、资产核对和系统设置。
- 移动端用于日常查看、快速录入和轻量编辑，并共享同一套后端数据语义。
- AI 识别、邮箱账单解析、批量记录、定期计划和多端 API 是长期重点。
- 财务计算应有统一口径，避免同一金额在不同页面出现不同结果。

## English

MoneyMoneyHome is a local-first intelligent finance system for households. It brings daily bookkeeping, assets and liabilities, mortgage repayment, scheduled fund investments, insurance policies, and AI-powered email bill recognition into one durable self-hosted workspace.

Your financial data stays on your own NAS, server, or Docker environment instead of being handed to an external SaaS platform.

## 日本語

MoneyMoneyHome は、家庭のお金を整えるローカルファーストのスマート家計システムです。日々の記帳、資産と負債、住宅ローン返済、投資信託の積立、保険契約、AI によるメール明細認識を、ひとつの自ホスト型ワークスペースにまとめます。

財務データは外部 SaaS に預けるのではなく、自分の NAS、サーバー、または Docker 環境に保存できます。

## Developer Docs

- [Development Docs](docs/development-docs.md)
- [Client API](docs/client-api.md)
- [Agent API](docs/agent-api.md)
- [Android Release](docs/android-release.md)
- [Edit Window Checklist](docs/edit-window-checklist.md)
- [Investment Data Check](docs/check-investment-data.md)
