# Sync Checklist

Run this checklist before closing a cross-surface rule change.

- Did the canonical owner change before downstream callers?
- Did every new or changed field get both read-path and write-path coverage?
- If a route changed, did route JSDoc and `../../docs/client-api.md` change too?
- If a derived number changed, did summaries, details, and recalculation paths stay aligned?
- If a dialog touches the concept, can it reopen with saved values intact?
- If the change affects mobile semantics, did you at least inspect mobile-facing endpoints?
- If the change affects update/deploy behavior, did you inspect docs and Docker-related files?
- Did you avoid adding a duplicate helper for money, dates, signs, or fund logic?
- Did you run the smallest useful validation command for the touched surface?
