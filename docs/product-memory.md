# Product Memory

This file records repeated product requirements, naming rules, interaction expectations, and display conventions that the user has already clarified multiple times.

Use this file as the first place to check before changing UI wording, account displays, sidebar grouping, edit dialogs, SS dropdowns, insurance/deposit/debt flows, and overview numbers.

Do not use this file for temporary tasks. Put temporary work in `docs/product-todos.md`.

## Purpose

- Reduce repeated clarification loops.
- Preserve user-confirmed product decisions across sessions.
- Keep stable UI and business rules in one human-editable place.

## Memory Rules

- If the user repeats the same product requirement more than once, add or update it here.
- If a previous requirement is superseded, update the old rule instead of keeping two competing versions.
- Prefer concrete product rules over abstract principles.
- Keep entries short, direct, and operational.

## Stable Product Preferences

### General

- Avoid requiring the user to repeat the same requirement across turns.
- Favor direct implementation over long planning once the requirement is clear.
- Keep Web as the dense, detailed primary workspace.
- Shared calculations and display semantics must stay consistent across views.
- 备注、说明、memo、note、remark 这类自由文本字段在表格、表单、导出列、接口示例和新增 schema 字段中默认排在最后；先放身份、类型、金额、日期、状态、分类、机构等结构化业务字段。
- A newly created ledger must guide first-time users through concrete setup actions. The first signed-in workspace should show an inline first-use guide as a full main-content workspace, not a floating/modal guide and not just a thin top bar. Its horizontal axis sits at the top of the main content area, and the guide starts with ledger name, family member/owner name, and automatically created cash/debit/credit accounts, then continues to investment accounts, insurance accounts, settlements, initial balances/holdings, daily entries, and scheduled tasks instead of leaving users to infer the workflow from empty pages.
- The left sidebar should show a persistent "使用向导" entry directly under "报表". It replaces the old top-level "初始数据" entry; initial data remains reachable from inside the guide.
- Clicking the sidebar "使用向导" entry should replace/cover the whole main content area with the guide workspace. First-use guide actions may open setup dialogs or navigate into detail pages, but the guide should never behave like a small one-way popup.
- First-use guide explanations should stay compact. Do not use large repeated "why / what to do / done when" panels that push the working page down; keep the horizontal guide plus one short contextual hint visible above the active workflow.
- In the first-use guide, the money-account step should open the account settings workspace below the guide like the family-member step. Creating a non-investment account from that guide context should also ask for 时间节点 and 余额, then write the same balance-initialization anchor used by the initial-data workflow. Investment accounts are different: the investment step should open the initial-data investment/fund-holding workflow, not the ordinary account create form with balance fields.
- In the first-use guide, the settlements/liabilities step should open a guide-specific workflow, not the ordinary debt overview. It should show a left-side counterparty/person list first, allow creating a counterparty directly when none exists, and only show the "新建往来款" action after a counterparty exists or is selected. The create-flow explanation should teach that users select or create the counterparty first, then save borrow/lend/repay/collect records under that object-owned settlement account.
- In the first-use guide, the final daily-entry step should open the default money account detail table, not the generic overview. Keep the table explanation concise and focused on date, type/category, related account, inflow/outflow direction, and balance. When this step opens the account table, mark the relevant controls with translucent background-color hotspots and show explanations only when the user hovers or focuses those highlighted areas. Cover 收支记账, import/export/balance calibration, sortable/filterable headers, row drag ordering, row selection for batch edit/delete, double-click row editing, row edit actions, and column/header settings. Do not use persistent floating explanation boxes, arrows, or red ellipses, and do not spend guide space on simple pagination controls.
- Feiniu/fnOS distribution has one stable app identity, `appname=mmh`, but Release assets are architecture-specific because the package includes Linux Node runtime and `better-sqlite3` native binaries. Official Releases must publish exactly two fnOS FPK assets: `mmh-x86_64.fpk` and `mmh-arm64.fpk`; do not publish `mmh.fpk`, versioned duplicate FPK files, or separate app IDs such as `mmh-native` or `mmh-arm`. Ordinary NAS installation remains Docker-based. The in-app system update page must distinguish fnOS from Docker/source deployments: fnOS updates are managed by the Feiniu app center or by installing the newer architecture-matched `.fpk`, not by Git pull or Docker image update.
- Feiniu/fnOS package updates must be direct same-app overlay upgrades. A newer architecture-matched `.fpk` with the same `appname=mmh` and higher `version=0.1.x` should be installed over the existing app and trigger the upgrade lifecycle; do not treat uninstall/reinstall as the normal update path. `uninstall_init` may remain only as a data-backup fallback for explicit user uninstall or abnormal recovery.
- Feiniu/fnOS updates must never store or overwrite the user SQLite database inside the app install directory. The package must resolve data to the fnOS persistent app data directory (`TRIM_DATADEST`, `TRIM_PKGVAR/data`, or `/vol*/@appdata/mmh/data`) and only initialize SQLite when the database has no user tables.
- Feiniu/fnOS database upgrades must preserve existing SQLite data without requiring backup restore. Additive schema changes should be idempotent runtime migrations such as `ALTER TABLE ADD COLUMN`; renames, splits, type changes, and table reshapes require explicit migration and backfill logic instead of rebuilding the database or clearing tables.
- Feiniu/fnOS uses SQLite and therefore has no separate database connection password. User-facing "数据库密码" checks for destructive system actions should be backed by the MMH system password (`MMH_SYSTEM_PASSWORD`) on fnOS. The fnOS install/config wizard must allow the user to set this password; leaving it blank generates a random password once and persists it under the fnOS app data directory.
- Public release pushes must cover both distribution paths: GitHub/GHCR for Docker-based NAS users and verified fnOS `.fpk` assets for x86 and ARM64 users. Public versions use one numeric `0.1.x` value from `package.json`; each formal public push/release increments the patch once with `npm run release:version` (`0.1.9` -> `0.1.10` -> `0.1.11`). Use the same version for the GitHub Release tag `v0.1.x`, GHCR image tags, app package version, all fnOS manifests, and fnOS repository metadata; do not publish separate `-fnos` package versions. Do not describe a release as published until the code/image path and both architecture package artifacts are built, version-aligned, and verified.
- Web and Android settings must use the shared settings catalog in `shared/settings/catalog.json` for common grouping, labels, route identity, and preference identity. Web imports it through `src/lib/settings/catalog.ts`; Android includes the same JSON as an asset and may also fetch `/api/v1/settings/catalog`.
- Web system settings pages should share one visual and interaction pattern: table-like master-data pages use a unified page header, primary add button, table shell, row action buttons, and modal create/edit flow; non-table settings use the same section/panel shell instead of each page inventing its own layout.
- User management's login-retention setting means the interval before that user needs to log in again. It does not mean the user's role, admin status, or permission expires.
- Credit-card normal table/account labels should use the configured credit-card table display template only. Do not append owner or account type in the visible label; expose owner and type in the hover title instead.
- Credit-card bill pages and credit-card account detail pages should expose manual Excel workflows through the same compact "导出/入" dropdown menu with "导出模板" and "导入 EXCEL 表"; importing from either credit-card surface should stay on the credit-card page/surface, parse into the credit-card statement preview confirmation window first, and only write records after the user confirms selected rows. It must reuse credit-card statement import semantics instead of navigating to the general batch-import workspace or directly writing parsed Excel rows into an account. Transfer/repayment rows without a matched counter account must be blocked in preview and server import; never write a transfer with an empty counter account.
- Do not generate a dedicated credit-card Excel template. Credit-card surfaces should download the same ordinary bill-record template used by funding accounts. The ordinary template includes 金额 plus optional 流出/流入 columns; examples should keep 金额 positive and use 流出/流入 for direction. Flow columns are recommended but not required: importing files that only have a single 金额 column must remain supported and should fall back to amount sign, 收支大类, and repayment/refund keywords instead of rejecting the file for missing 流出/流入. When importing a credit-card statement-style table, the 账户 column may stay as the unified credit-card account for every row; repayment rows use 类型=转账, leave 分类 blank, put the paying debit-card/wallet in 对向账户, and put the repayment amount in 流入. Credit-card refunds/returns/reversals stay as 支出 rows in the original category and also put the positive refund amount in 流入. The system should infer 信用卡还款 from that direction instead of asking the user to type the category.
- Statement recognition rules should be table-backed first. Generic keyword rules for categories, institutions, and source headers live in the single canonical table `statement_recognition_rules`; examples include 九牧王/班尼路 -> 服饰装饰 and 中国铁路/12306 -> 中国铁路 + 火车高铁. Category rules mean "keyword -> Category tree content", such as 供电 -> 电费 or Deepseek pro plan -> 云服务. Institution rules mean "keyword -> Institution table content": for example keyword 云闪付 may fill the Institution value 银联. Institution matches that do not resolve to a real Institution row should be left blank because the field is optional. User-filled institution edits in import previews or manual transaction edits may learn institution rules; automatic guesses must not. Institution rules must not target abstract category labels such as 教育、药店、医疗、快递 or 会员. User-confirmed category edits write directly into `statement_recognition_rules(targetType="category")`; do not add or continue a second category-only learning table. Learned keywords must be cleaned merchant keywords, not full raw remarks: strip payment-channel prefixes such as `支付宝-` / `微信支付-` / `云闪付-`, and when a company suffix such as `有限公司` appears, strip the suffix and everything after it. Code may keep parsing helpers, but should not be the only durable home for recognition rules.
- Detail views that offer manual Excel import/export should use the same compact "导出/入" dropdown pattern: export current details, export a context-specific template from the current view, choose the external record table, and open email bill import from that same component. Exporting an Excel table must first ask for the range implied by the current view: ordinary detail views use transaction date start/end, while credit-card bill views use bill-period start/end options. CSV export should not be exposed in normal user-facing view menus unless explicitly requested. There should be no ordinary user-facing "账簿导入" page or standalone import guide screen; the old `/batch-import` route may exist only as an internal preview carrier that immediately parses the selected file and shows the confirmation table. The view-level dropdown must not read an Excel file and directly write parsed rows into the database; records are written only after the user confirms the preview.
- Manual statement import entry points should parse and normalize source-specific data first, then hand the adjusted rows to one shared import preview dialog for SS editing, row selection, batch editing, confirmation, and final import. The shared preview should follow the mature email-import `AdvancedDataTable` preview pattern, stay generic for ordinary bills and credit-card-compatible flows, and use the full account SS list for both account and counter-account edits while persisting selections as stable account IDs.
- Manual Excel import should use two product categories, not a separate "credit-card Excel" concept: ordinary cash/debit/credit-card money movement uses one shared "账单记录 Excel" table and one shared preview/import dialog; investment ledgers use separate product-specific transaction Excel tables such as fund transactions and future stock transactions. The existing fund transaction Excel remains an investment-specific import path, separate from ordinary bill records.
- Fund transaction Excel rows that include a 资金账户 must resolve that value to a real cash-side account before import. A supplied but unmatched 资金账户 is a blocking preview/import error, because successful fund import must create the cash-side `TxRecord`, `FundTransactionCashFlow`, and `EntryBusinessLink` instead of leaving the fund transaction unlinked.
- Account IDs are the source of truth for account identity everywhere. Account names must not participate in calculation, filtering, grouping, balance/statistic logic, report logic, export identity, or mobile/API business semantics. Display/export/API labels should derive account labels from `Account` by `accountId`, `toAccountId`, `cashAccountId`, or other account ID fields where available instead of trusting denormalized `accountName` snapshots. Stored name fields such as `TxRecord.accountName` / `toAccountName` and `RegularInvestPlan.accountName` / `cashAccountName` are legacy/import compatibility fields and should be phased out only through a coordinated schema/API/mobile migration.
- Account notes are user-owned freeform text. Store, search, sync, export, restore, and edit them as ordinary account remarks; do not restrict, classify, warn, or judge how the user chooses to use that field. Account create/edit surfaces should render notes as multiline long text rather than a short one-line input.
- Database settings should expose the MMH encrypted restore package (`.mmh-backup`) for backup/recovery and a separate ordinary Excel table export (`.xlsx`) for user-side viewing, checking, and data processing. The Excel table export is not a backup, must not be accepted by restore, and should omit sensitive recovery/credential fields such as password hashes, API keys, encryption keys, and email passwords. Backup export, restore file picker, and restore API validation should use the same `.mmh-backup` extension; do not expose JSON table backup or Prisma Studio entry as normal user-facing settings.
- Backup and restore semantics are state-based: restoring a backup file should return the current ledger to the state captured when that file was exported, including all household-scoped business tables added over time.
- The household restore package is encrypted after the admin has entered the ledger. Exporting a backup and restoring a backup must both verify the current logged-in user's password immediately before the sensitive action, without asking the user to retype their username. Backup export may also accept a separate backup encryption passphrase; when it is omitted, the package uses the current user password as the file-encryption passphrase. Restore is destructive and must verify the current user password before clearing and rewriting the ledger, then use the supplied backup encryption passphrase (or current user password when omitted) to decrypt the file; do not keep restore credentials visible in the main database settings page, and do not also require manually typing a confirmation phrase such as "恢复当前账簿". The package should include keys and sensitive settings needed to restore the saved state, including access keys, AI API keys, invite codes, encryption master keys, legacy backup package encryption keys when present, email accounts, and household-scoped system settings. The backup file itself must be treated as sensitive recovery material and stored safely.
- Backup restore must support realistic household backup sizes beyond Next's default 10MB proxy body limit; the configured restore upload limit is 128MB, and oversized or incomplete uploads should return a clear user-facing error instead of a generic HTTP 500.
- Access whitelist entries are normalized hostnames, and the proxy must enforce them before public/login routes. User-facing entry should accept a hostname, IP, or URL with a port but store only the hostname. Local rescue hosts `localhost`, `127.0.0.1`, and `::1` are always allowed by code and must not be stored or shown as user whitelist entries. A fresh install with no whitelist entries must show the whitelist as disabled, and an empty user list must not be treated as a normal enabled whitelist. When the user turns the whitelist on, the current non-local access host must already be allowed or be visibly added to the list before the switch is saved, so the user does not lock themselves out. Saving or deleting whitelist entries must reject any enabled state where the current non-local access domain/IP is no longer allowed. The whitelist describes the domain/IP the user is visiting, not the client device IP or database server IP; do not reject a request only because Next's internal fallback hostname differs from the real Host/Forwarded/Origin access address.
- System initialization in database settings should require only the database password. Do not ask the user to type "系统初始化" or keep the database password input visible in the main page; open a password verification dialog from the initialization button.
- Ledger invite codes use the same 32-character alphanumeric generation behavior as API Keys; generation happens in the settings UI and the generated value is saved explicitly.

