import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { addWorkdaysUtc } from "@/lib/date-utils";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { getFundConfirmDays } from "@/lib/fund/confirmDays";
import { getFundNav, fetchHistoricalNavList, findNavFallback, preloadNavListToCache, NavListItem } from "@/lib/fund/navCache";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";

const toNum = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

function utcDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

async function getLatestNav(fundCode: string) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Referer: `http://fundgz.1234567.com.cn/js/${fundCode}.js`,
  };
  const url = `http://fundgz.1234567.com.cn/js/${fundCode}.js?rt=${Date.now()}`;
  const res = await fetch(url, { headers, cache: "no-store" });
  const text = await res.text();
  const m = text.match(/\{.+\}/);
  if (!m) return null;
  let data: any;
  try { data = JSON.parse(m[0]); } catch { return null; }
  if (!data?.dwjz) return null;
  return {
    name: data.name as string,
    nav: parseFloat(data.dwjz),
    date: data.jzrq as string,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const accountId = String(body.accountId ?? "").trim();
    if (!accountId) return NextResponse.json({ ok: false, error: "缺少 accountId" }, { status: 400 });

    let entryFilled = 0;
    let entryFailed = 0;

    // 直接查询 TxRecord 中未确认的基金交易（包括 fundSubtype 为 null 的记录）
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
    const fundCodes = [...new Set(unconfirmedEntries.map(e => e.fundCode).filter(Boolean))];
    const navCacheByFund: Map<string, NavListItem[]> = new Map();

    // 找出所有记录的最早和最晚确认日期
    const now = new Date();
    let earliestDate = now.toISOString().slice(0, 10);
    for (const entry of unconfirmedEntries) {
      if (!entry.fundCode) continue;
      const applyDate = entry.date.toISOString().slice(0, 10);
      if (applyDate < earliestDate) earliestDate = applyDate;
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

        // 先从预加载的净值列表中查找
        const navList = navCacheByFund.get(entry.fundCode);
        let navData: { nav: number; cumNav: number | null; name: string | null; dateMatch: boolean; actualDate?: string } | null = null;

        if (navList && navList.length > 0) {
          const found = findNavFallback(navList, confirmDate);
          if (found) {
            const dateMatch = found.date === confirmDate;
            navData = {
              nav: found.nav,
              cumNav: found.cumNav,
              name: null,
              dateMatch,
              actualDate: found.date,
            };
          }
        }

        // 如果预加载列表中没有找到，使用原有的查询方式
        if (!navData) {
          navData = await getFundNav(entry.fundCode, utcDate(confirmDate));
        }

        if (!navData) { entryFailed++; continue; }

        // 如果净值日期与确认日期不一致，使用实际净值日期作为确认日期
        const actualConfirmDate = navData.dateMatch
          ? utcDate(confirmDate)
          : utcDate(navData.actualDate ?? confirmDate);

        // Determine fee type based on fundSubtype (buy vs redeem/switch_out)
        const feeType = (entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out")
          ? "redeem"
          : "buy";
        const feeRate = await getFundFeeRateByDate(accountId, entry.fundCode, actualConfirmDate, feeType);

        const amount = Math.abs(toNum(entry.amount));
        // 计算手续费 = 金额 × 费率
        const fee = amount * feeRate;

        let units: number | null = null;
        if (navData.nav > 0) {
          if (entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out") {
            // 赎回: received = units * nav * (1 - feeRate) => units = received / (nav * (1 - feeRate))
            const divisor = navData.nav * (1 - feeRate);
            units = divisor > 0 ? amount / divisor : null;
          } else {
            // 买入: principal = amount - fee, units = principal / nav
            const principal = amount - fee;
            units = principal > 0 ? principal / navData.nav : null;
          }
        }

        // 如果 fundSubtype 为 null，根据金额符号推断类型
        const inferredSubtype = entry.fundSubtype ?? (toNum(entry.amount) < 0 ? "buy" : "redeem");

        // 更新 TxRecord：写入净值、确认日期、手续费、份额、交易类型
        const updateData: {
          fundNav: number;
          fundConfirmDate: Date;
          fundFee: number;
          fundUnits?: number;
          fundSubtype?: string;
          fundName?: string;
        } = {
          fundNav: navData.nav,
          fundConfirmDate: actualConfirmDate,
          fundFee: fee,
        };
        if (units != null && Number.isFinite(units) && units > 0) {
          updateData.fundUnits = units;
        }
        if (entry.fundSubtype == null) {
          updateData.fundSubtype = inferredSubtype;
        }
        if (navData.name) {
          updateData.fundName = navData.name;
        }

        await prisma.txRecord.update({
          where: { id: entry.id },
          data: updateData as any,
        });
        entryFilled++;
      } catch {
        entryFailed++;
      }
    }

    if (entryFilled > 0) {
      await recalcFundPositions(accountId).catch(() => {});
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
        const latestNav = await getLatestNav(h.fundCode);
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

    revalidateAfterInvestChange();

    return NextResponse.json({
      ok: true,
      entryFilled,
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