import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getLatestFundNav, refreshLatestFundNav, setFundNav } from "@/lib/fund/navCache";

/**
 * 获取基金名称（优先从净值缓存库，再从外部API，最后从持仓库）
 * GET /api/v1/fund/name?code=000001
 *
 * 1. 先从净值缓存库查询（权威来源，切断持仓→明细名称传播循环）
 * 2. 如果找不到，从外部API获取
 * 3. 最后从持仓库兜底（仅在navCache和外部API都没有时）
 */

function utcDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

async function fetchFromEastmoney(fundCode: string, headers: Record<string, string>): Promise<string | null> {
  try {
    // 方法1: 天天基金快查API
    const url1 = `http://fundgz.1234567.com.cn/js/${fundCode}.js?rt=${Date.now()}`;
    const res1 = await fetch(url1, {
      headers: { ...headers, Referer: `http://fundf10.eastmoney.com/jjjz_${fundCode}.html` },
      cache: "no-store"
    });
    const text1 = await res1.text();
    const m1 = text1.match(/\{.+\}/);
    if (m1) {
      try {
        const data: any = JSON.parse(m1[0]);
        if (data?.dwjz && data?.jzrq) {
          const nav = parseFloat(data.dwjz);
          const cumNav = data?.ljjz ? parseFloat(data.ljjz) : nav;
          if (Number.isFinite(nav) && nav > 0) {
            await setFundNav(fundCode, utcDate(data.jzrq), nav, Number.isFinite(cumNav) ? cumNav : nav, data?.name ?? null).catch((error) => {
              console.warn("Failed to cache fund NAV from name fallback", { fundCode, error });
            });
          }
        }
        if (data?.name) return data.name as string;
      } catch {}
    }

    // 方法2: 从基金详情页提取
    const url2 = `http://fundf10.eastmoney.com/jjjz_${fundCode}.html`;
    const res2 = await fetch(url2, {
      headers: { ...headers, Referer: url2 },
      cache: "no-store"
    });
    const html2 = await res2.text();
    // 多种匹配模式
    const patterns = [
      /基金简称[：<>\s]*([^：<>\s]{2,30})(?:基金|\s|<)/,
      /基金名称[：<>\s]*([^：<>\s]{2,30})(?:基金|\s|<)/,
      /<title[^>]*>([^<]{2,30})[（(]\d{6}[）)]/,  // title: "基金名称(代码)" or "基金名称（代码）"
      /f_name[^>]*>\s*([^<]{2,30})\s*</,    // 天天基金页面变量
    ];
    for (const pattern of patterns) {
      const match = html2.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        if (name && name.length > 2 && !/基金历史净值|基金档案|天天基金|基金吧/.test(name)) return name;
      }
    }
  } catch {}
  return null;
}

async function fetchFromDanjuan(fundCode: string, headers: Record<string, string>): Promise<string | null> {
  try {
    // 蛋卷基金API
    const url = `https://danjuanfunds.com/djapi/fund/${fundCode}`;
    const res = await fetch(url, {
      headers: {
        ...headers,
        Referer: `https://danjuanfunds.com/fund/${fundCode}`,
        Accept: "application/json",
      },
      cache: "no-store"
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (data?.data?.fd_name) return data.data.fd_name as string;
    if (data?.fd_name) return data.fd_name as string;
  } catch {}
  return null;
}

async function fetchFromFund123(fundCode: string, headers: Record<string, string>): Promise<string | null> {
  try {
    // 天天基金基金搜索API
    const url = `http://so.eastmoney.com/web/s?keyword=${fundCode}`;
    const res = await fetch(url, {
      headers: { ...headers },
      cache: "no-store"
    });
    const html = await res.text();
    // 从搜索结果页提取基金名称
    const match = html.match(new RegExp(`${fundCode}[^<]*?([^<]+?)</a>`));
    if (match && match[1]) {
      const name = match[1].trim();
      if (name && name.length > 2 && !name.includes("基金代码") && !/基金历史净值|基金档案|天天基金|基金吧/.test(name)) return name;
    }
  } catch {}
  return null;
}

async function fetchFromAlipay(fundCode: string, headers: Record<string, string>): Promise<string | null> {
  try {
    // 支付宝基金API（通过蚂蚁财富）
    const url = `https://fund.alipay.com/fund/fundDetail.htm?fundCode=${fundCode}`;
    const res = await fetch(url, {
      headers: { ...headers },
      cache: "no-store"
    });
    const html = await res.text();
    // 从页面标题或内容提取名称
    const patterns = [
      /<title[^>]*>([^<]+基金)/,
      /基金名称[：<>\s]*([^：<>\s]+)/,
      /fund-name[^>]*>([^<]+)</,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        if (name && name.length > 2 && !/基金历史净值|基金档案|天天基金|基金吧/.test(name)) return name;
      }
    }
  } catch {}
  return null;
}
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const fundCode = searchParams.get("code")?.trim();

  if (!fundCode) {
    return NextResponse.json({ ok: false, error: "缺少基金代码" }, { status: 400 });
  }

  try {
    // 1. 先从净值缓存库查询（权威来源，切断持仓→明细名称传播循环）
    const latestNav = await getLatestFundNav(fundCode);
    if (latestNav?.name) {
      return NextResponse.json({
        ok: true,
        name: latestNav.name,
        nav: toNumber(latestNav.nav),
        navDate: latestNav.navDate?.toISOString?.()?.slice(0, 10) ?? null,
        source: "navcache",
      });
    }

    const refreshedNav = await refreshLatestFundNav(fundCode);
    if (refreshedNav?.name || refreshedNav?.nav) {
      return NextResponse.json({
        ok: true,
        name: refreshedNav.name ?? fundCode,
        nav: toNumber(refreshedNav.nav),
        navDate: refreshedNav.navDate?.toISOString?.()?.slice(0, 10) ?? null,
        source: "navapi",
      });
    }

    // 2. 本地缓存没有，尝试多个外部API获取
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    };

    // 尝试天天基金API
    const eastmoneyName = await fetchFromEastmoney(fundCode, headers);
    if (eastmoneyName) {
      return NextResponse.json({
        ok: true,
        name: eastmoneyName,
        source: "eastmoney",
      });
    }

    // 尝试蛋卷基金API
    const danjuanName = await fetchFromDanjuan(fundCode, headers);
    if (danjuanName) {
      return NextResponse.json({
        ok: true,
        name: danjuanName,
        source: "danjuan",
      });
    }

    // 尝试天天基金搜索API
    const fund123Name = await fetchFromFund123(fundCode, headers);
    if (fund123Name) {
      return NextResponse.json({
        ok: true,
        name: fund123Name,
        source: "fund123",
      });
    }

    // 尝试支付宝基金API
    const alipayName = await fetchFromAlipay(fundCode, headers);
    if (alipayName) {
      return NextResponse.json({
        ok: true,
        name: alipayName,
        source: "alipay",
      });
    }

    // 3. 最后从持仓库兜底（仅在navCache和外部API都没有时）
    const holding = await prisma.fundHolding.findFirst({
      where: { fundCode },
      select: { fundName: true },
    });
    if (holding?.fundName) {
      return NextResponse.json({
        ok: true,
        name: holding.fundName,
        source: "holding",
      });
    }

    return NextResponse.json({ ok: false, error: `未找到基金代码 ${fundCode}，请确认代码是否正确` }, { status: 404 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 }
    );
  }
}
