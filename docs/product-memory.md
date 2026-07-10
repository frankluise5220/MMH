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
- Transfers from debit/cash asset accounts into credit card accounts remain transfer records in storage, but all detail/display semantics should recognize them as credit card repayments ("还款") rather than ordinary transfers.
- Credit card unbilled/current-cycle rows may show cycle expense and refund/income activity, but should not show a bill amount or expose manual bill-amount editing before the statement is generated.
- Credit card billed-cycle rows that have been fully paid should show a clear settled marker in the repayment column, instead of requiring the user to infer settled status from amounts.
- Credit card bill amount is a rolling statement amount: previous bill amount plus current-cycle expense minus current-cycle income/refunds. It may cross below zero when income/refunds exceed the rolling bill; the UI should show that as an overpaid/credit-balance state instead of clamping it to zero. Repayments affect settled status and remaining balance, but must not reduce the displayed bill amount formula.
- Credit card billed-cycle settled status and paid amount should be derived from the next statement cycle's income/repayment inflow covering the current bill amount. Repayment belongs to the cycle after the bill is generated, not to the bill cycle's own income.
- Credit card billing day is the first day of the next statement cycle. For example, billing day 10 means the cycle runs from the 10th through the 9th of the next month, and transactions on the 10th belong to the next statement month.
- Credit card sidebar account numbers should show the current bill balance after repayments and overpayment are applied (`cumulativeRemain - cumulativeOverpaid`), not the current statement bill amount (`effectiveBill`).
- Credit card summary "refund/income" is the current cycle's inflow display: refunds, income, and transfers into the credit card during that cycle. Credit card repayments still settle the previous bill cycle, whose repayment column should show settled status rather than repeating the paid amount.
- Credit card email bill import must block duplicates at the server import layer. Use mailbox UID for old records, envelope hash for mail-list marking, and a stable parsed statement fingerprint for forwarded or re-synced messages whose sender, subject, or UID changed. The stable statement fingerprint should use institution, card last four digits, and statement month/cycle, not parser-sensitive fields such as category, note, or raw detail text.
- Ordinary transfer records are same-currency only. If two accounts use different currencies, the app should require a dedicated foreign-exchange/cross-currency flow that records both-side amounts and exchange rate instead of silently saving one amount.
- Insurance cash value should be treated like balance/value; coverage amount should remain a separate non-cash metric.
- Expense entries may use a negative input amount to represent a refund or reduction within the same expense category. Store it as `type=expense` with a positive cash-flow amount, not as income, so category statistics can offset the original expense.
- Expense entries may have a separate posting time (`postedAt`) when spending is recorded later than it happened. `TxRecord.date` remains the business/occurred date for category statistics and existing detail ordering unless a specific view explicitly switches to posting-time sorting.

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

### Categories

- 收支分类名称在同一账簿内必须全局唯一，不区分收入、支出、代付类型，也不区分上级分类。
- 分类树可以表达层级和归属，但不能靠不同父级来区分同名分类。
- 批量导入、AI 识别和移动端按分类名称匹配时，应依赖这个全局唯一规则，避免用名称匹配到多个分类。

### Table Column Filters

- Table header filters should reuse the shared `TableColumnFilter` component instead of creating page-specific dropdown variants.
- When a table needs a field filter, prefer placing it directly in the header label area beside the field name.
- For shared dropdown filter behavior, a single row click should select that row, clear other values, confirm, and close the menu unless a page has a stronger, documented requirement.
- If a new table filter needs different behavior, update the shared component first and let calling pages inherit the change.
- Table columns should support user-adjustable widths with remembered preferences when the table is dense enough to benefit from it.
- The same table surface should expose a unified header settings button instead of multiple unrelated per-page controls.
- Sorting behavior should be shared where possible, so a sort change in one table follows the same interaction model in other tables.

### Shared Settings

- Settings that affect multiple screens should be centralized as a shared source of truth, not duplicated page by page.
- When the user changes a setting in one place, prefer reusing that setting everywhere the concept applies.
- If a page needs a different default, override only the default value, not the underlying setting shape or behavior.
- Login page "新建账簿" is not the same as creating a user or account. It should create a new ledger/household and must be gated by a higher-level permission such as an invite code.
- For password recovery, Resend is the preferred sending channel. SMTP or configured mailbox accounts are backup channels rather than the primary path.

### Accounts

