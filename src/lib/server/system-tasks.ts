import { prisma } from "@/lib/db/prisma";
import { materializeDueInstallmentPayments } from "@/lib/server/credit-card-installment";
import { ensureAccountGroupMemberPairing } from "@/lib/server/account-group-member-pairing";
import { bootstrapPendingAccountBalances } from "@/lib/server/account-balance";
import { runStatementMailAutoImportTick } from "@/lib/server/statement-mail-auto-import";
import { logger } from "@/lib/logger";

/**
 * System-level scheduled tasks (no user session required).
 *
 * Currently: materialize due credit-card installment payment rows for ALL
 * households, self-heal the owner group <-> family member pairing (every
 * person owner becomes a real family member and vice versa), and pull the
 * next period's bill for households that enabled "next period auto import"
 * on an emailed statement. Runs periodically from `src/instrumentation-node.ts`
 * so all of them stay correct independent of any login.
 */
export async function runDueSystemTasks(): Promise<{
  materializedInstallments: number;
  bootstrappedAccountBalances: number;
  statementMailAutoImports: number;
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
  // 邮箱账单「下期自动导入」：到期的计划去 IMAP 把下一期账单取回来，落成待确认任务。
  // 这里只抓取不落账，失败重试由计划自己记录，不影响其它账簿。
  const mailAutoImports = await runStatementMailAutoImportTick().catch((error) => {
    logger.error("statement mail auto import tick failed", "system-task", { error });
    return { ran: 0, created: 0, failed: 0 };
  });
  return {
    materializedInstallments,
    bootstrappedAccountBalances,
    statementMailAutoImports: mailAutoImports.created,
  };
}
