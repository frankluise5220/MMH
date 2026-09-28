# MMH 应用介绍（软仓 desc 规范文案）

本文案是飞牛软仓各处 `desc`/`description` 字段的规范来源。修改介绍时先改这里，再同步到下列 5 个位置，保持一致。

## 中文（主文案，飞牛软仓详情页）

MMH 家庭财务工作台（MoneyMoneyHome）是一个本地优先的家庭记账与全资产管理工具：程序和账本数据全部保存在你自己的飞牛 NAS 上，不经过第三方云端。支持 PC 与手机浏览器、Windows 桌面端、Android App 和开放 API 多端访问，支持多账本、多成员各自登录记账。
日常记账覆盖支出、收入、转账，以及代付、借入、借出、还款等往来款场景；支持多币种与汇率换算、二级收支分类、标签、机构、家庭成员和往来对象管理。
资产与负债可放进同一套账长期维护：信用卡账单周期、入账日期与分期计划；房贷等贷款的还款计划、LPR 利率调整、提前还款与还款重算；基金净值、持仓成本、确认到账与定投计划；股票买卖、分红、费用与持仓盈亏；存款与债券的产品 / 债单、存单、计息及收益记录；理财与贵金属；房产等固定资产的估值、装修投入与抵押关联；保险保单、缴费计划与现金价值。
同时提供统计报表与余额校准对账、周期计划任务自动入账、账单导入导出（支付宝/微信 Excel、财智8 明细转换、邮箱/文本/PDF/截图 AI 识别、标准模板批量导入）、AI 助手（对话记账、查账、批量修改、恢复误删）、流水附件、误操作撤销与删除恢复、手动/自动备份。报销与差旅工作流正在开发中，已提供部分录入、查看和数据结构能力，尚未完工。界面支持中/英/日。适合希望把家庭财务数据掌握在自己手里的个人和家庭。

## English（fnpack.json i18n en-US）

MMH (MoneyMoneyHome) is a local-first home bookkeeping and full asset-management workspace. The app and your ledger data stay on your own Feiniu NAS, without a third-party cloud. It supports multiple ledgers and members, PC and mobile browsers, a Windows desktop app, an Android app, and an open API. Daily entries cover expenses, income, transfers, and settlements, with multi-currency, categories, tags, institutions, and family members. Assets and liabilities share one ledger: credit cards and installments; loans; funds and regular investing; stocks, dividends and holding P/L; deposits and bonds with product or bond terms, deposit lots, interest schedules and returns; wealth products and precious metals; property and insurance. Reports, balance reconciliation, scheduled entries, bill imports, AI recognition and assistant workflows, attachments, undo/restore, and manual/automatic backups are also available. Reimbursement and travel workflows are under development; some entry and viewing capabilities are available, but the workflow is not complete.

## 日本語（fnpack.json i18n ja-JP）

MMH（MoneyMoneyHome）は、ローカルファーストの家庭向け家計・資産管理ワークスペースです。アプリと帳簿データは自分の Feiniu NAS 上に保存され、第三者クラウドを経由しません。複数帳簿・複数メンバーに対応し、PC / モバイルブラウザ、Windows デスクトップアプリ、Android アプリ、オープン API から利用できます。支出・収入・振替、立替・借入・貸付・返済に加え、多通貨、カテゴリ、タグ、金融機関、家族メンバーを管理できます。資産と負債を一つの帳簿で管理し、クレジットカード、ローン、投資信託、株式、預金と債券の商品・債券条件、預金ロット、利息予定と収益、理財商品、貴金属、不動産、保険に対応します。統計レポート、残高照合、定期タスク、帳簿取込、AI 認識とアシスタント、添付ファイル、取り消しと復元、手動 / 自動バックアップも利用できます。精算・出張ワークフローは開発中で、一部の入力・閲覧機能を提供していますが、まだ完成していません。

## 同步位置（改介绍必须 5 处全改）

| 文件 | 字段 | 说明 |
| --- | --- | --- |
| `fn-appstores.json`（根目录） | `_manual.desc` | 主清单，发布校验只查 version/changelog，desc 改动安全 |
| `deploy/fnos/repository/api/apps` | `desc` | GitHub raw 静态应用源（`源地址/api/apps`） |
| `deploy/fnos/repository/apps.example.json` | `description` | 字段草案 |
| `deploy/fnos/repository/fnpack.json` | `apps.mmh.desc` + `i18n.en-US.desc` + `i18n.ja-JP.desc` | 飞牛应用源 manifest，含三语 |
| `deploy/fnos/selfhosted-source/data/fn-appstores.json` | `desc` | 自建 VPS 源数据（仓库内副本） |

## 注意事项

- VPS 自建源（`fnapp.floatingice.win`）的 `desc` 不会被 `sync.sh` 自动更新（sync 只同步 version/图标/FPK）。改完仓库副本后需手动同步到 VPS `/opt/fn-appstores-server/data/fn-appstores.json`，然后 `docker restart fn-appstores-server`（app.py 有 24 小时缓存）。
- 客户端对 `desc` 的换行渲染未验证，文案按"去掉换行也能连读"撰写，段间用 `\n` 分隔属于渐进增强。
- 文案口径以代码库实际功能为准，禁止宣传未实现的能力（如预算、语音记账、日历记账均无，勿仿照 88jizhang 文案照搬）。
