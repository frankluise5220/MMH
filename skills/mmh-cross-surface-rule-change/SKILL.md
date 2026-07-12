---
name: mmh-cross-surface-rule-change
description: Implement MMH business-rule or schema changes that must stay consistent across canonical modules, Prisma data, Web UI, `/api/v1` contracts, mobile-facing semantics, refresh behavior, and project docs. Use when adding or changing fields, calculations, naming, shared settings, account/fund/loan/insurance rules, routing semantics, or any change that could fork behavior across surfaces.
---

# MMH Cross-Surface Rule Change

Start from the canonical owner of the concept, not from the first page that mentions it. Treat every rule change as a multi-surface change until proven otherwise.

## Workflow

1. Read the project rules before editing behavior.
   Read `../../AGENTS.md` first.
   Read `../../docs/product-memory.md` when wording, workflow, grouping, SS behavior, or finance semantics may be affected.
   Read `../../docs/development-docs.md` when the change may require doc sync.

2. Identify the concept owner.
   Search `src/lib`, shared components, and existing route handlers before adding helpers.
   Extend the current canonical module when one already owns the concept.
   Prefer fund owners already called out in `AGENTS.md`, such as `confirmDays.ts`, `feeRate.ts`, `navCache.ts`, and `recalcPosition.ts`.

3. Build the impact map before patching code.
   Check data/storage impact: Prisma schema, migrations, cache tables, derived fields, and existing records.
   Check service impact: canonical modules, server actions, background executors, recalculation flows.
   Check client/API impact: `/api/v1` routes, route JSDoc, `../../docs/client-api.md`, mobile sync semantics, stable response shapes.
   Check UI impact: create/edit dialogs, SS selectors, tables, summaries, local refresh, save-and-add-another, and persisted preferences.
   Check docs impact: update the one document that owns the changed rule instead of scattering notes.

4. Implement from owner to callers.
   Patch canonical modules first.
   Patch routes and server actions next.
   Patch pages, dialogs, and shared components after the source-of-truth behavior is correct.
   Avoid partial migrations where old and new rule paths coexist without a clear compatibility reason.

5. Verify the full path of the changed rule.
   Verify read path, write path, derived totals, and recalculation path.
   Verify that the same business number is not being recomputed differently across views.
   Verify deterministic ordering for balance-sensitive lists when multiple records share a date.
   Verify that any added field round-trips through edit flows when relevant.

6. Sync docs only where ownership belongs.
   Update `../../docs/client-api.md` for client contract changes.
   Update `../../docs/check-investment-data.md` for fund or investment calculation changes.
   Update `../../docs/edit-window-checklist.md` if a reusable dialog rule changed.
   Update `../../docs/product-memory.md` when the user has effectively set a new cross-page product rule.

## Read These References

- Read `references/change-categories.md` to classify the change and choose the right checklist.
- Read `references/canonical-hotspots.md` when the request touches funds, dialogs, shared selectors, or shared tables.
- Read `references/sync-checklist.md` before final verification.

## Default Commands

Prefer fast repo inspection:

```powershell
rg --files .
rg "pattern" src docs
```

Prefer targeted validation:

```powershell
npx tsc --noEmit
```

Only run broader checks when the touched surface actually needs them.
