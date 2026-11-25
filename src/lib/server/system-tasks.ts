import { prisma } from "@/lib/db/prisma";
import { materializeDueInstallmentPayments } from "@/lib/server/credit-card-installment";
import { ensureAccountGroupMemberPairing } from "@/lib/server/account-group-member-pairing";
import { bootstrapPendingAccountBalances } from "@/lib/server/account-balance";
import { runStatementMailAutoImportTick } from "@/lib/server/statement-mail-auto-import";
import { syncPropertyAssetDepreciations } from "@/lib/server/property-depreciation";
import { accrueMoneyFundIncome } from "@/lib/server/money-fund-income-accrual";
import { accrueWalletMoneyFundIncome } from "@/lib/server/wallet-money-fund-income";
import { runDueDepositPlansForHousehold } from "@/lib/server/deposit-plan-tasks";
import { logger } from "@/lib/logger";

/**
 * System-level scheduled tasks (no user session required).
 *
 * Currently: materialize due credit-card installment payment rows for ALL
 * households, self-heal the owner group <-> family member pairing (every
 * person owner becomes a real family member and vice versa), accrue money-fund
 * daily income into shares (the yield is real money that lands every day, not a
 * redemption-time settlement), and pull the next period's bill for households
 * that enabled "next period auto import" on an emailed statement. Runs
 * periodically from `src/instrumentation-node.ts` so all of them stay correct
 * independent of any login.
 */
export async function runDueSystemTasks(): Promise<{
  materializedInstallments: number;
  bootstrappedAccountBalances: number;
  statementMailAutoImports: number;
  propertyDepreciations: number;
  moneyFundIncomeAccruals: number;
  depositPlanInterestRows: number;
}> {
  const households = await prisma.household.findMany({ select: { id: true } });
  let materializedInstallments = 0;
  let propertyDepreciations = 0;
  let moneyFundIncomeAccruals = 0;
  let depositPlanInterestRows = 0;
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
    // 固定资产直线法折旧：按月补记到当前月（走折旧台账，不动现金/收支）。
    try {
      const result = await syncPropertyAssetDepreciations({ householdId: household.id });
      propertyDepreciations += result.created;
    } catch (error) {
      logger.error("property depreciation sync failed for household", "system-task", { householdId: household.id, error });
    }
    // 货基每日万份收益是真实入账：服务端自己补结到昨天，用户不开页面也不会漏。
    try {
      const result = await accrueMoneyFundIncome({ householdId: household.id });
      if (result.status === "accrued") moneyFundIncomeAccruals += result.days ?? 0;
    } catch (error) {
      logger.error("money fund income accrual failed for household", "system-task", { householdId: household.id, error });
    }
    // 轻量模型（2026-11-19 用户裁定）：钱包直接挂货基代码，按日余额结息。
    try {
      const result = await accrueWalletMoneyFundIncome({ householdId: household.id });
      if (result.status === "accrued") moneyFundIncomeAccruals += result.days ?? 0;
    } catch (error) {
      logger.error("wallet money fund income accrual failed for household", "system-task", { householdId: household.id, error });
    }
    // 存款到期/取息：历史上只由「浏览器打开页面时的一次性自检」触发，用户不开页面
    // 就永远不生成利息（用户报的「生成记录要很久」就是这个）。放到服务端 10 分钟
    // 轮次上之后与是否开页面无关；保存路径仍会当场跑一次以保证即时性，
    // 两者由执行器内部的 runExclusive 互斥、幂等去重。
    try {
      const result = await runDueDepositPlansForHousehold({ householdId: household.id });
      depositPlanInterestRows += result.pairs;
    } catch (error) {
      logger.error("deposit plan execution failed for household", "system-task", { householdId: household.id, error });
    }
  }
  if (materializedInstallments > 0) {
    logger.info(`system task materialized ${materializedInstallments} installment rows`, "system-task");
  }
  if (moneyFundIncomeAccruals > 0) {
    logger.info(`system task accrued ${moneyFundIncomeAccruals} money-fund income days`, "system-task");
  }
  if (propertyDepreciations > 0) {
    logger.info(`system task recorded ${propertyDepreciations} property depreciation periods`, "system-task");
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
  if (depositPlanInterestRows > 0) {
    logger.info(`system task generated ${depositPlanInterestRows} deposit interest rows`, "system-task");
  }
  return {
    materializedInstallments,
    bootstrappedAccountBalances,
    statementMailAutoImports: mailAutoImports.created,
    propertyDepreciations,
    moneyFundIncomeAccruals,
    depositPlanInterestRows,
  };
}