### Encoding And Text

- Treat mojibake as a real defect, not harmless console noise.
- When touching a file that already contains mojibake, clean that file instead of layering more edits onto corrupted text.
- Repository text files must remain UTF-8 with LF.
- In this repo, do not rely on complex PowerShell expressions to inspect or patch source files when a simpler `rg` search, explicit UTF-8 file read, or `apply_patch` edit can do the job more reliably.
- When Chinese text is involved, file content is the source of truth; terminal rendering is not.

### Internationalization

- Chinese, English, and Japanese product descriptions should use the same structure and comparable depth. Do not leave English or Japanese as short summaries when Chinese has the complete explanation.
- Translate system-controlled UI text, including navigation, buttons, table headers, filters, dialogs, empty states, errors, settings labels, and business enum display labels.
- Do not translate user-owned data, including account names, institution names, counterparty names, family member names, custom categories, tags, remarks, imported bill content, and raw statement text.
- Product terms should stay consistent across languages. "往来款" is "Settlements" in English and "立替・貸借" in Japanese. "往来对象" is "Counterparties" in English and "取引先" in Japanese. "计划任务" is "Scheduled Tasks" in English and "予定タスク" in Japanese.
- Language switching should change display text only. It must not rewrite stored business data or user-entered labels.

### Sidebar And Navigation

- Sidebar grouping is a major workflow surface and must be easy to scan.
- Do not redundantly repeat account type labels under account names when the parent group already expresses the type.
- Account lists should stay compact, readable, and scrollable when long.
- Mobile bottom navigation "账户" should expose clear module entries for money accounts, credit cards, insurance, and settlements/liabilities, so users do not need desktop sidebar knowledge or hidden URLs to enter those surfaces.
- Sticky controls such as top-level filters or add buttons should not drift awkwardly with page scroll unless there is a clear workflow reason.
- The user wants stronger grouping control in sidebar views, especially for accounts, institutions, insurance, credit cards, debt, and deposits.
- Grouping and display mode are separate concerns. Do not mix "how accounts are grouped" with "how one account label is rendered".
- When showing grouped account lists, avoid repeating institution names inside child account labels if the parent group already shows the institution.
- Sidebar debt grouping under "往来款" should keep the left navigation compact: show concrete bank loan/settlement accounts directly, and show one "借入借出" summary item that aggregates ordinary counterparty/person/company settlement accounts. Do not list each ordinary settlement object in the left sidebar; the debt page/table should show those concrete objects after entering "借入借出". Do not hardcode names for this layout; derive it from account kind plus counterparty/institution ownership. Cleared zero-balance bank loans should not clutter the debt group by default.
- Ordinary counterparty settlement workflow is object-first: the user selects a `Counterparty`/往来对象 first, and settlement accounts are child accounts under that object. A normal person/company counterparty should not get separate same-name accounts solely because one operation is 借入 and another is 借出; borrow/lend are transaction modes on the object-owned account. Institution/bank loan items may still be represented by concrete loan accounts where the account itself is the managed item.
- Selecting a bank institution such as 招行 as the debt object must not by itself switch the borrow/lend dialog into bank-loan mode or auto-pick a loan account. Bank-loan fields such as repayment method and schedule are shown only after a concrete bank-owned loan account is selected.
- Ordinary counterparty borrow/lend dialogs are not bank-loan dialogs. For `Counterparty`-owned settlement accounts, do not show or save loan-only fields such as 资金到账/消费分期、还款方式、还款周期、期数、利率、LPR 折扣 or historical rate settings. Those fields belong only to bank/institution loan items. Even for bank/institution borrow creation, the ordinary debt modal should not expose a `资金到账/消费分期` toggle; new borrow records created there are cash-disbursed by default, while `消费分期` belongs to the expense/credit-card financed-purchase flow.
- 往来对象/往来账户没有“所有人”这个显示维度。数据库中的账户分组只是账户表必填字段，不应出现在往来账户名称、悬停标题、SS 下拉分组、导入匹配候选、概览或移动同步的显示 groupName 中；例如应显示“甄宋·债务/债权”，不能显示“张四·甄宋·债务/债权”。

### Amount And Color Rules

