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
- Sticky controls such as top-level filters or add buttons should not drift awkwardly with page scroll unless there is a clear workflow reason.
- The user wants stronger grouping control in sidebar views, especially for accounts, institutions, insurance, credit cards, debt, and deposits.
- Grouping and display mode are separate concerns. Do not mix "how accounts are grouped" with "how one account label is rendered".
- When showing grouped account lists, avoid repeating institution names inside child account labels if the parent group already shows the institution.

### Amount And Color Rules

- Keep sign/color rules unified everywhere.
- Do not compute sidebar balances from income minus expense.
- Insurance cash value belongs to the same family as balance/value displays.
- Coverage amount must be shown separately from cash value/balance, not merged into one ambiguous metric.
- Credit card amounts are liabilities and should follow the unified liability color/sign semantics.
- Transfers from cash/debit/e-wallet accounts into credit card accounts are internal transfers. Store and display them as `type=transfer`, set their category to "信用卡还款", and exclude them from income/expense statistics.
- Batch import must preserve "信用卡还款" as an explicit preview business type while saving it as `type=transfer` with category "信用卡还款". Its payment source is limited to debit-card and e-wallet accounts, and its target is limited to credit-card accounts.
- Bill import has two explicit modes. Regular-bill mode resolves the source and counter account for every row. Credit-card-statement mode uses one shared credit-card account for the whole file; spending/refunds belong to that card, while repayment rows separately select a debit-card or e-wallet source flowing into the shared card.
- Credit card unbilled/current-cycle rows may show cycle expense and refund/income activity, but should not show a bill amount or expose manual bill-amount editing before the statement is generated.
- Credit card billed-cycle rows that have been fully paid should show a clear settled marker in the repayment column, instead of requiring the user to infer settled status from amounts.
- Credit card bill amount is a rolling statement amount: previous bill amount plus current-cycle expense minus current-cycle income/refunds. It may cross below zero when income/refunds exceed the rolling bill; the UI should show that as an overpaid/credit-balance state instead of clamping it to zero. Repayments affect settled status and remaining balance, but must not reduce the displayed bill amount formula.
- Credit card billed-cycle settled status and paid amount should be derived from the next statement cycle's income/repayment inflow covering the current bill amount. Repayment belongs to the cycle after the bill is generated, not to the bill cycle's own income.
- Credit card billing day is the first day of the next statement cycle. For example, billing day 10 means the cycle runs from the 10th through the 9th of the next month, and transactions on the 10th belong to the next statement month.
- Credit card sidebar account numbers should show the current bill balance after repayments and overpayment are applied (`cumulativeRemain - cumulativeOverpaid`), not the current statement bill amount (`effectiveBill`).
- Credit card summary "refund/income" is the current cycle's inflow display: refunds, income, and transfers into the credit card during that cycle. Credit card repayments still settle the previous bill cycle, whose repayment column should show settled status rather than repeating the paid amount.
- Credit cards may also be the source side of an ordinary transfer. When the credit card is the source account, the row belongs to that credit card's statement month and counts as an outflow; only debit/e-wallet/cash transfers into a credit card should be labeled as credit-card repayment.
- 信用卡与借记卡共用支出、收入、代付、转账四种记账语义。信用卡支出和收入沿用相同分类及正负方向；信用卡代付属于信用卡转出并进入对应账期；信用卡还款属于借记卡/现金/电子钱包转入信用卡的转账，分类为“信用卡还款”，不计入收支统计。
- 信用卡账单列表和账单周期缓存默认只显示/生成到当前日期所属账期。未来分期还款流水可以保留在明细中，但不能把账单列表延展到未来年份。
- Credit card email bill import should mark mail that has local import history as "已导入", but must still allow the user to preview and import it again. Use mailbox UID, envelope hash, and stable parsed statement fingerprint only for marking and user warning, not as a hard duplicate block.
- Credit card views should expose an import entry in the visible detail/table workflow, not only inside the bill-summary mail-reading control.
- A credit-card statement's card heading is the account identity for every transaction listed under that heading. Parse the institution, card display name, and last four digits from headings such as "平安银行美国运通耀红卡（2222） 主卡", use them to match the existing credit-card account, and do not silently replace that account with whichever account page opened the mail-import window. If a statement contains multiple primary or supplementary-card headings, apply each heading only to its following transaction block.
- Credit-card statement parsing must not treat debit/repayment account tails as credit-card tails. Four-digit values near "扣款账号", "还款账号", "自动还款", "借记卡", "储蓄卡", or "Debit Account" are repayment-source account hints, not credit-card identity.
- Credit card statement import uses the label "入账日期" for posting date. The value should be date-only (`YYYY-MM-DD`), default to the transaction date when missing, and remain editable in the import preview.
- Ordinary transfer records are same-currency only. If two accounts use different currencies, the app should require a dedicated foreign-exchange/cross-currency flow that records both-side amounts and exchange rate instead of silently saving one amount.
- When changing a record between income/expense/advance and transfer in any edit or import-preview flow, preserve the account on the correct cash-flow side: income accounts become transfer target accounts, expense and advance accounts become transfer source accounts, transfer-to-income uses the target account, and transfer-to-expense/advance uses the source account.
- Insurance cash value should be treated like balance/value; coverage amount should remain a separate non-cash metric.
- Expense entries may use a negative input amount to represent a refund or reduction within the same expense category. Store it as `type=expense` with a positive cash-flow amount, not as income, so category statistics can offset the original expense.
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
- SS dropdown panels should not be squeezed to the parent input width when that hides important option context. Account SS options must keep institution information visible in the dropdown, either in the main label or in the sublabel, even inside compact dialogs.
- When `SmartSelect` is used inside popovers, modals, or batch-edit panels, its portal dropdown must remain scrollable and clickable. Parent outside-click handlers should treat the SmartSelect dropdown portal as part of the active interaction, not as an outside click.

