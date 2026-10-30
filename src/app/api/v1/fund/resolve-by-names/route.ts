import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { refreshFundProfile } from "@/lib/fund/fundProfile";
import {
  matchFundNamesToCodes,
  type FundNameLibraryEntry,
} from "@/lib/fund/fund-name-match";
import { resolveFundCodeBySearch } from "@/lib/fund/fund-name-search";

/** 单个基金名的联网反查：超时即放弃（返回 null），不拖住整批解析。 */
async function searchWithTimeout(name: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resolveFundCodeBySearch(name, controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 按基金名称反查 6 位基金代码。
 *
 * POST /api/v1/fund/resolve-by-names  body: { names: string[] }
 * 返回 { items: [{ name, fundCode | null, matchedName, exact }] }
 *
 * 账单（支付宝 / 微信）只有基金名、没有代码，而基金导入要求 /^\d{6}$/ 的代码。
 * 这里用本地已有的 FundProfile / FundNavCache 当名称词典反查；查不到的返回
 * null，由前端留空让用户在预览里补一次 —— 导入成功后本地就有该基金资料，
 * 之后同样的账单能自动匹配。
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const body = await req.json() as { names?: unknown };
    const names = Array.isArray(body?.names)
      ? Array.from(new Set(body.names.map((name) => String(name ?? "").trim()).filter(Boolean))).slice(0, 200)
      : [];
    if (names.length === 0) {
      return NextResponse.json({ ok: true, items: [] });
    }

    const [profiles, navNames] = await Promise.all([
      prisma.fundProfile.findMany({
        where: { fundName: { not: null } },
        select: { fundCode: true, fundName: true },
      }),
      prisma.fundNavCache.findMany({
        where: { name: { not: null } },
        distinct: ["fundCode"],
        select: { fundCode: true, name: true },
      }),
    ]);

    const libraryMap = new Map<string, FundNameLibraryEntry>();
    for (const row of profiles) {
      if (row.fundName) libraryMap.set(row.fundCode, { fundCode: row.fundCode, name: row.fundName });
    }
    for (const row of navNames) {
      if (libraryMap.has(row.fundCode) || !row.name) continue;
      libraryMap.set(row.fundCode, { fundCode: row.fundCode, name: row.name });
    }

    const { resolved, unresolved } = matchFundNamesToCodes(names, Array.from(libraryMap.values()));
    const resolvedByName = new Map(resolved.map((item) => [item.name, item]));

    // 本地库里没有的基金，联网用名称反查 —— 查到就把基金资料拉回来写进本地库，
    // 下次同样的账单直接走本地匹配，不用再联网，也不需要用户手填。
    //
    // 必须并发 + 逐个限时：账单里通常有近十只本地没有的基金，串行 await 会把
    // 「读取文件」阶段拖成几十秒（用户报告的导入很慢），一次卡住的请求还会拖死全部。
    // 并且必须给**整批**一个总时限：逐个 8s × 20 个 ÷ 并发 4 = 最坏 40s，外部接口
    // 一限速，「读取文件 → 出明细」就变成一分钟（2026-10-30 用户再次反馈很慢）。
    // 总时限到点就带着已经命中的结果返回，没命中的留空、由用户在预览里补一次。
    // 健康情况下 20 个名称合计 < 1s（实测 525ms），所以这条时限只在外部接口劣化时生效。
    const MAX_ONLINE_LOOKUPS = 20;
    const ONLINE_LOOKUP_CONCURRENCY = 4;
    const ONLINE_LOOKUP_TIMEOUT_MS = 8_000;
    const ONLINE_LOOKUP_BUDGET_MS = 6_000;
    const queue = unresolved.slice(0, MAX_ONLINE_LOOKUPS);
    const onlineHits: Array<{ name: string; fundCode: string }> = [];
    let cursor = 0;
    let budgetExceeded = false;
    const lookupWorker = async () => {
      // 总时限到点后不再发起新请求；正在飞的请求由外层 Promise.race 直接放弃等待。
      while (cursor < queue.length && !budgetExceeded) {
        const unresolvedName = queue[cursor];
        cursor += 1;
        const hit = await searchWithTimeout(unresolvedName, ONLINE_LOOKUP_TIMEOUT_MS);
        if (!hit) continue;
        resolvedByName.set(unresolvedName, {
          name: unresolvedName,
          fundCode: hit.fundCode,
          matchedName: hit.name,
          exact: false,
        });
        onlineHits.push({ name: unresolvedName, fundCode: hit.fundCode });
      }
    };
    let budgetTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        Promise.all(
          Array.from({ length: Math.min(ONLINE_LOOKUP_CONCURRENCY, queue.length) }, () => lookupWorker()),
        ),
        new Promise<void>((resolve) => {
          budgetTimer = setTimeout(() => {
            budgetExceeded = true;
            resolve();
          }, ONLINE_LOOKUP_BUDGET_MS);
        }),
      ]);
    } finally {
      budgetExceeded = true;
      if (budgetTimer) clearTimeout(budgetTimer);
    }

    // 刷新资料（含基金公司 / 托管人）写入 FundProfile；失败不影响本次解析结果。
    // **故意不 await**：这份资料只有「下一次导入能否走本地匹配」会用到，本次预览一个字
    // 都不显示。冷启动时 15 只基金要各走一次 TLS 握手，实测把响应又拖后 3~4s；这里发起
    // 后立即返回，写库在后台跑完（本应用是长驻 Node 进程，不存在 Serverless 冻结问题）。
    void Promise.all(
      onlineHits.map((hit) =>
        refreshFundProfile(hit.fundCode, { householdId: ctx.householdId }).catch(() => null),
      ),
    );

    const stillUnresolved = names.filter((name) => !resolvedByName.has(name));

    return NextResponse.json({
      ok: true,
      items: names.map((name) => {
        const hit = resolvedByName.get(name);
        return hit
          ? { name, fundCode: hit.fundCode, matchedName: hit.matchedName, exact: hit.exact }
          : { name, fundCode: null, matchedName: null, exact: false };
      }),
      unresolvedCount: stillUnresolved.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "resolve failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
