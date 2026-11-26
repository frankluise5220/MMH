import { AccountKind, CreditCardInstallmentSourceType, TransactionType, Prisma, type CreditBillingDayTxPeriod } from "@prisma/client";
import type { DetailEntry } from "@/components/DetailViewClient";
import type { CreditBillSummaryRow } from "@/components/CreditBillSummaryTable";
import { prisma } from "@/lib/db/prisma";
import { addDaysUtc, businessTodayUtcStart, toNumber, formatDateUtc } from "@/lib/date-utils";
import { getHouseholdTimeZone } from "@/lib/server/household-preferences";
import {
  CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE,
  CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE,
  applyNextCyclePaidToCreditBillSummaries,
  buildCreditCardCyclePersistRows,
  buildCreditBillCycleDefinitionsFromBillingDayRules,
  computeCreditBillCascade,
  creditBillEffectiveDate,
  billingDayAtDate,
  cycleForStatementMonthWithBillingDayRules,
  fillMissingCreditBillSummaries,
  hasCreditCardCycleLockSource,
  isCreditBillSettled,
  mergeCreditCardCycleLockSources,
  mergeCreditBillSummariesWithCascade,
  normalizeBillingDayTxPeriod,
  signedCreditBillAmountFromCardSide,
  classifyCreditBillFlowSide,
  summarizeCreditBillSignedFlows,
} from "@/lib/credit/billing";
import { partitionCreditCycles } from "@/lib/server/credit-cycles";
import { markInitialBillingDayRules } from "@/lib/credit/billing-day-rules";
import { normalizeCreditCardInstallmentStatementMonths, materializeDueInstallmentPayments } from "@/lib/server/credit-card-installment";
import { createCreditBillAccountResolver } from "@/lib/server/credit-card-institution-settings";
import { reconcileCreditCardBillingDayRulesFromAccounts } from "@/lib/server/credit-card-billing-day-rules";
import { buildEntryBusinessLinkSummary } from "@/lib/server/entry-business-link";
import {
  CREDIT_BILL_DETAIL_TYPES,
  creditBillEntryEffectiveDate,
  creditBillScopeKey,
  loadCreditBillEntryChannel,
  type CreditBillEntryChannel,
} from "@/lib/server/credit-bill-entry-channel";

type SelectedBillAccount = {
  id: string;
  kind: AccountKind;
  billingDay: number | null;
  repaymentDay: number | null;
  repaymentOffsetDays?: number | null;
  billingDayTxPeriod?: CreditBillingDayTxPeriod | null;
};

type CreditBillingDayRuleRow = {
  id: string;
  accountId: string;
  effectiveDate: string;
  billingDay: number;
  isInitial: boolean;
};

type CreditBillPageData = {
  creditCardBill: {
    start: Date;
    end: Date;
    due: Date | null;
    repayEnd: Date;
    bill: number;
    paid: number;
    remain: number;
    overpaid: number;
    expenseAbs?: number;
    income?: number;
    statementMonth: string;
    isCurrentCycle: boolean;
  } | null;
  currentStatementMonth: string;
  settledBillMonth: string;
  lastRepayToAccountId: string | undefined;
  lastRepayFromAccountId: string | undefined;
  creditBillSummaryRows: CreditBillSummaryRow[];
  selectedCreditBillMonth: string;
  creditBillBalanceValue: number;
  creditCardBillDetails: { cycleEntries: unknown[]; details: DetailEntry[] } | null;
  currentPage: number;
  billListPageSize: number;
  hasCreditBillSummaries: boolean;
  showAllCreditBillDetails: boolean;
  billingDayRules: CreditBillingDayRuleRow[];
  billingDay: number | null;
  billingDayTxPeriod: CreditBillingDayTxPeriod;
  repaymentDay: number | null;
  repaymentOffsetDays: number | null;
};

type LoadCreditBillPageDataParams = {
  householdId: string;
  selectedAccount: SelectedBillAccount | null;
  isBillAccount: boolean;
  billAccountIds: string[];
  billStorageAccountId: string;
  billMonthParam: string;
  billPage: number;
  hideZeroBills: boolean;
  hideSettledBills: boolean;
  view: string;
  t: (key: string) => string;
  forceCycleRefresh?: boolean;
  /** 手动重算时允许「全锁卡」也走一遍（金额仍保持锁定值），见 refreshCreditCardCycleCachesForAccountIds。 */
  forceLockedCyclesRefresh?: boolean;
  categoryLabels: Map<string, string>;
  isSettlementLiabilityAccountId: (accountId: string | null | undefined) => boolean;
  isCreditCardRepaymentForDisplay: (entry: any) => boolean;
  /**
   * 该卡（含副卡组）的全部流水，由 `loadCreditBillEntryChannel` 一次读出。
   *
   * 这里不再自己查 `prisma.txRecord`：月份列表、当期明细、还款汇总、周期失效
   * 判定全部从这一份数据在内存里派生，同一次渲染只读一次库。
   */
  entryChannel: CreditBillEntryChannel;
};