- Keep sign/color rules unified everywhere.
- 收支统计和收支报表按资金方向着色：收入/流入使用正向颜色，支出/流出使用负向颜色；在红涨绿跌配色下表现为收入红、支出绿，不要因为报表内支出金额以正数存放而显示成红色。
- `TxRecord.amount` is a cash-flow value from the `accountId` side: positive means money flows into `accountId` and increases that account balance; negative means money flows out of `accountId` and decreases that account balance. `type` (`income`, `expense`, `transfer`, etc.) describes business/report classification and must not force the amount sign. For transfer-like records, `toAccountId` is the receiving side and balance logic treats that side as an inflow.
- In transaction create/edit dialogs, the user-facing amount follows the selected business type: for `expense`, positive means an outflow and negative means an inflow/refund, so the dialog converts it to the opposite `TxRecord.amount` sign on save and converts stored cash-flow signs back on edit open. For `income`, positive means inflow and negative means outflow/reversal, matching the stored cash-flow sign.
- Do not compute sidebar balances from income minus expense.
- Insurance cash value belongs to the same family as balance/value displays.
- Coverage amount must be shown separately from cash value/balance, not merged into one ambiguous metric.
- Credit card amounts are liabilities and should follow the unified liability color/sign semantics.
- Transfers from cash/debit/e-wallet accounts into credit card accounts are internal transfers. Store and display them as `type=transfer`, set their category to "信用卡还款", and exclude them from income/expense statistics.
- Batch import must preserve "信用卡还款" as an explicit preview business type while saving it as `type=transfer` with category "信用卡还款". Its payment source is limited to debit-card and e-wallet accounts, and its target is limited to credit-card accounts.
- Bill import has two explicit modes. Regular-bill mode resolves the source and counter account for every row. Credit-card-statement mode uses one shared credit-card account for the whole file; spending/refunds belong to that card, while repayment rows separately select a debit-card or e-wallet source flowing into the shared card.
- Credit card unbilled/current-cycle rows may show cycle expense and refund/income activity, but should not show a bill amount or expose manual bill-amount editing before the statement is generated.
- Credit card billed-cycle rows that have been fully paid should show a clear settled marker in the repayment column, instead of requiring the user to infer settled status from amounts.
- Credit card bill summaries show outflow/inflow by the signed cash-flow amount from the credit-card side, not by transaction major type. Negative card-side amounts count as outflow, positive card-side amounts count as inflow; for a transfer where the credit card is `toAccountId`, invert `TxRecord.amount` to get the card-side signed amount.
- Credit card bill summaries and details must be bounded by the cycle date range. Do not include transactions merely because their `statementMonth` matches a cycle; an incorrect stored `statementMonth` must not override the posting/transaction date window. This applies to both current/unbilled and historical billed cycles.
- Credit card bill amount is a rolling statement amount: previous bill amount plus current-cycle outflow minus current-cycle inflow. It may cross below zero when inflow exceeds the rolling bill; the UI should show that as an overpaid/credit-balance state instead of clamping it to zero. Repayments affect settled status and remaining balance, but must not be mixed with the outflow/inflow column labels.
- Credit card billed-cycle settled status and paid amount should be derived from the next statement cycle's card-side inflow covering the current bill amount. If the next cycle's inflow is greater than or equal to the current cycle's bill amount, the current cycle shows "已还款". The inflow still remains displayed in the next cycle's inflow column.
- Credit card billing day is the first day of the next statement cycle. For example, billing day 10 means the cycle runs from the 10th through the 9th of the next month, and transactions on the 10th belong to the next statement month.
- Manually edited credit-card cycle boundaries are durable database facts on `CreditCardCycle`. Transaction or installment recalculation may refresh amounts and current-cycle flags, but must preserve rows marked as manual cycles instead of deleting them and regenerating dates from `Account.billingDay`.
- Credit card account balance/used amount should show the rolling current card balance: issued current bill amount plus unbilled current-cycle spending minus unbilled current-cycle income/refunds/repayments. In code this is the current credit-card cycle `effectiveBill`; do not use `cumulativeRemain - cumulativeOverpaid` as the general account balance.
- Overview should show a single net debt metric instead of separate gross payable and receivable cards. Net debt is credit-card payable plus settlement/loan payable minus settlement/loan receivable; when the result is positive, label it "净负债", and when negative, label the absolute value "净债权". Gross payable and receivable can remain available in detail views, but the top-level overview should present only the net conclusion.
- In the debt/settlement holding table, bank/institution loan rows should use loan wording instead of ordinary settlement wording: show remaining interest, remaining principal, and total payable amount (`remainingPrincipal + remainingInterest`) in that order, and do not show a separate "往来余额" column for the loan row.
- Credit card summary "refund/income" is the current cycle's inflow display: refunds, income, and transfers into the credit card during that cycle. Credit card repayments still settle the previous bill cycle, whose repayment column should show settled status rather than repeating the paid amount.
- Credit cards may be selected in ordinary transfer account selectors when the user is recording a real transfer involving a credit card. When a credit card is involved, bill calculation still treats the credit-card side by card-side signed amount and statement cycle.
- 信用卡与借记卡共用支出、收入、代付、转账四种记账语义。信用卡支出和收入沿用相同分类及正负方向；信用卡代付属于信用卡转出并进入对应账期；信用卡还款属于借记卡/现金/电子钱包转入信用卡的转账，分类为“信用卡还款”，不计入收支统计。
- 代付窗口金额按用户输入正负表达业务方向：正数表示替往来对象垫付，保存为资金账户流出、往来应收增加；负数表示往来对象返还，保存为往来账户流出、资金账户流入、往来应收减少。两者都保存为 `type=transfer`、`source=advance`，并保留代付分类和往来对象快照。
- 信用卡账单列表和账单周期缓存默认只显示/生成到当前日期所属账期。未来分期还款流水可以保留在明细中，但不能把账单列表延展到未来年份。
- Credit card email bill import should mark mail that has local import history as "已导入", but must still allow the user to preview and import it again. Use mailbox UID, envelope hash, and stable parsed statement fingerprint only for marking and user warning, not as a hard duplicate block.
- Credit card "获取账单" belongs above the bill summary table. Credit-card transaction/bill detail toolbars should not duplicate that button when the bill summary already exposes it.
- Credit card page "获取账单" and Settings > email account "获取账单" must use the same email bill reading, parsing, account-matching, and import channel. The credit-card page may provide a contextual shortcut, but it must not force every parsed row into the currently opened card when statement metadata identifies another card/account.
- Credit-card page "获取账单" should open the same mailbox bill-import workspace used by System Settings > email, presented as a floating workspace over the credit-card view. Do not maintain a separate credit-card-only mail selection, recognition, preview, or import flow.
- Overview credit-card cards must follow bill storage semantics. For cards using consolidated institution billing, show one institution-level summary bill row instead of repeating the same current bill once per card account. The institution-level card title should use the full institution name, such as "招商银行", without adding "汇总账单" or using a short bank nickname.
- Bill import preview amount colors must use the shared color-scheme rule by money direction, not by hardcoded transaction type color. Income is displayed as inflow, expense as outflow; with `red_up_green_down`, expense/outflow is green.
- A credit-card statement's card heading is the account identity for every transaction listed under that heading. Parse the institution, card display name, and last four digits from headings such as "平安银行美国运通耀红卡（2222） 主卡", use them to match the existing credit-card account, and do not silently replace that account with whichever account page opened the mail-import window. If a statement contains multiple primary or supplementary-card headings, apply each heading only to its following transaction block.
- Credit-card statement parsing should prefer bank-specific templates for known bank email formats, registered through one parser template list, then fall back to the generic table/text parser. When a known bank format diverges, add a dedicated bank template instead of widening generic heuristics until they become fragile. Templates must identify the true transaction-detail table and must not treat statement summary rows such as 本期应还款 or 最低应还款 as transactions.
- Known bank spreadsheet parsers must map source table headers to MMH fields through explicit bank/table profiles, require exact required headers and sample transaction-row validation, and fail closed instead of widening generic guesses when required headers are absent or ambiguous. Do not infer money columns from broad labels such as 金额 when the known format has a precise transaction amount header.
- Statement import header learning is a controlled alias-catalog workflow: source table headers such as `后四位`, `入账日期`, `到账日期`, and `商户` map to MMH field names through `statement_recognition_rules` rows with `targetType=field` and `fieldName`. After a real file is confirmed, add observed source headers to this shared field alias table or a bank-specific profile, then keep matching exact normalized headers plus row validation. Do not let runtime fuzzy matching automatically learn from unconfirmed imports.
- Email statement import and Excel/template statement import must share the same post-parse normalization for merchant/institution inference, category candidate matching, amount direction semantics, and refund handling. A same-merchant/same-remark inflow that matches an existing expense should remain an expense-side inflow/refund, not become income, and category matching must not clear a useful inferred category merely because no exact ledger category was found.
- Credit-card statement amount direction must be inferred per file before classifying ordinary signed amounts. Use definite inflow rows as anchors: refunds, reversals, repayments, card credits, and bank credits are credit-card-account inflows. If those anchor rows are negative, then negative means inflow and positive means outflow in that file; if those anchors are positive, then positive means inflow and negative means outflow. Do not hardcode one global signed-amount convention for all banks or templates.
- Credit-card statement parsing must not treat debit/repayment account tails as credit-card tails. Four-digit values near "扣款账号", "还款账号", "自动还款", "借记卡", "储蓄卡", or "Debit Account" are repayment-source account hints, not credit-card identity.
- Credit-card statement amount extraction must ignore points/reward contexts such as 积分, Bonus Point Balance, Points, and Rewards; points balances are not bill amounts.
- Credit card statement import uses the label "入账日期" for posting date. The value should be date-only (`YYYY-MM-DD`), default to the transaction date when missing, and remain editable in the import preview.
- When credit card statement import parses useful statement metadata, use it instead of discarding it: total credit limit updates the matched credit-card account; statement period start/end and exact due date lock the corresponding `CreditCardCycle`; statement amount such as 本期应还、本期应缴余额、本期账单金额, New Balance, or Total Due saves as a `BillOverride` for that statement month. Email bill import previews must visibly show detected statement amount, statement period, due date, and credit limit before import, and show the locked account/month/amount/period/due date after import completes.
- Ordinary transfer records are same-currency only. If two accounts use different currencies, the app should require a dedicated foreign-exchange/cross-currency flow that records both-side amounts and exchange rate instead of silently saving one amount.
- Foreign-exchange/currency-conversion records are not ordinary transfers. They create two single-sided cash-flow rows, one outflow in the source account currency and one inflow in the target account currency, linked by `FxConversion` with both-side amounts and exchange rate. The target foreign-currency balance can then be used by same-currency wealth, deposit, or investment flows; for example JPY bought into a JPY account may buy JPY wealth products, while CNY funds cannot directly buy a JPY product without a conversion first.
- Foreign-exchange/currency-conversion is a standalone capsule-menu operation, not a sub-type inside income, expense, advance, or transfer. Its form order is date, source debit-card account and target account, source currency read from the source account, target currency read from the selected target account or manually selected only when target account is omitted, source amount and exchange rate, fee and target amount, then note. Do not show a swap button in this flow.
- Foreign-exchange entry form display should use the common quote convention for the user-facing preview: show "100 target foreign currency = source currency amount", such as "100 USD = 700.00 CNY". The form's precise rate field must remain manually editable, and should also expose a "获取汇率" button that fills the same field from the shared FX-rate API/cache. Internal storage and calculations may still use the precise target-currency-per-source-currency rate.
- Foreign-exchange source account must be a debit-card account. Foreign-exchange target accounts must be foreign-currency accounts, not CNY accounts. The target side follows the same resolve-or-create rule used by settlement, deposit, wealth, and similar asset flows: after the user chooses the target foreign currency, selecting a target account is optional. If omitted, the server should reuse or create a same-household, same-owner/group, same-institution account in that target currency.
- Each household has one current/base display currency. Account records and transaction records keep their own original currency, while sidebar totals, net worth, and cross-account summaries convert foreign-currency balances into the household base currency through the shared FX-rate resolver. Cached `FxRate` rows are preferred; when no cache exists, the resolver should reuse the latest same-household `FxConversion` rate in either direction before reporting a missing rate.
- Transaction detail rows should keep amount columns compact and single-line. Original transaction currency should be available as a separate table column that users can show or hide through the shared header settings button, especially for non-CNY accounts such as USD or JPY accounts. Base/current-currency equivalents may be shown as clearly labeled converted values, but must not replace or hide the original transaction amount and currency. Sidebar totals, net worth, and cross-account statistics use the household current/base display currency.
- When the user is inside a concrete account page, the page header's primary balance should use that account's original currency. If the account currency differs from the household current/base currency and a cached rate exists, show the converted current-currency equivalent as clearly labeled secondary text such as "折合 ¥...", and show the exact rate plus rate date next to that converted amount. The header rate text can be double-clicked for manual edit, and a nearby "获取汇率" button should refresh that same cached rate through the shared FX-rate API. Do not replace the account's original-currency balance with the converted amount.
- Display settings should expose the household current/base currency selector as a plain dropdown aligned with the interface language dropdown. Do not show a "获取汇率" action, rate table, or manual rate-entry table in display settings; cached rates remain a calculation/data concern and may be managed by explicit refresh actions or currency workflows.
- Missing foreign-exchange rates must be explicit in the UI/API. Do not silently treat a missing rate as 1:1; if the rate is missing after checking both cached rates and historical `FxConversion` rates, omit that foreign-currency amount from converted totals and show which currency still needs a rate. Normal page refresh should avoid slow external FX calls and use cached/local rates; the explicit "获取汇率" action must force-fetch the latest external rate, write a cache row on success, and show an error instead of silently keeping an old displayed rate when external refresh fails.
- Converted account display must use the shared account-currency display resolver. UI code must not use `convertedBalance ?? balance` as a fallback, because that can show an original-currency amount with the household base-currency symbol.
- 普通转账编辑窗口打开时金额永远显示正值，含义是“从转出账户转到转入账户”的业务金额；允许用户输入负值，负值表示把当前表单里的转出/转入方向反过来保存。落库后仍统一为 `accountId` 实际转出方、`toAccountId` 实际转入方、`amount` 为转出方负值。
- 普通转账和往来款的“转出账户/转入账户”选择应允许信用卡账户；涉及信用卡的一侧仍按信用卡账期和卡侧金额规则计算。
- When changing a record between income/expense/advance and transfer in any edit or import-preview flow, preserve the account on the correct cash-flow side: income accounts become transfer target accounts, expense and advance accounts become transfer source accounts, transfer-to-income uses the target account, and transfer-to-expense/advance uses the source account.
- A borrow/lend settlement record with no interest or fee can be converted back to an ordinary transfer. When the edited transfer no longer involves a settlement/loan account, clear `source=debt_*` / `source=advance` and all debt principal/interest/fee fields so the row is no longer treated as 借入借出.
- Insurance cash value should be treated like balance/value; coverage amount should remain a separate non-cash metric.
- Expense entries may use a negative input amount to represent a refund or reduction within the same expense category. Store it as `type=expense` with a positive cash-flow amount, not as income, so category statistics can offset the original expense.
- Bill and AI import should classify original-spend refunds/returns/reversals such as `退款`, `退货`, `退回`, and `冲正` as `type=expense` refunds, not income. Preview may show the amount in the inflow column, and natural-language AI items may use a negative expense amount; both must save as an account-side inflow that offsets the original expense category.
- Credit-card statement/table imports must infer signed amount direction per file before classifying ordinary rows. Use definite card-side inflow anchors such as refunds/returns/reversals, credit-card repayments, and card credits/刷卡金抵扣: if those anchor amounts are negative, negative means card-side inflow and positive means outflow for that file; if those anchor amounts are positive, positive means card-side inflow and negative means outflow. Do not hardcode one global bank sign convention.
- Expense entries may have a separate posting date (`postedAt`) when spending is recorded later than it happened. User-facing labels should say "入账日期", values should be date-only (`YYYY-MM-DD`), and the UI must not expose a `00:00` time. `TxRecord.date` remains the business/occurred date for category statistics and existing detail ordering unless a specific view explicitly switches to posting-date sorting.

