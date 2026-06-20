import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { Prisma, TransactionType, IntervalUnit, RegularInvestStatus } from "@prisma/client";
import { isWeekend, nextMonday, addDays, addWeeks, addMonths } from "date-fns";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getFundConfirmDays, getFundArrivalDays, normalizeNonNegativeDays } from "@/lib/fund/confirmDays";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { addWorkdaysUtc, formatDateUtc } from "@/lib/date-utils";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";

const NAV_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "http://fundf10.eastmoney.com/",
};

function skipWeekend(date: Date): Date {
  if (isWeekend(date)) return nextMonday(date);
  return date;
}

function calcNextRunDate(fromDate: Date, unit: IntervalUnit, value: number): Date {
  switch (unit) {
    case "day": return addDays(fromDate, value);
    case "week": return addWeeks(fromDate, value);
    case "biweek": return addWeeks(fromDate, value * 2);
    case "month": return addMonths(fromDate, value);
    default: return addMonths(fromDate, value);
  }
}

/** Fetch NAV for a single confirm date (1-2 pages max). Returns flat list with all received entries. */
async function fetchNavForDate(fundCode: string, confirmDate: string): Promise<Array<{ date: string; nav: number; sgzt: string }>> {
  const results: Array<{ date: string; nav: number; sgzt: string }> = [];
  // Narrow window: ~15 trading days before confirm date ~ 3 weeks calendar
  const start = new Date(confirmDate);
  start.setDate(start.getDate() - 21);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = new Date(confirmDate).toISOString().slice(0, 10);

  for (let pageIndex = 1; pageIndex <= 2; pageIndex++) {
    const url = `http://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=${pageIndex}&pageSize=20&startDate=${startStr}&endDate=${endStr}`;
    try {
      const res = await fetch(url, { headers: NAV_HEADERS, cache: "no-store" });
      if (!res.ok) break;
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { break; }
      const list: Array<{ FSRQ: string; DWJZ: string; SGZT: string }> = data?.Data?.LSJZList ?? [];
      if (list.length === 0) break;
      for (const item of list) {
        results.push({ date: item.FSRQ, nav: parseFloat(item.DWJZ), sgzt: item.SGZT ?? "" });
      }
      if (list.length < 20) break;
    } catch { break; }
  }
  return results;
}

/** Upsert multiple NAV entries into cache in one batch */
async function batchUpsertNavCache(entries: Array<{ fundCode: string; navDate: string; nav: number; sgzt: string }>) {
  if (entries.length === 0) return;
  // Use individual upserts — Prisma doesn't have bulk upsert
  const promises = entries.map(e =>
    prisma.fundNavCache.upsert({
      where: { fundCode_navDate: { fundCode: e.fundCode, navDate: new Date(e.navDate + "T00:00:00Z") } },
      create: { fundCode: e.fundCode, navDate: new Date(e.navDate + "T00:00:00Z"), nav: e.nav, sgzt: e.sgzt },
      update: { nav: e.nav, sgzt: e.sgzt },
    }).catch(() => {})
  );
  await Promise.all(promises);
}

