# Roundtrip Audit

Follow this sequence for MMH dialogs.

## 1. Open

- Locate the record fetch or page-derived payload.
- Confirm that edit mode does not silently substitute "today", empty account IDs, or guessed values for saved values.
- Confirm that dropdown labels and stored IDs are not being confused.

## 2. Form State

- Compare form fields with database columns and linked tables.
- Note fields that are UI-only, derived-only, or saved fields.
- For new fields, verify both display and serialization.

## 3. Save

- Confirm parsing of money, decimals, dates, nullable strings, and IDs.
- Confirm that clearing a field writes `null` when appropriate.
- Confirm linked updates for pairs like `TxRecord` and `FundEntry`.

## 4. Refresh

- Identify which list, summary, or detail pane should refresh.
- Avoid broad refresh when a narrower refresh path already exists.
- Verify that the user remains in the same context when product memory says they should.

## 5. Reopen

- Reopen the saved record.
- Compare every critical field against the database-backed source.
- If anything differs, treat it as a round-trip bug even if the first save "looked successful."
