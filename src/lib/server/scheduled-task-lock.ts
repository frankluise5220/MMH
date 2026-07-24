import type { Prisma } from "@prisma/client";

/**
 * Serializes scheduled-task writes for one plan inside the current DB transaction.
 * This prevents two concurrent requests from both passing the pre-check and
 * inserting the same plan/date records before either transaction commits.
 */
export async function acquireScheduledTaskPlanLock(tx: Prisma.TransactionClient, planId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`scheduled-task:${planId}`}))`;
}
