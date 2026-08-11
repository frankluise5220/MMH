import { NextRequest, NextResponse } from "next/server";
import { FundCashFlowKind, FundProductType, FundSubtype } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { addWorkdaysUtc } from "@/lib/date-utils";
import { getFundConfirmDays } from "@/lib/fund/confirmDays";
import { getFundNav, fetchHistoricalNavList, preloadNavListToCache, refreshHeldFundLatestNavs, NavListItem } from "@/lib/fund/navCache";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { getAccountFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { ensureFundTransactionCashFlowLinks } from "@/lib/fund/transactions";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";

const toNum = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

function utcDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function refundAmountOf(row: {
  refundAmount: unknown;
  cashFlows: Array<{ kind: FundCashFlowKind; amount: unknown }>;
}) {
  const byRow = Math.abs(toNum(row.refundAmount));
  const byFlows = row.cashFlows
    .filter((flow) => flow.kind === FundCashFlowKind.refund_in)
    .reduce((sum, flow) => sum + Math.abs(toNum(flow.amount)), 0);
  return Math.max(byRow, byFlows);
}

export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json();
    const accountId = String(body.accountId ?? "").trim();
    if (!accountId) return NextResponse.json({ ok: false, error: "缺少 accountId" }, { status: 400 });

    let entryFilled = 0;
    let entryFailed = 0;
    let entryNavFilled = 0;
    const syncedEntryIds: string[] = [];
    const fundUnitsDecimals = await getAccountFundUnitsDecimals(accountId);

    // 直接查询 FundTransaction 中未确认的基金交易。
    const requestedSymbols: string[] = Array.isArray(body.symbols) ? body.symbols.map(String).filter(Boolean) : [];
    const unconfirmedEntries = await prisma.fundTransaction.findMany({
      where: {
        householdId,
        fundAccountId: accountId,
        deletedAt: null,
        fundProductType: { in: [FundProductType.fund, FundProductType.money] },
        OR: [
          { nav: null },
          { units: null },
          { units: { lte: 0 } },
        ],
        fundSubtype: { in: [FundSubtype.buy, FundSubtype.redeem, FundSubtype.switch_out] },
      },
      include: { cashFlows: true },
      orderBy: { createdAt: "asc" },
    });

    // 按基金代码分组，一次性获取每个基金的历史净值
    const fundCodes = [...new Set([...unconfirmedEntries.map(e => e.fundCode).filter(Boolean), ...requestedSymbols])];
    const navCacheByFund: Map<string, NavListItem[]> = new Map();

    // 找出所有记录的最早日期。如无待确认记录，取 30 天前
    const now = new Date();
    let earliestDate = now.toISOString().slice(0, 10);
    for (const entry of unconfirmedEntries) {
      if (!entry.fundCode) continue;
      const applyDate = entry.applyDate.toISOString().slice(0, 10);
      if (applyDate < earliestDate) earliestDate = applyDate;
    }
    // 如果有显式请求的 symbol 但没有未确认记录，用 30 天前作为起始
    if (requestedSymbols.length > 0 && unconfirmedEntries.length === 0) {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      earliestDate = d.toISOString().slice(0, 10);
    }

    // 为每个基金预加载历史净值（从最早申请日期到今天）
    for (const fundCode of fundCodes) {
      if (!fundCode) continue;
      const navList = await fetchHistoricalNavList(fundCode, earliestDate, now.toISOString().slice(0, 10));
      if (navList.length > 0) {
        navCacheByFund.set(fundCode, navList);
        // 将净值写入缓存表（含申购状态）
        await preloadNavListToCache(fundCode, navList);
      }
    }

    for (const entry of unconfirmedEntries) {
      if (!entry.fundCode) continue;
      try {
        const applyDate = entry.applyDate.toISOString().slice(0, 10);
        const confirmDays = entry.confirmDate ? null : await getFundConfirmDays(accountId, entry.fundCode);
        const confirmDate = entry.confirmDate
          ? entry.confirmDate.toISOString().slice(0, 10)
          : addWorkdaysUtc(applyDate, confirmDays ?? 1);
        if (confirmDate < applyDate) logger.warn(`confirmDate ${confirmDate} < applyDate ${applyDate}, confirmDays=${confirmDays}`, "fund/refresh");

        // 先从预加载的净值列表中查找
        const navList = navCacheByFund.get(entry.fundCode);
        let navData: { nav: number; cumNav: number | null; name: string | null; dateMatch: boolean; actualDate?: string } | null = null;

        if (navList && navList.length > 0) {
          const found = navList.find((item) => item.date === confirmDate);
          if (found) {
            navData = {
              nav: found.nav,
              cumNav: found.cumNav,
              name: null,
              dateMatch: true,
              actualDate: found.date,
            };
          }
        }

        // 如果预加载列表中没有找到，使用原有的查询方式
        if (!navData) {
          navData = await getFundNav(entry.fundCode, utcDate(confirmDate), accountId);
        }

        const hasExactNav = !!navData && navData.dateMatch;

        const actualConfirmDate = utcDate(confirmDate);

        // Determine fee type based on fundSubtype (buy vs redeem/switch_out)
        const feeType = (entry.fundSubtype === FundSubtype.redeem || entry.fundSubtype === FundSubtype.switch_out)
          ? "redeem"
          : "buy";
        const feeRateRaw = await getFundFeeRateByDate(accountId, entry.fundCode, actualConfirmDate, feeType);
        const feeRate = feeRateRaw / 100;

        const amount = Math.abs(toNum(entry.grossAmount));
        const isBuyEntry = entry.fundSubtype === FundSubtype.buy;
        const refundAmount = isBuyEntry ? refundAmountOf(entry) : 0;
        const confirmedAmount = isBuyEntry ? Math.max(0, amount - refundAmount) : amount;
        const fee = confirmedAmount * feeRate;

        let units: number | null = null;
        if (hasExactNav && navData && navData.nav > 0) {
          if (entry.fundSubtype === FundSubtype.redeem || entry.fundSubtype === FundSubtype.switch_out) {
            // 赎回: received = units * nav * (1 - feeRate) => units = received / (nav * (1 - feeRate))
            const divisor = navData.nav * (1 - feeRate);
            units = divisor > 0 ? roundFundUnits(amount / divisor, fundUnitsDecimals) : null;
          } else {
            units = calculateConfirmedBuyUnits({
              grossAmount: amount,
              refundAmount,
              fee,
              nav: navData.nav,
              roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
            });
          }
        }

        // 更新 FundTransaction：写入净值、确认日期、手续费、份额。
        const updateData: {
          nav?: number;
          confirmDate: Date;
          fee: number;
          units?: number;
          fundName?: string;
        } = {
          confirmDate: actualConfirmDate,
          fee,
        };
        if (hasExactNav && navData) {
          updateData.nav = navData.nav;
          if (navData.name) {
            updateData.fundName = navData.name;
          }
        }
        if (units != null && Number.isFinite(units) && units > 0) {
          updateData.units = units;
        }

        await prisma.fundTransaction.update({
          where: { id: entry.id },
          data: updateData,
        });
        syncedEntryIds.push(entry.id);
        entryFilled++;
        if (hasExactNav) entryNavFilled++;
      } catch {
        entryFailed++;
      }
    }

    if (entryFilled > 0) {
      await ensureFundTransactionCashFlowLinks(prisma, syncedEntryIds);
      await recalcFundPositions(accountId).catch(logger.catchLog("操作失败", "route.ts"));
    }

    const heldNavResult = await refreshHeldFundLatestNavs({ accountId });

    // Client-side handles page refresh

    return NextResponse.json({
      ok: true,
      entryFilled,
      entryNavFilled,
      entryFailed,
      holdingNavChecked: heldNavResult.checked,
      holdingNavRefreshed: heldNavResult.latestNavAvailable,
      holdingNavFailed: heldNavResult.failed,
      nameFixed: heldNavResult.nameFixed,
      message: `补填确认净值 ${entryFilled} 笔${entryFailed > 0 ? `，${entryFailed} 笔失败` : ""}${heldNavResult.nameFixed > 0 ? `，修正名称 ${heldNavResult.nameFixed} 个` : ""}`,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "刷新失败" },
      { status: 500 }
    );
  }
}
