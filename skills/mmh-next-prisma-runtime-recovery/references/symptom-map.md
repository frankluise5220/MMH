# Symptom Map

Use this table to avoid chasing the wrong class of failure.

## Prisma Says A Field Or Relation Is Unknown

Likely causes:
- running server still uses old generated Prisma client
- server was not restarted after schema or client change
- query path is older than the file you just inspected

Check:
- current running process
- Prisma generate state
- whether the error still matches current source

## Page Returns 500 But `tsc` Passes

Likely causes:
- runtime-only server error
- bad query input
- auth/session mismatch
- stale server process

Check:
- server logs
- page and API response bodies
- whether API JSON is actually redirected HTML

## Browser Still Shows Old Behavior

Likely causes:
- stale dev server
- stale browser cache
- wrong port or wrong environment
- changes landed in a different file path than the route actually serving traffic

Check:
- active process on serving port
- page hard refresh only after confirming the server is correct

## Parse Error Looks Impossible

Likely causes:
- file encoding damage
- CRLF/BOM or mojibake corruption
- partial bad patch left broken text in source

Check:
- actual UTF-8 file content
- nearby edited lines
- whether terminal rendering differs from file contents

## Connection Timeout Or Unexpected Disconnect

Likely causes:
- bad pooled connection
- aggressive timeout/idle defaults
- dev server resumed with old pool state

Check:
- `../../src/lib/db/prisma.ts`
- DB reachability separately from page reachability
