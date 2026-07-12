# Runtime Triage

Follow this order unless the symptom clearly points elsewhere.

1. Confirm the exact failing surface.
   Page, API route, build, or background task.

2. Confirm the active runtime target.
   Which port?
   Which process?
   Which environment?

3. Confirm whether the response is the expected type.
   JSON endpoint returning HTML usually means redirect/auth mismatch.

4. Compare runtime failure with current source.
   If the error mentions code that no longer exists, suspect stale runtime or stale Prisma client.

5. Inspect project-specific runtime anchors.
   `../../src/lib/db/prisma.ts`
   active `/api/v1` route
   recent shared helpers touched by the failing route

6. Only then choose recovery.
   regenerate client
   restart dev server
   fix source
   repair encoding