### Date Inputs

- The agreed shared date input is called "步进日期框" in product discussion and `DateStepper` in code.
- A "步进日期框" means a native `type=date` input with `min="1900-01-01"` and `max="2999-12-31"`, invalid-state styling, a right-side calendar icon that toggles the picker, and in-field up/down buttons for next/previous day.
- New create/edit dialogs and high-frequency financial date fields should use `DateStepper` instead of a raw `input type="date"` unless a compact table filter or browser-native-only control has a specific reason to stay raw.

### Categories

- 分类名称在同一账簿内必须全局唯一，不区分收入、支出、代付、转账类型，也不区分一级、二级、三级或上级分类。二级和三级分类不能在不同父级下使用相同名称。
- 分类树可以表达层级和归属，但不能靠不同父级来区分同名分类。
- 批量导入、AI 识别和移动端按分类名称匹配时，应依赖这个全局唯一规则，避免用名称匹配到多个分类。
- 投资、还款、贷款等系统业务类别必须出现在分类管理中并标记为系统内置。用户不能改名、移动或删除这些系统类别，但可以在其下新增自己的子分类。
- 分类管理包含真正的“转账”系统父分类，“信用卡还款”是其子分类。分类管理用“转账”类型标题代表该父节点，避免重复显示两层“转账”。
- 分类管理包含真正的“投资”系统父分类，基金投资、理财投资、存款投资、贵金属投资、其他投资是其子分类；基金投资下继续分基金定投、基金买入、基金赎回、现金分红、分红再投资等具体动作分类。所有交易保存时应优先写入分类树中的 `categoryId`，即使是系统分类也不能只作为自由文本写入。投资买入、赎回和定投不计为普通收支，用户自定义的投资分类优先于自动系统分类。保险不统一归为投资：保费按保险支出、理赔/退保/满期领取按保险回款处理，只有未来明确建模的投连险投资账户部分才归投资。
- 在往来款明细中删除任何一笔记录都只软删除所选记录。删除首笔借入/借出记录不能删除往来账户、后续明细、还款计划或利率调整；删除整个往来项目必须使用独立的项目/账户删除入口。
- 往来款本金输入允许负数，便于修正和按用户习惯录入；现有数据模型仍以借入、借出、还款、收回等操作模式决定现金流方向，本金字段保存和计算金额大小，不用负号反转业务方向。
- 基金、理财、存款卖出/赎回/支取收益不应额外生成一条现金收入流水。现金账户只体现真实到账金额；基金已实现收益保存在投资交易 `realizedProfit` 中，理财和存款收益按 `depositInterest - fundFee` 计算，手续费必须扣入净收益。投资买入本身属于资产转换，不应作为收支支出统计；收支报表/统计应只映射收益、亏损、分红、利息等结果项。
- 统计项应优先挂接到收支分类树的分类 ID。普通交易使用保存的 `categoryId`，旧数据可按 `categoryName` 回挂；基金收益/亏损、理财收益/亏损、存款利息/手续费等派生统计项也必须解析到系统内置分类节点。分类名称只是显示兜底，不应成为长期统计主键。

