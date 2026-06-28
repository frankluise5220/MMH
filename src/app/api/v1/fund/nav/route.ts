import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { addWorkdaysUtc } from "@/lib/date-utils";
import { getFundNav, getLatestFundNav, refreshLatestFundNav, setFundNav } from "@/lib/fund/navCache";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { getFundConfirmDays } from "@/lib/fund/confirmDays";
import { getAccountFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { logger } from "@/lib/logger";

const toNum = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

function utcDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

async function getNav(fundCode: string, dateStr: string) {
  const navDate = utcDate(dateStr);
  const cached = await getFundNav(fundCode, navDate);
  if (cached) {
    return {
      date: cached.actualDate ?? dateStr,
      nav: cached.nav,
      cumNav: cached.cumNav ?? undefined,
      name: cached.name ?? undefined,
    };
  }
  // 指定日期如果是未来日期/非交易日，东方财富历史净值可能没有数据。
  // 回退到缓存或最新净值，避免赎回界面误以为函数调用失败；返回 date 用于提示实际净值日期。
  const latest = await getLatestFundNav(fundCode);
  if (latest) {
    return {
      date: latest.navDate.toISOString().slice(0, 10),
      nav: latest.nav,
      cumNav: latest.cumNav ?? undefined,
      name: latest.name ?? undefined,
    };
  }
  return null;
}

/*
async function fetchNavFromEastmoney(fundCode: string, date?: string) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Referer: `http://fundf10.eastmoney.com/jjjz_${fundCode}.html`,
  };

  if (date) {
    // 先用精确日期查询
    const exactUrl = `http://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=1&pageSize=5&startDate=${date}&endDate=${date}`;
    const exactRes = await fetch(exactUrl, { headers, cache: "no-store" });
    let json: any = null;
    try { json = await exactRes.json(); } catch { ignore }
    const list: { FSRQ: string; DWJZ: string; LJJZ: string }[] =
      json?.Data?.LSJZList ?? [];
    if (list.length > 0) {
      return { date: list[0]!.FSRQ, nav: parseFloat(list[0]!.DWJZ), cumNav: parseFloat(list[0]!.LJJZ) };
    }

    // 精确日期无数据（非交易日），扩大范围搜索前后 30 天
    const target = new Date(date + "T00:00:00Z");
    const startDate = new Date(target.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const endDate = new Date(target.getTime() + 30 * 86400000).toISOString().slice(0, 10);
    const rangeUrl = `http://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=1&pageSize=50&startDate=${startDate}&endDate=${endDate}`;
    const rangeRes = await fetch(rangeUrl, { headers, cache: "no-store" });
    let rangeJson: any = null;
    try { rangeJson = await rangeRes.json(); } catch { return null; }
    const rangeList: { FSRQ: string; DWJZ: string; LJJZ: string }[] =
      rangeJson?.Data?.LSJZList ?? [];
    if (rangeList.length === 0) return null;

    // 按日期降序，找≤目标日期最近的交易日净值
    const sorted = rangeList
      .map((item: any) => ({ ...item, _t: new Date(item.FSRQ + "T00:00:00Z").getTime() }))
      .sort((a: any, b: any) => b._t - a._t);
    const targetTime = target.getTime();
    for (const item of sorted) {
      if (item._t <= targetTime) {
        return { date: item.FSRQ, nav: parseFloat(item.DWJZ), cumNav: parseFloat(item.LJJZ) };
      }
    }
    // 没有≤目标日期的，返回最新的
    const latest = sorted[0];
    return latest ? { date: latest.FSRQ, nav: parseFloat(latest.DWJZ), cumNav: parseFloat(latest.LJJZ) } : null;
  }

  const url = `http://fundgz.1234567.com.cn/js/${fundCode}.js?rt=${Date.now()}`;
  const res = await fetch(url, { headers, cache: "no-store" });
  const text = await res.text();
  const m = text.match(/\{.+\}/);
  if (!m) return null;
  let data: any;
  try { data = JSON.parse(m[0]); } catch { return null; }
  if (!data?.dwjz) return null;
  return {
    date: data.jzrq as string,
    nav: parseFloat(data.dwjz),
    cumNav: parseFloat(data.dwjz),
    name: data.name as string,
    estimatedNav: parseFloat(data.gsz),
    estimatedTime: data.gztime as string,
  };
}

*/
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const fundCode = searchParams.get("code")?.trim();
  const date = searchParams.get("date")?.trim();

  if (!fundCode) {
    return NextResponse.json({ ok: false, error: "缺少基金代码" }, { status: 400 });
  }

  try {
    if (date) {
      // 使用 getNav()（包含缓存→东方财富→最新净值回退链），避免未来日期/非交易日无数据时直接报错
      const data = await getNav(fundCode, date);
      if (!data) {
        return NextResponse.json({ ok: false, error: `未找到基金代码 ${fundCode} 的净值，请确认代码是否正确` }, { status: 404 });
      }
      return NextResponse.json({ ok: true, ...data });
    }

    // 无日期时：查询实时估值
    const latest = await refreshLatestFundNav(fundCode);
    if (!latest) {
      return NextResponse.json({ ok: false, error: `未找到基金代码 ${fundCode} 的净值，请确认代码是否正确` }, { status: 404 });
    }
    const navDateStr = latest.navDate.toISOString().slice(0, 10);
    return NextResponse.json({
      ok: true,
      date: navDateStr,
      nav: latest.nav,
      cumNav: latest.cumNav ?? undefined,
      name: latest.name ?? undefined,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 }
    );
  }
}

