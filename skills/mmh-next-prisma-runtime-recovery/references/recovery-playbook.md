# Recovery Playbook

Choose the narrowest recovery that matches the verified cause.

## Stale Next Dev Server

- Restart the serving dev process.
- Recheck the target page/API after restart.
- Do not assume a restart fixed logic until the response actually changes.

## Stale Prisma Client

- Regenerate Prisma client when schema and runtime disagree.
- Restart the serving process after regeneration if the process caches the old client.

## Auth Redirect Masking API Debugging

- Confirm whether an API request without session is returning login HTML.
- Do not interpret redirected HTML as evidence that the mutation logic ran.

## Encoding Corruption

- Repair the touched file in clean UTF-8/LF.
- Avoid stacking more partial edits on corrupted text.

## Connection Pool Instability

- Test DB reachability separately from full page rendering.
- Inspect and adjust connection defaults only if the symptom is genuinely connection-state related.