### Table Column Filters

- Table header filters should reuse the shared `TableColumnFilter` component instead of creating page-specific dropdown variants.
- When a table needs a field filter, prefer placing it directly in the header label area beside the field name.
- For shared dropdown filter behavior, a single row click should select that row, clear other values, confirm, and close the menu unless a page has a stronger, documented requirement.
- If a new table filter needs different behavior, update the shared component first and let calling pages inherit the change.
- Table columns should support user-adjustable widths with remembered preferences when the table is dense enough to benefit from it.
- The same table surface should expose a unified header settings button instead of multiple unrelated per-page controls.
- Sorting behavior should be shared where possible, so a sort change in one table follows the same interaction model in other tables.
- Draggable table rows should use a dedicated drag handle. Dragging must not be bound to the whole row, and row-click selection must not consume an active text selection, so users can still select and copy text in cells.

### Shared Settings

- Settings that affect multiple screens should be centralized as a shared source of truth, not duplicated page by page.
- When the user changes a setting in one place, prefer reusing that setting everywhere the concept applies.
- If a page needs a different default, override only the default value, not the underlying setting shape or behavior.
- Login page "新建账簿" is not the same as creating a user or account. It should create a new ledger/household and must be gated by a higher-level permission such as an invite code.
- For password recovery, Resend is the preferred sending channel. SMTP or configured mailbox accounts are backup channels rather than the primary path.

### Accounts