### SS Dropdowns

- SS dropdown is a shared system, not a one-off control.
- `SmartSelect` is the shared base for SS dropdown behavior. New SS variants should extend it through parameters or thin adapters instead of forking a separate dropdown UI.
- It should support nested add flows, search, keyboard movement, and owner/group cycling where appropriate.
- Different dropdowns may apply different filtering, but should reuse the same shared component behavior.
- Account-picking dropdowns should follow the established account SS behavior instead of each screen inventing a slightly different selector.
- Account selectors are still part of the same shared SS system. Their extra behavior should be limited to account-specific filtering and one cycle control for owner/group switching.
- Account SS dropdowns should generally support:
  - nested add
  - search
  - keyboard navigation
  - owner/group cycling
  - context-aware filtering
- The account SS experience used in the preferred transaction entry flow is the reference behavior that other account selectors should converge toward.
- Do not add extra always-visible owner header rows above the dropdown body when the cycling control already expresses owner switching.
- Hierarchical SS dropdowns must distinguish display-only headers from selectable groups. Category selectors and category parent selectors should allow real category nodes at any level, including second-level categories and categories with children, to be selected when the caller enables selectable groups.
- In hierarchical category SS dropdowns, when a selectable category with children is expanded or selected, its child category menu should appear as one grouped block directly beneath that parent with a visually distinct background, not mixed into the same grid as sibling categories.
- SS dropdown panels default to the same width as their trigger/input. Callers may explicitly pass a wider `minDropdownWidth` only when a dense table, batch-edit panel, or multi-column selector needs more context.
- Account SS options must keep institution information visible in the dropdown, either in the main label or in the sublabel, even inside compact dialogs.
- Account SS option main labels should include the canonical account identity, such as institution short name plus account name/tail. When the main label already contains the institution, the right-side sublabel must not repeat it; use the sublabel only for owner/group and account type context, such as `墨斗鱼 · 借记卡`.
- When `SmartSelect` is used inside popovers, modals, or batch-edit panels, its portal dropdown must remain scrollable and clickable. Parent outside-click handlers should treat the SmartSelect dropdown portal as part of the active interaction, not as an outside click.

### Date Inputs

- The agreed shared date input is called "步进日期框" in product discussion and `DateStepper` in code.
- A "步进日期框" means a native `type=date` input with `min="1900-01-01"` and `max="2999-12-31"`, invalid-state styling, a right-side calendar icon that toggles the picker, and in-field up/down buttons for next/previous day.
- New create/edit dialogs and high-frequency financial date fields should use `DateStepper` instead of a raw `input type="date"` unless a compact table filter or browser-native-only control has a specific reason to stay raw.

### Categories

- 分类名称在同一账簿内必须全局唯一，不区分收入、支出、代付、转账类型，也不区分一级、二级、三级或上级分类。二级和三级分类不能在不同父级下使用相同名称。
- 分类树可以表达层级和归属，但不能靠不同父级来区分同名分类。
- 批量导入、AI 识别和移动端按分类名称匹配时，应依赖这个全局唯一规则，避免用名称匹配到多个分类。
- 账单导入和 AI 识别的分类判断应优先使用账簿内的分类学习表：用户在单笔明细、批量修改、普通 Excel 导入预览、邮箱/信用卡账单预览中手动确认分类后，系统记录“收支机构/支付渠道/备注 -> 分类”的关系，邮箱账单和 Excel 预览都应先使用这些学习规则。历史交易样本只能作为次级补充，兜底关键词只能用于候选提示，最终保存仍必须对齐到分类树中已经存在的分类，不能为单个商户硬造独立识别规则。
- 写入分类学习表时，只能使用用户手动分类或人工确认来源的记录；导入预览必须通过 `categoryUserEdited: true` 标记人工改动。未被手动确认的自动导入、AI 识别、计划任务或其他系统生成分类不能进入训练样本，避免一次错误分类在后续导入中被不断放大。
- 投资、还款、贷款等系统业务类别必须出现在分类管理中并标记为系统内置。用户不能改名、移动或删除这些系统类别，但可以在其下新增自己的子分类。
- 分类管理包含真正的“转账”系统父分类，“信用卡还款”和“借入借出”是其子分类。分类管理用“转账”类型标题代表该父节点，避免重复显示两层“转账”。借入借出明细的类型/分类显示必须来自分类树中的“转账 > 借入借出”，不能临时显示“往来款”“还款”等动作文案。
- 分类管理包含真正的“投资”系统父分类，基金投资、股票投资、理财投资、存款投资、贵金属投资、其他投资是其子分类；基金投资下继续分基金定投、基金买入、基金赎回、现金分红、分红再投资等具体动作分类，股票投资下应继续分股票买入、股票卖出、股票分红、股票税费等具体动作分类。所有交易保存时应优先写入分类树中的 `categoryId`，即使是系统分类也不能只作为自由文本写入。投资买入、赎回和定投不计为普通收支，用户自定义的投资分类优先于自动系统分类。保险不统一归为投资：系统收支分类必须包含“保险支出”和“保险回款”，保费按保险支出、理赔/退保/满期领取按保险回款处理，只有未来明确建模的投连险投资账户部分才归投资。
- 分类管理里的“移动至”应与分类名称框保持同一行，分类名称框保持紧凑宽度；用向右箭头连接当前分类名称区域和“移动至”SS 下拉。下拉只负责选择目标上级，必须点击同一行的“移动”按钮后才提交层级变更。移动至下拉必须按分类树顺序递归展示，展开某个二级分类时，其三级分类作为该二级分类下方的整块显示；二级分类采用手风琴展开，点开一个二级分类时同层其它二级分类自动收起，不能把不同层级重新扁平排序。选中某个分类表示把当前分类整体插入到该分类下；选中类型顶层表示移动为该类型一级分类。
- 批量修改明细分类时，应先按已选记录的收支大类限定分类树。大类确定后，下拉从该大类下的二级分类开始选择，一级分类只作为分组/展开入口，不作为批量替换目标。
- 投资类记录按“收支大类 + 收支分类”判断业务归属：收支大类为“投资”时，收支分类的二级分类决定独立业务表（基金投资→基金交易表、股票投资→股票交易表、理财投资→理财交易表、存款投资→存款交易表、贵金属投资→贵金属交易表），三级分类决定具体动作（如基金定投、基金买入、股票买入、股票卖出、理财买入、理财赎回）。资金流水仍应通过 `EntryBusinessLink` 和业务表的 `cashEntryId` 与独立业务记录互相关联，不能只靠分类文字或备注推断关联。
- 在往来款明细中删除任何一笔记录都只软删除所选记录。删除首笔借入/借出记录不能删除往来账户、后续明细、还款计划或利率调整；删除整个往来项目必须使用独立的项目/账户删除入口。
- 往来款本金输入允许负数，便于修正和按用户习惯录入；普通借入、借出、收回应保留本金正负并同步影响资金流水方向、往来余额和再次编辑回显。贷款还款、提前还款、固定还款计划仍以本金绝对值参与计划校验和重算，避免负数破坏银行贷款计划。
- 基金、理财、存款卖出/赎回/支取收益不应额外生成一条现金收入流水。现金账户只体现真实到账金额；基金已实现收益保存在投资交易 `realizedProfit` 中。有份额的理财赎回应按被赎回份额对应的持仓成本计算 `realizedProfit`；无份额理财和存款收益按 `depositInterest - fundFee` 计算，手续费必须扣入净收益。投资买入本身属于资产转换，不应作为收支支出统计；收支报表/统计应只映射收益、亏损、分红、利息等结果项。
- `TxRecord.realizedProfit` 是通用业务收益/损失字段，不属于某一个业务模板。往来款、投资、存款、理财等业务如果一条资金流水同时包含本金和收益，现金账户只记录真实资金流动总额，本金/持仓余额按业务本金字段计算，收益/损失通过 `realizedProfit` 投影到收入或支出统计。
- 统计项应优先挂接到收支分类树的分类 ID。普通交易使用保存的 `categoryId`，旧数据可按 `categoryName` 回挂；基金收益/亏损、理财收益/亏损、存款利息/手续费等派生统计项也必须解析到系统内置分类节点。分类名称只是显示兜底，不应成为长期统计主键。

### Table Column Filters

- Table header filters should reuse the shared `TableColumnFilter` component instead of creating page-specific dropdown variants.
- When a table needs a field filter, prefer placing it directly in the header label area beside the field name.
- For shared dropdown filter behavior, a single row click should select that row, clear other values, confirm, and close the menu unless a page has a stronger, documented requirement.
- If a new table filter needs different behavior, update the shared component first and let calling pages inherit the change.
- Table columns should support user-adjustable widths with remembered preferences when the table is dense enough to benefit from it.
- Tables should fit the visible container by default and avoid horizontal scroll whenever the container can still satisfy each column's true minimum width. Treat page-level `minTableWidth` and hardcoded table widths as preferred proportions, not hard lower bounds; only allow horizontal scroll when columns cannot shrink further without breaking the table.
- The same table surface should expose a unified header settings button instead of multiple unrelated per-page controls.
- Sorting behavior should be shared where possible, so a sort change in one table follows the same interaction model in other tables.
- Draggable table rows should use a dedicated drag handle. Dragging must not be bound to the whole row, and row-click selection must not consume an active text selection, so users can still select and copy text in cells.

