import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { addWorkdaysUtc } from "@/lib/date-utils";
import { getFundConfirmDays } from "@/lib/fund/confirmDays";
import { getFundNav, fetchHistoricalNavList, preloadNavListToCache, refreshLatestFundNav, NavListItem } from "@/lib/fund/navCache";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { getAccountFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { logger } from "@/lib/logger";

const toNum = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

function utcDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const accountId = String(body.accountId ?? "").trim();
    if (!accountId) return NextResponse.json({ ok: false, error: "缺少 accountId" }, { status: 400 });

    let entryFilled = 0;
    let entryFailed = 0;
    let entryNavFilled = 0;
    const fundUnitsDecimals = await getAccountFundUnitsDecimals(accountId);

    // 直接查询 TxRecord 中未确认的基金交易（包括 fundSubtype 为 null 的记录）
    const requestedSymbols: string[] = Array.isArray(body.symbols) ? body.symbols.map(String).filter(Boolean) : [];
    const unconfirmedEntries = await prisma.txRecord.findMany({
      where: {
        fundNav: null,
        deletedAt: null,
        OR: [
          { toAccountId: accountId, OR: [{ fundSubtype: null }, { fundSubtype: { in: ["buy", "redeem", "switch_out"] } }] },
          { accountId: accountId, OR: [{ fundSubtype: null }, { fundSubtype: { in: ["buy", "redeem", "switch_out"] } }] },
        ],
      },
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
      const applyDate = entry.date.toISOString().slice(0, 10);
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
        const applyDate = entry.date.toISOString().slice(0, 10);
        const confirmDays = await getFundConfirmDays(accountId, entry.fundCode);
        const confirmDate = addWorkdaysUtc(applyDate, confirmDays);
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
          navData = await getFundNav(entry.fundCode, utcDate(confirmDate));
        }

        const hasExactNav = !!navData && navData.dateMatch;

        const actualConfirmDate = utcDate(confirmDate);

        // Determine fee type based on fundSubtype (buy vs redeem/switch_out)
        const feeType = (entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out")
          ? "redeem"
          : "buy";
        const feeRateRaw = await getFundFeeRateByDate(accountId, entry.fundCode, actualConfirmDate, feeType);
        const feeRate = feeRateRaw / 100;

        const amount = Math.abs(toNum(entry.amount));
        // 计算手续费 = 金额 × 费率
        const fee = amount * feeRate;

        let units: number | null = null;
        if (hasExactNav && navData && navData.nav > 0) {
          if (entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out") {
            // 赎回: received = units * nav * (1 - feeRate) => units = received / (nav * (1 - feeRate))
            const divisor = navData.nav * (1 - feeRate);
            units = divisor > 0 ? roundFundUnits(amount / divisor, fundUnitsDecimals) : null;
          } else {
            // 买入: principal = amount - fee, units = principal / nav
            const principal = amount - fee;
            units = principal > 0 ? roundFundUnits(principal / navData.nav, fundUnitsDecimals) : null;
          }
        }

        // 如果 fundSubtype 为 null，根据金额符号推断类型
        const inferredSubtype = entry.fundSubtype ?? (toNum(entry.amount) < 0 ? "buy" : "redeem");

        // 更新 TxRecord：写入净值、确认日期、手续费、份额、交易类型
        const updateData: {
          fundNav?: number;
          fundConfirmDate: Date;
          fundFee: number;
          fundUnits?: number;
          fundSubtype?: string;
          fundName?: string;
        } = {
          fundConfirmDate: actualConfirmDate,
          fundFee: fee,
        };
        if (hasExactNav && navData) {
          updateData.fundNav = navData.nav;
          if (navData.name) {
            updateData.fundName = navData.name;
          }
        }
        if (units != null && Number.isFinite(units) && units > 0) {
          updateData.fundUnits = units;
        }
        if (entry.fundSubtype == null) {
          updateData.fundSubtype = inferredSubtype;
        }

        await prisma.txRecord.update({
          where: { id: entry.id },
          data: updateData as any,
        });
        entryFilled++;
        if (hasExactNav) entryNavFilled++;
      } catch {
        entryFailed++;
      }
    }

    if (entryFilled > 0) {
      await recalcFundPositions(accountId).catch(logger.catchLog("操作失败", "route.ts"));
    }

    // 额外刷新所有基金的名称（从外部API获取最新名称，直接写入）
    const allHoldings = await prisma.fundHolding.findMany({
      where: { accountId },
      select: { fundCode: true, fundName: true },
    });

    let nameFixed = 0;
    for (const h of allHoldings) {
      if (!h.fundCode) continue;
      try {
        // 获取最新净值（同时带回基金名称）
        const latestNav = await refreshLatestFundNav(h.fundCode);
        if (!latestNav?.name) continue;

        // 直接更新基金名称（如果名称不同）
        if (latestNav.name !== h.fundName) {
          await prisma.fundHolding.update({
            where: { accountId_fundCode: { accountId, fundCode: h.fundCode } },
            data: { fundName: latestNav.name },
          });
          nameFixed++;
        }
      } catch {
        // 忽略单个基金名称获取失败
      }
    }

    // Client-side handles page refresh

    return NextResponse.json({
      ok: true,
      entryFilled,
      entryNavFilled,
      entryFailed,
      nameFixed,
      message: `补填确认净值 ${entryFilled} 笔${entryFailed > 0 ? `，${entryFailed} 笔失败` : ""}${nameFixed > 0 ? `，修正名称 ${nameFixed} 个` : ""}`,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "刷新失败" },
      { status: 500 }
    );
  }
}