- 银行理财买入时，理财账户只能使用资金来源账户的同机构账户，或同一所有人名下的第三方支付/钱包机构账户；不得选择其他银行的理财账户。新增理财产品时若同机构尚无理财账户，系统应继承资金来源账户的机构、所有人和币种自动建立并立即选中，已有账户则直接复用。
- 机构名称在同一账簿内使用同一个唯一名称池：任一机构的全称和简称都不能与任何机构的全称或简称重复，同一机构自己的全称和简称也不能相同。
- In cash/debit account entry, the counter/target account determines the business operation: normal cash targets save as transfers; fund/investment targets open investment entry; deposit targets open deposit-in/out entry; debt/settlement targets open borrow/lend/repay entry. Do not save these special targets as ordinary transfers.
- Account uniqueness matters. In the same household, accounts should not be indistinguishable under the same owner, institution, and account type. For bank debit/credit accounts, the last four digits are the primary differentiator; the same owner + institution + type + last-four combination is duplicate. If no last-four is available, the same owner + institution + type + account name is duplicate.
- Dropdown display names are not constrained by sidebar display settings. They should favor clarity.
- Statement and batch-import account matching should use the shared import account resolver. Match by institution aliases, account kind, account aliases, and card/account last four digits; do not let a page-specific matcher block accounts such as "招商银行储蓄卡（2758）" or "中国邮政储蓄银行信用卡" when the account table has a corresponding account.
- Sidebar display formatting rules and dropdown display formatting rules are separate concerns.
- Account display formatting must stay user-centered and configurable.
- Credit-card-like naming in import preview and account selection must show institution short name, card/product name, and last four digits when those fields are available; fallback rules must avoid empty or duplicated fragments.
- Statement and batch import account matching may use generic labels such as "中国建设银行信用卡". If the label contains an institution plus account kind but no last-four digits, automatically match only when there is exactly one active account of that institution and kind; otherwise leave it for user confirmation.
- Ledger/batch import should not expose a separate credit-card statement template entry. Credit-card statement rows use the generic bill-record template, keep legacy `cardAccount/type/merchant` header compatibility, and still validate credit-card repayment as a transfer into the credit-card account.
- In ledger/batch import, the presence of a `对向账户`-style column means accounts are row-level transfer accounts and must not trigger the credit-card statement unified-account mode. If `付款账户`/`还款账户` and `信用卡账户` appear together, the payment account is the source and the credit-card account is the counter/target account.
- When an account is created or edited, all fields that were previously entered must reliably round-trip back into the edit form.
- Any account display that does not visibly include owner and account category must expose them in hover text, using an owner-qualified shape such as `墨斗鱼 · 微信·零钱 · 电子钱包`.
- 收支机构永远只表示银行和第三方支付机构（`bank`、`payment`、`ewallet`），不得包含往来人员、往来组织、家庭成员或其他往来对象。普通收入/支出/转账里的“收支机构”使用机构表；代付、借入借出、还款等往来款流程使用往来对象表和往来对象 SS。
- 账户显示余额永远只计算到当前日期。账户列表、侧栏、概览、移动同步和账户 API 的余额不得提前纳入未来日期的计划任务、贷款/汽车分期、保险缴费或其他未来流水；未来记录可以存在于明细或计划中，但不能改变今天的账户显示余额。

### Insurance

- Insurance should exist as a first-class area alongside other major financial areas, not be hidden as a special case.
- Insurance product definition and owned policy/holding are different concepts and should not share one table forever.
- The same insurance product may be purchased by different owners or insured people, so product master data must be reusable across multiple policy/holding records.
- Insurance product master data is not a policy. It should contain reusable product facts such as name, type, insurer, currency, accounting type, and note. It must not contain policyholder, insured person, beneficiary, first purchase date, premium term, coverage amount, or premium records.
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

