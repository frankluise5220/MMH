import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
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
 * 这里用 FundProfile（唯一持有基金名的表）当名称词典反查；查不到的返回
 * null，由前端留空让用户在预览里补一次。资料库只读，反查不写 FundProfile ——
 * 想让下次账单自动匹配，得用户到基金资料页把这批基金补进去。
 */
export async function POST(req: NextRequest) {
  try {
    await getHouseholdScope();
    const body = await req.json() as { names?: unknown };
    const names = Array.isArray(body?.names)
      ? Array.from(new Set(body.names.map((name) => String(name ?? "").trim()).filter(Boolean))).slice(0, 200)
      : [];
    if (names.length === 0) {
      return NextResponse.json({ ok: true, items: [] });
    }

    // 名称词典只来自 FundProfile —— 唯一持有基金名的地方。
    const profiles = await prisma.fundProfile.findMany({
      where: { fundName: { not: null } },
      select: { fundCode: true, fundName: true },
    });

    const libraryMap = new Map<string, FundNameLibraryEntry>();
    for (const row of profiles) {
      if (row.fundName) libraryMap.set(row.fundCode, { fundCode: row.fundCode, name: row.fundName });
    }

    const { resolved, unresolved } = matchFundNamesToCodes(names, Array.from(libraryMap.values()));
    const resolvedByName = new Map(resolved.map((item) => [item.name, item]));

    // 本地库里没有的基金，联网用名称反查 —— 只把结果带回本次预览，不写 FundProfile。
    // 资料库的写入只允许发生在基金资料页。
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

    // 不再顺手刷新 FundProfile：资料库的写入只允许发生在基金资料页。
    // 按名字反查是纯读操作，命中结果只用于本次导入预览。
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
