# Manual Test Prompts

Use these as a compact verification set after dialog changes.

- Open an existing record with every non-empty field populated. Save without changes. Reopen it and confirm nothing drifted.
- Edit one nullable field to empty. Save. Reopen and confirm it stayed empty instead of reverting.
- Change every selector once, including owner-scoped selectors. Save. Reopen and confirm stored IDs match displayed labels.
- Use save-and-add-another. Confirm preserved defaults match product expectations and that one-time fields reset.
- If the dialog affects summaries or linked detail tables, confirm only the relevant surfaces refresh.
- If the dialog manages linked tables, confirm both sides updated and that editing from each entry point still agrees.