### Shared Settings

- Settings that affect multiple screens should be centralized as a shared source of truth, not duplicated page by page.
- When the user changes a setting in one place, prefer reusing that setting everywhere the concept applies.
- If a page needs a different default, override only the default value, not the underlying setting shape or behavior.
- Login page "新建账簿" is not the same as creating a user or account. It should create a new ledger/household. On a truly empty first install it is the required first-run setup and does not need an invite code; after the first ledger exists it must be gated by a higher-level permission such as an invite code.
- For password recovery, Resend is the preferred sending channel. SMTP or configured mailbox accounts are backup channels rather than the primary path.

### Accounts

- 银行理财买入时，理财账户只能使用资金来源账户的同机构账户，或同一所有人名下的第三方支付/钱包机构账户；不得选择其他银行的理财账户。新增理财产品时若同机构尚无理财账户，系统应继承资金来源账户的机构、所有人和币种自动建立并立即选中，已有账户则直接复用。
- 机构名称在同一账簿内使用同一个唯一名称池：任一机构的全称和简称都不能与任何机构的全称或简称重复，同一机构自己的全称和简称也不能相同。
- In cash/debit account entry, the counter/target account determines the business operation: normal cash targets save as transfers; fund/investment targets open investment entry; deposit targets open deposit-in/out entry; debt/settlement targets open borrow/lend/repay entry. Do not save these special targets as ordinary transfers.
- Account uniqueness matters. In the same household, accounts should not be indistinguishable under the same owner, institution, and account type. For bank debit/credit accounts, the last four digits are the primary differentiator; the same owner + institution + type + last-four combination is duplicate. If no last-four is available, the same owner + institution + type + account name is duplicate.
- Dropdown display names are not constrained by sidebar display settings. They should favor clarity.
- Statement, batch-import, and AI-import account matching should use the shared import account resolver. Match by institution aliases, payment-provider aliases, account kind, account aliases, and card/account last four digits; do not let a page-specific matcher block accounts such as "招商银行储蓄卡（2758）" or "中国邮政储蓄银行信用卡" when the account table has a corresponding account. Generic Alipay balance-product labels such as "支付宝投资类" should resolve to "余额宝" when that account exists, unless the source text explicitly names "余利宝".
- In statement and batch import, headers such as `卡号末四位`, `信用卡后四位`, `信用卡末四位`, `cardLast4` identify the credit-card account, not the repayment source account. A bare four-digit value from those headers should be matched as a credit-card last-four hint.
- Sidebar display formatting rules and dropdown display formatting rules are separate concerns.
- Account display formatting must stay user-centered and configurable.
- Credit-card-like naming in import preview and account selection must show institution short name, card/product name, and last four digits when those fields are available; fallback rules must avoid empty or duplicated fragments.
- Statement and batch import account matching may use generic labels such as "中国建设银行信用卡". If the label contains an institution plus account kind but no last-four digits, automatically match only when there is exactly one active account of that institution and kind; otherwise leave it for user confirmation.
- Ledger/batch import should not expose a separate credit-card statement template entry. Credit-card statement rows use the generic bill-record template, keep legacy `cardAccount/type/merchant` header compatibility, and still validate credit-card repayment as a transfer into the credit-card account.
- In ledger/batch import, the presence of a `对向账户`-style column means accounts are row-level transfer accounts and must not trigger the credit-card statement unified-account mode. If `付款账户`/`还款账户` and `信用卡账户` appear together, the payment account is the source and the credit-card account is the counter/target account.
- When an account is created or edited, all fields that were previously entered must reliably round-trip back into the edit form.
- Any account display that does not visibly include owner and account category must expose them in hover text, using an owner-qualified shape such as `墨斗鱼 · 微信·零钱 · 电子钱包`.
- 收支机构必须来自机构表中用于普通收支识别/选择的真实机构或商户主体，例如支付宝、京东、中国银联、云闪付、银行或明确商户；不得包含“教育、药店、医疗、快递、会员”这类抽象分类词，也不得包含往来人员、往来组织、家庭成员或其他往来对象。普通收入/支出/转账里的“收支机构”使用机构表；识别不到机构表记录时可以留空，不要保存未匹配的自由文本。代付、借入借出、还款等往来款流程使用往来对象表和往来对象 SS。
- 账户显示余额永远只计算到当前日期。账户列表、侧栏、概览、移动同步和账户 API 的余额不得提前纳入未来日期的计划任务、贷款/汽车分期、保险缴费或其他未来流水；未来记录可以存在于明细或计划中，但不能改变今天的账户显示余额。
- 概览总资产/总净值应包含资产型或启用现金价值口径的保险余额。保险不因此归入投资分类；投资市值仍只统计基金、理财、货币基金、贵金属等投资账户，保险现金价值作为单独资产项展示。

### Insurance

- Insurance should exist as a first-class area alongside other major financial areas, not be hidden as a special case.
- Insurance product definition and owned policy/holding are different concepts and should not share one table forever.
- The same insurance product may be purchased by different owners or insured people, so product master data must be reusable across multiple policy/holding records.
- 保险现金价值使用保单资产口径展示：续期保费和保全缴费增加现金价值，回款/退保减少现金价值；不要沿用资金账户现金流符号把现金价值显示成负数。
- Insurance product master data is not a policy. It should contain reusable product facts such as name, type, insurer, currency, accounting type, and note. It must not contain policyholder, insured person, beneficiary, first purchase date, premium term, coverage amount, or premium records. Like wealth products, insurance products should not appear as a standalone system-settings menu item; maintain them from insurance purchase/edit and insurance holding workflows.
- Insurance purchase creates or selects one owned policy under a policyholder plus insurer context. One initial purchase/payment creates one policy; later scheduled or manual payments for that policy must not create a new policy.
- The insurance purchase form should select an insurance product master through SS, with nested creation of product master data when missing.
- Insurance product creation inside SS should only ask for product master fields, especially name, type, accounting type, insurer institution, currency, and note.
- Insurance purchase fields should be:
  - policyholder first, selected from family members
  - funding account SS filtered to the selected policyholder's account scope
  - insurance product SS, with insurer derived from the selected product
  - insured person and beneficiary selected from family members
  - first purchase date, payment method, payment term or already-paid dates when annual payment applies, premium amount, coverage amount, and note
- Insurance account grouping uses the selected policyholder. The funding account must belong to that policyholder's account scope.
- Insurance policy payment method is limited to annual payment and single premium for now. Annual payment stores a yearly schedule anchored to the first purchase date; single premium does not create repeated payment plans.
- If the first purchase date is earlier than the current premium date by at least one payment cycle, the purchase flow should offer two default-checked actions: create a future payment plan and generate historical premium records up to the latest scheduled date before the current premium date.
- Insurance scheduled payment notes should read like "计划任务：保险缴费：保险名称", and debit-card transaction views should show category wording as insurance expense.
- Family-member selection for insurance must come from `Institution(type="family_member")`, not from users or account groups. Adding an account owner should also create/update the same-named family member.
- Family-member SS labels should use the sublabel "家庭成员", not "投保人" or "被保险人".
- Different insurance products should show different content, but within a unified insurance workflow.
- Insurance purchase flow should collect core product information directly in the main form instead of forcing a disconnected side flow.
- Core insurance fields include:
  - product name
  - product type
  - insurer institution
  - policy owner
  - insured person
  - premium amount
  - payment frequency
  - payment term
  - coverage term
  - coverage amount
- Insurance holdings should show:
  - status
  - total premium paid
  - cash value or balance
  - coverage amount in a separate column
- Protection-oriented insurance may still have cash value. Do not assume protection means value-less.
- Insurance must support different display emphases by product type without splitting into unrelated workflows.
- Insurance holdings should not force a single metric column that mixes cash value and coverage amount together.
- Insurance status such as active, matured, surrendered, or lapsed should be visible in holdings.
- Insurance form and holdings should prefer the user's financial mental model over generic investment terminology.
- Insurance view structure should be:
  - insurance account as the container
  - policy list at the top
  - policy-linked premium/insurance records below
- Insurance accounts should be created around policy owner plus insurer context, so the account layer matches how the user thinks about policies.
- Insurance account names should be policyholder plus insurer, such as "张四的泰康养老", not a duplicated form such as "泰康养老·张四的泰康养老".
- Insurance product rows should preferably show:
  - product name
  - status
  - start date
  - insured person
  - payment frequency
  - payment term years
  - coverage term years
  - total premium paid
  - cash value or balance
  - coverage amount
- Cash value or balance and coverage amount must remain two separate columns.
- Product type should affect emphasis and labels, but should not split insurance into unrelated UI workflows.
- Protection-oriented products that also have cash value should still show both cash value and coverage amount.
- Insurance summary totals should count only monetary value columns into asset-like totals, while still displaying coverage amount as a separate informational metric.
- Insurance data model direction:
  - one product master table for reusable insurance product definitions
  - one owned policy/holding table for one person's actual purchased policy under one insurer/account context
  - transaction records should ultimately link to the owned policy/holding record, not directly treat the reusable product master as the holding itself
- Insurance policy list should include policyholder, insured person, total premium paid, cash value balance, coverage amount, and status.
- Insurance policy number and effective date belong to the owned policy/holding, not to the reusable insurance product master. Policy creation and policy editing should preserve them for document reconciliation.
- Insurance policy list summary should be a table-like summary row at the bottom: "汇总" in the policy-name column and totals under total premium, cash value balance, and coverage amount.
- The lower insurance detail list should be called "投保记录", not generic "保险记录".
- Selecting a policy should filter the lower detail list to only records linked to that policy.
- Double-clicking a policy should open an edit dialog for policy name, policyholder, insured person, beneficiary, payment term, and related policy fields, using SS dropdowns where selection is needed.
- Editing an insurance premium record should only edit premium date, funding account, non-editable insurance product/policy, premium amount with two decimals, and note.
- Manual insurance renewal should be available from the selected policy's detail header as a policy-linked premium action. It creates another normal premium record under the existing policy and must not create a new policy.
- Policy-level additional premium / preservation premium ("保全缴费") is a one-off policy-linked premium addition. It increases total premium paid and cash value/balance, stays under insurance expense, must not change coverage amount or payment term, and must not create or alter future premium plans.
- Insurance create/edit dialogs must stay inside the viewport with a fixed full-screen overlay and scrollable body; they must not jump to the top of the page or overflow above the viewport.

### Deposits

- Deposit is not investment in the user mental model.
- Deposit flows should minimize user input by defaulting institution-related accounts and values whenever possible.
- Deposit holdings should behave more like holdings/lots with clear linkage between deposit-in and deposit-out records.
- Deposit should be treated as its own major operation type, not hidden under investment.
- Deposit-in and deposit-out flows should aggressively default institution-linked accounts and values to reduce user input.
- Deposit records should preserve linkage between the deposit lot and later withdrawal/redemption actions.

