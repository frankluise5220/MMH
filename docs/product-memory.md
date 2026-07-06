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
- Insurance cash value should be treated like balance/value; coverage amount should remain a separate non-cash metric.

### SS Dropdowns

- SS dropdown is a shared system, not a one-off control.
- It should support nested add flows, search, keyboard movement, and owner/group cycling where appropriate.
- Different dropdowns may apply different filtering, but should reuse the same shared component behavior.
- Account-picking dropdowns should follow the established account SS behavior instead of each screen inventing a slightly different selector.
- Account SS dropdowns should generally support:
  - nested add
  - search
  - keyboard navigation
  - owner/group cycling
  - context-aware filtering
- The account SS experience used in the preferred transaction entry flow is the reference behavior that other account selectors should converge toward.
- Do not add extra always-visible owner header rows above the dropdown body when the cycling control already expresses owner switching.

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

### Accounts

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

## Working Agreement For Future Changes

- Before implementing a change in a repeated problem area, check this file first.
- If the current request conflicts with an entry here, update this file as part of the same change.
- If the user says "I already said this before", that is a signal this file is missing a rule or the rule is too vague.
