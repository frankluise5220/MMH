---
name: mmh-edit-dialog-roundtrip-audit
description: Audit MMH create/edit dialogs, save-and-add-another flows, import-preview edits, and shared selectors so values round-trip correctly from database to form state to save handler to refreshed UI. Use when building or modifying transaction dialogs, fund dialogs, debt dialogs, insurance dialogs, SS pickers, batch-edit forms, or any modal that has a history of losing fields or refreshing the wrong surface.
---

# MMH Edit Dialog Roundtrip Audit

Treat every MMH dialog change as a data round-trip problem, not just a JSX problem. Follow the value from database to form payload to save path to post-save refresh to reopen.

## Workflow

1. Read the dialog baseline first.
   Read `../../docs/edit-window-checklist.md`.
   Read `../../docs/product-memory.md` when the dialog includes SS behavior, owner scoping, grouping, wording, or save-and-add-another expectations.

2. Classify the dialog.
   Determine whether this is create, edit, save-and-add-another, batch edit, or import-preview editing.
   Determine whether the dialog owns one record, multiple linked records, or a master-plus-detail pair such as `TxRecord` and `FundEntry`.

3. Trace the open path.
   Find the query or payload builder that populates the dialog.
   Check whether every field comes from database truth or canonical derived data.
   Check whether defaults are intentional rather than accidental fallbacks to blank or current date.

4. Trace the save path.
   Check parsing, null handling, IDs, linked records, and optional fields.
   Check whether edits write every field needed for a later reopen to remain stable.
   Check whether linked entities such as `TxRecord`, `FundEntry`, plans, or account metadata stay synchronized.

5. Trace the refresh path.
   Verify what refreshes after save: affected row, summary, derived values, related detail list, or parent table.
   Prefer local or targeted refresh over full-page reset when the existing product rule expects stable context.
   Verify save-and-add-another preserves the right defaults and clears the right fields.

6. Reopen and compare.
   Reopen the same record after save.
   Compare against database truth for dates, account IDs, fund code, amounts, notes, and linked references.
   If the dialog supports clear-to-null behavior, verify that clearing a field survives reopen.

## Read These References

- Read `references/roundtrip-audit.md` for the full audit sequence.
- Read `references/high-risk-fields.md` before touching investment, debt, insurance, or linked-record dialogs.
- Read `references/manual-test-prompts.md` when you need a repeatable verification checklist.

## Default Commands

Use targeted search first:

```powershell
rg "openEdit|editPayload|saveAndAddAnother|linkId|linkType" src
```

Use targeted static validation after edits:

```powershell
npx tsc --noEmit
```