### Debt

- Ordinary debt borrow creation no longer exposes `资金到账/消费分期` as a user choice. Cash-disbursed loans create a transfer into the selected cash account. `消费分期` is handled from the expense/credit-card financed-purchase flow, not from the ordinary borrow/lend window; existing `debt_financed_purchase` rows remain supported for compatibility and must round-trip without being accidentally converted.
- Vehicle and other financed-purchase loan creation must not bulk-generate repayment `TxRecord` rows. Saving the loan creates the liability and a `loan_repayment` scheduled task; repayment transaction rows are created only when the scheduled task executes for due periods. If a historical catch-up is ever offered, it must require explicit user confirmation and must never create future rows.
- Old auto-generated financed-purchase repayment rows can be corrected through the internal cleanup endpoint `/api/v1/cleanup/financed-purchase-repayments`; it defaults to dry-run and only targets generated `scheduled_task` rows linked to financed-purchase loan plans.
- Interest-free vehicle and other standalone financed purchases may use the explicit repayment method `免息分期还本`. The plan divides principal across the selected runs, records zero interest, and must not require a positive annual rate, LPR, or historical rate adjustment.

- Debt/claim displays should match the user mental model for personal/family finance, not corporate finance wording.
- Names such as borrower/lender, borrowed/lent, or institution/person context matter and should be chosen carefully.
- Debt views should lean toward personal/family wording such as borrowed/lent or person/institution context, rather than formal enterprise wording.
- Debt details should behave more like position/detail views, with a clear summary by counterparty and linked detail records below.
- Borrow/lend creation should allow selecting or adding a counterparty object through SS. Repayment, prepayment, and collection should choose existing debt items instead of silently creating new ones.
- Any transfer whose source or target account is a debt/settlement account must be recognized as a debt action: borrowed-in, lent-out, repayment-out, or collection-in depending on the debt account side and payable/receivable direction. Editing those rows must reopen the debt dialog, not the generic transfer dialog.
- Debt interest should be entered as structured debt interest on the debt operation. It must not be mixed into principal; principal balance changes should continue to use the principal amount.
- Borrow-in with free repayment should not ask for or save an agreed rate or fixed repayment schedule fields. Actual interest is entered later on the repayment or collection operation.

### Overview

- Overview should avoid redundant repeated metrics.
- When multiple modules are shown together, layout should stay compact and comparable.
- Credit card, investment, insurance, debt, and daily account summaries should align visually where the concepts are parallel.
- Overview modules should avoid duplicate summaries between top blocks and detailed blocks.
- Comparative modules should align visually where the business concept is parallel, but should not force the same widget style when that hurts clarity.

### Reports

- The reports page header should directly show the current report name, such as "收支统计表", instead of a generic "报表" title plus a duplicate report sub-navigation.
- Income/expense report hierarchy has exactly two modes: year and month. Year mode allows a start/end range using year selectors; month mode allows a start/end range using year-month inputs. Neither mode uses day-level dates.
- Income/expense reports should prioritize dense statistical rows and must not spend vertical space on duplicate total-income, total-expense, net, or column-count cards above the table.
- Report filters such as hierarchy, start/end year-month, and account should use one compact toolbar row without a separate summary row or tall filter card.
- 投资收益表展示的是市值收益，不是赎回时确认的投资收入。按日视图顶部合计只汇总当前月份，按月视图顶部合计只汇总当前年份，按年视图才展示有收益以来到当前年的累计合计；前翻/后翻与按日、按月、按年粒度切换放在同一组控件中。投资收益表发现已发生工作日的持仓基金净值缺失时，必须在统计范围控件最右侧以内联提示显示并询问用户是否获取缺失净值，不应另占一行；周末/非交易日可以沿用上一可用交易日净值，不应造成永久缺失提示。用户确认获取缺失净值且请求成功结束后，当前提示条应局部消隐，不应整页刷新。
- The income/expense statistics table scrolls inside its own bounded panel with a frozen header. When drill-down details are open, a horizontal splitter must let the user resize the statistics panel height, and the chosen height should persist locally. The upper statistics panel must never collapse below half of the currently available split area.
- The reports workspace must not show a page-level vertical scrollbar. The statistics panel and drill-down detail panel each scroll internally within the remaining viewport height.
- Clicking a report amount should show the filtered records through the shared conventional transaction detail table used by account views, including the same column sizing, header filters, compact rows, selection, batch actions, and edit/delete controls. Do not maintain a separate simplified report-detail table.
- The shared conventional transaction table is named "MMH明细表" in the UI. It should provide checkboxes, batch edit/delete, header sorting and filtering, field/column settings, persisted column widths, and pagination with page-size and show-all controls.
- MMH明细表的筛选状态只作用于当前账户/当前表。切换账户或账单上下文时应清空筛选；列宽、隐藏列等用户偏好可以继续保留。
- 基金、理财等业务交易明细的复选状态和批量操作应与“交易明细”标题同一行展示；不要在表格表头上方另新增一条 toolbar，也不要在“交易明细”标题前放收起/展开按钮。
- 通用表格的处理边界以传入卡片/表格组件的 `rows` 为准：当前页是 20/40 条时，表格只筛选、排序、选择和渲染这 20/40 条；用户选择“全部”时才处理全量记录。外层页面必须先完成分页/上下文筛选，再把当前卡片应显示的记录传入表格。
- 通用表格的大数据渲染应只生成当前视图附近的行 DOM；屏幕外记录可以参与排序、筛选和统计，但不应因为一次复选、排序或单元格状态变化而全部重新渲染。表格必须保持 `table`/`colgroup`/表头/列宽结构稳定，不能为了优化牺牲表头与表体对齐。
- 通用表格字段应遵循同一契约：`render` 只负责显示；`filterText` 是用户可理解的筛选值，不能使用 ID；`filterSearchText` 可补充别名、机构、所有人、尾号等搜索内容；`sortValue` 必须是稳定可比较的原始值，例如数字金额、ISO 日期或完整名称；余额和操作列等不适合筛选排序的列不传筛选/排序字段。
- 账户类表格字段的可见文本统一只显示机构简称、账户名称/尾号等紧凑账户名，不直接显示所有人或账户类型；所有人和账户类型只放在悬浮说明或搜索文本中，用于保留完整账户语义。
- All report and MMH detail-table amounts must follow the configured red-up/green-down or green-up/red-down rule. Income uses its signed amount, expense uses its economic direction (normal expense is down; an expense refund is up), and net income uses its signed result.
- Report grouping controls such as monthly/yearly granularity should stay compact and sit directly under the income/expense report heading.
- Clicking a report amount should show the exactly filtered transaction records below the report, including parent-category descendants and signed expense offsets.
- Report drill-down rows must allow editing through the shared transaction editor and deleting with confirmation. After save or deletion, refresh the report totals, drill-down rows, affected account balances, and sidebar summaries through the shared finance refresh path.

### High-Frequency UX Themes

- User-initiated entry edits, batch edits, deletes, and batch deletes should expose one global "undo last operation" action. A batch is one atomic undo unit, and restoring it must refresh balances, holdings, bill caches, summaries, and current detail rows.
- Undo history is scoped by household and user and retains only the latest entry operation. Background recalculation must not create undo history. Whole-loan-project deletion remains outside ordinary entry undo because it hard-deletes the loan account, plans, and rates.

- Credit cards under the same institution share billing day, repayment day, and bill mode. Creating a card should prefill those values plus credit limit from an existing card at that institution; the inherited limit is only a default and must not overwrite existing cards.
- Credit-card bill mode is either separate or consolidated. Consolidated mode groups credit cards by household and institution, including inactive cards so historical bills remain stable, while preserving each transaction's concrete card account. Selecting any card in that group shows one combined bill and all group details.
- In consolidated credit-card billing, both a selected statement-cycle detail view and the "all credit bill details" view must load every card in the bill group, not only the currently selected card. The card column can distinguish the concrete last four digits such as 3710 or 3833.
- Consolidated bill cycles and manual bill overrides use one stable representative account resolved by shared server logic. Shared credit limits or institution-wide credit utilization are not inferred from consolidated billing.

- Credit-card installments have two explicit entries: `消费分期` in new credit-card expense entry, and `账单分期` in the credit-bill summary toolbar. Do not merge them into one ambiguous entry.
- Credit-card expense entry may create an installment plan for all or only part of the purchase. The original purchase remains unchanged; the financed principal is offset in its original statement, then installment principal plus fee/interest is added to each statement exactly once.
- A posted statement may convert all or part of its unpaid balance into a statement installment. Keep every original purchase unchanged, offset only the financed principal in the source statement, and let the first payment posting date determine the billing cycle for generated principal and fee rows. The unfinanced balance remains due normally.
- Statement installments are owned by credit-card account plus source statement month, not by an arbitrary purchase. The source statement month is derived from the user-entered installment date and the card billing day; the bill summary table should not use a separate row-level installment column. Current/unposted cycles and settled statements cannot create statement installments; a consolidated statement allows only one active plan for the same source month.
- Credit-card bill summary rows show `本期金额` as `支出 - 收入`; statement installment creation stays in the table header tool area beside bill-fetch/import actions.
- Credit-card installment payment dates keep the day-of-month from the first payment posting date and advance monthly; for example, a first posting date of `11-27` has its second payment dated `12-27`. In statement-installment dialogs, the installment date owns the source-statement offset, while the first payment posting date owns generated principal/fee rows and defaults to the installment date. Generated rows should note the original installment date. Each installment period writes principal and fee/interest as separate same-day expense rows when fee/interest is non-zero.
- Credit-card installments store structured plan and row fields. Do not infer installment number, principal, fee, or plan identity from notes.
- Installment rate input must distinguish annual interest from a per-period fee rate because these are not equivalent financial meanings.
- Deleting or restoring the source purchase or any generated installment row must cancel or restore the linked offset and all installment rows together.

