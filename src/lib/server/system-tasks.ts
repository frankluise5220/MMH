import { prisma } from "@/lib/db/prisma";
import { materializeDueInstallmentPayments } from "@/lib/server/credit-card-installment";
import { ensureAccountGroupMemberPairing } from "@/lib/server/account-group-member-pairing";
import { bootstrapPendingAccountBalances } from "@/lib/server/account-balance";
import { logger } from "@/lib/logger";

/**
 * System-level scheduled tasks (no user session required).
 *
 * Currently: materialize due credit-card installment payment rows for ALL
 * households, and self-heal the owner group <-> family member pairing (every
 * person owner becomes a real family member and vice versa). Runs
 * periodically from `src/instrumentation-node.ts` so both stay correct
 * independent of any login.
 */
export async function runDueSystemTasks(): Promise<{
  materializedInstallments: number;
  bootstrappedAccountBalances: number;
}> {
  const households = await prisma.household.findMany({ select: { id: true } });
  let materializedInstallments = 0;
  for (const household of households) {
    try {
      const result = await materializeDueInstallmentPayments(prisma, { householdId: household.id });
      materializedInstallments += result.materialized;
    } catch (error) {
      logger.error("installment materialization failed for household", "system-task", { householdId: household.id, error });
    }
    try {
      await prisma.$transaction((tx) => ensureAccountGroupMemberPairing(tx, household.id));
    } catch (error) {
      logger.error("owner/member pairing self-heal failed for household", "system-task", { householdId: household.id, error });
    }
  }
  if (materializedInstallments > 0) {
    logger.info(`system task materialized ${materializedInstallments} installment rows`, "system-task");
  }
  const bootstrappedAccountBalances = await bootstrapPendingAccountBalances(1).catch((error) => {
    logger.error("account balance bootstrap failed", "system-task", { error });
    return 0;
  });
  if (bootstrappedAccountBalances > 0) {
    logger.info(`system task bootstrapped ${bootstrappedAccountBalances} account balances`, "system-task");
  }
  return { materializedInstallments, bootstrappedAccountBalances };
}
