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
  // 每轮 4 个账户做全量重算：与「只往前推进」不同，全量重算能纠正任何漏账，
  // 所以这一轮的吞吐直接决定错误最长存活时间。10 分钟 4 个 ≈ 每天 576 个，
  // 足够覆盖单账簿几百个账户的一天一轮。
  const bootstrappedAccountBalances = await bootstrapPendingAccountBalances(4).catch((error) => {
    logger.error("account balance bootstrap failed", "system-task", { error });
    return 0;
  });
  if (bootstrappedAccountBalances > 0) {
    logger.info(`system task bootstrapped ${bootstrappedAccountBalances} account balances`, "system-task");
  }
  return { materializedInstallments, bootstrappedAccountBalances };
}