- The product should reduce user operations wherever defaults can be inferred from institution, owner, account type, prior records, or current page context.
- Bill import has one user-facing upload entry. During parsing, the system automatically chooses regular-bill mode or credit-card-statement mode from the file structure and account content.
- XLSX bill import should merge worksheets that share the same header structure instead of reading only the first sheet, and the preview diagnostics should report sheet, candidate-row, recognized-row, and filtered-row counts.
- In development, bill import diagnostics should persist structured, privacy-safe events under one visible trace ID so parsing, validation, batch replacement, API ingestion, and failures can be correlated without logging raw statement text or account names.
- Import account selectors must show account type and owner alongside the account label. When multiple accounts match the same imported name, automatic matching must stop for manual confirmation, and the confirmed selection must retain a stable account ID through preview, batch replacement, and ingestion.
- Manual account selection in import preview must immediately render the selected account as the full owner-qualified identity, not the raw imported tail, raw text, or internal `account-id:` marker.
- In compact import tables, batch-edit panels, and SS dropdowns, account cells/options must at least expose the full owner-qualified account label in hover text, such as `墨斗鱼 · 微信·零钱 · 电子钱包`, so a truncated visible label cannot hide the owner.
- Import account matching must use owner-qualified labels when the imported text includes an owner/person, such as `张四·微信·零钱通`. The owner is part of the disambiguation key, so a longer account name like `零钱通` must not be blocked by a shorter same-owner account like `零钱`. Exported labels such as `张四·微信·零钱·电子钱包` and `张四·招行·2758·借记卡` must be accepted by the same shared import account resolver without manual correction.
- Import preview may use internal `account-id:` markers to keep a selected account stable, but those markers must never be displayed as account names or written into transaction account-name fields.
- Credit-card repayment always means a one-way transfer from a debit-card or e-wallet account into a credit-card account. Preview, account selectors, validation, and ingestion must enforce the same direction.
- Import validation summaries count distinct affected records, not the number of validation messages. Multiple reasons on one row are grouped under that row.
- Import preview confirmation should validate and import only the current target selection. Rows outside the current filtered/selected import target must not disable the confirm button or change the confirm count.
- Import preview should still validate the full preview set and show blocking errors immediately, without requiring the user to select all rows first. Full-preview errors may be pinned and filtered for review, while the confirm/import button only depends on the currently selected target rows.
- Import preview warnings must be visible in the active foreground preview surface, not only in a background page or diagnostics panel. Preview is only "passed" when there are no blocking errors and no warnings; rows with blocking errors appear first, warning rows second, and clean rows after them.
- Batch editing in import preview is a valid workflow. It must remain available for fixing repeated recognition mistakes, but if an original imported account identity clearly conflicts with the selected account (for example institution/card last four digits point to another card), preview and ingestion must block that write instead of silently moving rows into the wrong account.
- Transaction detail export should include tags, category, counterparty institution, and owner-qualified account identity. Account identity should be one readable field such as `张四·招行·2758·借记卡` (owner, institution short name, last four or account name, account type), not split into several columns. When a separate transaction major-type column exists, the category column must not repeat root labels such as 支出、收入、转账、代付、投资.
- Large bill imports must distinguish preview validation from server-side write progress. A row number caused by database transaction timeout is not a dirty-row validation failure; the UI/API should say the transaction timed out around that row, show write progress while importing, and keep the whole batch rollback semantics clear.
- Import preview should avoid repeating the same recognized-record count across title, hint, button, status, and diagnostics. Keep one compact count in the table status area; show detailed diagnostics only for failures or explicit debugging.
- The user strongly prefers direct inline workflows over hidden corner controls or disconnected secondary panels.
- Repeatedly broken create/edit round-trips are considered a major product quality problem and should be treated as first-class regressions.
- When the user repeatedly corrects wording or layout, that preference should be promoted here instead of being left only in chat history.
- Saving any change that can affect amounts, balances, bill summaries, holdings, or related account totals must trigger a cascade refresh: sidebar account numbers, page-header totals, current list/table rows, and affected summaries should all update together.
- Every mutation should declare and honor its actual data impact scope. Operations that only affect local ordering, display metadata, or a bounded row range should do the smallest correct recalculation and refresh instead of broadcasting a global finance refresh.
- Ordinary saves, deletes, imports, scheduled-task execution, undo, and edit-dialog confirmations must not call `router.refresh()` or browser reload as a default success action. They should update local state and broadcast scoped change events so only affected rows, balances, summaries, and selector caches refresh. Full route refresh is reserved for explicit user refresh actions, login/logout, ledger/book switching, database restore/reset, system update, or other global context changes.
- High-frequency account switching should feel cached. Do not disable route prefetch on account-entry links by default. For long sidebars with many accounts, use hover/focus/touch-triggered `router.prefetch` with dedupe instead of eager prefetching every account at page load; for short overview account lists, allow normal Link prefetch.
- Master-data mutations such as accounts, owners/account groups, institutions, counterparties, categories, tags, and reusable selector dictionaries must update the database, revalidate server-side common/settings caches, invalidate or prewarm the client settings cache, and broadcast the shared settings-data changed event so open pages, SS dropdowns, and edit dialogs do not require a manual refresh.
- System/global tags attached by import or automation are still user-visible record tags. Transaction edit dialogs must show them, allow removing them from the record, and keep tag selector dictionaries scoped to current-household plus global tags.
- All create/edit/import-preview windows should expose only one user-facing remark field. `toNote` is an internal compatibility/display field for transfer-like or specialized linked records; it must not appear as a second ordinary remark input.

### Investments And Precious Metals

