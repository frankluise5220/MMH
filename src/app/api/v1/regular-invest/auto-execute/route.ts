import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { TransactionType, IntervalUnit, RegularInvestStatus } from "@prisma/client";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getFundConfirmDays, getFundArrivalDays, normalizeNonNegativeDays } from "@/lib/fund/confirmDays";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { addWorkdaysUtc, formatDateUtc, startOfDayUtc } from "@/lib/date-utils";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { fetchHistoricalNavList, preloadNavListToCache } from "@/lib/fund/navCache";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { decodeScheduledTaskMemo } from "@/lib/scheduled-task";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import { calcInitialScheduledRunDate as calcInitialRunDate, calcNextScheduledRunDate as calcNextRunDate, skipWeekend } from "@/lib/scheduled-task-date";
import { executeNonFundScheduledTaskPlan, isNonFundScheduledTask } from "@/lib/server/scheduled-task-executor";

export async function POST() {
  try {
    const { householdId } = await getHouseholdScope();

    const now = new Date();
    const today = startOfDayUtc(now);
    const todayStr = formatDateUtc(now);

    const allPlans = await prisma.regularInvestPlan.findMany({
      where: { householdId, status: RegularInvestStatus.active },
    });

    if (allPlans.length === 0) {
      return NextResponse.json({ ok: true, message: "没有执行中的计划任务", executedCount: 0, skippedCount: 0 });
    }

    // ── Phase 1: Filter & load all data in batch ──
    const plansToRun: typeof allPlans = [];
    const completed: string[] = [];

    for (const p of allPlans) {
      if ((p.endDate && p.endDate < now) || (p.totalRuns && p.executedRuns >= p.totalRuns)) {
        completed.push(p.id);
      } else {
        plansToRun.push(p);
      }
    }

    if (completed.length > 0) {
      await prisma.regularInvestPlan.updateMany({ where: { id: { in: completed } }, data: { status: RegularInvestStatus.completed } });
    }

    if (plansToRun.length === 0) {
      return NextResponse.json({ ok: true, message: `已完成 ${completed.length} 条到期的计划`, executedCount: 0, skippedCount: 0, completedCount: completed.length, details: [] });
    }

    const generalPlans = plansToRun.filter((plan) => isNonFundScheduledTask(decodeScheduledTaskMemo(plan.memo).type));
    const fundPlans = plansToRun.filter((plan) => !isNonFundScheduledTask(decodeScheduledTaskMemo(plan.memo).type));

    const generalExecuted: string[] = [];
    const generalSkipped: string[] = [];
    const generalDetails: Array<{ planId: string; fundCode: string; action: string; reason?: string }> = [];
    let generalGeneratedCount = 0;

    for (const plan of generalPlans) {
      const task = decodeScheduledTaskMemo(plan.memo);
      try {
        const result = await executeNonFundScheduledTaskPlan({
          householdId,
          plan,
          task,
          now,
        });
        if (result.generatedCount > 0) {
          generalExecuted.push(plan.id);
          generalGeneratedCount += result.generatedCount;
          generalDetails.push({ planId: plan.id, fundCode: plan.fundCode, action: "executed", reason: `生成 ${result.generatedCount} 条` });
        } else {
          generalSkipped.push(plan.id);
          generalDetails.push({ planId: plan.id, fundCode: plan.fundCode, action: "skipped", reason: result.message });
        }
      } catch (e) {
        generalSkipped.push(plan.id);
        generalDetails.push({ planId: plan.id, fundCode: plan.fundCode, action: "skipped", reason: e instanceof Error ? e.message : "执行失败" });
      }
    }

    if (fundPlans.length === 0) {
      if (generalExecuted.length > 0) revalidateAfterTxChange();
      return NextResponse.json({
        ok: true,
        message: `执行完成：生成 ${generalGeneratedCount} 条记录，${generalSkipped.length} 条计划已跳过，${completed.length} 条已完成`,
        executedCount: generalGeneratedCount,
        skippedCount: generalSkipped.length,
        completedCount: completed.length,
        details: generalDetails,
      });
    }

    // Batch-check already-run-today
    plansToRun.splice(0, plansToRun.length, ...fundPlans);
    const fundCodeSet = new Set(plansToRun.map(p => p.fundCode));
    const alreadyRunToday = await prisma.txRecord.findMany({
      where: { fundCode: { in: [...fundCodeSet] }, source: "regular_invest", date: { gte: new Date(todayStr + "T00:00:00Z"), lte: new Date(todayStr + "T23:59:59Z") } },
      select: { fundCode: true, toAccountId: true },
    });
    const runTodaySet = new Set(alreadyRunToday.map(r => `${r.fundCode}|${r.toAccountId}`));

    // Load accounts
    const accountIds = [...new Set(plansToRun.map(p => p.accountId))];
    const cashAccountIds = [...new Set(plansToRun.map(p => p.cashAccountId).filter(Boolean))];
    const [fundAccs, cashAccs] = await Promise.all([
      prisma.account.findMany({ where: { id: { in: accountIds } } }),
      cashAccountIds.length > 0 ? prisma.account.findMany({ where: { id: { in: cashAccountIds as string[] } }, select: { id: true, name: true } }) : Promise.resolve([]),
    ]);
    const fundAccMap = new Map(fundAccs.map(a => [a.id, a] as [string, typeof a]));
    const cashAccMap = new Map(cashAccs.map(a => [a.id, a] as [string, typeof a]));

    // ── Phase 2: Pre-compute all plan data, then generate ALL records in ONE transaction ──
    const executed: string[] = [];
    const skipped: string[] = [];
    const details: Array<{ planId: string; fundCode: string; action: string; reason?: string }> = [];
    let skippedPaused = 0;
    let skippedGap = 0;
    const genStart = Date.now();

    // Pre-compute per-plan data (no DB calls)
    type PlanExec = {
      plan: typeof plansToRun[number];
      fundAcc: NonNullable<typeof fundAccMap.get extends (id: string) => infer R ? R : never>;
      cashAcc: ReturnType<typeof cashAccMap.get>;
      runDate: Date;
      confirmDate: Date;
      confirmDateStr: string;
      arrivalDate: Date;
      amountNum: number;
      feeRate: number;
      principal: number;
      newExecutedRuns: number;
      willComplete: boolean;
      nextRun: Date;
    };
    const execs: PlanExec[] = [];

    for (const plan of plansToRun) {
      if (plan.nextRunDate > now) {
        skipped.push(plan.id);
        details.push({ planId: plan.id, fundCode: plan.fundCode, action: "skipped", reason: "未到执行日" });
        continue;
      }
      if (runTodaySet.has(`${plan.fundCode}|${plan.accountId}`)) {
        skipped.push(plan.id);
        details.push({ planId: plan.id, fundCode: plan.fundCode, action: "skipped", reason: "今日已执行" });
        continue;
      }
      const fundAcc = fundAccMap.get(plan.accountId);
      if (!fundAcc) {
        skipped.push(plan.id);
        details.push({ planId: plan.id, fundCode: plan.fundCode, action: "skipped", reason: "基金账户不存在" });
        continue;
      }

      const cashAcc = plan.cashAccountId ? cashAccMap.get(plan.cashAccountId) ?? null : null;
      const runDate = skipWeekend(new Date(plan.nextRunDate));
      const runDateStr = formatDateUtc(runDate);
      const confirmDays = normalizeNonNegativeDays(plan.confirmDays, 0);
      let confirmDateStr = addWorkdaysUtc(runDateStr, confirmDays);
      if (confirmDateStr < runDateStr) {
        logger.warn(`confirmDate ${confirmDateStr} < runDate ${runDateStr}, confirmDays=${confirmDays}`, "auto-execute");
        confirmDateStr = runDateStr;
      }
      const confirmDate = new Date(Date.UTC(parseInt(confirmDateStr.slice(0, 4)), parseInt(confirmDateStr.slice(5, 7)) - 1, parseInt(confirmDateStr.slice(8, 10))));
      const arrivalDays = normalizeNonNegativeDays(plan.arrivalDays, 2);
      const arrivalDateStr = arrivalDays > 0 ? addWorkdaysUtc(confirmDateStr, arrivalDays) : confirmDateStr;
      const arrivalDate = new Date(Date.UTC(parseInt(arrivalDateStr.slice(0, 4)), parseInt(arrivalDateStr.slice(5, 7)) - 1, parseInt(arrivalDateStr.slice(8, 10))));
      const amountNum = parseFloat(String(plan.amount));
      const newExecutedRuns = plan.executedRuns + 1;
      const nextRun = calcNextRunDate(runDate, plan.intervalUnit as IntervalUnit, plan.intervalValue, plan.executionDay, true);
      const willComplete = !!(
        (plan.totalRuns && newExecutedRuns >= plan.totalRuns) ||
        (plan.endDate && plan.endDate < nextRun));

      execs.push({
        plan, fundAcc, cashAcc, runDate, confirmDate, confirmDateStr, arrivalDate,
        amountNum, feeRate: 0, principal: amountNum, newExecutedRuns, willComplete, nextRun,
      });
    }

    if (execs.length === 0) {
      if (generalExecuted.length > 0) revalidateAfterTxChange();
      return NextResponse.json({
        ok: true,
        message: `执行完成：生成 ${generalGeneratedCount} 条记录，${generalSkipped.length + skipped.length} 条计划已跳过，${completed.length} 条已完成`,
        executedCount: generalGeneratedCount,
        skippedCount: generalSkipped.length + skipped.length,
        completedCount: completed.length,
        details: [...generalDetails, ...details],
      });
    }

    // Batch fetch confirmDays & feeRates for all plans (parallel per unique (accountId, fundCode))
    const confirmDaysKeys = [...new Set(execs.map(e => `${e.plan.accountId}:${e.plan.fundCode}`))];
    const confirmDaysMap = new Map<string, number>();
    for (const key of confirmDaysKeys) {
      const [acctId, code] = key.split(":");
      const matched = execs.find(e => e.plan.accountId === acctId && e.plan.fundCode === code);
      const days = matched?.plan.confirmDays !== null && matched?.plan.confirmDays !== undefined ? matched.plan.confirmDays : await getFundConfirmDays(acctId, code);
      confirmDaysMap.set(key, normalizeNonNegativeDays(days, 0));
    }
    // Update confirmDates & arrivalDates based on actual confirmDays & arrivalDays
    const arrivalDaysKeys = [...new Set(execs.map(e => `${e.plan.accountId}:${e.plan.fundCode}`))];
    const arrivalDaysMap = new Map<string, number>();
    for (const key of arrivalDaysKeys) {
      const [acctId, code] = key.split(":");
      const matched = execs.find(e => e.plan.accountId === acctId && e.plan.fundCode === code);
      const days = matched?.plan.arrivalDays !== null && matched?.plan.arrivalDays !== undefined ? matched.plan.arrivalDays : await getFundArrivalDays(acctId, code);
      arrivalDaysMap.set(key, normalizeNonNegativeDays(days, 2));
    }
    for (const e of execs) {
      const cDays = confirmDaysMap.get(`${e.plan.accountId}:${e.plan.fundCode}`) ?? normalizeNonNegativeDays(e.plan.confirmDays, 0);
      const aDays = arrivalDaysMap.get(`${e.plan.accountId}:${e.plan.fundCode}`) ?? normalizeNonNegativeDays(e.plan.arrivalDays, 2);
      // Always recompute confirmDate/arrivalDate from final confirmDays+arrivalDays
      const runDateStr = formatDateUtc(e.runDate);
      let cdStr = addWorkdaysUtc(runDateStr, cDays);
      if (cdStr < runDateStr) {
        logger.warn(`confirmDate ${cdStr} < runDate ${runDateStr}, cDays=${cDays}`, "auto-execute");
        cdStr = runDateStr;
      }
      e.confirmDate = new Date(Date.UTC(parseInt(cdStr.slice(0, 4)), parseInt(cdStr.slice(5, 7)) - 1, parseInt(cdStr.slice(8, 10))));
      e.confirmDateStr = cdStr;
      const adStr = aDays > 0 ? addWorkdaysUtc(cdStr, aDays) : cdStr;
      e.arrivalDate = new Date(Date.UTC(parseInt(adStr.slice(0, 4)), parseInt(adStr.slice(5, 7)) - 1, parseInt(adStr.slice(8, 10))));
    }

    const feeRateKeys = [...new Set(execs.map(e => `${e.plan.accountId}:${e.plan.fundCode}`))];
    const feeRateMap = new Map<string, number>();
    for (const key of feeRateKeys) {
      const [acctId, code] = key.split(":");
      const rate = await getFundFeeRateByDate(acctId, code, new Date(), "buy");
      feeRateMap.set(key, rate / 100);
    }
    for (const e of execs) {
      const fr = feeRateMap.get(`${e.plan.accountId}:${e.plan.fundCode}`) ?? 0;
      e.feeRate = fr;
      e.principal = fr > 0 ? e.amountNum * (1 - fr) : e.amountNum;
    }

    // ONE transaction: create all records + update all plans
    const generatedRecords: Array<{ id: string; fundCode: string; confirmDate: string; principal: number; fundUnitsDecimals: number }> = [];
    const affectedFunds = new Set<string>();

    await prisma.$transaction(async (tx) => {
      // Batch all sgzt & nav checks
      const navChecks = await Promise.all(execs.map(e =>
        tx.fundNavCache.findUnique({ where: { fundCode_navDate: { fundCode: e.plan.fundCode, navDate: e.confirmDate } }, select: { sgzt: true, purchaseLimit: true, nav: true } })
      ));

      // Batch all txRecord creates
      for (let i = 0; i < execs.length; i++) {
        const e = execs[i];
        const navCheck = navChecks[i];
        const sgzt = navCheck?.sgzt ?? "";
        const feeAmount = e.feeRate > 0 ? e.amountNum * e.feeRate : null;

        // 跳过暂停申购 + 无净值间隙
        if (e.plan.skipPendingPreceding !== false) {
          if (sgzt === "暂停申购") {
            skippedPaused++;
            skipped.push(e.plan.id);
            details.push({ planId: e.plan.id, fundCode: e.plan.fundCode, action: "skipped", reason: "暂停申购" });
            await tx.regularInvestPlan.update({ where: { id: e.plan.id }, data: { nextRunDate: skipWeekend(e.nextRun) } });
            continue;
          }
          // 确认日无净值且不是暂停申购：
          // - 确认日已过去（历史日期）→ 市场休市（假期等），跳过
          // - 确认日尚未到或为今天 → 净值未公布是正常的，保留（nav=null 后续补填）
          const noNav = !navCheck || ((navCheck.nav == null || Number(navCheck.nav) <= 0) && sgzt !== "暂停申购");
          if (noNav && e.confirmDateStr < todayStr) {
            skippedGap++;
            skipped.push(e.plan.id);
            details.push({ planId: e.plan.id, fundCode: e.plan.fundCode, action: "skipped", reason: "无净值数据（确认日已过）" });
            await tx.regularInvestPlan.update({ where: { id: e.plan.id }, data: { nextRunDate: skipWeekend(e.nextRun) } });
            continue;
          }
        }

        if (sgzt === "暂停申购") {
          // skipPendingPreceding=false 的旧行为：生成两条对冲 buy_failed 记录
          await tx.txRecord.create({ data: { householdId, type: TransactionType.investment, date: e.runDate, accountId: e.cashAcc?.id ?? e.fundAcc.id, accountName: e.cashAcc?.name ?? e.fundAcc.name, toAccountId: e.fundAcc.id, toAccountName: e.fundAcc.name, amount: -e.amountNum, fundCode: e.plan.fundCode, fundName: e.plan.fundName || e.plan.fundCode, fundProductType: e.plan.fundProductType || e.fundAcc.investProductType, fundSubtype: "buy_failed", source: "regular_invest", fundFee: null, fundConfirmDate: e.confirmDate, fundArrivalDate: e.arrivalDate, fundNav: null, fundUnits: null, regularInvestPlanId: e.plan.id, note: `基金暂停申购 ${e.plan.fundCode}` } });
          await tx.txRecord.create({ data: { householdId, type: TransactionType.investment, date: e.runDate, accountId: e.fundAcc.id, accountName: e.fundAcc.name, toAccountId: e.cashAcc?.id ?? e.fundAcc.id, toAccountName: e.cashAcc?.name ?? e.fundAcc.name, amount: -e.amountNum, fundCode: e.plan.fundCode, fundName: e.plan.fundName || e.plan.fundCode, fundProductType: e.plan.fundProductType || e.fundAcc.investProductType, fundSubtype: "buy_failed", source: "regular_invest_refund", fundFee: null, fundConfirmDate: e.confirmDate, fundArrivalDate: e.arrivalDate, fundNav: null, fundUnits: null, regularInvestPlanId: e.plan.id, note: `基金暂停申购，资金退回 ${e.plan.fundCode}` } });
        } else {
          const rec = await tx.txRecord.create({ data: { householdId, type: TransactionType.investment, date: e.runDate, accountId: e.cashAcc?.id ?? e.fundAcc.id, accountName: e.cashAcc?.name ?? e.fundAcc.name, toAccountId: e.fundAcc.id, toAccountName: e.fundAcc.name, amount: -e.amountNum, fundCode: e.plan.fundCode, fundName: e.plan.fundName || e.plan.fundCode, fundProductType: e.plan.fundProductType || e.fundAcc.investProductType, fundSubtype: "buy", source: "regular_invest", fundFee: feeAmount, fundConfirmDate: e.confirmDate, fundArrivalDate: e.arrivalDate, fundNav: null, fundUnits: null, regularInvestPlanId: e.plan.id, note: `基金定期定额申购 ${e.plan.fundCode}` } });
          generatedRecords.push({
            id: rec.id,
            fundCode: e.plan.fundCode,
            confirmDate: e.confirmDateStr,
            principal: e.principal,
            fundUnitsDecimals: normalizeFundUnitsDecimals(e.fundAcc.fundUnitsDecimals),
          });
        }

        await tx.regularInvestPlan.update({ where: { id: e.plan.id }, data: { lastRunDate: e.runDate, nextRunDate: skipWeekend(e.nextRun), executedRuns: e.newExecutedRuns, status: e.willComplete ? RegularInvestStatus.completed : RegularInvestStatus.active } });

        affectedFunds.add(`${e.fundAcc.id}|${e.plan.fundCode}`);
        if (e.willComplete) {
          details.push({ planId: e.plan.id, fundCode: e.plan.fundCode, action: "completed", reason: "达到结束条件" });
        } else {
          executed.push(e.plan.id);
          details.push({ planId: e.plan.id, fundCode: e.plan.fundCode, action: "executed" });
        }
      }
    });
    logger.info("Phase2 生成记录完成: " + generatedRecords.length + " 条 buy+" + (execs.length - generatedRecords.length) + " 条 buy_failed, 耗时 " + (Date.now() - genStart) + "ms", "auto-execute");

    // ── Phase 3: Check cache first, only fetch NAV from API for missing dates ──
    if (generatedRecords.length > 0) {
      const navStart = Date.now();

      // Collect unique (fundCode, confirmDate) pairs needed
      const neededPairs = new Map<string, Set<string>>(); // fundCode → Set of confirmDate strings
      for (const r of generatedRecords) {
        if (!neededPairs.has(r.fundCode)) neededPairs.set(r.fundCode, new Set());
        neededPairs.get(r.fundCode)!.add(r.confirmDate);
      }

      // Batch query cache: find ALL existing entries for ALL needed fundCodes within the date range
      const allFundCodes = [...neededPairs.keys()];
      const minDate = [...neededPairs.values()].flatMap(s => [...s]).sort()[0] || "2020-01-01";
      const existingCache = await prisma.fundNavCache.findMany({
        where: {
          fundCode: { in: allFundCodes },
          navDate: { gte: new Date(minDate + "T00:00:00Z") },
        },
        select: { fundCode: true, navDate: true, nav: true },
      });

      // Build set of (fundCode, date) already cached
      const cachedSet = new Set(existingCache.map(c => `${c.fundCode}|${c.navDate.toISOString().slice(0, 10)}`));

      // Find which fundCodes have at least one missing date
      const missingFunds = new Set<string>();
      for (const r of generatedRecords) {
        if (!cachedSet.has(`${r.fundCode}|${r.confirmDate}`)) {
          missingFunds.add(r.fundCode);
        }
      }

      // Only fetch from API for funds with missing cache entries
      if (missingFunds.size > 0) {
        const fetchPromises = [...missingFunds].map(async (code) => {
          // Use the latest needed confirm date as the query target
          const dates = [...neededPairs.get(code)!.values()].sort();
          const latestDate = dates[dates.length - 1];
          const navList = await fetchHistoricalNavList(code, dates[0]!, latestDate);
          if (navList.length > 0) {
            await preloadNavListToCache(code, navList);
          }
        });
        await Promise.all(fetchPromises);
        logger.info("Phase3 NAV API: " + missingFunds.size + "/" + allFundCodes.length + " 只基金需调API, 耗时 " + (Date.now() - navStart) + "ms", "auto-execute");
      } else {
        logger.info("Phase3 NAV API: 缓存全部命中, 无需调API, 耗时 " + (Date.now() - navStart) + "ms", "auto-execute");
      }

      // ── Phase 4: Batch update records with nav/units from cache (parallel) ──
      const updateStart = Date.now();
      // Batch read all needed cache entries
      const cacheQueries = generatedRecords.map(r =>
        prisma.fundNavCache.findUnique({
          where: { fundCode_navDate: { fundCode: r.fundCode, navDate: new Date(r.confirmDate + "T00:00:00Z") } },
          select: { nav: true, name: true },
        })
      );
      const cacheResults = await Promise.all(cacheQueries);

      // Batch update all records in parallel
      const updates = generatedRecords.map(async (r, i) => {
        const n = cacheResults[i];
        if (n && Number(n.nav) > 0) {
          const nav = Number(n.nav);
          const units = roundFundUnits(r.principal / nav, r.fundUnitsDecimals);
          const name = (n.name ?? "").trim();
          await prisma.txRecord.update({
            where: { id: r.id },
            data: {
              fundNav: nav,
              fundUnits: units,
              ...(name && name !== r.fundCode ? { fundName: name } : {}),
            },
          });
          return true;
        }
        return false;
      });
      const updateResults = await Promise.all(updates);
      const updatedCount = updateResults.filter(Boolean).length;
      logger.info("Phase4 净值回填完成: " + updatedCount + "/" + generatedRecords.length + " 条, 耗时 " + (Date.now() - updateStart) + "ms", "auto-execute");
    }

    // ── Phase 5: Batch recalc positions ──
    const recalcStart = Date.now();
    const accountsToRecalc = new Map<string, string[]>();
    for (const aff of affectedFunds) {
      const [acctId, code] = aff.split("|");
      if (!accountsToRecalc.has(acctId)) accountsToRecalc.set(acctId, []);
      accountsToRecalc.get(acctId)!.push(code);
    }
    for (const [acctId, codes] of accountsToRecalc) {
      await recalcFundPositions(acctId, codes).catch(logger.catchLog("recalc", "auto-execute"));
      await recalcAndSaveAccountBalance(acctId).catch(logger.catchLog("balance", "auto-execute"));
    }
    for (const plan of plansToRun) {
      if (plan.cashAccountId) await recalcAndSaveAccountBalance(plan.cashAccountId).catch(logger.catchLog("balance", "auto-execute"));
    }
    logger.info(`Phase5 重算持仓完成: 耗时 ${Date.now() - recalcStart}ms`, "auto-execute");
    if (executed.length > 0 || generatedRecords.length > 0) revalidateAfterInvestChange();
    else if (generalExecuted.length > 0) revalidateAfterTxChange();

    // Client-side handles page refresh
    return NextResponse.json({
      ok: true,
      message: `执行完成：生成 ${generalGeneratedCount + executed.length} 条记录，${generalSkipped.length + skipped.length} 条计划已跳过${skippedPaused > 0 ? `（暂停申购 ${skippedPaused}` : ""}${skippedGap > 0 ? `${skippedPaused > 0 ? "，" : "（无净值 "}${skippedGap}` : ""}${skippedPaused + skippedGap > 0 ? "）" : ""}，${completed.length} 条已完成`,
      executedCount: generalGeneratedCount + executed.length,
      skippedCount: generalSkipped.length + skipped.length,
      completedCount: completed.length,
      skippedPaused,
      skippedGap,
      details: [...generalDetails, ...details],
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "执行失败" }, { status: 500 });
  }
}