- Loan creation distinguishes `资金到账` from `消费分期`. Cash-disbursed loans create a transfer into the selected cash account. Financed purchases such as vehicle loans establish the payable principal directly on the loan account and use the selected cash account only for future repayments; they must never increase that cash account balance.
- Vehicle and other financed purchases remain loan liabilities with normal repayment plans, not credit-card installment plans. Their initial source is `debt_financed_purchase`; principal is recognized when the financed purchase occurs, while later repayments reduce the liability without counting principal again.
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
- The income/expense statistics table scrolls inside its own bounded panel with a frozen header. When drill-down details are open, a horizontal splitter must let the user resize the statistics panel height, and the chosen height should persist locally. The upper statistics panel must never collapse below half of the currently available split area.
- The reports workspace must not show a page-level vertical scrollbar. The statistics panel and drill-down detail panel each scroll internally within the remaining viewport height.
- Clicking a report amount should show the filtered records through the shared conventional transaction detail table used by account views, including the same column sizing, header filters, compact rows, selection, batch actions, and edit/delete controls. Do not maintain a separate simplified report-detail table.
- The shared conventional transaction table is named "MMH明细表" in the UI. It should provide checkboxes, batch edit/delete, header sorting and filtering, field/column settings, persisted column widths, and pagination with page-size and show-all controls.
- MMH明细表的筛选状态只作用于当前账户/当前表。切换账户或账单上下文时应清空筛选；列宽、隐藏列等用户偏好可以继续保留。
- 通用表格的处理边界以传入卡片/表格组件的 `rows` 为准：当前页是 20/40 条时，表格只筛选、排序、选择和渲染这 20/40 条；用户选择“全部”时才处理全量记录。外层页面必须先完成分页/上下文筛选，再把当前卡片应显示的记录传入表格。
- 通用表格的大数据渲染应只生成当前视图附近的行 DOM；屏幕外记录可以参与排序、筛选和统计，但不应因为一次复选、排序或单元格状态变化而全部重新渲染。表格必须保持 `table`/`colgroup`/表头/列宽结构稳定，不能为了优化牺牲表头与表体对齐。
- 通用表格字段应遵循同一契约：`render` 只负责显示；`filterText` 是用户可理解的筛选值，不能使用 ID；`filterSearchText` 可补充别名、机构、所有人、尾号等搜索内容；`sortValue` 必须是稳定可比较的原始值，例如数字金额、ISO 日期或完整名称；余额和操作列等不适合筛选排序的列不传筛选/排序字段。
- 账户类表格字段统一使用所有人、机构简称、账户名称/尾号、账户类型组成的展示语义，例如 `张四·招行·2758·借记卡`。如果可见文本被截断，悬浮说明或搜索文本必须保留完整账户语义。
- All report and MMH detail-table amounts must follow the configured red-up/green-down or green-up/red-down rule. Income uses its signed amount, expense uses its economic direction (normal expense is down; an expense refund is up), and net income uses its signed result.
- Report grouping controls such as monthly/yearly granularity should stay compact and sit directly under the income/expense report heading.
- Clicking a report amount should show the exactly filtered transaction records below the report, including parent-category descendants and signed expense offsets.
- Report drill-down rows must allow editing through the shared transaction editor and deleting with confirmation. After save or deletion, refresh the report totals, drill-down rows, affected account balances, and sidebar summaries through the shared finance refresh path.

### High-Frequency UX Themes

- User-initiated entry edits, batch edits, deletes, and batch deletes should expose one global "undo last operation" action. A batch is one atomic undo unit, and restoring it must refresh balances, holdings, bill caches, summaries, and current detail rows.
- Undo history is scoped by household and user and retains only the latest entry operation. Background recalculation must not create undo history. Whole-loan-project deletion remains outside ordinary entry undo because it hard-deletes the loan account, plans, and rates.

- Credit cards under the same institution share billing day, repayment day, and bill mode. Creating a card should prefill those values plus credit limit from an existing card at that institution; the inherited limit is only a default and must not overwrite existing cards.
- Credit-card bill mode is either separate or consolidated. Consolidated mode groups credit cards by household and institution, including inactive cards so historical bills remain stable, while preserving each transaction's concrete card account. Selecting any card in that group shows one combined bill and all group details.
- Consolidated bill cycles and manual bill overrides use one stable representative account resolved by shared server logic. Shared credit limits or institution-wide credit utilization are not inferred from consolidated billing.

- Credit-card installments have two explicit entries: `消费分期` in new credit-card expense entry, and `账单分期` on a posted statement row. Do not merge them into one ambiguous entry.
- Credit-card expense entry may create an installment plan for all or only part of the purchase. The original purchase remains unchanged; the financed principal is offset in its original statement, then installment principal plus fee/interest is added to each statement exactly once.
- A posted statement may convert all or part of its unpaid balance into a statement installment. Keep every original purchase unchanged, offset only the financed principal in the source statement, and add installments from the next statement month. The unfinanced balance remains due normally.
- Statement installments are owned by credit-card account plus source statement month, not by an arbitrary purchase. Current/unposted cycles and settled statements cannot create statement installments; a consolidated statement allows only one active plan for the same source month.
- Credit-card installments store structured plan and row fields. Do not infer installment number, principal, fee, or plan identity from notes.
- Installment rate input must distinguish annual interest from a per-period fee rate because these are not equivalent financial meanings.
- Deleting or restoring the source purchase or any generated installment row must cancel or restore the linked offset and all installment rows together.