- In cash/debit account entry, the counter/target account determines the business operation: normal cash targets save as transfers; fund/investment targets open investment entry; deposit targets open deposit-in/out entry; debt/settlement targets open borrow/lend/repay entry. Do not save these special targets as ordinary transfers.
- Account uniqueness matters. Avoid allowing indistinguishable duplicate accounts when institution and name are the same and there is no differentiator such as last four digits.
- Dropdown display names are not constrained by sidebar display settings. They should favor clarity.
- Sidebar display formatting rules and dropdown display formatting rules are separate concerns.
- Account display formatting must stay user-centered and configurable.
- Credit-card-like naming often needs institution name, card/product name, and last four digits, but fallback rules must avoid empty or duplicated fragments.
- When an account is created or edited, all fields that were previously entered must reliably round-trip back into the edit form.

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
- Insurance policy list summary should be a table-like summary row at the bottom: "汇总" in the policy-name column and totals under total premium, cash value balance, and coverage amount.
- The lower insurance detail list should be called "投保记录", not generic "保险记录".
- Selecting a policy should filter the lower detail list to only records linked to that policy.
- Double-clicking a policy should open an edit dialog for policy name, policyholder, insured person, beneficiary, payment term, and related policy fields, using SS dropdowns where selection is needed.
- Editing an insurance premium record should only edit premium date, funding account, non-editable insurance product/policy, premium amount with two decimals, and note.
- Insurance create/edit dialogs must stay inside the viewport with a fixed full-screen overlay and scrollable body; they must not jump to the top of the page or overflow above the viewport.

### Deposits

- Deposit is not investment in the user mental model.
- Deposit flows should minimize user input by defaulting institution-related accounts and values whenever possible.
- Deposit holdings should behave more like holdings/lots with clear linkage between deposit-in and deposit-out records.
- Deposit should be treated as its own major operation type, not hidden under investment.
- Deposit-in and deposit-out flows should aggressively default institution-linked accounts and values to reduce user input.
- Deposit records should preserve linkage between the deposit lot and later withdrawal/redemption actions.

### Debt

- Debt/claim displays should match the user mental model for personal/family finance, not corporate finance wording.
- Names such as borrower/lender, borrowed/lent, or institution/person context matter and should be chosen carefully.
- Debt views should lean toward personal/family wording such as borrowed/lent or person/institution context, rather than formal enterprise wording.
- Debt details should behave more like position/detail views, with a clear summary by counterparty and linked detail records below.

### Overview

- Overview should avoid redundant repeated metrics.
- When multiple modules are shown together, layout should stay compact and comparable.
- Credit card, investment, insurance, debt, and daily account summaries should align visually where the concepts are parallel.
- Overview modules should avoid duplicate summaries between top blocks and detailed blocks.
- Comparative modules should align visually where the business concept is parallel, but should not force the same widget style when that hurts clarity.

### High-Frequency UX Themes

- The product should reduce user operations wherever defaults can be inferred from institution, owner, account type, prior records, or current page context.
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
- Fund buy units must be calculated from the net confirmed amount: `gross buy amount - linked refund amount - fee`, divided by NAV. The buy row's `fundUnits` stores this net confirmed units value. Linked buy-refund rows are cash-flow/relationship rows only and must not reduce units a second time in display, holding recalculation, NAV fill, import, or batch-edit paths.
- On app startup, the system should run a lightweight background check after login: execute due scheduled tasks, then fill due pending fund buy rows whose NAV or units are missing. This startup check must run from server-side database queries, not by loading every fund page in the client, and pending buy unit calculation must use the same net confirmed amount rule including linked refunds.
- Bank wealth products should use reusable wealth product master data. Wealth buy/redeem flows must select the product through SS and persist `wealthProductId` while keeping `fundName` only as display text.
- Wealth buy/redeem account SS must only show investment accounts whose `investProductType` is `wealth`; fund, money-fund, deposit, and precious-metal accounts must not appear in that selector.
- Wealth redemption should select from held wealth products under the selected wealth account. The principal reduces the holding, while the arrival amount is principal plus any entered interest.
- Wealth cash dividends should select from held wealth products under the selected wealth account, use a same-institution debit card as the arrival account, and must not reduce the held principal.
- Wealth holding selectors for redemption and dividends should respect the selected transaction date, so historical dividends can choose products that were held at that date even if they are now fully redeemed.

## Working Agreement For Future Changes

- Before implementing a change in a repeated problem area, check this file first.
- If the current request conflicts with an entry here, update this file as part of the same change.
- If the user says "I already said this before", that is a signal this file is missing a rule or the rule is too vague.