export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();

    const now = new Date();
    const todayStr = formatDateUtc(now);

    const allPlans = await prisma.regularInvestPlan.findMany({
      where: { householdId, status: RegularInvestStatus.active, nextRunDate: { lte: now } },
    });

    if (allPlans.length === 0) {
      return NextResponse.json({ ok: true, message: "没有需要执行的定投计划", executedCount: 0, skippedCount: 0 });
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

    // Batch-check already-run-today
    const fundCodeSet = new Set(plansToRun.map(p => p.fundCode));
    const alreadyRunToday = await prisma.txRecord.findMany({
      where: { fundCode: { in: [...fundCodeSet] }, source: "regular_invest", deletedAt: null, date: { gte: new Date(todayStr + "T00:00:00Z"), lte: new Date(todayStr + "T23:59:59Z") } },
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
      const confirmDateStr = addWorkdaysUtc(runDateStr, confirmDays);
      if (confirmDateStr < runDateStr) logger.warn(`confirmDate ${confirmDateStr} < runDate ${runDateStr}, confirmDays=${confirmDays}`, "auto-execute");
      const confirmDate = new Date(Date.UTC(parseInt(confirmDateStr.slice(0, 4)), parseInt(confirmDateStr.slice(5, 7)) - 1, parseInt(confirmDateStr.slice(8, 10))));
      const arrivalDays = normalizeNonNegativeDays(plan.arrivalDays, 2);
      const arrivalDateStr = arrivalDays > 0 ? addWorkdaysUtc(confirmDateStr, arrivalDays) : confirmDateStr;
      const arrivalDate = new Date(Date.UTC(parseInt(arrivalDateStr.slice(0, 4)), parseInt(arrivalDateStr.slice(5, 7)) - 1, parseInt(arrivalDateStr.slice(8, 10))));
      const amountNum = parseFloat(String(plan.amount));
      const newExecutedRuns = plan.executedRuns + 1;
      const willComplete = !!(
        (plan.totalRuns && newExecutedRuns >= plan.totalRuns) ||
        (plan.endDate && plan.endDate < calcNextRunDate(runDate, plan.intervalUnit as IntervalUnit, plan.intervalValue)));
      const nextRun = calcNextRunDate(runDate, plan.intervalUnit as IntervalUnit, plan.intervalValue);

      execs.push({
        plan, fundAcc, cashAcc, runDate, confirmDate, confirmDateStr, arrivalDate,
        amountNum, feeRate: 0, principal: amountNum, newExecutedRuns, willComplete, nextRun,
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
      const cdStr = addWorkdaysUtc(formatDateUtc(e.runDate), cDays);
      if (cdStr < formatDateUtc(e.runDate)) logger.warn(`confirmDate ${cdStr} < runDate ${formatDateUtc(e.runDate)}, cDays=${cDays}`, "auto-execute");
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
    const generatedRecords: Array<{ id: string; fundCode: string; confirmDate: string; principal: number }> = [];
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
        const purchaseLimit = navCheck?.purchaseLimit ?? null;
        const actualBuy = purchaseLimit ? Math.min(e.amountNum, purchaseLimit) : e.amountNum;
        const excess = purchaseLimit ? e.amountNum - actualBuy : 0;
        const feeAmount = e.feeRate > 0 ? actualBuy * e.feeRate : null;

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
          await tx.txRecord.create({ data: { householdId, type: TransactionType.investment, date: e.runDate, accountId: e.cashAcc?.id ?? e.fundAcc.id, accountName: e.cashAcc?.name ?? e.fundAcc.name, toAccountId: e.fundAcc.id, toAccountName: e.fundAcc.name, amount: -actualBuy, fundCode: e.plan.fundCode, fundName: e.plan.fundName || e.plan.fundCode, fundProductType: e.plan.fundProductType || e.fundAcc.investProductType, fundSubtype: "buy_failed", source: "regular_invest", fundFee: null, fundConfirmDate: e.confirmDate, fundArrivalDate: e.arrivalDate, fundNav: null, fundUnits: null, regularInvestPlanId: e.plan.id, note: `基金暂停申购 ${e.plan.fundCode}` } });
          await tx.txRecord.create({ data: { householdId, type: TransactionType.investment, date: e.runDate, accountId: e.fundAcc.id, accountName: e.fundAcc.name, toAccountId: e.cashAcc?.id ?? e.fundAcc.id, toAccountName: e.cashAcc?.name ?? e.fundAcc.name, amount: -e.amountNum, fundCode: e.plan.fundCode, fundName: e.plan.fundName || e.plan.fundCode, fundProductType: e.plan.fundProductType || e.fundAcc.investProductType, fundSubtype: "buy_failed", source: "regular_invest_refund", fundFee: null, fundConfirmDate: e.confirmDate, fundArrivalDate: e.arrivalDate, fundNav: null, fundUnits: null, regularInvestPlanId: e.plan.id, note: `基金暂停申购，资金退回 ${e.plan.fundCode}` } });
        } else {
          const rec = await tx.txRecord.create({ data: { householdId, type: TransactionType.investment, date: e.runDate, accountId: e.cashAcc?.id ?? e.fundAcc.id, accountName: e.cashAcc?.name ?? e.fundAcc.name, toAccountId: e.fundAcc.id, toAccountName: e.fundAcc.name, amount: -e.amountNum, fundCode: e.plan.fundCode, fundName: e.plan.fundName || e.plan.fundCode, fundProductType: e.plan.fundProductType || e.fundAcc.investProductType, fundSubtype: "buy", source: "regular_invest", fundFee: feeAmount, fundConfirmDate: e.confirmDate, fundArrivalDate: e.arrivalDate, fundNav: null, fundUnits: null, regularInvestPlanId: e.plan.id, note: `基金定期定额申购 ${e.plan.fundCode}` } });
          generatedRecords.push({ id: rec.id, fundCode: e.plan.fundCode, confirmDate: e.confirmDateStr, principal: e.principal - excess });
          if (excess > 0) {
            await tx.txRecord.create({ data: { householdId, type: TransactionType.investment, date: e.runDate, accountId: e.fundAcc.id, accountName: e.fundAcc.name, toAccountId: e.cashAcc?.id ?? e.fundAcc.id, toAccountName: e.cashAcc?.name ?? e.fundAcc.name, amount: -excess, fundCode: e.plan.fundCode, fundName: e.plan.fundName || e.plan.fundCode, fundProductType: e.plan.fundProductType || e.fundAcc.investProductType, fundSubtype: "buy_failed", source: "regular_invest_limit_refund", fundFee: null, fundConfirmDate: e.confirmDate, fundArrivalDate: e.arrivalDate, fundNav: null, fundUnits: null, regularInvestPlanId: e.plan.id, note: `基金申购超限，退回 ${excess} 元 ${e.plan.fundCode}` } });
          }
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
          const navList = await fetchNavForDate(code, latestDate);
          if (navList.length > 0) {
            await batchUpsertNavCache(navList.map(n => ({ fundCode: code, navDate: n.date, nav: n.nav, sgzt: n.sgzt })));
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
          select: { nav: true },
        })
      );
      const cacheResults = await Promise.all(cacheQueries);

      // Batch update all records in parallel
      const updates = generatedRecords.map(async (r, i) => {
        const n = cacheResults[i];
        if (n && Number(n.nav) > 0) {
          const nav = Number(n.nav);
          const units = r.principal / nav;
          await prisma.txRecord.update({ where: { id: r.id }, data: { fundNav: nav, fundUnits: units } });
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

    // Client-side handles page refresh
    return NextResponse.json({
      ok: true,
      message: `执行完成：${executed.length} 条已执行，${skipped.length} 条已跳过${skippedPaused > 0 ? `（暂停申购 ${skippedPaused}` : ""}${skippedGap > 0 ? `${skippedPaused > 0 ? "，" : "（无净值 "}${skippedGap}` : ""}${skippedPaused + skippedGap > 0 ? "）" : ""}，${completed.length} 条已完成`,
      executedCount: executed.length,
      skippedCount: skipped.length,
      completedCount: completed.length,
      skippedPaused,
      skippedGap,
      details,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "执行失败" }, { status: 500 });
  }
}