- The product should reduce user operations wherever defaults can be inferred from institution, owner, account type, prior records, or current page context.
- Bill import has one user-facing upload entry. During parsing, the system automatically chooses regular-bill mode or credit-card-statement mode from the file structure and account content.
- XLSX bill import should merge worksheets that share the same header structure instead of reading only the first sheet, and the preview diagnostics should report sheet, candidate-row, recognized-row, and filtered-row counts.
- In development, bill import diagnostics should persist structured, privacy-safe events under one visible trace ID so parsing, validation, batch replacement, API ingestion, and failures can be correlated without logging raw statement text or account names.
- Import account selectors must show account type and owner alongside the account label. When multiple accounts match the same imported name, automatic matching must stop for manual confirmation, and the confirmed selection must retain a stable account ID through preview, batch replacement, and ingestion.
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
- All create/edit/import-preview windows should expose only one user-facing remark field. `toNote` is an internal compatibility/display field for transfer-like or specialized linked records; it must not appear as a second ordinary remark input.

### Investments And Precious Metals

- Precious metals should use dedicated dictionaries for metal type and unit. The UI should let users select "黄金/白银/铂金/钯金" and "克/千克/盎司/钱" style entries instead of asking users to type a fund-like code.
- Precious metal transaction create/edit flows must round-trip the selected type ID, unit ID, quantity, unit price, and fee through dedicated metal fields. Do not store precious-metal identity or quantity in fund fields such as `fundCode`, `fundName`, `fundUnits`, or `fundNav`.
- Precious metal buy/sell account SS must only show investment accounts whose `investProductType` is `metal`; fund, money-fund, wealth, and deposit accounts must not appear in that selector.
- Fund-like investment accounts should keep trading-calendar ownership at the account level. Confirm/arrival T+N calculation must read that account setting instead of assuming every fund account follows the same market calendar.
- Fund buy-refund matching should persist the refund row's `fundSourceEntryId` to the source buy row. Date fallback is only for old data migration and must not be the primary edit/save rule. In cash/debit account detail views, a buy-refund cash receipt displays and sorts by its actual arrival date (`fundArrivalDate`, falling back to `date`), the same as redemption cash receipts. In fund transaction detail views, linked buy-refund rows display and sort under the source buy row's application date (`date`), while the refund's own `fundArrivalDate` remains in the arrival-date column. `TxRecord.date` remains the original ledger/import transaction date and must not be overwritten by computed confirmation or arrival dates.
- Balance reconciliation and balance initialization rows that carry a `balance_reconcile_target:` marker are balance anchors. They represent the final balance at the end of their displayed local date, so they must sort after all ordinary records on the same displayed date for balance calculation, and before those ordinary same-day records in descending detail views.
- Ordinary transactions on the same displayed date may be manually reordered without changing their date. `TxRecord.dayOrder` stores this same-day business order: larger values mean later within the day, so they appear higher in descending detail views and later in ascending balance calculations. Balance anchors still outrank manual same-day order and remain the end-of-day record.
- Cash/debit card ledgers and fund transaction semantics are separate concepts even when both currently live in `TxRecord`. The cash/debit side should only render actual cash movement rows and dates. The fund side should render the fund business order, including application date, confirmation date, NAV, units, fee, and linked refund amount. A buy with a refund should be edited as one fund buy order that owns/updates the linked refund cash row, not as two unrelated edit windows.
- 资金交易与保险、基金、理财、存款、贵金属等业务明细应从“一条 TxRecord 同时承担两侧含义”迁移为“资金流水记录 + 独立业务交易表记录 + `EntryBusinessLink` 关联表”。当前已有独立业务表：`FundTransaction`、`InsuranceTransaction`、`WealthTransaction`、`DepositTransaction`、`PreciousMetalTransaction`；`TxRecord` 可暂时作为兼容投影和旧数据入口，但新增/同步路径应写入独立业务表并更新关联表。旧数据可以用 `legacy_combined_record` 自关联兼容，并通过回填迁移补出独立业务记录；删除提示应优先读取关联表，避免删除资金流水时无提示地删除业务明细。
- 保险、基金、理财、存款、贵金属的业务页面和业务汇总应优先读取各自独立业务交易表；`TxRecord` 只作为现金流水、旧数据兼容投影和迁移同步入口。新增、编辑、批量修改、删除、恢复和撤销都必须同步维护独立业务表及 `EntryBusinessLink`。
- 关联规则按“是否跨资金流水和独立业务台账”判断，而不是按页面临时决定。凡是一笔用户操作同时产生或影响资金流水记录和独立业务交易记录，就必须写入 `EntryBusinessLink` 并在资金侧和业务侧显示关联图标；适用范围包括基金申购/赎回/分红/买入退回、保险投保/续费/退保/理赔回款、银行理财买入/赎回/分红、存款存入/支取/利息、贵金属买入/卖出等。普通收入、支出、转账、代付、信用卡还款、纯估值快照、账户余额调整、只改变业务状态但没有对应资金流水的操作，不显示关联图标。存款需要关联，因为存入/支取同时有资金账户现金流和存款持仓/交易台账；存款利息属于这笔业务交易的收益字段，现金账户只显示实际到账金额。
- Fund buy units must be calculated from the net confirmed amount: `gross buy amount - linked refund amount - fee`, divided by NAV. The buy row's `fundUnits` stores this net confirmed units value. Linked buy-refund rows are cash-flow/relationship rows only and must not reduce units a second time in display, holding recalculation, NAV fill, import, or batch-edit paths.
- On app startup, the system should run a lightweight background check after login: execute due scheduled tasks, then fill due pending fund buy rows whose NAV or units are missing. This startup check must run from server-side database queries, not by loading every fund page in the client, and pending buy unit calculation must use the same net confirmed amount rule including linked refunds.
- Bank wealth products should use reusable wealth product master data. Wealth buy/redeem flows must select the product through SS and persist `wealthProductId` while keeping `fundName` only as display text.
- Bank wealth accounts must route to the wealth investment view and default to the wealth entry workflow. They must not be treated as open-end fund views just because they reuse investment-account storage.
- Wealth buy/redeem account SS must only show investment accounts whose `investProductType` is `wealth`; fund, money-fund, deposit, and precious-metal accounts must not appear in that selector.
- Wealth redemption should select from held wealth products under the selected wealth account. The principal reduces the holding, while the arrival amount is principal plus any entered interest.
- Wealth redemption arrival accounts may be any bank debit-card account plus e-wallet accounts under the same institution as the selected wealth account. This supports third-party wealth institutions redeeming either to linked bank debit cards or to their own e-wallet account.
- Wealth cash dividends should select from held wealth products under the selected wealth account, use a same-institution debit card as the arrival account, and must not reduce the held principal.
- Wealth holding selectors for redemption and dividends should respect the selected transaction date, so historical dividends can choose products that were held at that date even if they are now fully redeemed.
- Redemption/refund/withdrawal-style dialogs for funds, wealth, insurance, deposits, and similar investment products must expose an arrival date. In new dialogs, arrival date defaults to the operation/application date and can then be changed by the user. The business date remains the operation/application date; arrival date is the cash-arrival date. Deposit maturity date and withdrawal arrival date are separate semantics and must not be stored or displayed as the same field in independent business tables.

## Working Agreement For Future Changes

- Before implementing a change in a repeated problem area, check this file first.
- If the current request conflicts with an entry here, update this file as part of the same change.
- If the user says "I already said this before", that is a signal this file is missing a rule or the rule is too vague.
