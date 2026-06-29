# Product TODOs

## Insurance

### Split product master from owned policy/holding
Status: planned

Goal:
- Stop using one table to represent both reusable insurance product definition and one person's owned policy/holding.
- Allow the same insurance product to be purchased by different owners or insured users.

Target model:
- Insurance product master:
  - reusable product definition
  - product name, product type, insurer institution, accounting/display defaults
- Insurance owned policy/holding:
  - one purchased policy/holding under one owner/account context
  - owner, insured user, beneficiary, status, actual coverage, actual payment terms
- Insurance transaction records:
  - linked to the owned policy/holding

Implementation direction:
- Prefer additive migration first.
- Keep current `InsuranceProduct` data usable during transition.
- Add a reusable master table and link existing owned records to it.
- Migrate UI and APIs in steps rather than renaming everything in one pass.

Open implementation tasks:
- Add insurance product master table and relation field from current policy/holding records.
- Backfill existing insurance records into product masters by normalized product identity.
- Update create/edit form to choose/create product master separately from owned policy fields.
- Update insurance pages to display owned holdings while reading shared product metadata from product master.
- Update import/export and backup schemas after the data model stabilizes.

### Insurance account shell
Status: in progress

Goal:
- Insurance should appear as a peer group under accounts, alongside assets, credit cards, investments, and liabilities.
- The top-level sidebar nav should not keep a separate insurance shortcut once the account-group entry is the primary path.
- Each insurance account should behave like a dedicated account page.

Desired account-page shape:
- Left sidebar account group: `??`
- Under it: one row per insurance account, such as `???????`, `????????`
- Inside a selected insurance account page:
  - Top area: product summary for the products under this insurance account
  - Main list: records for this insurance account

Terminology direction:
- For now, keep the UI wording close to the existing investment shell pattern so the interaction stays familiar.
- Later decide whether insurance should keep the word `??` or switch to a more insurance-native term such as `??` / `????`.

Open implementation tasks:
- Remove remaining top-level insurance nav entries from sidebar chrome.
- Keep insurance only in the account-group sections.
- Refine the insurance account page so one account shows its own products and records, not only the global insurance overview.
- Recheck account switching, sidebar grouping, and insurance edit/create event refresh paths.

## Scheduled tasks

### Unify regular invest into generic scheduled tasks
Status: in progress

Goal:
- Replace the current narrow regular-invest mental model with a broader scheduled-task model.
- Keep fund regular invest as one task type, and add more task types later without duplicating scheduling logic.

Expected task categories:
- Fund regular investment.
- Loan repayment.
- Account transfer.
- Insurance premium payment.

Direction:
- Reuse the current regular-invest scheduler table and execution cadence fields where possible.
- Keep one shared plan view with common columns: funding account, task type, cycle, next run, executed count, and start date.
- Treat task-specific fields as task content: fund code/account, target account, loan account, or insurance product.
- Execution should call the existing transaction/investment/insurance semantics instead of inventing a new transaction type.
- Keep execution logs and next-run calculation unified.
- Daily auto execution may scan all active plans; plans whose next-run date has not arrived are skipped without creating transactions or recalculating balances.
- Web first; mobile can later consume the same API semantics.

Open implementation tasks:
- Design a generic scheduled-task data model.
- Decide whether to evolve `regularInvestPlan` in place or introduce a new table and migrate.
- Define task-type-specific payloads and validation rules.
- Define how insurance purchase tasks choose insurance account, product, owner, and funding account defaults.
- Define how transfer tasks choose source and destination account defaults.
- Update sidebar / navigation wording from `??` to `????` when the generic model is ready.
