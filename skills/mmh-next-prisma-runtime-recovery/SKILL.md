---
name: mmh-next-prisma-runtime-recovery
description: Diagnose and recover MMH Next.js and Prisma runtime failures such as stale dev servers, Prisma client/schema drift, unexpected login-page HTML in API calls, port or process mismatches, connection-pool issues, and encoding corruption. Use when MMH pages stop rendering, runtime/build errors persist after code changes, Prisma validation errors mention old fields, or the app behaves like it is still running old code.
---

# MMH Next Prisma Runtime Recovery

Assume the failure may be runtime-state drift before assuming the latest source code is wrong. Classify the symptom, verify which process is serving traffic, then narrow the fix.

## Workflow

1. Classify the symptom.
   Separate build-time parse errors, runtime 500s, Prisma validation errors, connection failures, and "page still looks old" reports.
   Determine whether the symptom points to stale runtime, stale Prisma client, bad data, auth redirect, or actual logic bug.

2. Verify the serving target.
   Confirm which process owns the active port.
   Confirm whether the target page or API returns expected JSON/HTML, or a login page / redirect page instead.
   Do not trust browser screenshots alone when an API call may really be returning redirected HTML.

3. Check stale runtime and stale client drift.
   When Prisma complains about unknown fields or old relations, suspect old generated client or old dev server first.
   When code looks correct but runtime still shows the old error, suspect stale Next dev process or cache.
   Restart only the minimum process needed after confirming the likely drift.

4. Check schema and connection state.
   Compare Prisma schema, generated client expectations, and runtime query shape.
   For connection issues, inspect `../../src/lib/db/prisma.ts` and recent connection-pool defaults.
   Distinguish database-unreachable failures from single bad pooled connection behavior.

5. Check text and file health.
   If the failure looks syntactic but the file content is supposed to be fine, inspect UTF-8/LF/BOM/mojibake risk.
   Treat corrupted text as a real source issue, not terminal noise.

6. Conclude root cause before broad edits.
   State whether the fault is code logic, stale runtime, stale Prisma client, auth/session mismatch, encoding corruption, or process state.
   Apply the narrowest recovery that fixes the verified class of problem.

## Read These References

- Read `references/symptom-map.md` first to map the visible error to likely root causes.
- Read `references/runtime-triage.md` for the triage order and common checks.
- Read `references/recovery-playbook.md` before restarting services or regenerating runtime artifacts.

## Default Commands

Use these only as needed for the symptom:

```powershell
npx tsc --noEmit
```

```powershell
rg "Counterparty|routeKey|errorDetail|PrismaClientValidationError" src docs
```
