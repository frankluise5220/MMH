import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId")?.trim();
  const yearStr = searchParams.get("year")?.trim();
  const monthStr = searchParams.get("month")?.trim();
  const mode = searchParams.get("mode") || "month";

  if (!accountId) {
    return NextResponse.json({ ok: false, error: "缺少参数" }, { status: 400 });
  }

  try {
    const holdings = await prisma.fundHolding.findMany({
      where: { accountId, units: { gt: 0 } },
      select: { fundCode: true, units: true },
    });
    if (holdings.length === 0) {
      return NextResponse.json({ ok: true, days: [], months: [] });
    }

    const fundCodes = holdings.map(h => h.fundCode);
    const unitsByCode = new Map(holdings.map(h => [h.fundCode, Number(h.units)]));

    // Year mode: return monthly summaries
    if (mode === "year" && yearStr) {
      const year = parseInt(yearStr, 10);
      const startDate = new Date(Date.UTC(year - 1, 11, 25));
      const endDate = new Date(Date.UTC(year + 1, 0, 5));

      const navRecords = await prisma.fundNavCache.findMany({
        where: { fundCode: { in: fundCodes }, navDate: { gte: startDate, lte: endDate } },
        orderBy: { navDate: "asc" },
        select: { fundCode: true, navDate: true, nav: true },
      });

      const navByDate = new Map<string, Map<string, number>>(); // date → fundCode → nav
      for (const r of navRecords) {
        const ds = r.navDate.toISOString().slice(0, 10);
        if (!navByDate.has(ds)) navByDate.set(ds, new Map());
        navByDate.get(ds)!.set(r.fundCode, Number(r.nav));
      }

      const daysList = Array.from(navByDate.keys()).sort();
      const months: Array<{ month: number; pnl: number | null; mv: number | null }> = [];

      // For each month, find the last available NAV day
      let prevMonthMv: number | null = null;
      for (let m = 1; m <= 12; m++) {
        const lastDay = new Date(year, m, 0).getDate();
        let lastNavDate = "";
        // scan from last day backwards
        for (let d = lastDay; d >= 1; d--) {
          const ds = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          if (navByDate.has(ds)) { lastNavDate = ds; break; }
        }
        if (!lastNavDate) {
          months.push({ month: m, pnl: null, mv: null });
          continue;
        }

        const fundNavs = navByDate.get(lastNavDate)!;
        let mv = 0;
        for (const code of fundCodes) {
          const units = unitsByCode.get(code) || 0;
          const nav = fundNavs.get(code);
          if (nav) mv += units * nav;
        }
        mv = Math.round(mv * 100) / 100;
        const pnl = prevMonthMv !== null ? Math.round((mv - prevMonthMv) * 100) / 100 : null;
        months.push({ month: m, mv, pnl: pnl !== 0 ? pnl : null });
        prevMonthMv = mv;
      }

      return NextResponse.json({ ok: true, months });
    }

    // Month mode
    const year = parseInt(yearStr!, 10);
    const month = parseInt(monthStr!, 10);

    const startDate = new Date(Date.UTC(year, month - 2, 25));
    const endDate = new Date(Date.UTC(year, month, 5));

    const navRecords = await prisma.fundNavCache.findMany({
      where: { fundCode: { in: fundCodes }, navDate: { gte: startDate, lte: endDate } },
      orderBy: { navDate: "asc" },
      select: { fundCode: true, navDate: true, nav: true },
    });

    const navByDate = new Map<string, Map<string, number>>();
    for (const r of navRecords) {
      const ds = r.navDate.toISOString().slice(0, 10);
      if (!navByDate.has(ds)) navByDate.set(ds, new Map());
      navByDate.get(ds)!.set(r.fundCode, Number(r.nav));
    }

    const dates = Array.from(navByDate.keys()).sort();
    const daysInMonth = new Date(year, month, 0).getDate();
    const results: Array<{ date: string; mv: number; pnl: number | null }> = [];

    // Find last day before this month for baseline
    let prevMv: number | null = null;
    for (let d = 31; d >= 1; d--) {
      const ds = `${year}-${String(month - 1 || 12).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (navByDate.has(ds)) {
        const fundNavs = navByDate.get(ds)!;
        let mv = 0;
        for (const code of fundCodes) {
          const units = unitsByCode.get(code) || 0;
          const nav = fundNavs.get(code);
          if (nav) mv += units * nav;
        }
        prevMv = Math.round(mv * 100) / 100;
        break;
      }
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const ds = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const fundNavs = navByDate.get(ds);
      if (!fundNavs) continue;

      let mv = 0;
      for (const code of fundCodes) {
        const units = unitsByCode.get(code) || 0;
        const nav = fundNavs.get(code);
        if (nav) mv += units * nav;
      }
      mv = Math.round(mv * 100) / 100;
      const pnl = prevMv !== null && prevMv > 0 ? Math.round((mv - prevMv) * 100) / 100 : null;
      results.push({ date: ds, mv, pnl: pnl !== 0 ? pnl : null });
      prevMv = mv;
    }

    return NextResponse.json({ ok: true, days: results });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "查询失败" }, { status: 500 });
  }
}
