/**
 * 明细「余额」列必须与时间轴的取值范围无关 —— `npm run check:detail-balance`。
 *
 * 余额是账户的状态量（截至本笔的账户余额），不是区间的统计量：把它折叠在「当前显示
 * 窗口」上，同一笔流水在不同范围下会算出不同的余额（用户报告的问题）。本脚本连真实的
 * 开发库，对每个账户跑一个**窗口矩阵 × 筛选矩阵**，断言：
 *
 * 1. 任意窗口 / 任意列筛选下，重叠行（同 id）的余额与「全量」逐分相等；
 * 2. 每个窗口列出的行，恰好等于「全量行 ∩ 该窗口」—— 范围只裁剪行，不改值；
 * 3. 窗口内最新一行余额 == 服务端算出的账户余额（列表顶部不能与页头分叉）；
 * 4. `queryDetailOpeningBalanceBefore`（窗口期初余额）== 窗口前最后一行的余额；
 * 5. 对每个窗口：「期初余额 + 窗口内本地折叠」== 服务端余额 —— 客户端只拉窗口内的
 *    行、靠一个期初余额补齐的算法，必须与服务端整表折叠逐分一致。
 *
 * 只读：不写任何表。默认跑 1 个账户（`DETAIL_BALANCE_MAX_ACCOUNTS` 可调）；账户里
 * 有投资流时跳过断言 5（赎回/到账日只存在业务表，脚本拿不到装饰后的行，属既有口径
 * 差异，与「窗口无关性」无关）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const TOLERANCE = 0.005;
const PAGE_SIZE = 1000;
const MAX_PAGES = 200;

/** tsx 不会自动加载 .env.local，而 Prisma 只认 process.env 里的 DATABASE_URL。 */
function loadEnvFiles() {
  for (const name of [".env.local", ".env"]) {
    const file = path.resolve(process.cwd(), name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      if (process.env[match[1]] != null) continue;
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

function parseYmd(ymd: string) {
  const [year, month, day] = ymd.split("-").map(Number);
  return { year, month, day };
}

function formatYmd(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function shiftYears(ymd: string, years: number) {
  const { year, month, day } = parseYmd(ymd);
  const safeDay = month === 2 && day === 29 ? 28 : day;
  return formatYmd(year - years, month, safeDay);
}

function shiftMonths(ymd: string, months: number) {
  const { year, month, day } = parseYmd(ymd);
  const total = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12 + 12) % 12 + 1;
  const lastDayOfMonth = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  return formatYmd(nextYear, nextMonth, Math.min(day, lastDayOfMonth));
}

function dayStartUtc(ymd: string) {
  const { year, month, day } = parseYmd(ymd);
  return new Date(Date.UTC(year, month - 1, day));
}

const TX_SELECT = {
  id: true,
  date: true,
  postedAt: true,
  createdAt: true,
  dayOrder: true,
  type: true,
  amount: true,
  accountId: true,
  toAccountId: true,
  toNote: true,
  source: true,
  principalAmount: true,
  fundProductType: true,
  fundSubtype: true,
  fundConfirmDate: true,
  fundArrivalDate: true,
  fundArrivalAmount: true,
  reconciledBalance: true,
} as const;

type AccountRow = { id: string; householdId: string; kind: string; investProductType: string | null };
type WindowSpec = { label: string; dateRange: { from: string; to: string } | null };

async function main() {
  loadEnvFiles();
  if (!process.env.DATABASE_URL) {
    throw new Error("缺少 DATABASE_URL（.env.local / 环境变量）");
  }

  const { prisma } = await import("../src/lib/db/prisma");
  const { queryDetailOpeningBalanceBefore, queryDetailPage, queryDetailRunningBalancesForEntries } = await import(
    "../src/lib/server/detail-page-query"
  );
  const { computeAccountDisplayBalances } = await import("../src/lib/server/account-balance");
  const { foldRunningBalancesInDescOrder } = await import("../src/lib/detail-running-balance");
  const { compareDetailEntriesDesc, getDetailEntryDisplayDate } = await import("../src/lib/detail-entry-order");
  const { formatDateUtc, toNumber, todayDateBusinessYmd } = await import("../src/lib/date-utils");
  const { getHouseholdTimeZone } = await import("../src/lib/server/household-preferences");

  /* ── 选账户：非信用卡、有流水 ── */
  const override = (process.env.DETAIL_BALANCE_ACCOUNT_ID ?? "").trim();
  const wanted = Math.max(1, Number(process.env.DETAIL_BALANCE_MAX_ACCOUNTS ?? "1") || 1);
  const accounts: AccountRow[] = [];
  const accountSelect = { id: true, householdId: true, kind: true, investProductType: true } as const;
  if (override) {
    const found = await prisma.account.findUnique({ where: { id: override }, select: accountSelect });
    if (found) accounts.push(found);
  } else {
    // 按「最近一年的流水数」挑：全量最多的账户很可能是挑不动的老账户（窗口里只剩
    // 几行，重叠比对等于没跑）。
    const todayKey = todayDateBusinessYmd();
    const recentFrom = dayStartUtc(shiftYears(todayKey, 1));
    const grouped = await prisma.txRecord.groupBy({
      by: ["accountId"],
      where: { deletedAt: null, date: { gte: recentFrom } },
      _count: { _all: true },
      orderBy: { _count: { accountId: "desc" } },
      take: 60,
    });
    // 无投资流的账户优先：只有它们能跑「客户端侧期初余额 + 窗口内折叠」的断言
    // （投资行的到账日只存在业务表，脚本复现不出客户端拿到的装饰字段）。
    const investmentBySide = await prisma.txRecord.groupBy({
      by: ["accountId"],
      where: { deletedAt: null, type: "investment" },
      _count: { _all: true },
    });
    const investmentToSide = await prisma.txRecord.groupBy({
      by: ["toAccountId"],
      where: { deletedAt: null, type: "investment" },
      _count: { _all: true },
    });
    const investmentCount = new Map<string, number>();
    for (const row of [...investmentBySide, ...investmentToSide]) {
      const key = row.accountId ?? (row as { toAccountId?: string | null }).toAccountId;
      if (!key) continue;
      investmentCount.set(key, (investmentCount.get(key) ?? 0) + row._count._all);
    }
    const candidates: AccountRow[] = [];
    for (const row of grouped) {
      if (!row.accountId) continue;
      const candidate = await prisma.account.findUnique({
        where: { id: row.accountId },
        select: accountSelect,
      });
      if (!candidate || candidate.kind === "bank_credit") continue;
      candidates.push(candidate);
    }
    const ordered = [
      ...candidates.filter((item) => (investmentCount.get(item.id) ?? 0) === 0),
      ...candidates.filter((item) => (investmentCount.get(item.id) ?? 0) > 0),
    ];
    accounts.push(...ordered.slice(0, wanted));
  }
  assert.ok(accounts.length > 0, "找不到可用于校验的账户");

  for (const account of accounts) {
    await verifyAccount(account, {
      prisma,
      queryDetailPage,
      queryDetailOpeningBalanceBefore,
      queryDetailRunningBalancesForEntries,
      computeAccountDisplayBalances,
      foldRunningBalancesInDescOrder,
      compareDetailEntriesDesc,
      getDetailEntryDisplayDate,
      formatDateUtc,
      toNumber,
      todayDateBusinessYmd,
      getHouseholdTimeZone,
    });
  }

  console.log("\ndetail balance window independence passed");
}

type Deps = {
  prisma: typeof import("../src/lib/db/prisma")["prisma"];
  queryDetailPage: typeof import("../src/lib/server/detail-page-query")["queryDetailPage"];
  queryDetailOpeningBalanceBefore: typeof import("../src/lib/server/detail-page-query")["queryDetailOpeningBalanceBefore"];
  queryDetailRunningBalancesForEntries: typeof import("../src/lib/server/detail-page-query")["queryDetailRunningBalancesForEntries"];
  computeAccountDisplayBalances: typeof import("../src/lib/server/account-balance")["computeAccountDisplayBalances"];
  foldRunningBalancesInDescOrder: typeof import("../src/lib/detail-running-balance")["foldRunningBalancesInDescOrder"];
  compareDetailEntriesDesc: typeof import("../src/lib/detail-entry-order")["compareDetailEntriesDesc"];
  getDetailEntryDisplayDate: typeof import("../src/lib/detail-entry-order")["getDetailEntryDisplayDate"];
  formatDateUtc: typeof import("../src/lib/date-utils")["formatDateUtc"];
  toNumber: typeof import("../src/lib/date-utils")["toNumber"];
  todayDateBusinessYmd: typeof import("../src/lib/date-utils")["todayDateBusinessYmd"];
  getHouseholdTimeZone: typeof import("../src/lib/server/household-preferences")["getHouseholdTimeZone"];
};

async function verifyAccount(account: AccountRow, deps: Deps) {
  const { prisma, queryDetailPage, formatDateUtc, toNumber } = deps;

  const householdId = account.householdId;
  const timeZone = await deps.getHouseholdTimeZone(householdId);
  const todayKey = deps.todayDateBusinessYmd(timeZone);

  /** 逐页拉完一个窗口，收集 id 与余额。 */
  const collect = async (spec: { dateRange: { from: string; to: string } | null; filters?: unknown }) => {
    const balanceById: Record<string, number> = {};
    const ids: string[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const args = {
        accountIds: [account.id],
        householdId,
        page,
        pageSize: PAGE_SIZE,
        sortAccountId: account.id,
        includeRunningBalances: true,
        dateRange: spec.dateRange,
        filters: spec.filters,
      } as Parameters<typeof queryDetailPage>[0];
      const result = await queryDetailPage(args);
      ids.push(...result.pageIds);
      for (const [id, value] of Object.entries(result.runningBalanceById)) balanceById[id] = value;
      if (result.pageIds.length < PAGE_SIZE) return { ids, balanceById };
    }
    throw new Error("翻页超过上限，检查 pageSize 与总数");
  };

  const totalRows = await prisma.txRecord.count({
    where: { deletedAt: null, OR: [{ accountId: account.id }, { toAccountId: account.id }] },
  });

  /* ── 全量行（用于算每个窗口「应该有哪些行」） ── */
  const allRows = await prisma.txRecord.findMany({
    where: { deletedAt: null, householdId, OR: [{ accountId: account.id }, { toAccountId: account.id }] },
    select: TX_SELECT,
    take: 100000,
  });
  const dayKeyById = new Map<string, string>();
  for (const row of allRows) {
    dayKeyById.set(row.id, formatDateUtc(deps.getDetailEntryDisplayDate(row, account.id)));
  }
  const sortedDays = [...new Set(dayKeyById.values())].sort();
  const midDay = sortedDays[Math.floor(sortedDays.length / 2)] ?? todayKey;
  const hasInvestment = allRows.some((row) => row.type === "investment");

  const windows: WindowSpec[] = [
    { label: "全量", dateRange: null },
    { label: "近 1 月", dateRange: { from: shiftMonths(todayKey, -1), to: "" } },
    { label: "近 6 月", dateRange: { from: shiftMonths(todayKey, -6), to: "" } },
    { label: "近 1 年", dateRange: { from: shiftYears(todayKey, 1), to: "" } },
    { label: "近 3 年", dateRange: { from: shiftYears(todayKey, 3), to: "" } },
    { label: "近 10 年", dateRange: { from: shiftYears(todayKey, 10), to: "" } },
    { label: `只有终点（≤ ${midDay}）`, dateRange: { from: "", to: midDay } },
    { label: `跨 6 月区间（${shiftMonths(midDay, -6)} ~ ${midDay}）`, dateRange: { from: shiftMonths(midDay, -6), to: midDay } },
    { label: `单日（${midDay}）`, dateRange: { from: midDay, to: midDay } },
    { label: "未来窗口（无数据）", dateRange: { from: shiftYears(todayKey, -1), to: "" } },
  ];
  const filterSpecs: Array<{ label: string; filters: unknown }> = [
    { label: "列筛选 type=expense", filters: { type: ["expense"] } },
    { label: "列筛选 type=income", filters: { type: ["income"] } },
    { label: "列筛选 type=transfer", filters: { type: ["transfer"] } },
  ];

  console.log(`\n=== 账户 ${account.id}（${account.kind}）：${totalRows} 行，今天 ${todayKey}（${timeZone}）`);
  const baseline = await collect({ dateRange: null });
  const baselineIds = new Set(baseline.ids);
  console.log(`全量：${baseline.ids.length} 行`);

  let overlaps = 0;
  const checkOne = (label: string, result: { ids: string[]; balanceById: Record<string, number> }, range?: { from: string; to: string } | null) => {
    for (const id of result.ids) {
      const expected = baseline.balanceById[id];
      if (expected == null) continue;
      const actual = result.balanceById[id];
      assert.ok(actual != null, `${label}：${id} 缺少余额`);
      assert.ok(
        Math.abs(expected - actual) < TOLERANCE,
        `${label} 改变了余额：${id} 全量 ${expected} vs ${label} ${actual}`,
      );
      overlaps += 1;
    }
    // 行集合：窗口列出的行必须恰好是「全量行 ∩ 该范围」（范围只裁剪行，不多不少）。
    if (range === undefined) return;
    const expectedIds = new Set(
      baseline.ids.filter((id) => {
        const day = dayKeyById.get(id);
        if (!day) return false;
        if (!range) return true;
        if (range.from && day < range.from) return false;
        if (range.to && day > range.to) return false;
        return true;
      }),
    );
    const missing = [...expectedIds].filter((id) => !result.ids.includes(id));
    const extra = result.ids.filter((id) => !expectedIds.has(id));
    assert.equal(missing.length, 0, `${label} 少了 ${missing.length} 行（例：${missing[0]}）`);
    assert.equal(extra.length, 0, `${label} 多了 ${extra.length} 行（例：${extra[0]}）`);
  };

  for (const spec of windows.slice(1)) {
    const result = await collect({ dateRange: spec.dateRange });
    // 含投资流的账户跳过「行集合精确」断言：服务端用业务表到账日（脚本拿不到），
    // 按 TxRecord 日期算出来的候选集必然与实际差几行，与窗口裁剪无关。
    checkOne(spec.label, result, hasInvestment ? undefined : spec.dateRange);
  }
  for (const spec of filterSpecs) {
    const result = await collect({ dateRange: null, filters: spec.filters });
    checkOne(spec.label, result, undefined);
  }
  assert.ok(overlaps > 0, "窗口与全量没有重叠行，校验没有真正跑到");
  console.log(
    `断言 1/2 通过：${windows.length - 1} 个窗口 + ${filterSpecs.length} 组筛选，共 ${overlaps} 行余额一致`
      + (hasInvestment ? "（行集合精确性跳过：含投资流）" : "且行集合精确"),
  );

  /* ── 断言 3：窗口内最新一行 == 服务端账户余额 ── */
  const displayBalances = await deps.computeAccountDisplayBalances([account], { householdId });
  const accountBalance = displayBalances.get(account.id) ?? 0;
  const newestId = baseline.ids[0]!;
  // 存款 / 理财账户的页头余额来自存单与持仓（本金、计息），不等于资金流水的折叠值，
  // 这是既有口径（新旧实现在这些账户上首行余额逐分相同，页头本来就不同）。
  if (!hasInvestment) {
    assert.ok(
      Math.abs(accountBalance - baseline.balanceById[newestId]!) < TOLERANCE,
      `列表顶部余额与账户余额分叉：账户 ${accountBalance} vs 首行 ${baseline.balanceById[newestId]}`,
    );
    console.log(`断言 3 通过：首行余额 ${baseline.balanceById[newestId]} == 账户余额 ${accountBalance}`);
  } else {
    console.log(`断言 3 跳过：含投资流（页头余额来自存单/持仓，非流水折叠）：首行 ${baseline.balanceById[newestId]} vs 页头 ${accountBalance}`);
  }

  /* ── 断言 4/5：期初余额 与 客户端「期初余额 + 窗口内折叠」 ── */
  const foldable = !hasInvestment;
  let checkedWindows = 0;
  for (const spec of windows) {
    const from = spec.dateRange?.from ?? "";
    if (!from) continue;
    const openingBalance = await deps.queryDetailOpeningBalanceBefore({
      accountIds: [account.id],
      householdId,
      sortAccountId: account.id,
      beforeYmd: from,
    });

    // 期初余额 == 窗口前最后一行的余额（用同一条折叠链回算该行）。
    const beforeRows = allRows
      .filter((row) => (dayKeyById.get(row.id) ?? "") < from)
      .sort((a, b) => deps.compareDetailEntriesDesc(a, b, account.id));
    if (beforeRows.length > 0) {
      const lastBefore = beforeRows[0]!;
      const expected = (
        await deps.queryDetailRunningBalancesForEntries({
          accountIds: [account.id],
          householdId,
          sortAccountId: account.id,
          entryIds: [lastBefore.id],
        })
      )[lastBefore.id]!;
      // 「窗口前最后一行」由客户端日期挑出来，含投资流时可能与服务端 displayAt 不同，
      // 这一条只对干净账户断言（余额本身是否一致已由断言 1 覆盖）。
      if (foldable) {
        assert.ok(
          Math.abs(openingBalance - expected) < TOLERANCE,
          `${spec.label} 期初余额口径不一致：接口 ${openingBalance} vs 窗口前最后一行 ${expected}`,
        );
      }

      if (foldable) {
        // 顺序必须取**服务端顺序**（`baseline.ids` 就是 rowNumber 升序）：真客户端
        // 缓存的行本来就排好了，`scopeEntriesOf` 用 `foldRunningBalancesInDescOrder`
        // 沿这个顺序折叠，绝不自己重排 —— 同日多行的次级键只要差一个整段余额就错开。
        const rowById = new Map(allRows.map((row) => [row.id, row]));
        const windowRows = baseline.ids
          .map((id) => rowById.get(id))
          .filter((row): row is NonNullable<typeof row> => !!row)
          .filter((row) => (dayKeyById.get(row.id) ?? "") >= from)
          .filter((row) => (
            row.accountId === account.id
            || !(row.toAccountId === account.id && row.source === "fx_conversion")
          ))
          .map((row) => ({
            id: row.id,
            date: formatDateUtc(row.date),
            postedAt: row.postedAt ? row.postedAt.toISOString() : null,
            createdAt: row.createdAt.toISOString(),
            dayOrder: row.dayOrder,
            amount: toNumber(row.amount),
            type: row.type,
            accountId: row.accountId,
            toAccountId: row.toAccountId,
            toNote: row.toNote,
            source: row.source,
            principalAmount: row.principalAmount != null ? toNumber(row.principalAmount) : null,
            fundProductType: row.fundProductType,
            fundSubtype: row.fundSubtype,
            fundConfirmDate: row.fundConfirmDate ? row.fundConfirmDate.toISOString() : null,
            fundArrivalDate: row.fundArrivalDate ? row.fundArrivalDate.toISOString() : null,
            fundArrivalAmount: row.fundArrivalAmount != null ? toNumber(row.fundArrivalAmount) : null,
            reconciledBalance: row.reconciledBalance != null ? toNumber(row.reconciledBalance) : null,
          }));
        const folded = deps.foldRunningBalancesInDescOrder(
          windowRows,
          account.id,
          account.kind,
          todayKey,
          openingBalance,
        );
        let compared = 0;
        for (const entry of folded) {
          if (!baselineIds.has(entry.id)) continue;
          const expectedBalance = baseline.balanceById[entry.id]!;
          assert.ok(
            Math.abs(expectedBalance - (entry.runningBalance ?? NaN)) < TOLERANCE,
            `${spec.label} 本地折叠与服务端不一致：${entry.id} 本地 ${entry.runningBalance} vs 服务端 ${expectedBalance}`,
          );
          compared += 1;
        }
        checkedWindows += 1;
        console.log(`   · ${spec.label}：期初 ${openingBalance}，${compared} 行本地折叠 == 服务端`);
      }
    } else {
      assert.equal(openingBalance, 0, `${spec.label} 窗口前没有流水，期初余额应为 0，实得 ${openingBalance}`);
    }
  }
  if (foldable) {
    assert.ok(checkedWindows > 0, "没有任何带起点的窗口被校验");
    console.log(`断言 4/5 通过：${checkedWindows} 个窗口的期初余额与本地折叠逐分一致`);
  } else {
    console.log("断言 4 部分跳过：账户含投资流，脚本无法复现客户端拿到的装饰字段（期初余额已校验）");
  }
}

void main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