/**
 * 补填基金净值（查询净值、计算手续费和份额，并写入 TxRecord）
 *
 * POST { entryId: string, date?: string, confirmDays?: number, amount?: number, fee?: number }
 *   entryId 必须是 TxRecord.id
 *   返回 { ok: true, nav, units, confirmDate, fee } 或 { ok: false, error }
 *
 * 自动从费率库查询申购手续费率，计算手续费和份额，写入数据库。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const entryId = String(body.entryId ?? "").trim();
    if (!entryId) return NextResponse.json({ ok: false, error: "缺少 entryId" }, { status: 400 });

    // 查找 TxRecord
    const txRecord = await prisma.txRecord.findUnique({
      where: { id: entryId },
    });

    if (!txRecord) {
      return NextResponse.json({ ok: false, error: "记录不存在" }, { status: 404 });
    }

    if (!txRecord.toAccountId) {
      return NextResponse.json({ ok: false, error: "该记录不是基金交易" }, { status: 400 });
    }

    const fundCode = txRecord.fundCode;
    if (!fundCode) return NextResponse.json({ ok: false, error: "该记录无基金代码" }, { status: 400 });

    // 优先使用用户传入的申请日期，否则使用数据库中的日期
    const userDate = body.date ? String(body.date) : null;
    const applyDate = userDate ?? txRecord.date.toISOString().slice(0, 10);
    const accountId = txRecord.toAccountId;
    const userConfirmDate = body.confirmDate ? String(body.confirmDate) : null;

    let confirmDate: string;
    let confirmDateObj: Date;
    if (userConfirmDate) {
      confirmDate = userConfirmDate;
      confirmDateObj = utcDate(confirmDate);
    } else {
      // 从确认天数库查询确认天数（使用统一模块）
      const confirmDays = await getFundConfirmDays(accountId, fundCode);
      confirmDate = addWorkdaysUtc(applyDate, confirmDays);
      confirmDateObj = utcDate(confirmDate);
    }

    const navData = await getNav(fundCode, confirmDate);
    if (!navData) {
      return NextResponse.json({ ok: false, error: `未找到 ${confirmDate} 的净值，可能是非交易日` }, { status: 404 });
    }
    if (navData.date && navData.date !== confirmDate) {
      return NextResponse.json(
        { ok: false, error: `${confirmDate} 没有精确净值，最新可用净值日期是 ${navData.date}，未写入份额` },
        { status: 404 }
      );
    }

    const nav = navData.nav;
    // 优先使用用户传入的金额，否则使用数据库中的值
    const userAmount = body.amount ? parseFloat(String(body.amount)) : null;
    const amount = Math.abs(userAmount ?? toNum(txRecord.amount));

    // 从费率库查询申购手续费率（按确认日期查询）
    const feeRateRaw = await getFundFeeRateByDate(accountId, fundCode, confirmDateObj, "buy");
    const feeRate = feeRateRaw / 100;
    // 计算手续费 = 金额 × 费率
    const fee = amount * feeRate;
    // 计算份额 = (金额 - 手续费) / 净值
    const principal = amount - fee;
    const fundUnitsDecimals = await getAccountFundUnitsDecimals(accountId);
    const units = nav > 0 ? roundFundUnits(principal / nav, fundUnitsDecimals) : null;

    // 写入 TxRecord
    const updateData: {
      fundNav: number;
      fundConfirmDate: Date;
      fundFee: number;
      fundUnits?: number;
      fundName?: string;
    } = {
      fundNav: nav,
      fundConfirmDate: confirmDateObj,
      fundFee: fee,
    };
    if (units != null) {
      updateData.fundUnits = units;
    }
    if (navData.name) {
      updateData.fundName = navData.name;
    }

    await prisma.txRecord.update({
      where: { id: entryId },
      data: updateData,
    });

    // 重新计算持仓
    await recalcFundPositions(accountId).catch(logger.catchLog("操作失败", "route.ts"));
    // Client-side handles page refresh

    return NextResponse.json({
      ok: true,
      nav,
      units,
      fee,
      confirmDate,
      name: navData.name,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "补填失败" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const fundCode = String(body.fundCode ?? "").trim();
    const date = String(body.date ?? "").trim();
    const nav = parseFloat(String(body.nav ?? ""));
    if (!fundCode || !date || !Number.isFinite(nav) || nav <= 0) {
      return NextResponse.json({ ok: false, error: "缺少参数" }, { status: 400 });
    }
    await setFundNav(fundCode, new Date(date+"T00:00:00Z"), nav);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "保存失败" }, { status: 500 });
  }
}