function ymdUtc(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function mdUtcDots(d: Date) {
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${m}.${day}`;
}

function toValidDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function toIsoOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? date.toISOString() : null;
}

function toDateOnlyUtcOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? formatDateUtc(date) : null;
}

function toYmdOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? ymdUtc(date) : null;
}

export async function loadCreditBillPageData(params: LoadCreditBillPageDataParams): Promise<CreditBillPageData> {
  const {
    householdId,
    selectedAccount,
    isBillAccount,
    billAccountIds,
    billStorageAccountId,
    billMonthParam,
    billPage,
    hideZeroBills,
    hideSettledBills,
    view,
    t,
    forceCycleRefresh = false,
    categoryLabels,
    isSettlementLiabilityAccountId,
    isCreditCardRepaymentForDisplay,
    entryChannel,
  } = params;

  const billAccountIdSet = new Set(billAccountIds);
  const scopedBillAccountIds = billAccountIds.length > 0 ? billAccountIds : selectedAccount ? [selectedAccount.id] : [];

  // Lazy materialization: create installment payment rows that became due
  // since the last daily job, so the bill view is correct even if the job
  // has not run yet. Non-fatal on failure.
  if (scopedBillAccountIds.length > 0) {
    await materializeDueInstallmentPayments(prisma, {
      householdId,
      accountIds: scopedBillAccountIds,
    }).catch((error) => {
      console.error("materialize installment payments failed:", error);
    });
  }

  // 账期判断用的「今天」必须是业务时区的今天：`new Date()` 取 UTC 日期会在
  // 北京时间 00:00–08:00 把账期算成前一天（当期账单/还款日提示全错）。
  const creditBillNow = businessTodayUtcStart(await getHouseholdTimeZone(householdId));
  const todayUtcStart = creditBillNow;
  const billingDayTxPeriod = normalizeBillingDayTxPeriod(selectedAccount?.billingDayTxPeriod);
  const shouldUseCreditBillingRules = isBillAccount && selectedAccount?.kind === AccountKind.bank_credit && billAccountIds.length > 0;
  if (shouldUseCreditBillingRules) {
    await prisma.$transaction((tx) =>
      reconcileCreditCardBillingDayRulesFromAccounts(tx, {
        householdId,
        accountIds: billAccountIds,
        asOf: creditBillNow,
      }),
    );
  }
  const billingDayRules = shouldUseCreditBillingRules
    ? await prisma.creditCardBillingDay.findMany({
        where: { accountId: { in: billAccountIds } },
        select: {
          id: true,
          accountId: true,
          effectiveDate: true,
          billingDay: true,
          // 还款日跟着同一条记录走：记录里没写才回退账户级设置。
          repaymentDay: true,
          repaymentOffsetDays: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      })
    : [];
  const billingDayRuleRows: CreditBillingDayRuleRow[] = markInitialBillingDayRules(
    billingDayRules
      .slice()
      .sort((a, b) =>
        a.effectiveDate.getTime() - b.effectiveDate.getTime() ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
      )
      .map((rule) => ({
        id: rule.id,
        accountId: rule.accountId,
        effectiveDate: ymdUtc(rule.effectiveDate),
        billingDay: rule.billingDay,
        repaymentDay: rule.repaymentDay,
        repaymentOffsetDays: rule.repaymentOffsetDays,
      })),
  );
  const currentBillingDay = billingDayAtDate(billingDayRules, creditBillNow);
  const fallbackBillingDay = null;
  const hasBillingDayRules = currentBillingDay != null;
  // Bump this timestamp whenever the credit-bill flow calculation logic
  // changes (e.g. classifyCreditBillFlowSide). It forces persisted cycle
  // summaries to be recomputed with the new logic instead of reusing stale
  // cached values. Last bumped: 2026-11-16 (`signedCreditBillAmountFromCardSide`
  // now treats every row whose destination is the card as inflow with
  // `Math.abs(amount)`, so refunds stored positive are no longer counted as
  // outflow; every persisted cycle has to be recomputed).
  const creditBillSummaryLogicUpdatedAt = new Date(Date.UTC(2026, 10, 16, 0, 0, 0));
  const latestBillingDayRuleUpdatedAt = billingDayRules.reduce<Date | null>(
    (latest, rule) => (!latest || rule.updatedAt > latest ? rule.updatedAt : latest),
    null,
  );
  const currentStatementMonth = (() => {
    if (!isBillAccount || !selectedAccount || !hasBillingDayRules) return "";
    const currentMonth = `${creditBillNow.getUTCFullYear()}-${String(creditBillNow.getUTCMonth() + 1).padStart(2, "0")}`;
    const nextMonthDate = new Date(Date.UTC(creditBillNow.getUTCFullYear(), creditBillNow.getUTCMonth() + 1, 1));
    const nextMonth = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
    const definitions = buildCreditBillCycleDefinitionsFromBillingDayRules({
      months: [currentMonth, nextMonth],
      billingDayRules,
      repaymentDay: selectedAccount.repaymentDay ?? null,
      repaymentOffsetDays: selectedAccount.repaymentOffsetDays ?? null,
      now: creditBillNow,
      fallbackBillingDay,
      billingDayTxPeriod,
    });
    const today = todayUtcStart.getTime();
    return Array.from(definitions.entries()).find(([, cycle]) => (
      today >= cycle.start.getTime() && today < addDaysUtc(cycle.end, 1).getTime()
    ))?.[0] ?? currentMonth;
  })();

  const normalizedCreditInstallments =
    isBillAccount && selectedAccount?.kind === AccountKind.bank_credit && currentBillingDay && billAccountIds.length > 0
      ? await prisma.$transaction((tx) =>
          normalizeCreditCardInstallmentStatementMonths(tx, {
            householdId,
            accountIds: billAccountIds,
            billingDay: currentBillingDay,
            billingDayTxPeriod,
          }),
        )
      : { updatedEntries: 0, updatedPlans: 0 };
  const installmentsChanged =
    normalizedCreditInstallments.updatedEntries > 0 || normalizedCreditInstallments.updatedPlans > 0;

  const isDisplayableBillMonth = (month: string) => !currentStatementMonth || month <= currentStatementMonth;
  const persistedCyclesInitial = isBillAccount && selectedAccount
    ? await prisma.creditCardCycle.findMany({
        where: {
          accountId: billStorageAccountId,
          ...(currentStatementMonth ? { statementMonth: { lte: currentStatementMonth } } : {}),
        },
        orderBy: { statementMonth: "desc" },
      })
    : [];
  const activeStatementInstallments = isBillAccount && selectedAccount?.kind === AccountKind.bank_credit
    ? await prisma.creditCardInstallmentPlan.findMany({
        where: {
          householdId,
          accountId: { in: billAccountIds },
          sourceType: CreditCardInstallmentSourceType.statement,
          sourceStatementMonth: { not: null },
          status: "active",
        },
        select: { sourceStatementMonth: true, installmentPrincipal: true },
      })
    : [];
  const statementInstallmentPrincipalByMonth = new Map(
    activeStatementInstallments.map((plan) => [
      plan.sourceStatementMonth ?? "",
      toNumber(plan.installmentPrincipal),
    ]),
  );
  const billOverrides = isBillAccount && selectedAccount
    ? await prisma.billOverride.findMany({
        where: { accountId: billStorageAccountId },
        orderBy: { statementMonth: "desc" },
      })
    : [];
  // 持久化周期不一定可信：手工改期/对账单导入会按提交值落库，一旦某期结束日
  // 落在邻月（例如 2017-06 被写成 05.01 ~ 05.31），相邻月份就会被挤成「两个月
  // 一期」，而这一期自己的流水没有周期可落。这类周期一律丢弃，按账单日规则重算，
  // 并通过下面的 stale 判断触发一次回写，把库里的坏周期改回来。
  const { accepted: consistentPersistedCycles, rejectedMonths: rejectedCycleMonths } = partitionCreditCycles(
    persistedCyclesInitial,
    billingDayTxPeriod,
  );
  const persistedCycleByMonth = new Map(consistentPersistedCycles.map((cycle) => [cycle.statementMonth, cycle]));
  // 写回时的「这一期是否已存在」必须看**含坏周期的全部行**：坏周期仍在库里，用上面
  // 只看自洽行的 map 判存在会把它当成缺失期再 INSERT 一次，撞 (accountId, statementMonth)
  // 唯一约束后整个事务回滚——坏周期永远修不掉，且每次首屏都白跑一次失败事务。
  const persistedAnyCycleByMonth = new Map(persistedCyclesInitial.map((cycle) => [cycle.statementMonth, cycle]));
  // 「坏周期」只有**真能修**的才算待修：判坏有两类原因，
  //   ① 这一期自己的起止日与账单日规则不符 → 重算会写回正确账期，可以修；
  //   ② 与邻期接不上（手工改期/对账单导入把某一期锁成自然月，缝在两侧）→ 重算
  //      得到的账期与库里完全一致（锁定期还会原样保留起止日），写回无任何变化。
  // 只有 ① 才该点亮 stale；否则第 ② 类会让 stale 永远为真，每次打开账单都要把
  // 全卡上百期重算一遍（实测花呗 140 期：2018-03 手工锁期、2019-09 是它的缝）。
  const repairedCycleMonths = new Set(
    [...rejectedCycleMonths].filter((statementMonth) => {
      const cycle = persistedAnyCycleByMonth.get(statementMonth);
      if (!cycle) return false;
      if (
        hasCreditCardCycleLockSource(cycle.lockSource, CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE) ||
        hasCreditCardCycleLockSource(cycle.lockSource, CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE)
      ) {
        return false;
      }
      if (!hasBillingDayRules || !selectedAccount) return true;
      const definition = cycleForStatementMonthWithBillingDayRules({
        statementMonth,
        billingDayRules,
        repaymentDay: selectedAccount.repaymentDay ?? null,
        repaymentOffsetDays: selectedAccount.repaymentOffsetDays ?? null,
        now: creditBillNow,
        fallbackBillingDay,
        billingDayTxPeriod,
      });
      if (!definition) return true;
      return (
        !sameCreditCycleDay(cycle.periodStart, definition.start) ||
        !sameCreditCycleDay(cycle.periodEnd, definition.end)
      );
    }),
  );
  // 周期缓存 stale 判定必须用**含软删行**的最新 updatedAt（删掉一笔流水后周期要
  // 重算），所以取通道的 latestAnyUpdatedAt，不能用 activeRows 的最大值。
  const latestBillTxUpdatedAt = isBillAccount && selectedAccount && entryChannel.latestAnyUpdatedAt
    ? { updatedAt: entryChannel.latestAnyUpdatedAt }
    : null;
  const activeBillTxCount = isBillAccount && selectedAccount ? entryChannel.activeCount : 0;
  const latestCycleUpdatedAt = persistedCyclesInitial.reduce<Date | null>(
    (latest, cycle) => (!latest || cycle.updatedAt > latest ? cycle.updatedAt : latest),
    null,
  );
  const latestOverrideUpdatedAt = billOverrides.reduce<Date | null>(
    (latest, override) => (!latest || override.updatedAt > latest ? override.updatedAt : latest),
    null,
  );
  const billOverrideAmountByMonthInitial = new Map(
    billOverrides.map((override) => [override.statementMonth, toNumber(override.amount)]),
  );
  const importedStatementCycleNeedsRecalc = persistedCyclesInitial.some((cycle) => {
    if (!hasCreditCardCycleLockSource(cycle.lockSource, CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE)) return false;
    const overrideAmount = billOverrideAmountByMonthInitial.get(cycle.statementMonth);
    if (overrideAmount === undefined) return false;
    return Math.abs(toNumber(cycle.effectiveBill) - overrideAmount) > 0.005;
  });
  // 锁定期（手工改账期 manual_cycle / 对账单导入 statement_import）的应还金额是外部
  // 事实：重算时把它当作 override 注入累计链，并且不覆盖这几期的金额。否则记一笔账
  // 就把银行给的/用户手改的金额冲掉，锁定形同虚设。
  const lockedCycleBillByMonth = new Map<string, number>();
  for (const cycle of persistedCyclesInitial) {
    if (
      hasCreditCardCycleLockSource(cycle.lockSource, CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE) ||
      hasCreditCardCycleLockSource(cycle.lockSource, CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE)
    ) {
      lockedCycleBillByMonth.set(cycle.statementMonth, toNumber(cycle.effectiveBill));
    }
  }
  // 「全锁」只说明已有账期不必重算；一旦跨进新账期（当前期没有周期行），仍然必须
  // 重算把这一期补出来，否则新账单永远不会出现。
  const allCyclesLocked =
    persistedCyclesInitial.length > 0 &&
    lockedCycleBillByMonth.size === persistedCyclesInitial.length &&
    (!currentStatementMonth || persistedCycleByMonth.has(currentStatementMonth));
  const creditCycleCacheStale = !!(
    isBillAccount &&
    selectedAccount &&
    (!allCyclesLocked || !!params.forceLockedCyclesRefresh) &&
    (
      forceCycleRefresh ||
      installmentsChanged ||
      persistedCyclesInitial.length === 0 ||
      (!!currentStatementMonth && !persistedCycleByMonth.has(currentStatementMonth)) ||
      (
        activeBillTxCount === 0 &&
        persistedCyclesInitial.some((cycle) =>
          toNumber(cycle.expenseAbs) !== 0 ||
          toNumber(cycle.income) !== 0 ||
          toNumber(cycle.paid) !== 0 ||
          toNumber(cycle.rawBill) !== 0 ||
          toNumber(cycle.effectiveBill) !== 0 ||
          toNumber(cycle.cumulativeRemain) !== 0 ||
          toNumber(cycle.cumulativeOverpaid) !== 0
        )
      ) ||
      !latestCycleUpdatedAt ||
      latestCycleUpdatedAt < creditBillSummaryLogicUpdatedAt ||
      // 这里故意不按「今天还没算过」自动重算：跨天本身不会改变已出账期的金额，
      // 而每次打开/切换账单都重算会把该卡全部历史周期（实测单卡 138~157 期）
      // 全部汇总 + 逐期 upsert 一遍。重算改由两处触发：
      //   ① 记账 / 编辑 / 删除流水后的 `invalidateCreditCardCycleCacheForAccountIds`（会立刻重建）；
      //   ② 账单页工具条的「重算账单」按钮（强制）。
      // 下面保留的都是「结构性缺失」兜底：周期表为空、当前期没行、坏周期待修、
      // 计算口径升级、以及写入路径漏失效导致流水比周期新。
      (!!latestBillingDayRuleUpdatedAt && latestBillingDayRuleUpdatedAt > latestCycleUpdatedAt) ||
      repairedCycleMonths.size > 0 ||
      importedStatementCycleNeedsRecalc ||
      (!!latestBillTxUpdatedAt?.updatedAt && latestBillTxUpdatedAt.updatedAt > latestCycleUpdatedAt) ||
      (!!latestOverrideUpdatedAt && latestOverrideUpdatedAt > latestCycleUpdatedAt)
    )
  );

  // Available bill months are derived from the billing-day history table. The
  // billing day is the cycle end date; if it changes mid-cycle, the current
  // cycle's end date moves to the newly effective billing day.
  const availableBillMonths =
    isBillAccount && selectedAccount && hasBillingDayRules
      ? await (async () => {
          // 月份列表同样从通道派生：整卡流水已经在内存里，不再扫一遍库。
          const rows = entryChannel.activeRows;
          const candidateMonths = new Set<string>();
          for (const row of rows) {
            const date = creditBillEffectiveDate(row);
            if (!date) continue;
            candidateMonths.add(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
            const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
            candidateMonths.add(`${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, "0")}`);
          }
          const cycleByMonth = buildCreditBillCycleDefinitionsFromBillingDayRules({
            months: Array.from(candidateMonths),
            billingDayRules,
            repaymentDay: selectedAccount.repaymentDay ?? null,
            repaymentOffsetDays: selectedAccount.repaymentOffsetDays ?? null,
            now: creditBillNow,
            fallbackBillingDay,
            billingDayTxPeriod,
          });
          const months = new Set<string>();
          for (const row of rows) {
            const date = creditBillEffectiveDate(row);
            if (!date) continue;
            const timestamp = date.getTime();
            const matchedMonth = Array.from(cycleByMonth.entries()).find(([, cycle]) => (
              timestamp >= cycle.start.getTime() && timestamp < addDaysUtc(cycle.end, 1).getTime()
            ))?.[0];
            if (matchedMonth && isDisplayableBillMonth(matchedMonth)) months.add(matchedMonth);
          }
          return Array.from(months).sort((a, b) => b.localeCompare(a));
        })()
      : [];

  const showAllCreditBillDetails = billMonthParam === "all";
  const selectedBillMonth =
    !showAllCreditBillDetails && /^(\d{4})-(\d{2})$/.test(billMonthParam) && isDisplayableBillMonth(billMonthParam)
      ? billMonthParam
      : "";

  const creditCardBill =
    isBillAccount && selectedAccount && hasBillingDayRules
      ? await (async () => {
          const base = selectedBillMonth
            ? (() => {
                const persisted = persistedCycleByMonth.get(selectedBillMonth);
                if (persisted) {
                  const today = todayUtcStart;
                  return {
                    start: persisted.periodStart,
                    end: persisted.periodEnd,
                    due: persisted.dueDate,
                    today,
                    isCurrentCycle: today >= persisted.periodStart && today < addDaysUtc(persisted.periodEnd, 1),
                  };
                }
                return cycleForStatementMonthWithBillingDayRules({
                  statementMonth: selectedBillMonth,
                  billingDayRules,
                  repaymentDay: selectedAccount.repaymentDay ?? null,
                  repaymentOffsetDays: selectedAccount.repaymentOffsetDays ?? null,
                  now: creditBillNow,
                  fallbackBillingDay,
                  billingDayTxPeriod,
                });
              })()
            : cycleForStatementMonthWithBillingDayRules({
                statementMonth: currentStatementMonth,
                billingDayRules,
                repaymentDay: selectedAccount.repaymentDay ?? null,
                repaymentOffsetDays: selectedAccount.repaymentOffsetDays ?? null,
                now: creditBillNow,
                fallbackBillingDay,
                billingDayTxPeriod,
              });
          if (!base) return null;

          const { start, end, due, today, isCurrentCycle } = base;
          const repayEnd = due && due.getTime() < today.getTime() ? due : today;
          const statementMonth = selectedBillMonth || currentStatementMonth;
          const cachedCycle = !creditCycleCacheStale
            ? persistedCyclesInitial.find((cycle) => cycle.statementMonth === statementMonth)
            : null;
          if (cachedCycle) {
            return {
              start: cachedCycle.periodStart,
              end: cachedCycle.periodEnd,
              due: cachedCycle.dueDate,
              repayEnd,
              bill: Number(cachedCycle.rawBill),
              paid: Number(cachedCycle.paid),
              remain: Number(cachedCycle.cumulativeRemain),
              overpaid: Number(cachedCycle.cumulativeOverpaid),
              statementMonth,
              isCurrentCycle: cachedCycle.isCurrentCycle,
            };
          }

          // 当期账单流水 + 还款汇总：都从通道的 activeRows 在内存里筛 / 折。
          const cycleStartMs = start.getTime();
          const cycleEndExclusiveMs = addDaysUtc(end, 1).getTime();
          const repayEndExclusiveMs = addDaysUtc(repayEnd, 1).getTime();
          const cycleFlowRows = entryChannel.activeRows.filter((row) => {
            if (!(row.accountId && billAccountIdSet.has(row.accountId)) && !(row.toAccountId && billAccountIdSet.has(row.toAccountId))) {
              return false;
            }
            const effective = creditBillEntryEffectiveDate(row);
            if (!effective) return false;
            const ms = effective.getTime();
            return ms >= cycleStartMs && ms < cycleEndExclusiveMs;
          });
          // 金额用 Decimal 累加：SQL 的 aggregate 原本走 decimal，改成浮点求和会在
          // 分位上产生 0.01 级别的漂移。
          const paidDecimal = entryChannel.activeRows.reduce((sum, row) => {
            if (row.type !== TransactionType.transfer) return sum;
            if (!row.toAccountId || !billAccountIdSet.has(row.toAccountId)) return sum;
            if (toNumber(row.amount) >= 0) return sum;
            if (!(row.date instanceof Date)) return sum;
            const ms = row.date.getTime();
            return ms >= cycleEndExclusiveMs && ms < repayEndExclusiveMs ? sum.plus(row.amount) : sum;
          }, new Prisma.Decimal(0));
          const paidAgg = { _sum: { amount: paidDecimal } };

          const flows = summarizeCreditBillSignedFlows(cycleFlowRows, billAccountIdSet);
          const bill = flows.bill;
          const income = flows.income;
          const expenseAbs = flows.expenseAbs;
          const paid = Math.max(0, -toNumber(paidAgg._sum.amount ?? 0));
          const remainRaw = bill - paid;
          const remain = Math.max(0, remainRaw);
          const overpaid = Math.max(0, -remainRaw);

          return { start, end, due, repayEnd, bill, paid, remain, overpaid, expenseAbs, income, statementMonth, isCurrentCycle };
        })()
      : null;

  const settledBillMonth = (() => {
    if (!currentStatementMonth) return "";
    const m = currentStatementMonth.match(/^(\d{4})-(\d{2})$/);
    if (!m) return "";
    const y = Number(m[1]);
    const monthIndex = Number(m[2]) - 1;
    const d = new Date(Date.UTC(y, monthIndex - 1, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  })();

  // The entry channel folds this scalar while reading, without retaining a
  // second copy of every row (including soft-deleted rows).
  const lastRepayCounterpartyAccountId =
    isBillAccount && selectedAccount
      ? entryChannel.lastRepayCounterpartyAccountId ?? undefined
      : undefined;

  const lastRepayToAccountId = lastRepayCounterpartyAccountId;
  const lastRepayFromAccountId = lastRepayCounterpartyAccountId;

  const billMonthsForList = (() => {
    const months = new Set<string>();
    for (const m of availableBillMonths) months.add(m);
    if (currentStatementMonth) months.add(currentStatementMonth);
    if (selectedBillMonth) months.add(selectedBillMonth);

    if (months.size > 0 && !hideZeroBills) {
      const sorted = Array.from(months).sort((a, b) => a.localeCompare(b));
      const earliest = sorted[0];
      const latest = sorted[sorted.length - 1];
      const [ey, em] = earliest.split("-").map(Number);
      const [ly, lm] = latest.split("-").map(Number);
      for (let y = ey; y <= ly; y++) {
        const startM = y === ey ? em : 1;
        const endM = y === ly ? lm : 12;
        for (let m = startM; m <= endM; m++) {
          months.add(`${y}-${String(m).padStart(2, "0")}`);
        }
      }
    }

    return Array.from(months).sort((a, b) => b.localeCompare(a));
  })();

  const billMonthsForCumulative = (() => {
    const merged = new Set<string>();
    if (currentStatementMonth) merged.add(currentStatementMonth);
    if (selectedBillMonth) merged.add(selectedBillMonth);
    for (const m of availableBillMonths) merged.add(m);

    const arr = Array.from(merged).sort((a, b) => a.localeCompare(b));
    if (arr.length === 0) return arr;
    const [ey, em] = arr[0]!.split("-").map(Number);
    const [ly, lm] = arr[arr.length - 1]!.split("-").map(Number);
    const full: string[] = [];
    for (let y = ey; y <= ly; y++) {
      const startM = y === ey ? em : 1;
      const endM = y === ly ? lm : 12;
      for (let m = startM; m <= endM; m++) {
        full.push(`${y}-${String(m).padStart(2, "0")}`);
      }
    }
    return full;
  })();

  const cycleDefinitionByMonth = buildCreditBillCycleDefinitionsFromBillingDayRules({
    months: Array.from(new Set([...billMonthsForCumulative, ...billMonthsForList, currentStatementMonth, selectedBillMonth].filter(Boolean))),
    billingDayRules,
    repaymentDay: selectedAccount?.repaymentDay ?? null,
    repaymentOffsetDays: selectedAccount?.repaymentOffsetDays ?? null,
    now: creditBillNow,
    fallbackBillingDay,
    billingDayTxPeriod,
  });

  const creditCycleDefinitions = (() => {
    const definitions: Array<{
      month: string;
      start: Date;
      end: Date;
      endExclusive: Date;
      due: Date | null;
      isCurrentCycle: boolean;
    }> = [];
    const account = selectedAccount;
    if (!isBillAccount || !account || !hasBillingDayRules) return definitions;

    for (const month of billMonthsForCumulative) {
      const persisted = persistedCycleByMonth.get(month);
      const base = persisted
        ? (() => {
            const today = new Date(Date.UTC(
              creditBillNow.getUTCFullYear(),
              creditBillNow.getUTCMonth(),
              creditBillNow.getUTCDate(),
            ));
            return {
              start: persisted.periodStart,
              end: persisted.periodEnd,
              due: persisted.dueDate,
              isCurrentCycle: today >= persisted.periodStart && today < addDaysUtc(persisted.periodEnd, 1),
            };
          })()
        : cycleDefinitionByMonth.get(month);
      if (!base) continue;
      definitions.push({
        month,
        start: base.start,
        end: base.end,
        endExclusive: addDaysUtc(base.end, 1),
        due: base.due,
        isCurrentCycle: base.isCurrentCycle,
      });
    }
    return definitions;
  })();

  const creditCycleDateRange = creditCycleDefinitions.length > 0
    ? {
        start: creditCycleDefinitions.reduce(
          (earliest, cycle) => cycle.start < earliest ? cycle.start : earliest,
          creditCycleDefinitions[0]!.start,
        ),
        endExclusive: creditCycleDefinitions.reduce(
          (latest, cycle) => cycle.endExclusive > latest ? cycle.endExclusive : latest,
          creditCycleDefinitions[0]!.endExclusive,
        ),
      }
    : null;

  const creditCycleActivityRows =
    creditCycleCacheStale &&
    isBillAccount &&
    selectedAccount &&
    creditCycleDefinitions.length > 0
      ? (() => {
          const rangeStartMs = creditCycleDateRange!.start.getTime();
          const rangeEndExclusiveMs = creditCycleDateRange!.endExclusive.getTime();
          return entryChannel.activeRows.filter((row) => {
            const effective = creditBillEntryEffectiveDate(row);
            if (!effective) return false;
            const ms = effective.getTime();
            return ms >= rangeStartMs && ms < rangeEndExclusiveMs;
          });
        })()
      : [];

  const creditCycleActivityByMonth = (() => {
    const totals = new Map(
      creditCycleDefinitions.map((cycle) => [
        cycle.month,
        { outflow: 0, inflow: 0 },
      ]),
    );
    const findMonthByDate = (date: Date | null) => {
      if (!date) return undefined;
      const timestamp = date.getTime();
      return creditCycleDefinitions.find(
        (cycle) => timestamp >= cycle.start.getTime() && timestamp < cycle.endExclusive.getTime(),
      )?.month;
    };

    for (const row of creditCycleActivityRows) {
      const side = classifyCreditBillFlowSide(row, billAccountIdSet);
      if (!side) continue;
      const signedAmount = signedCreditBillAmountFromCardSide(row, billAccountIdSet);
      if (signedAmount == null) continue;
      const month = findMonthByDate(creditBillEffectiveDate(row));
      if (!month) continue;
      const monthTotals = totals.get(month);
      if (!monthTotals) continue;
      if (side === "outflow") monthTotals.outflow += Math.abs(signedAmount);
      else monthTotals.inflow += Math.abs(signedAmount);
    }
    return totals;
  })();

  const persistedBillSummariesAll = persistedCyclesInitial.map((cycle) => ({
    month: cycle.statementMonth,
    start: cycle.periodStart,
    end: cycle.periodEnd,
    due: cycle.dueDate,
    bill: Number(cycle.rawBill),
    paid: Number(cycle.paid),
    remain: Number(cycle.cumulativeRemain),
    overpaid: Number(cycle.cumulativeOverpaid),
    expenseAbs: Number(cycle.expenseAbs),
    income: Number(cycle.income),
    isCurrentCycle: cycle.isCurrentCycle,
  }));

  const billSummariesAll =
    !creditCycleCacheStale
      ? persistedBillSummariesAll.filter((summary) => billMonthsForCumulative.includes(summary.month))
      : isBillAccount && selectedAccount && hasBillingDayRules && creditCycleDefinitions.length
        ? creditCycleDefinitions.map(({ month, start, end, due, isCurrentCycle }) => {
            const activity = creditCycleActivityByMonth.get(month) ?? {
              outflow: 0,
              inflow: 0,
            };
            const expenseAbs = activity.outflow;
            const income = activity.inflow;
            const bill = expenseAbs - income;
            return {
              month,
              start,
              end,
              due,
              bill,
              paid: 0,
              remain: bill,
              overpaid: 0,
              expenseAbs,
              income,
              isCurrentCycle,
            };
          })
        : [];

  const billSummariesAllWithNextCyclePaid = applyNextCyclePaidToCreditBillSummaries(billSummariesAll);
  const billSummaryByMonth = new Map(billSummariesAllWithNextCyclePaid.map((s) => [s.month, s]));
  const billSummaries = fillMissingCreditBillSummaries({
    months: billMonthsForList,
    summaryByMonth: billSummaryByMonth,
    billingDay: currentBillingDay ?? 1,
    repaymentDay: selectedAccount?.repaymentDay ?? null,
    repaymentOffsetDays: selectedAccount?.repaymentOffsetDays ?? null,
    now: creditBillNow,
    cycleByMonth: cycleDefinitionByMonth,
    billingDayTxPeriod,
  });

  const cachedOverrideByMonth = new Map<string, number>(
    billOverrides
      .filter((override) => !!override.statementMonth)
      .map((override) => [override.statementMonth, Number(override.amount)]),
  );
  const cachedEffectiveBillByMonth = new Map<string, number>(
    persistedCyclesInitial.map((cycle) => [cycle.statementMonth, Number(cycle.effectiveBill)]),
  );
  const cachedCumulativeByMonth = new Map<string, { cumulativeRemain: number; cumulativeOverpaid: number }>(
    persistedCyclesInitial.map((cycle) => [
      cycle.statementMonth,
      {
        cumulativeRemain: Number(cycle.cumulativeRemain),
        cumulativeOverpaid: Number(cycle.cumulativeOverpaid),
      },
    ]),
  );
  const creditCascade = !creditCycleCacheStale
    ? {
        overrideByMonth: cachedOverrideByMonth,
        allMonthsForCascade: persistedCyclesInitial
          .filter((cycle) => billMonthsForCumulative.includes(cycle.statementMonth))
          .sort((a, b) => a.statementMonth.localeCompare(b.statementMonth))
          .map((cycle) => ({
            month: cycle.statementMonth,
            bill: Number(cycle.rawBill),
            billDelta: Number(cycle.expenseAbs) - Number(cycle.income),
            paid: Number(cycle.paid),
          })),
        effectiveBillByMonth: cachedEffectiveBillByMonth,
        cumulativeByMonth: cachedCumulativeByMonth,
      }
    : computeCreditBillCascade({
        monthsForCascade: billMonthsForCumulative,
        summaryByMonth: billSummaryByMonth,
        // 锁定期的金额排在前面、用户手改的 BillOverride 排在后面：Map 构造时后者覆盖
        // 前者，保住「用户最后一次手改优先」的既有口径。
        overrides: [
          ...Array.from(lockedCycleBillByMonth, ([statementMonth, amount]) => ({ statementMonth, amount })),
          ...billOverrides.map((override) => ({
            statementMonth: override.statementMonth,
            amount: Number(override.amount),
          })),
        ],
      });
  const {
    overrideByMonth,
    allMonthsForCascade,
    effectiveBillByMonth,
    cumulativeByMonth,
  } = creditCascade;
  const creditCardCyclePersistRows = buildCreditCardCyclePersistRows({
    billingDay: currentBillingDay ?? 1,
    repaymentDay: selectedAccount?.repaymentDay ?? null,
    repaymentOffsetDays: selectedAccount?.repaymentOffsetDays ?? null,
    months: allMonthsForCascade,
    summaryByMonth: billSummaryByMonth,
    effectiveBillByMonth,
    cumulativeByMonth,
    overrideByMonth,
    now: creditBillNow,
    cycleByMonth: cycleDefinitionByMonth,
    billingDayTxPeriod,
  });

  if (creditCycleCacheStale && isBillAccount && selectedAccount) {
    await prisma.$transaction(async (tx) => {
      const persistStatementMonths = creditCardCyclePersistRows.map((row) => row.statementMonth);
      await tx.creditCardCycle.deleteMany({
        where: {
          accountId: billStorageAccountId,
          statementMonth: { notIn: persistStatementMonths },
          OR: [
            { lockSource: null },
            {
              AND: [
                { NOT: { lockSource: { contains: CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE } } },
                { NOT: { lockSource: { contains: CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE } } },
              ],
            },
          ],
        },
      });
      if (creditCardCyclePersistRows.length === 0) return;
      // 只写**真的变了**的期：stale 判定里只要有一期被判「坏周期」就会走这条重算
      // 路径，而重算结果常常与库中完全一致（坏周期多半是手工锁期这类外部事实，
      // 改不动）。以前无条件对全部期 upsert，一次首屏就是 140 次 UPDATE。
      const creates: Prisma.CreditCardCycleCreateManyInput[] = [];
      const updates: { statementMonth: string; data: Prisma.CreditCardCycleUpdateInput }[] = [];
      for (const row of creditCardCyclePersistRows) {
        // 用「全部行」判存在：被判坏的期也要走 UPDATE 把它修正，绝不能再 INSERT。
        const persistedCycle = persistedAnyCycleByMonth.get(row.statementMonth);
        const hasManualCycleLock = hasCreditCardCycleLockSource(
          persistedCycle?.lockSource,
          CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE,
        );
        const hasStatementImportCycleLock = hasCreditCardCycleLockSource(
          persistedCycle?.lockSource,
          CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE,
        );
        const hasFixedCyclePeriodLock = hasManualCycleLock || hasStatementImportCycleLock;
        const lockSource = mergeCreditCardCycleLockSources(
          row.lockSource,
          hasManualCycleLock ? CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE : null,
          hasStatementImportCycleLock ? CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE : null,
        );
        const isLocked = row.isLocked || hasFixedCyclePeriodLock;
        const periodStart = hasFixedCyclePeriodLock && persistedCycle ? persistedCycle.periodStart : row.periodStart;
        const periodEnd = hasFixedCyclePeriodLock && persistedCycle ? persistedCycle.periodEnd : row.periodEnd;
        const dueDate = hasFixedCyclePeriodLock && persistedCycle ? persistedCycle.dueDate : row.dueDate;
        const isCurrentCycle = hasFixedCyclePeriodLock && persistedCycle
          ? todayUtcStart >= periodStart && todayUtcStart < addDaysUtc(periodEnd, 1)
          : row.isCurrentCycle;
        // 锁定期只用新数据刷新「还款/累计/账期状态」，金额保持外部事实（对账单导入或
        // 手工改账期那一刻的值）。用户又在这期手改过金额（BillOverride）时例外：
        // 那个值必须落库，否则下次打开又会判定为「override 与缓存不一致」而反复重算。
        const amounts = hasFixedCyclePeriodLock && !billOverrideAmountByMonthInitial.has(row.statementMonth)
          ? {}
          : {
              expenseAbs: String(row.expenseAbs),
              income: String(row.income),
              rawBill: String(row.rawBill),
              effectiveBill: String(row.effectiveBill),
            };

        if (!persistedCycle) {
          creates.push({
            accountId: billStorageAccountId,
            statementMonth: row.statementMonth,
            periodStart,
            periodEnd,
            dueDate,
            expenseAbs: String(row.expenseAbs),
            income: String(row.income),
            paid: String(row.paid),
            rawBill: String(row.rawBill),
            effectiveBill: String(row.effectiveBill),
            cumulativeRemain: String(row.cumulativeRemain),
            cumulativeOverpaid: String(row.cumulativeOverpaid),
            isCurrentCycle,
            isLocked,
            lockSource,
          });
          continue;
        }

        const desired = {
          periodStart,
          periodEnd,
          dueDate,
          ...amounts,
          paid: String(row.paid),
          cumulativeRemain: String(row.cumulativeRemain),
          cumulativeOverpaid: String(row.cumulativeOverpaid),
          isCurrentCycle,
          isLocked,
          lockSource,
        };
        if (isCreditCardCycleRowUnchanged(persistedCycle, desired)) continue;
        updates.push({ statementMonth: row.statementMonth, data: desired });
      }

      if (creates.length > 0) {
        await tx.creditCardCycle.createMany({ data: creates });
      }
      for (const update of updates) {
        await tx.creditCardCycle.update({
          where: {
            accountId_statementMonth: {
              accountId: billStorageAccountId,
              statementMonth: update.statementMonth,
            },
          },
          data: update.data,
        });
      }
    }, { maxWait: 10_000, timeout: 60_000 });
  }

  const billSummariesWithCumulative = mergeCreditBillSummariesWithCascade(
    billSummaries,
    effectiveBillByMonth,
    cumulativeByMonth,
  );
  const displayBillRows = billSummariesWithCumulative
    .filter((s) => hideZeroBills ? !(s.expenseAbs === 0 && s.income === 0 && s.bill === 0 && s.paid === 0 && !s.isCurrentCycle) : true)
    .filter((s) => hideSettledBills ? !isCreditBillSettled(s) : true);

  const billListPageSize = 10;
  const totalPages = Math.ceil(displayBillRows.length / billListPageSize);
  const currentPage = Math.min(billPage, totalPages || 1);
  const creditBillSummaryRows: CreditBillSummaryRow[] = displayBillRows.map((s) => ({
    month: s.month,
    periodStart: ymdUtc(s.start),
    periodEnd: ymdUtc(s.end),
    dueDate: s.due ? ymdUtc(s.due) : "",
    periodLabel: `${mdUtcDots(s.start)} ~ ${mdUtcDots(s.end)}`,
    dueLabel: s.due ? ymdUtc(s.due) : "-",
    expenseAbs: s.expenseAbs,
    income: s.income,
    paid: s.paid,
    effectiveBill: s.effectiveBill,
    isCurrentCycle: s.isCurrentCycle,
    hasOverride: billOverrides.some((o) => o.statementMonth === s.month),
    statementInstallmentPrincipal: statementInstallmentPrincipalByMonth.get(s.month) ?? null,
  }));

  const creditBillMonth = creditCardBill?.statementMonth ?? "";
  const selectedCreditBillMonth = showAllCreditBillDetails ? "" : (selectedBillMonth || creditBillMonth);
  const creditBillBalanceValue = (() => {
    if (!currentStatementMonth) return (creditCardBill?.remain ?? 0) - (creditCardBill?.overpaid ?? 0);
    const effective = effectiveBillByMonth.get(currentStatementMonth);
    if (effective !== undefined) return effective;
    const cum = cumulativeByMonth.get(currentStatementMonth);
    if (cum) return cum.cumulativeRemain - cum.cumulativeOverpaid;
    return (creditCardBill?.remain ?? 0) - (creditCardBill?.overpaid ?? 0);
  })();

  const creditCardBillDetails =
    view === "bill" && !showAllCreditBillDetails && creditCardBill && isBillAccount
      ? await (async () => {
          const { start, end } = creditCardBill;
          // Detail rows must be ordered by the effective (display) date: the
          // posting date for expense/income with a transaction-date fallback —
          // the same key compareDetailEntriesDesc (shared with the client
          // detail table) uses. Prisma cannot order by a per-type COALESCE, so
          // rows are fetched in the same three branches as
          // creditBillDateRangeWhere and merged in memory.
          // Hydrate the complete selected period; a row limit must not hide
          // records from the client-side pagination controls.
          const cycleEntries = await entryChannel.loadCycleDetailRows({
            start,
            end: addDaysUtc(end, 1),
            sortAccountId: selectedAccount?.id ?? null,
            types: CREDIT_BILL_DETAIL_TYPES,
            take: Math.max(1, entryChannel.activeCount),
          });
          const details: DetailEntry[] = cycleEntries.map((e) => ({
            id: e.id,
            date: toYmdOrNull(e.date) ?? "",
            postedAt: toDateOnlyUtcOrNull(e.postedAt),
            createdAt: toIsoOrNull(e.createdAt),
            entryOrigin: e.entryOrigin ?? null,
            dayOrder: e.dayOrder ?? 0,
            amount: toNumber(e.type === TransactionType.transfer && billAccountIdSet.has(e.toAccountId ?? "") ? Math.abs(toNumber(e.amount)) : e.amount),
            currency: e.currency ?? e.account?.currency ?? e.toAccount?.currency ?? "CNY",
            runningBalance: null,
            type: e.type,
            categoryId: e.categoryId,
            categoryName:
              e.type === TransactionType.expense || e.type === TransactionType.income
                ? e.categoryId
                  ? categoryLabels.get(e.categoryId) ?? e.categoryName ?? t("txForm.uncategorized")
                  : e.categoryName ?? t("txForm.uncategorized")
                : isCreditCardRepaymentForDisplay(e)
                  ? t("transaction.category.creditCardRepayment")
                  : e.categoryName,
            accountId: e.accountId,
            accountName: e.accountName,
            accountKind: e.account?.kind ?? null,
            accountLiabilityDirection: e.account?.liabilityDirection ?? null,
            accountIsSettlementAccount: isSettlementLiabilityAccountId(e.accountId),
            counterpartyInstitutionId: e.counterpartyInstitutionId ?? null,
            counterpartyInstitutionName: e.counterpartyInstitutionName ?? null,
            originalCurrency: e.originalCurrency ?? null,
            originalAmount: e.originalAmount == null ? null : toNumber(e.originalAmount),
            locationId: e.locationId ?? null,
            locationName: e.locationName ?? null,
            toAccountId: e.toAccountId,
            toAccountName: e.toAccountName,
            toAccountKind: e.toAccount?.kind ?? null,
            toAccountLiabilityDirection: e.toAccount?.liabilityDirection ?? null,
            toAccountIsSettlementAccount: isSettlementLiabilityAccountId(e.toAccountId),
            note: e.note,
            toNote: e.toNote,
            fundSubtype: e.fundSubtype,
            fundCode: e.fundCode,
            fundName: e.fundName,
            wealthProductId: e.wealthProductId ?? null,
            depositProductId: e.depositProductId ?? null,
            source: e.source,
            insuranceProductId: e.insuranceProductId ?? null,
            principalAmount: e.principalAmount != null ? toNumber(e.principalAmount) : null,
            interestAmount: e.interestAmount != null ? toNumber(e.interestAmount) : null,
            feeAmount: e.feeAmount != null ? toNumber(e.feeAmount) : null,
            depositAnnualRate: e.depositAnnualRate != null ? toNumber(e.depositAnnualRate) : null,
            depositInterest: e.depositInterest != null ? toNumber(e.depositInterest) : null,
            fundProductType: e.fundProductType,
            metalTypeId: e.metalTypeId ?? null,
            metalTypeName: e.metalTypeName ?? null,
            metalUnitId: e.metalUnitId ?? null,
            metalUnitName: e.metalUnitName ?? null,
            metalQuantity: e.metalQuantity != null ? toNumber(e.metalQuantity) : null,
            metalUnitPrice: e.metalUnitPrice != null ? toNumber(e.metalUnitPrice) : null,
            metalFee: e.metalFee != null ? toNumber(e.metalFee) : null,
            fundUnits: e.fundUnits != null ? toNumber(e.fundUnits) : null,
            fundNav: e.fundNav != null ? toNumber(e.fundNav) : null,
            fundFee: e.fundFee != null ? toNumber(e.fundFee) : null,
            fundConfirmDate: toIsoOrNull(e.fundConfirmDate),
            fundArrivalDate: toIsoOrNull(e.fundArrivalDate),
            fundArrivalAmount: e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null,
            ...buildEntryBusinessLinkSummary(e),
            attachments: (e.Attachment || []).map((attachment: any) => ({
              id: attachment.id,
              name: attachment.name ?? "",
              mimeType: attachment.mimeType ?? null,
              url: attachment.url ?? `/api/v1/attachments/${encodeURIComponent(attachment.id)}`,
            })),
            entryTags: (e.EntryTag || []).map((et: any) => ({
              tagId: et.tagId,
              Tag: et.Tag ? { name: et.Tag.name, color: et.Tag.color } : null,
            })),
          }));
          return { cycleEntries, details };
        })()
      : null;

  return {
    creditCardBill,
    currentStatementMonth,
    settledBillMonth,
    lastRepayToAccountId,
    lastRepayFromAccountId,
    creditBillSummaryRows,
    selectedCreditBillMonth,
    creditBillBalanceValue,
    creditCardBillDetails,
    currentPage,
    billListPageSize,
    hasCreditBillSummaries: billSummariesWithCumulative.length > 0,
    showAllCreditBillDetails,
    billingDayRules: billingDayRuleRows,
    billingDay: currentBillingDay,
    billingDayTxPeriod,
    repaymentDay: selectedAccount?.repaymentDay ?? null,
    repaymentOffsetDays: selectedAccount?.repaymentOffsetDays ?? null,
  };
}

export async function refreshCreditCardCycleCachesForAccountIds(params: {
  householdId: string;
  accountIds: Iterable<string | null | undefined>;
  /**
   * 用户手动点「重算账单」时传 true：全锁卡也走一遍，好让还款进度/累计金额跟上，
   * 但锁定期本身的金额与账期仍然保持外部事实（不会被重算覆盖）。
   */
  forceLocked?: boolean;
}) {
  const accountIds = Array.from(
    new Set(Array.from(params.accountIds).filter((accountId): accountId is string => Boolean(accountId))),
  );
  if (accountIds.length === 0) return 0;

  const accounts = await prisma.account.findMany({
    where: {
      id: { in: accountIds },
      householdId: params.householdId,
      kind: AccountKind.bank_credit,
    },
    select: {
      id: true,
      householdId: true,
      institutionId: true,
      groupId: true,
      kind: true,
      billingDay: true,
      repaymentDay: true,
      repaymentOffsetDays: true,
      creditBillMode: true,
      cardRole: true,
      primaryCardId: true,
      billingDayTxPeriod: true,
    },
  });

  const accountSnapshot = await prisma.account.findMany({
    where: { householdId: params.householdId, kind: AccountKind.bank_credit },
    select: {
      id: true,
      householdId: true,
      institutionId: true,
      groupId: true,
      kind: true,
      creditBillMode: true,
      cardRole: true,
      primaryCardId: true,
    },
  });
  const resolveCreditBillAccountIds = createCreditBillAccountResolver(accountSnapshot);

  const refreshGroups = new Map<
    string,
    {
      selectedAccount: SelectedBillAccount;
      billAccountIds: string[];
      billStorageAccountId: string;
    }
  >();
  for (const account of accounts) {
    const billAccountIds = resolveCreditBillAccountIds(account);
    const billStorageAccountId = billAccountIds[0] ?? account.id;
    if (refreshGroups.has(billStorageAccountId)) continue;
    refreshGroups.set(billStorageAccountId, {
      selectedAccount: account,
      billAccountIds,
      billStorageAccountId,
    });
  }

  let refreshedGroups = 0;
  for (const group of refreshGroups.values()) {
    // 全卡账单都锁定（手工改账期 / 对账单导入）且当前期已有行时，重算既改不动任何
    // 金额、又要白算 140+ 期，直接跳过；跨进新账期（当前期缺行）仍需补期。
    if (!params.forceLocked && await areCreditCardCyclesFullyLocked(group.billStorageAccountId, params.householdId)) continue;
    await loadCreditBillPageData({
      householdId: params.householdId,
      selectedAccount: group.selectedAccount,
      isBillAccount: true,
      billAccountIds: group.billAccountIds,
      billStorageAccountId: group.billStorageAccountId,
      billMonthParam: "",
      billPage: 1,
      hideZeroBills: false,
      hideSettledBills: false,
      view: "refresh",
      t: (key) => key,
      forceCycleRefresh: true,
      forceLockedCyclesRefresh: !!params.forceLocked,
      categoryLabels: new Map(),
      isSettlementLiabilityAccountId: () => false,
      isCreditCardRepaymentForDisplay: () => false,
      entryChannel: await loadCreditBillEntryChannel(params.householdId, creditBillScopeKey(group.billAccountIds)),
    });
    refreshedGroups += 1;
  }

  return refreshedGroups;
}

/**
 * 该卡（账单存储账户）的全部周期是否都已锁定，且当前账期已经在周期表里。
 *
 * 「全锁」本身不足以跳过重算：跨进新账期时当前期还没有行，必须算一次把它补出来。
 * 这里用周期自身的 `periodStart..periodEnd` 判断今天是否落在某一期内，避免为了
 * 判断「当前期是哪个月」再跑一遍账单日规则。
 */
async function areCreditCardCyclesFullyLocked(billStorageAccountId: string, householdId: string) {
  const cycles = await prisma.creditCardCycle.findMany({
    where: { accountId: billStorageAccountId },
    select: { lockSource: true, periodStart: true, periodEnd: true },
  });
  if (cycles.length === 0) return false;
  const allLocked = cycles.every(
    (cycle) =>
      hasCreditCardCycleLockSource(cycle.lockSource, CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE) ||
      hasCreditCardCycleLockSource(cycle.lockSource, CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE),
  );
  if (!allLocked) return false;
  const todayUtcStart = businessTodayUtcStart(await getHouseholdTimeZone(householdId));
  return cycles.some((cycle) => cycle.periodStart <= todayUtcStart && todayUtcStart <= cycle.periodEnd);
}

/**
 * 周期行「是否需要落库」的判定：period / 到期日 / 状态位 / 金额都相同就跳过写入。
 * 金额用数值比较 —— 库里是 `Decimal`（`"100"`），算出来是 `String(number)`（`"100"`），
 * 字符串形式可能带尾零，直接比字符串会永远判定为「变了」。
 */
function sameCreditCycleDay(left: Date | null, right: Date | null): boolean {
  if (!left || !right) return left === right;
  return left.getTime() === right.getTime();
}

function sameCreditCycleAmount(left: unknown, right: unknown): boolean {
  const a = Number(left);
  const b = Number(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return String(left) === String(right);
  // 必须按库里的列精度（`Decimal(18, 2)`）比较：汇总出来的是浮点结果（例如
  // `1234.5649999`），写进 numeric(18,2) 会被四舍五入成 `1234.56`，用 `===` 比
  // 就永远判定「变了」，每次打开账单都要把这几十期原样 UPDATE 一遍。
  return Math.round(a * 100) === Math.round(b * 100);
}

function isCreditCardCycleRowUnchanged(
  persisted: {
    periodStart: Date;
    periodEnd: Date;
    dueDate: Date | null;
    expenseAbs?: unknown;
    income?: unknown;
    paid?: unknown;
    rawBill?: unknown;
    effectiveBill?: unknown;
    cumulativeRemain?: unknown;
    cumulativeOverpaid?: unknown;
    isCurrentCycle: boolean;
    isLocked: boolean;
    lockSource: string | null;
  },
  desired: {
    periodStart: Date;
    periodEnd: Date;
    dueDate: Date | null;
    expenseAbs?: string;
    income?: string;
    paid: string;
    rawBill?: string;
    effectiveBill?: string;
    cumulativeRemain: string;
    cumulativeOverpaid: string;
    isCurrentCycle: boolean;
    isLocked: boolean;
    lockSource: string | null;
  },
): boolean {
  if (!sameCreditCycleDay(persisted.periodStart, desired.periodStart)) return false;
  if (!sameCreditCycleDay(persisted.periodEnd, desired.periodEnd)) return false;
  if (!sameCreditCycleDay(persisted.dueDate, desired.dueDate)) return false;
  if (persisted.isCurrentCycle !== desired.isCurrentCycle) return false;
  if (persisted.isLocked !== desired.isLocked) return false;
  if ((persisted.lockSource ?? null) !== (desired.lockSource ?? null)) return false;
  if (!sameCreditCycleAmount(persisted.paid, desired.paid)) return false;
  if (!sameCreditCycleAmount(persisted.cumulativeRemain, desired.cumulativeRemain)) return false;
  if (!sameCreditCycleAmount(persisted.cumulativeOverpaid, desired.cumulativeOverpaid)) return false;
  if (desired.expenseAbs !== undefined && !sameCreditCycleAmount(persisted.expenseAbs, desired.expenseAbs)) return false;
  if (desired.income !== undefined && !sameCreditCycleAmount(persisted.income, desired.income)) return false;
  if (desired.rawBill !== undefined && !sameCreditCycleAmount(persisted.rawBill, desired.rawBill)) return false;
  if (desired.effectiveBill !== undefined && !sameCreditCycleAmount(persisted.effectiveBill, desired.effectiveBill)) {
    return false;
  }
  return true;
}