- Mobile investment/fund pages should have one visible product home under bottom navigation "投资". Do not keep a separate mobile fund-holding implementation under account-like routes when the FundShell investment detail already owns the active fund card, chart, and transaction-card workflow.
- 股票应作为独立 `stock` 投资域实现，归在 `Account.kind = "investment"` + `investProductType = "stock"` 下面以支持多个股票账户；股票账户、股票持仓、股票交易、股票价格、股票手续费、股票 API 和股票 UI 都使用 `stock` 命名空间，不能复用或暴露 `fund` 字段、表名、路由、组件名、URL 参数或业务文案。股票身份字段使用 `stockCode` / `stockName` / `market` / `securityId` 等股票专用语义，不得借用 `fundCode`、`fundName`、`fundUnits`、`fundNav`、`FundTransaction`、`FundHolding`、`fundFeeRate` 或基金净值/确认/到账模块。
- 股票业务应新增独立业务表和统一服务模块，例如 `StockSecurity`、`StockTransaction`、`StockHolding`、`StockPriceCache`、`StockFeeRule`、`StockMarketFeeRule`、`StockBrokerageCatalog` 和 `src/lib/stock/**`；股票手续费规则可以借鉴现有按账户、产品代码、费用类型和生效日期查询的模式，但代码和数据模型必须归入 stock 域。市场公开规则（印花税、过户费、经手费、监管费等）存入 `StockMarketFeeRule`，账户/券商/客户协议覆盖（佣金、最低收费、特殊市场/标的规则）存入 `StockFeeRule`，证券公司公开名录和别名存入 `StockBrokerageCatalog`。
- 股票交易与资金流水的关联必须通过 `EntryBusinessLink` 建立股票专属关系：模型应增加 `stockTransactionId`，`businessType` 应增加 `stock`，关联记录的主键或返回字段可作为 UI/API 的 `linkId`；股票导入或券商成交单如带外部流水号，应另存 `externalLinkId` / `brokerTradeId` 用于去重和追溯，不能把它混同为基金的 refund link、`fundSourceEntryId` 或 `fundTransactionId`。
- 股票买入、卖出、股息、送转、拆并股、税费调整和纯估值快照都必须按股票业务语义建模。凡是同时影响证券持仓和现金账户的动作，要写入 `StockTransaction`、必要的资金侧 `TxRecord` 和 `EntryBusinessLink`；只改变行情价格或持仓市值的估值快照不生成资金流水关联。
- 胶囊菜单必须提供独立“股票”入口。第一次股票买入时若当前账簿没有股票账户，交易弹窗自动建立 `investProductType = "stock"` 的股票账户；已有一个或多个股票账户时必须让用户通过 SS 股票账户下拉选择，且该下拉支持“新增股票账户”。创建或编辑股票账户时，机构只能选择类型为证券/`brokerage` 的机构；服务端必须拒绝非证券机构，并同时确保该证券机构、该所有人、该币种下存在一个现金/钱包类“证券资金账户”，不存在则自动建立；交易弹窗资金账户下拉也必须是 SS，并支持“新增资金账户”，新增时应显示当前股票账户继承来的所有人、证券机构和币种，并锁定这些归属字段，不能只让用户填写账户名称。交易弹窗手工新增资金账户的名称示例使用“资金账户21003344”这类证券资金账号表达；服务端自动建立资金账户时，名称优先使用证券机构短名/名称，缺少机构名时才使用“证券资金账户”。股票买入、卖出、分红以及账户费用/税费调整的资金来源/去向默认使用同券商机构下的证券资金账户，没有单独资金账户时才兼容退回股票账户自身现金。银行与券商之间的入金/出金作为单独“银证转账”普通转账处理，目标/来源是证券资金账户；同一证券公司名下的股票账户和基金账户可以通过 `cashAccountId` 共用这笔可用资金，但股票业务表、API 和 UI 仍全部归入 `stock` 域，不复用基金字段。股票账户页应分开展示证券资金账户现金、持仓市值、总资产和浮动盈亏，不能把未买入的现金混进 `StockHolding`。
- 股票交易弹窗里的买入、卖出、分红和低频股本变动不是同一种录入界面套不同标题；每个动作必须只显示它需要的字段。买卖高频窗口只显示股票账户、证券资金账户、股票代码/自动查询名称、交易日期、数量、价格和成交金额，成交金额由数量 × 成交价格自动得出；股票市场在窗口中优先由股票代码推断，手工市场、印花税、佣金、过户费、经手费、监管费等账户规则不在交易窗口展示，优先放在股票视图持仓列表表头的“账户费率”入口中，作为股票账户级/市场级设置维护。送股、拆股、并股不是常规高频操作，不占用三个交易入口，应合并为一个“股本变动”入口，在入口内选择具体变动类型并只填写股数变化。费用调整、税费调整这类影响整体股票账户现金/规则的动作不出现在股票交易弹窗，放在股票视图持仓列表表头入口处理。交易弹窗不显示“记录证券买入”“银证转账进这里”“保存后……”等说明文案，底部只保留一个右下角“保存”按钮；现金分红显示分红金额和可选净到账。
- Opening a fund or money-fund investment account should show only the holdings table first, like insurance/deposit holding-first views, without auto-selecting the first holding. The fund transaction detail pane itself should not render until the user clicks a specific holding or opens a URL with an explicit `fundCode`. When investment accounts show all records/all transactions, do not show per-row running balance or remaining-balance style columns such as wealth remaining units; those values are only meaningful in a single holding/product scope.
- Precious metals should use dedicated dictionaries for metal type and unit. The UI should let users select "黄金/白银/铂金/钯金" and "克/千克/盎司/钱" style entries instead of asking users to type a fund-like code.
- Precious metal transaction create/edit flows must round-trip the selected type ID, unit ID, quantity, unit price, and fee through dedicated metal fields. Do not store precious-metal identity or quantity in fund fields such as `fundCode`, `fundName`, `fundUnits`, or `fundNav`.
- Precious metal buy/sell account SS must only show investment accounts whose `investProductType` is `metal`; fund, money-fund, wealth, and deposit accounts must not appear in that selector.
- Fund-like investment accounts should keep trading-calendar ownership at the account level. Confirm/arrival T+N calculation must read that account setting instead of assuming every fund account follows the same market calendar.
- Fund buy-refund matching should persist the refund row's `fundSourceEntryId` to the source buy row. Date fallback is only for old data migration and must not be the primary edit/save rule. In cash/debit account detail views, a buy-refund cash receipt displays and sorts by its actual arrival date (`fundArrivalDate`, falling back to `date`), the same as redemption cash receipts. In fund transaction detail views, linked buy-refund rows display and sort under the source buy row's application date (`date`), while the refund's own `fundArrivalDate` remains in the arrival-date column. `TxRecord.date` remains the original ledger/import transaction date and must not be overwritten by computed confirmation or arrival dates.
- Fund buy cash movement happens on the application date: fund purchase and regular-invest cash-side entries should display and sort by the buy application date (`date`), not by confirmation or arrival date. Only fund redemption, cash dividend, and buy-refund cash receipts use the cash arrival date (`fundArrivalDate`) for cash/debit account detail display and sorting.
- Balance reconciliation and balance initialization rows that carry a `balance_reconcile_target:` marker are balance anchors. They represent the final balance at the end of their displayed local date, so they must sort after all ordinary records on the same displayed date for balance calculation, and before those ordinary same-day records in descending detail views.
- Ordinary transactions on the same displayed date may be manually reordered without changing their date. `TxRecord.dayOrder` stores this same-day business order: larger values mean later within the day, so they appear higher in descending detail views and later in ascending balance calculations. Balance anchors still outrank manual same-day order and remain the end-of-day record.
- Cash/debit card ledgers and fund transaction semantics are separate concepts even when both currently live in `TxRecord`. The cash/debit side should only render actual cash movement rows and dates. The fund side should render the fund business order, including application date, confirmation date, NAV, units, fee, and linked refund amount. A buy with a refund should be edited as one fund buy order that owns/updates the linked refund cash row, not as two unrelated edit windows.
- 资金交易与保险、基金、股票、理财、存款、贵金属等业务明细应从“一条 TxRecord 同时承担两侧含义”迁移为“资金流水记录 + 独立业务交易表记录 + `EntryBusinessLink` 关联表”。当前已有独立业务表：`FundTransaction`、`InsuranceTransaction`、`WealthTransaction`、`DepositTransaction`、`PreciousMetalTransaction`；股票应新增 `StockTransaction` 等独立业务表；`TxRecord` 可暂时作为兼容投影和旧数据入口，但新增/同步路径应写入独立业务表并更新关联表。旧数据可以用 `legacy_combined_record` 自关联兼容，并通过回填迁移补出独立业务记录；删除提示应优先读取关联表，避免删除资金流水时无提示地删除业务明细。
- 保险、基金、股票、理财、存款、贵金属的业务页面和业务汇总应优先读取各自独立业务交易表；`TxRecord` 只作为现金流水、旧数据兼容投影和迁移同步入口。新增、编辑、批量修改、删除、恢复和撤销都必须同步维护独立业务表及 `EntryBusinessLink`。
- 基金/货币基金新增和定投生成必须直接写入 `FundTransaction`、`FundTransactionCashFlow` 和 `EntryBusinessLink`；对应的 `TxRecord` 只表示资金账户现金流水，不再写入 `fundCode`、`fundName`、`fundUnits`、`fundNav`、`fundFee`、确认/到账日期等基金业务字段。旧 `TxRecord` 基金字段仅用于历史数据兼容、回填和迁移读取，不得作为新增业务事实来源。
- 关联规则按“是否跨资金流水和独立业务台账”判断，而不是按页面临时决定。凡是一笔用户操作同时产生或影响资金流水记录和独立业务交易记录，就必须写入 `EntryBusinessLink` 并在资金侧和业务侧显示关联图标；适用范围包括基金申购/赎回/分红/买入退回、股票买入/卖出/股息到账/现金税费、保险投保/续费/退保/理赔回款、银行理财买入/赎回/分红、存款存入/支取/利息、贵金属买入/卖出等。普通收入、支出、转账、代付、信用卡还款、纯估值快照、账户余额调整、只改变业务状态但没有对应资金流水的操作，不显示关联图标。存款需要关联，因为存入/支取同时有资金账户现金流和存款持仓/交易台账；存款利息属于这笔业务交易的收益字段，现金账户只显示实际到账金额。
- 理财等独立业务记录编辑窗口必须把业务侧字段和资金侧字段分开读取：业务字段来自独立业务交易表，资金账户、资金日期、现金备注等来自 `cashEntryId`/`EntryBusinessLink` 指向的资金流水。编辑保存时如果业务记录没有关联资金流水，应按当前业务记录补建资金侧 `TxRecord`，回写业务表的 `cashEntryId`，并建立 `EntryBusinessLink`；不能把业务记录 ID 当作资金流水 ID 传递或保存。
- `EntryBusinessLink` 只有在指向的资金流水和业务记录都存在且未软删除时，才代表有效关联并点亮关联图标。业务记录如果只剩下指向已软删除资金流水的 `cashEntryId`，编辑保存时必须恢复该资金流水或重建一条可见资金流水，并保持 `EntryBusinessLink` 指向有效记录。
- 业务明细里的未关联图标不是静态提示。点击未亮起的关联图标时，如果该业务记录已有明确资金账户，系统应在资金侧恢复或建立对应 `TxRecord`，回写业务记录的资金流水 ID，并建立有效 `EntryBusinessLink`；如果缺少资金账户或业务 ID，应给出明确错误而不是静默失败。
- 业务关联图标应放在明细表操作列内，与编辑按钮、删除按钮保持同一组行操作；不再在申请日期、资金日期等业务字段前单独显示。增强明细表应提供可选 `rowActions` 能力承载关联、编辑、删除等行操作；复选后出现在表头上方的批量编辑/删除应使用统一图标按钮格式。
- Fund confirmed buy amount means `gross buy amount - linked refund amount`, before fees. Confirmed fund buy units use `confirmed buy amount - buy fee` divided by NAV, because the fee does not become shares. Holding cost basis uses the confirmed buy amount before fees, because buy fees are part of the user's investment cost. Linked buy-refund rows are cash-flow/relationship rows only and must not reduce units a second time in display, holding recalculation, NAV fill, import, or batch-edit paths.
- Fund redemption realized profit uses the net arrival amount; if no separate arrival amount is stored, `TxRecord.amount` is already the cash-side net receipt and must not have the redemption fee deducted again during holding recalculation.
- Fund `buy_failed` / paused-subscription rows are execution and cash-flow history only. They must not increase fund holding units, holding cost, or pending cost, even before or after a matching refund row is linked. Only actual buy rows with no confirmed units/NAV count as pending fund cost.
- Fund redemption create and edit dialogs must share the held-fund SS selector. Available units in that selector replay holdings as of the selected redemption date using the arrival-date availability of fund cash-flow rows, and edit mode must exclude the row being edited so a full redemption is not reduced to zero by itself. Historical replay must not carry negative units across a full redemption; clamp each fund's replayed units at zero so later buys start a new positive cycle. If replayed units are still zero but the current holding has positive units, keep that fund selectable as a manual correction fallback.
- On app startup, the system should run a lightweight background check after login: execute due scheduled tasks, refresh latest NAV for all current fund-like holdings, then fill due pending fund buy rows whose NAV or units are missing. This startup check must run from server-side database queries, not by loading every fund page in the client. Held fund NAV refresh must be based on current `FundHolding` rows, not only regular-invest plans or pending buy rows; pending buy unit calculation must use the same confirmed amount minus fee rule including linked refunds.
- Scheduled task next execution date is an internal cursor derived from the latest generated linked record plus the task frequency, or from the start date when no generated record exists. It must not be exposed as a user-editable date, and edit/save paths must not accept a client-supplied next execution date that can move the cursor backward and generate duplicate buys/payments/transfers.
- Bank wealth products should use reusable wealth product master data. Wealth buy/redeem flows must select the product through SS and persist `wealthProductId` while keeping `fundName` only as display text.
- Bank wealth accounts must route to the wealth investment view and default to the wealth entry workflow. They must not be treated as open-end fund views just because they reuse investment-account storage.
- Wealth buy/redeem account SS must only show investment accounts whose `investProductType` is `wealth`; fund, money-fund, deposit, and precious-metal accounts must not appear in that selector.
- Wealth redemption should select from held wealth products under the selected wealth account. The principal reduces the holding, while the arrival amount is principal plus any entered interest.
- Wealth holdings should display a current holding date derived from the first buy date of the current non-zero principal cycle. When a product is fully redeemed, this holding date clears; if the product is bought again later, the new buy date starts the next holding cycle.
- Wealth transaction units are separate from principal. The units column must only show units, principal belongs in amount/cost, and average cost is principal divided by units. Holding clearing must use principal and units together: when a cycle has units, either remaining principal clearing or remaining units clearing means the holding is closed, because historical wealth redemptions may have one side missing or inconsistent; records without units fall back to remaining principal.
- Unit-based wealth buy transactions must persist the entered or calculated transaction NAV on the wealth transaction row. Unit-based wealth redemption profit is calculated from redeemed units and NAV difference: redeemed units times redemption NAV minus the corresponding original unit cost basis; if old buy NAV is missing, infer the original buy NAV from buy amount divided by units.
- Wealth products do not use a shared NAV library. NAV belongs only to the individual `WealthTransaction.nav` row and is either entered by the user or calculated as buy principal divided by buy units; later redemptions use those transaction-level values and the canonical holding cost basis.
- Wealth transaction detail tables should show the per-row remaining units for the same wealth product when the product uses units. This is a separate display value from the row's transaction units.
- Cash-side notes for linked wealth transactions should include the operation summary, including action, wealth product name, and units when available. The wealth business note remains the user-entered memo and must not be replaced by the generated cash-side summary in edit dialogs.
- If a wealth product already has unit-based records under the same wealth account, subsequent buy transactions for that product must include units. Do not allow continuing a unit-based holding with principal-only buys.
- Wealth product identity must use wealth-specific fields and URL params such as `wealthProductId`. Do not put wealth product IDs into fund-code UI semantics or URLs; `fundCode` is for funds and money funds.
- Wealth redemption arrival accounts may be any bank debit-card account plus e-wallet accounts under the same institution as the selected wealth account. This supports third-party wealth institutions redeeming either to linked bank debit cards or to their own e-wallet account.
- Wealth cash dividends should select from held wealth products under the selected wealth account, use a same-institution debit card as the arrival account, and must not reduce the held principal.
- Wealth cash dividend arrival amount is the dividend amount itself. Do not calculate it as principal plus interest; that formula belongs to wealth redemption.
- Wealth cash dividend realized profit is also the dividend amount itself. Do not calculate it from `interest - fee`; that fallback belongs to wealth redemption.
- Wealth holding selectors for redemption and dividends should respect the selected transaction date, so historical dividends can choose products that were held at that date even if they are now fully redeemed.
- Redemption/refund/withdrawal-style dialogs for funds, wealth, insurance, deposits, and similar investment products must expose an arrival date. In new dialogs, arrival date defaults to the operation/application date and can then be changed by the user. The business date remains the operation/application date; arrival date is the cash-arrival date. Deposit maturity date and withdrawal arrival date are separate semantics and must not be stored or displayed as the same field in independent business tables.

## Working Agreement For Future Changes

- Before implementing a change in a repeated problem area, check this file first.
- If the current request conflicts with an entry here, update this file as part of the same change.
- If the user says "I already said this before", that is a signal this file is missing a rule or the rule is too vague.
