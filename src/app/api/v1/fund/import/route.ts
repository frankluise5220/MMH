import { NextResponse } from "next/server";
import { AccountKind, FundCashFlowKind, FundProductType, FundSubtype, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  buildImportAccountCandidates,
  buildImportAccountInputCandidates,
  createImportAccountResolver,
  findSoleFallbackImportAccount,
  normalizeImportAccountMatchKey,
} from "@/lib/account-import-match";
import { getFundConfirmRule } from "@/lib/fund/confirmDays";
import { getFundFeeRate, getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { getFundNav, getLatestFundNav, refreshFundNavCacheRanges } from "@/lib/fund/navCache";
import { resolveFundName } from "@/lib/fund/fundProfile";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { createFundTransactionWithCashFlows, type FundCashFlowInput } from "@/lib/fund/transactions";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision-core";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { attachEntryTagsByNames, parseTagNamesInput } from "@/lib/server/entry-tags";
import { addTradingDaysUtc, parseFlexibleDateToYmd } from "@/lib/date-utils";
import { getCurrentUser, isReadOnly } from "@/lib/server/auth";

export const runtime = "nodejs";

/**
 * POST /api/v1/fund/import
 *
 * Body:
 * - mode: "preview" | "import"; omitted mode defaults to preview
 * - items: fund import rows using the template contract fields
 *   fee is an actual fee amount; feeRateInput/feeRate is a percent value such as 1 for 1%.
 *   When fee and feeRateInput/feeRate are both provided, fee amount wins and fee rate is ignored.
 *   If NAV is blank, preview/import derives the NAV date from the application date/time and fetches the exact NAV when available.
 *   Preview/import returns calculatedFields for system-derived numeric values such as NAV, fee rate, fee, and units.
 * - context?: optional current fund-account view context used only to fill blank fund/cash account fields.
 * - overrides?: optional T+N rules keyed by fund account + fund code, used for preview recalculation and persisted on import
 *
 * Success:
 * - preview: { ok: true, items }
 * - import: { ok: true, createdCount, ids, items }
 *
 * Failure:
 * - { ok: false, error }
 */

type AccountLookupRow = {
  id: string;
  name: string;
  kind: AccountKind;
  userId?: string | null;
  institutionId?: string | null;
  investProductType: string | null;
  tradingCalendar: string | null;
  billingDay: number | null;
  fundUnitsDecimals: number | null;
  numberMasked: string | null;
  Institution: { name: string | null; shortName?: string | null } | null;
  /** 所有人（账户组）：同机构下多位成员都有基金账户时，靠它区分是谁的。 */
  AccountGroup?: { id: string; name: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
  /** 手工记账的使用信号（导入不加分），同一机构多只基金账户时用来挑「最常用」的那只。 */
  usageCount?: number | null;
  lastUsedAt?: Date | null;
};

type ImportIssue = {
  level: "error" | "warning";
  code?: string;
  message: string;
};

const FUND_IMPORT_CALCULATED_FIELDS = [
  "feeRate",
  "fee",
  "nav",
  "units",
] as const;

type FundImportCalculatedField = typeof FUND_IMPORT_CALCULATED_FIELDS[number];

const FUND_IMPORT_CALCULATED_FIELD_SET = new Set<string>(FUND_IMPORT_CALCULATED_FIELDS);

type FundImportInput = {
  rawText?: string;
  date?: string;
  fundSubtype?: string;
  source?: string;
  cashAccountId?: string | null;
  fundAccountId?: string | null;
  cashAccount?: string;
  fundAccount?: string;
  fundCode?: string;
  fundName?: string;
  amount?: number;
  units?: number | null;
  nav?: number | null;
  fee?: number | null;
  feeRate?: number | null;
  feeRateInput?: number | null;
  confirmDate?: string | null;
  arrivalDate?: string | null;
  remark?: string;
  tags?: string | string[];
  calculatedFields?: FundImportCalculatedField[] | null;
};

type FundImportEnrichedItem = {
  rawText: string;
  date: string;
  fundSubtype: string;
  source: string;
  cashAccount: string;
  fundAccount: string;
  fundCode: string;
  fundName: string | null;
  amount: number;
  units: number | null;
  nav: number | null;
  fee: number | null;
  confirmDate: string | null;
  arrivalDate: string | null;
  remark: string;
  tags: string;
  feeRate: number | null;
  confirmDays: number | null;
  arrivalDays: number | null;
  cashAccountId: string | null;
  fundAccountId: string | null;
  fundProductType: string | null;
  /** 勾选「缺少账户时在同机构下自动创建」时：需要新建的同机构资金账户（导入阶段创建） */
  pendingInstitutionCashAccount?: { name: string; institutionId: string } | null;
  /**
   * 同一勾选的**另一半**：基金账户解析不到时，在**资金账户所属机构**（支付宝）下新建一个
   * 基金账户（2026-10-30 用户：「这个功能实际上应该反过来，创建同机构的基金账户，
   * 这个机构就是支付宝」）。导入阶段落地，预览只提示将创建。
   */
  pendingInstitutionFundAccount?: { name: string; institutionId: string; groupId: string | null } | null;
  calculatedFields: FundImportCalculatedField[];
  issues: ImportIssue[];
};

type FundImportRequestContext = {
  fundAccountId?: string | null;
  fundAccount?: string | null;
  fundCode?: string | null;
  fundName?: string | null;
};

type ResolvedFundImportRequestContext = {
  fundAccountMeta: AccountLookupRow | null;
  fundAccount: string;
  fundCode: string | null;
  fundName: string | null;
};

type ImportContext = {
  householdId: string;
  accountIdByMatchKey: Map<string, string>;
  accountLookupRows: AccountLookupRow[];
  /**
   * 账户名解析器：`createImportAccountResolver` 会把「账户 × 别名 × 候选名」全量展开一次，
   * 是纯 CPU 的大对象构建。以前每行都重建一遍，6 行并发就在事件循环里排队、
   * 一张 401 行的账单预览光这一项就白烧几秒到几十秒。整次请求只建一次。
   */
  accountResolver?: (accountName: string | undefined) => AccountLookupRow | null;
  /** 账户名解析结果缓存（含 null）：同名行（「零钱」「支付宝」）在账单里成百上千次。 */
  accountResolveCache: Map<string, AccountLookupRow | null>;
  /** 净值只读缓存（预览模式）：不在 enrich 里现抓外部接口，缺的先返回空、后台补。 */
  navCacheOnly: boolean;
  navLookupCache: Map<string, Promise<Awaited<ReturnType<typeof getFundNav>>>>;
  fundNameLookupCache: Map<string, Promise<string | null>>;
  /**
   * 确认规则 / 费率这类「按账户 + 基金代码」的查询：一张账单里同一只基金会重复几十次，
   * 不缓存就是每行一次数据库往返（401 行的账单预览曾跑到 82 秒）。
   */
  accountFundLookupCache: Map<string, Promise<unknown>>;
  inferredCashAccountByFundAccountId: Map<string, Promise<AccountLookupRow | null>>;
  /**
   * 勾选「缺少账户时在同机构下自动创建」：两个方向都管 ——
   * 缺资金账户 → 复用/创建基金账户同机构的电子钱包；
   * 缺基金账户 → 在资金账户同机构（支付宝）下新建基金账户。
   */
  createInstitutionAccounts: boolean;
  /** 同机构电子钱包缓存：institutionId -> 账户（null 表示该机构下暂无） */
  institutionCashAccountByInstitutionId: Map<string, AccountLookupRow | null>;
  /**
   * 同所有人 + 同机构下的「默认基金账户」缓存：`机构id|所有人组id` -> 账户。
   * 401 行账单里同一对组合会问几百次，频次查询只能做一次。
   */
  siblingFundAccountCache: Map<string, Promise<AccountLookupRow | null>>;
  requestContext: ResolvedFundImportRequestContext | null;
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

// Enrichment runs per-row DB and external-API lookups; cap the concurrency so
// large imports do not exhaust the pg pool (and its connection wait timeout).
const ENRICH_CONCURRENCY = Math.max(1, Number(process.env.FUND_IMPORT_ENRICH_CONCURRENCY ?? 6));


async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function isPureInvestmentAccount(account: Pick<AccountLookupRow, "kind" | "investProductType"> | null | undefined) {
  return !!account && account.kind === AccountKind.investment && account.investProductType !== "deposit";
}

function normalizeImportDatePart(value: string | null | undefined) {
  return parseFlexibleDateToYmd(value);
}

function addImportTradingDays(dateStr: string, days: number, tradingCalendar?: string | null) {
  const datePart = normalizeImportDatePart(dateStr);
  return datePart ? addTradingDaysUtc(datePart, days, tradingCalendar) : addTradingDaysUtc(dateStr, days, tradingCalendar);
}

function toUtcDate(dateStr: string): Date {
  const datePart = normalizeImportDatePart(dateStr) ?? dateStr;
  const [y, m, d] = datePart.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function parsePositiveNumber(value: unknown): number | null {
  const num = Number(String(value ?? "").replace(/[,，￥¥\s]/g, ""));
  if (!Number.isFinite(num)) return null;
  const abs = Math.abs(num);
  return abs > 0 ? abs : null;
}

function parseNonNegativeNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const num = Number(String(value).replace(/[,，￥¥\s]/g, ""));
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
}

function importCalculatedFieldSet(input: FundImportInput) {
  return new Set(
    (input.calculatedFields ?? []).filter((field): field is FundImportCalculatedField =>
      FUND_IMPORT_CALCULATED_FIELD_SET.has(String(field)),
    ),
  );
}

function parseUserPositiveNumber(
  input: FundImportInput,
  field: FundImportCalculatedField,
  calculatedFields: Set<FundImportCalculatedField>,
) {
  return calculatedFields.has(field) ? null : parsePositiveNumber(input[field]);
}

function parseUserNonNegativeNumber(
  input: FundImportInput,
  field: "fee" | "feeRate",
  calculatedFields: Set<FundImportCalculatedField>,
) {
  return calculatedFields.has(field) ? null : parseNonNegativeNumber(input[field]);
}

function sortedCalculatedFields(fields: Set<FundImportCalculatedField>) {
  return FUND_IMPORT_CALCULATED_FIELDS.filter((field) => fields.has(field));
}

function normalizeUsableFundName(value: unknown, fundCode: string) {
  const name = String(value ?? "").trim();
  return name && name !== fundCode ? name : null;
}

function firstUsableFundName(fundCode: string, ...values: unknown[]) {
  for (const value of values) {
    const name = normalizeUsableFundName(value, fundCode);
    if (name) return name;
  }
  return null;
}

function normalizeSubtype(raw: string) {
  const value = String(raw ?? "").trim().toLowerCase();
  const valid = new Set(["buy", "redeem", "dividend_cash", "dividend_reinvest", "buy_failed"]);
  return valid.has(value) ? value : "";
}

function normalizeSource(raw: string, subtype: string, rawSubtype?: string) {
  const rawValue = String(raw ?? "").trim();
  const rawSubtypeValue = String(rawSubtype ?? "").trim();
  const isRefundAlias = rawSubtypeValue === "refund" || rawSubtypeValue === "returned" || rawSubtypeValue === "buy_refund";

  let value = rawValue;
  if (value === "regular_invest_refund" && subtype !== "buy_failed") {
    value = "regular_invest";
  }
  if (subtype === "buy_failed" && (!value || value === "manual" || value === "regular_invest" || value === "regular_invest_refund")) {
    return "regular_invest_refund";
  }
  if (isRefundAlias && (!value || value === "manual" || value === "regular_invest" || value === "regular_invest_refund")) {
    return "regular_invest_refund";
  }
  if (!value) return subtype === "dividend_reinvest" ? "dividend" : "manual";
  return value;
}

function amountForSubtype(amount: number, subtype: string) {
  if (!Number.isFinite(amount)) return 0;
  if (subtype.includes("buy")) return Math.abs(amount);
  return amount;
}

function isSupportedFundCode(value: string) {
  return /^\d{6}$/.test(value.trim());
}

/** 预览/导入前批量补净值的总时间预算：超时就先出结果，剩下的交给缓存/用户补。 */
const NAV_PRELOAD_BUDGET_MS = 15_000;
/**
 * 预览时**最多**等净值抓取的时间。超过就先返回明细（净值列留空），
 * 后台继续抓，客户端隔几秒静默回填（用户 2026-10-30：明细要 1 秒内出来）。
 */
const PREVIEW_NAV_WAIT_MS = 1_200;
/** 预览后台补净值的总预算（超出就放弃，等下次重算）。 */
const PREVIEW_NAV_BACKGROUND_BUDGET_MS = 20_000;

type NavPreloadRequest = { fundCode: string; startDate: string; endDate: string };

/**
 * 预览/导入前，把缺失的净值**按基金一次性**补进 FundNavCache。
 *
 * 逐行 `getFundNav` 是「每个 (基金, 日期) 一次外部请求」，且单次最多按优先级试
 * 3 个接口：一张 400 行的支付宝账单能凑出上百个组合，预览卡几分钟就是这么来的。
 * 这里先把每支基金需要的日期并成一个区间、整段抓一次写缓存，随后的逐行查询
 * 全部命中缓存（纯 DB）。
 *
 * 已经覆盖的基金直接跳过：缺的那几天是周末/节假日，重复抓只会白等。
 * 预取失败或超时都不影响预览 —— 净值退回缓存值，用户仍可在预览里手填。
 *
 * 拆成「算计划」和「执行」两步：预览可以先等一小会儿就返回，剩下的交给后台。
 */
async function planImportNavPreload(inputs: readonly FundImportInput[]): Promise<NavPreloadRequest[]> {
  const ranges = new Map<string, { min: string; max: string; dates: Set<string> }>();
  for (const input of inputs) {
    const fundCode = String(input.fundCode ?? "").trim();
    if (!/^\d{6}$/.test(fundCode)) continue;
    if (input.nav != null && input.nav > 0) continue;
    const date = normalizeImportDatePart(input.confirmDate) ?? normalizeImportDatePart(input.date);
    if (!date) continue;
    const current = ranges.get(fundCode);
    if (!current) {
      ranges.set(fundCode, { min: date, max: date, dates: new Set([date]) });
    } else {
      if (date < current.min) current.min = date;
      if (date > current.max) current.max = date;
      current.dates.add(date);
    }
  }
  if (ranges.size === 0) return [];

  const requests: NavPreloadRequest[] = [];
  const entries = Array.from(ranges.entries());
  // 逐个查缓存覆盖度：pg 连接池只有个位数，别一次打满。
  const CHECK_CONCURRENCY = 4;
  for (let start = 0; start < entries.length; start += CHECK_CONCURRENCY) {
    await Promise.all(entries.slice(start, start + CHECK_CONCURRENCY).map(async ([fundCode, range]) => {
      const count = await prisma.fundNavCache.count({
        where: {
          fundCode,
          navDate: { gte: toUtcDate(range.min), lte: toUtcDate(range.max) },
        },
      }).catch(() => 0);
      // 区间内的缓存条数已够覆盖需要的日期（少的那些是周末/节假日）→ 不再打扰外部接口
      if (count >= range.dates.size) return;
      requests.push({ fundCode, startDate: range.min, endDate: range.max });
    }));
  }
  return requests;
}

/** 执行预取计划；budgetMs 到点就放行（调用方可能还在等响应）。 */
async function runImportNavPreload(requests: readonly NavPreloadRequest[], budgetMs: number) {
  if (requests.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      refreshFundNavCacheRanges([...requests], { concurrency: 4 }),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); }),
    ]);
  } catch {
    // 预取只是加速：失败就按缓存走
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 一次性的完整预取（导入模式用：份额要按净值算，先等它抓完）。 */
async function preloadImportNavCache(inputs: readonly FundImportInput[]) {
  await runImportNavPreload(await planImportNavPreload(inputs), NAV_PRELOAD_BUDGET_MS);
}

/**
 * 预览用：最多等 PREVIEW_NAV_WAIT_MS 就先返回，剩下的丢后台抓。
 * 后台那轮重新算一次覆盖度 —— 等的那 1.2 秒里可能已经写进缓存了，避免重复抓同一段。
 */
async function preloadImportNavCacheForPreview(inputs: readonly FundImportInput[]) {
  const requests = await planImportNavPreload(inputs);
  if (requests.length === 0) return { stillFetching: false };
  await runImportNavPreload(requests, PREVIEW_NAV_WAIT_MS);
  void (async () => {
    const remaining = await planImportNavPreload(inputs);
    await runImportNavPreload(remaining, PREVIEW_NAV_BACKGROUND_BUDGET_MS);
  })().catch(() => {});
  return { stillFetching: true };
}

/**
 * 账户候选键 → 账户 id 的快速索引。
 *
 * 同一个键属于多个账户时（两位成员各有一个「余额宝」，候选键里都有「支付宝余额宝」），
 * 这个键**不能**停在「最后写入的那个账户」上 —— 那会让「余额宝」这种不带所有人的
 * 模糊文本静默记到别人的账户里。冲突键直接作废，交给 matcher 去消歧。
 */
function indexAccountLookup(
  map: Map<string, string>,
  duplicatedKeys: Set<string>,
  account: AccountLookupRow,
) {
  for (const candidate of buildImportAccountCandidates(account)) {
    const key = normalizeImportAccountMatchKey(candidate);
    if (!key) continue;
    const existing = map.get(key);
    if (existing === account.id) continue;
    if (existing) {
      map.delete(key);
      duplicatedKeys.add(key);
      continue;
    }
    if (duplicatedKeys.has(key)) continue;
    map.set(key, account.id);
  }
}

async function buildImportContext(): Promise<ImportContext> {
  const { householdId } = await getHouseholdScope();
  const accounts = await prisma.account.findMany({
    // 多币种父账户（isAggregate）只是统计单位、不能记账，导入时直接排除，
    // 否则把「宁波·0214」这类父账户名填进模板会静默记到父账户上。
    where: { householdId, isPlaceholder: { not: true }, isAggregate: { not: true } },
    select: {
      id: true,
      name: true,
      kind: true,
      userId: true,
      institutionId: true,
      investProductType: true,
      tradingCalendar: true,
      billingDay: true,
      fundUnitsDecimals: true,
      numberMasked: true,
      usageCount: true,
      lastUsedAt: true,
      Institution: { select: { name: true, shortName: true } },
      AccountGroup: { select: { id: true, name: true } },
      AccountAlias: { select: { alias: true } },
    },
  });
  const accountIdByMatchKey = new Map<string, string>();
  const duplicatedAccountKeys = new Set<string>();
  for (const account of accounts) indexAccountLookup(accountIdByMatchKey, duplicatedAccountKeys, account);
  return {
    householdId,
    accountIdByMatchKey,
    accountLookupRows: accounts,
    accountResolveCache: new Map(),
    navCacheOnly: true,
    navLookupCache: new Map(),
    fundNameLookupCache: new Map(),
    accountFundLookupCache: new Map(),
    inferredCashAccountByFundAccountId: new Map(),
    createInstitutionAccounts: false,
    institutionCashAccountByInstitutionId: new Map(),
    siblingFundAccountCache: new Map(),
    requestContext: null,
  };
}

/** 同一次请求内按 key 合并重复查询（同一只基金在一张账单里会出现几十次）。 */
function memoizedAccountFundLookup<T>(
  ctx: ImportContext,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const existing = ctx.accountFundLookupCache.get(key);
  if (existing) return existing as Promise<T>;
  const promise = load();
  ctx.accountFundLookupCache.set(key, promise);
  return promise;
}

async function resolveFundNameByCode(ctx: ImportContext, fundCode: string) {
  const code = String(fundCode ?? "").trim();
  if (!code) return null;
  const existing = ctx.fundNameLookupCache.get(code);
  if (existing) return existing;

  const lookup = (async () => {
    const resolved = await resolveFundName(code, { householdId: ctx.householdId }).catch(() => null);
    const resolvedName = normalizeUsableFundName(resolved, code);
    if (resolvedName) return resolvedName;

    const latestNav = await getLatestFundNav(code).catch(() => null);
    return normalizeUsableFundName(latestNav?.name, code);
  })();
  ctx.fundNameLookupCache.set(code, lookup);
  return lookup;
}

function findAccountById(ctx: ImportContext, accountId: string | null | undefined) {
  const id = String(accountId ?? "").trim();
  return id ? ctx.accountLookupRows.find((item) => item.id === id) ?? null : null;
}

async function resolveAccount(
  ctx: ImportContext,
  accountName: string,
): Promise<AccountLookupRow | null> {
  const normalizedTarget = normalizeImportAccountMatchKey(accountName);
  if (!normalizedTarget) return null;
  // 结果缓存（含「解析不到」）：账单里「零钱」这类名字会出现几百次，
  // 而解析器每次都要把全部账户 × 别名 × 候选名展开一遍，是纯 CPU 的重活。
  if (ctx.accountResolveCache.has(normalizedTarget)) {
    return ctx.accountResolveCache.get(normalizedTarget) ?? null;
  }
  const cachedId = ctx.accountIdByMatchKey.get(normalizedTarget);
  if (cachedId) {
    const hit = ctx.accountLookupRows.find((item) => item.id === cachedId) ?? null;
    ctx.accountResolveCache.set(normalizedTarget, hit);
    return hit;
  }
  // 解析器整次请求只建一次（createImportAccountResolver 内部会建匹配索引）。
  ctx.accountResolver ??= createImportAccountResolver(ctx.accountLookupRows);
  const resolved = ctx.accountResolver(accountName);
  if (resolved) {
    for (const candidate of buildImportAccountInputCandidates(accountName)) {
      const key = normalizeImportAccountMatchKey(candidate);
      if (key) ctx.accountIdByMatchKey.set(key, resolved.id);
    }
    ctx.accountResolveCache.set(normalizedTarget, resolved);
    return resolved;
  }
  // 兜底子串匹配：只认唯一且具体的命中（见 findSoleFallbackImportAccount）。
  // 旧实现「谁先命中就返回谁」，账户侧候选里的机构泛化键（「支付宝」）会吞掉
  // 任何以机构名开头的未识别文本，把「张四支付宝基金」记到「理财账户1100」上。
  const fallback = findSoleFallbackImportAccount(accountName, ctx.accountLookupRows);
  if (fallback) {
    ctx.accountIdByMatchKey.set(normalizedTarget, fallback.id);
    ctx.accountResolveCache.set(normalizedTarget, fallback);
    return fallback;
  }
  ctx.accountResolveCache.set(normalizedTarget, null);
  return null;
}

async function resolveAccountInput(
  ctx: ImportContext,
  accountId: string | null | undefined,
  accountName: string,
) {
  return findAccountById(ctx, accountId) ?? (await resolveAccount(ctx, accountName));
}

/** 同机构资金账户名：机构名·资金账户（用户口径：基金账户同机构的电子钱包）。 */
function institutionCashAccountName(fundAccount: AccountLookupRow) {
  const institutionName = String(fundAccount.Institution?.shortName ?? "").trim()
    || String(fundAccount.Institution?.name ?? "").trim();
  return institutionName ? `${institutionName}·资金账户` : "同机构资金账户";
}

/**
 * 同机构基金账户名：机构名·基金账户（如「支付宝·基金账户」）。
 *
 * 与上面的资金账户命名对称。名字里带机构名有个额外好处：下次同机构再来账单，
 * `findSiblingFundAccount` 的「名字带机构名」那一步会直接选中它，不会再按频次去猜。
 */
function institutionFundAccountName(cashAccount: AccountLookupRow) {
  const institutionName = String(cashAccount.Institution?.shortName ?? "").trim()
    || String(cashAccount.Institution?.name ?? "").trim();
  return institutionName ? `${institutionName}·基金账户` : "同机构基金账户";
}

/**
 * 解析基金账户「同机构的资金账户（电子钱包）」：
 * - 同机构下已有电子钱包账户 → 直接复用；
 * - 没有 → 返回计划创建的账户（预览不阻断，导入阶段真正创建）。
 * 仅当勾选「创建基金账户的同机构资金账户」时启用。
 */
async function resolveInstitutionCashAccount(
  ctx: ImportContext,
  fundAccount: AccountLookupRow,
): Promise<{ existing: AccountLookupRow | null; pending: { name: string; institutionId: string } | null }> {
  const institutionId = String(fundAccount.institutionId ?? "").trim();
  if (!institutionId) return { existing: null, pending: null };
  if (ctx.institutionCashAccountByInstitutionId.has(institutionId)) {
    const cached = ctx.institutionCashAccountByInstitutionId.get(institutionId) ?? null;
    return { existing: cached, pending: cached ? null : { name: institutionCashAccountName(fundAccount), institutionId } };
  }
  const candidate = ctx.accountLookupRows.find(
    (account) => account.kind === AccountKind.ewallet && String(account.institutionId ?? "") === institutionId,
  ) ?? null;
  ctx.institutionCashAccountByInstitutionId.set(institutionId, candidate);
  return { existing: candidate, pending: candidate ? null : { name: institutionCashAccountName(fundAccount), institutionId } };
}

/**
 * 与资金账户同机构的基金账户。
 *
 * 支付宝账单里只写了基金销售机构（「蚂蚁财富-蚂蚁（杭州）基金销售有限公司」），
 * 那不是账本里的账户；账本里真正收这笔钱的是「和资金账户（收/付款方式，如余额宝）
 * 同一个机构下的基金账户」。`Account.userId` 在本账本里是空的，所有人靠 AccountGroup
 * 表达，所以这里按机构 + 账户种类 + **同一所有人**认。
 *
 * 同一人在该机构下有多只基金账户时（张四在支付宝下有「稳健理财基金」和
 * 「开放基金1100」），按下面的顺序定默认值：
 *  1. 只有一只 → 就用它（绝大多数账本）；
 *  2. 名字里带机构名的那一只（「支付宝基金」这类用户自己的命名习惯）；
 *  3. **最常用的那一只**（见 mostUsedDefaultFundAccount：用户 2026-10-30 要求
 *     「找相同所有人名下支付宝这个机构里最常用的基金账户」）；
 *  4. 仍然并列 → 返回 null，留给用户在预览里选，不猜。
 */
async function findSiblingFundAccount(
  ctx: ImportContext,
  cashAccountMeta: AccountLookupRow | null,
): Promise<AccountLookupRow | null> {
  const institutionId = String(cashAccountMeta?.institutionId ?? "").trim();
  if (!institutionId) return null;
  const ownerGroupId = String(cashAccountMeta?.AccountGroup?.id ?? "").trim();
  const candidates = ctx.accountLookupRows.filter((account) =>
    account.id !== cashAccountMeta?.id
    && isPureInvestmentAccount(account)
    && (account.investProductType === "fund" || account.investProductType == null)
    && String(account.institutionId ?? "").trim() === institutionId
    // 同一个支付宝下常有多位成员的基金账户（「墨支付宝基金」/「开放基金1100」）：
    // 只认同所有人，否则张四的账单会被记到墨斗鱼的基金账户上。
    && (!ownerGroupId || String(account.AccountGroup?.id ?? "").trim() === ownerGroupId));
  if (candidates.length <= 1) return candidates[0] ?? null;
  const institutionName = String(
    cashAccountMeta?.Institution?.shortName ?? cashAccountMeta?.Institution?.name ?? "",
  ).trim();
  if (institutionName) {
    const named = candidates.filter((account) => account.name.includes(institutionName));
    if (named.length === 1) return named[0];
  }
  return mostUsedDefaultFundAccount(ctx, institutionId, ownerGroupId, candidates);
}

/**
 * 同一所有人 + 同一机构下的多只基金账户里，取「最常用」的那一只当默认值。
 *
 * 频次口径（按优先级，全部来自服务端已有数据，不需要用户先选过）：
 *  1. 该基金账户上的基金交易条数（`FundTransaction`：导入进来的和历史手记的都在内，
 *     `[fundAccountId, applyDate]` 索引现成，一次 groupBy 只查这几只候选）；
 *  2. `Account.usageCount` / `lastUsedAt`：只有手工记账会累加，导入不加分，用作平手时的
 *     「这个人平时在哪个账户里操作」的补充信号；
 *  3. 三项全等（连最近使用时间都一样）→ 返回 null：两只真的分不出常用，退回「不猜」，
 *     让用户在预览里选，绝不按账户 id / 名字顺序瞎挑一只。
 *
 * 结果按 `机构id|所有人组id` 缓存在 `ctx` 里：401 行账单只会算一次。
 */
async function mostUsedDefaultFundAccount(
  ctx: ImportContext,
  institutionId: string,
  ownerGroupId: string,
  candidates: readonly AccountLookupRow[],
): Promise<AccountLookupRow | null> {
  const cacheKey = `${institutionId}|${ownerGroupId}`;
  const cached = ctx.siblingFundAccountCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const counts = new Map<string, number>();
    try {
      const grouped = await prisma.fundTransaction.groupBy({
        by: ["fundAccountId"],
        where: {
          householdId: ctx.householdId,
          fundAccountId: { in: candidates.map((account) => account.id) },
          deletedAt: null,
        },
        _count: { _all: true },
      });
      for (const row of grouped) counts.set(row.fundAccountId, row._count._all);
    } catch {
      // 频次查不到不影响导入：退回 usageCount / lastUsedAt 判断。
    }

    const ranked = candidates
      .map((account) => ({
        account,
        count: counts.get(account.id) ?? 0,
        usage: account.usageCount ?? 0,
        last: account.lastUsedAt ? account.lastUsedAt.getTime() : 0,
      }))
      .sort((a, b) => b.count - a.count || b.usage - a.usage || b.last - a.last);

    const best = ranked[0];
    if (!best) return null;
    // 谁都没用过（新账本 / 刚建好的账户）：没有「最常用」可言，不猜。
    if (best.count === 0 && best.usage === 0 && best.last === 0) return null;
    const second = ranked[1];
    if (second && best.count === second.count && best.usage === second.usage && best.last === second.last) return null;
    return best.account;
  })();

  ctx.siblingFundAccountCache.set(cacheKey, promise);
  return promise;
}

async function resolveFundImportRequestContext(
  ctx: ImportContext,
  input: FundImportRequestContext | null | undefined,
): Promise<ResolvedFundImportRequestContext | null> {
  const rawFundAccount = String(input?.fundAccount ?? "").trim();
  const fundAccountMeta = await resolveAccountInput(ctx, input?.fundAccountId, rawFundAccount);
  const usableFundAccountMeta = isPureInvestmentAccount(fundAccountMeta) ? fundAccountMeta : null;
  const fundCode = String(input?.fundCode ?? "").trim() || null;
  const fundName = fundCode
    ? normalizeUsableFundName(input?.fundName, fundCode)
    : String(input?.fundName ?? "").trim() || null;
  if (!usableFundAccountMeta && !rawFundAccount && !fundCode && !fundName) return null;
  return {
    fundAccountMeta: usableFundAccountMeta,
    fundAccount: usableFundAccountMeta?.name ?? rawFundAccount,
    fundCode,
    fundName,
  };
}

function subtypeNeedsCashAccount(subtype: string, source: string) {
  return subtype === "buy"
    || subtype === "redeem"
    || subtype === "dividend_cash"
    || (subtype === "buy_failed" && source === "regular_invest_refund");
}

function canInferCashAccountFromContext(
  ctx: ImportContext,
  fundAccountMeta: AccountLookupRow | null,
) {
  return !!ctx.requestContext?.fundAccountMeta
    && !!fundAccountMeta
    && ctx.requestContext.fundAccountMeta.id === fundAccountMeta.id;
}

async function loadInferredCashAccountForFundAccount(
  ctx: ImportContext,
  fundAccountId: string,
) {
  const existing = ctx.inferredCashAccountByFundAccountId.get(fundAccountId);
  if (existing) return existing;

  const lookup = prisma.fundTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      fundAccountId,
      cashAccountId: { not: null },
      deletedAt: null,
    },
    select: {
      cashAccountId: true,
    },
    orderBy: [
      { createdAt: "desc" },
      { applyDate: "desc" },
    ],
    take: 100,
  }).then((rows) => {
    const stats = new Map<string, { count: number; firstIndex: number }>();
    rows.forEach((row, index) => {
      if (!row.cashAccountId) return;
      const current = stats.get(row.cashAccountId);
      if (current) {
        current.count += 1;
      } else {
        stats.set(row.cashAccountId, { count: 1, firstIndex: index });
      }
    });
    const best = Array.from(stats.entries()).sort((left, right) => {
      const countDiff = right[1].count - left[1].count;
      return countDiff || left[1].firstIndex - right[1].firstIndex;
    })[0]?.[0];
    const account = best ? ctx.accountLookupRows.find((item) => item.id === best) ?? null : null;
    return account && !isPureInvestmentAccount(account) ? account : null;
  });
  ctx.inferredCashAccountByFundAccountId.set(fundAccountId, lookup);
  return lookup;
}

async function enrichImportItem(
  ctx: ImportContext,
  input: FundImportInput,
): Promise<FundImportEnrichedItem> {
  const sourceCalculatedFields = importCalculatedFieldSet(input);
  const calculatedFields = new Set<FundImportCalculatedField>();
  const date = String(input.date ?? "").trim();
  const rawSubtype = String(input.fundSubtype ?? "");
  const subtype = normalizeSubtype(rawSubtype);
  const source = normalizeSource(String(input.source ?? ""), subtype, rawSubtype);
  const isDividendReinvest = subtype === "dividend_reinvest";
  let cashAccount = isDividendReinvest ? "" : String(input.cashAccount ?? "").trim();
  let fundAccount = String(input.fundAccount ?? "").trim();
  let fundCode = String(input.fundCode ?? "").trim();
  const contextFundCodeUsed = !fundCode && !!ctx.requestContext?.fundCode;
  if (contextFundCodeUsed && ctx.requestContext?.fundCode) fundCode = ctx.requestContext.fundCode;
  const supportedFundCode = isSupportedFundCode(fundCode);
  const amount = amountForSubtype(Number(input.amount ?? 0), subtype);
  const issues: ImportIssue[] = [];

  const inputCashAccountId = isDividendReinvest ? "" : String(input.cashAccountId ?? "").trim();
  const inputFundAccountId = String(input.fundAccountId ?? "").trim();
  const hasCashAccountInput = !isDividendReinvest && (!!inputCashAccountId || !!cashAccount);
  const hasFundAccountInput = !!inputFundAccountId || !!fundAccount;

  let cashAccountMeta = hasCashAccountInput
    ? await resolveAccountInput(ctx, inputCashAccountId, cashAccount)
    : null;
  let fundAccountMeta = hasFundAccountInput
    ? await resolveAccountInput(ctx, inputFundAccountId, fundAccount)
    : null;

  if (ctx.requestContext?.fundAccountMeta && (!hasFundAccountInput || !fundAccountMeta)) {
    // 无基金账户输入、或行内账户名在账本中解析不到时，回落到当前基金账户页面上下文
    // （用户在某个基金账户页面导入 = 导入到该账户）。
    fundAccountMeta = ctx.requestContext.fundAccountMeta;
    fundAccount = ctx.requestContext.fundAccount || fundAccountMeta.name;
  } else if (fundAccountMeta) {
    fundAccount = fundAccountMeta.name;
  } else if (!fundAccount && inputFundAccountId) {
    fundAccount = inputFundAccountId;
  }

  const needsCashAccount = subtypeNeedsCashAccount(subtype, source);
  if (!hasCashAccountInput && needsCashAccount && fundAccountMeta && canInferCashAccountFromContext(ctx, fundAccountMeta)) {
    cashAccountMeta = await loadInferredCashAccountForFundAccount(ctx, fundAccountMeta.id);
    if (cashAccountMeta) cashAccount = cashAccountMeta.name;
  } else if (cashAccountMeta) {
    cashAccount = cashAccountMeta.name;
  } else if (!cashAccount && inputCashAccountId) {
    cashAccount = inputCashAccountId;
  }

  // 行里的基金账户名解析不到时（支付宝账单写的「蚂蚁财富-…」只是销售机构）：
  // 取同所有人、同机构（支付宝）下的那个基金账户。资金账户已经在上面解析出来了，
  // 它和基金账户在账本里是同一个机构下的两个账户。
  if (!fundAccountMeta) {
    const siblingFundAccount = await findSiblingFundAccount(ctx, cashAccountMeta);
    if (siblingFundAccount) {
      fundAccountMeta = siblingFundAccount;
      fundAccount = siblingFundAccount.name;
    }
  }

  // 勾选「缺少账户时在同机构下自动创建」：同机构下确实没有基金账户时，在**资金账户所属机构**
  // （支付宝）下新建一个基金账户。这是这个勾选框真正该干的事（2026-10-30 用户：
  // 「这个功能实际上应该反过来，创建同机构的基金账户，这个机构，就是支付宝」）。
  // 机构只能从资金账户身上拿，所以资金账户必须先解析出来；拿不到机构就仍然留空给用户选。
  let pendingInstitutionFundAccount: { name: string; institutionId: string; groupId: string | null } | null = null;
  if (!fundAccountMeta && ctx.createInstitutionAccounts && cashAccountMeta) {
    const institutionId = String(cashAccountMeta.institutionId ?? "").trim();
    if (institutionId) {
      pendingInstitutionFundAccount = {
        name: institutionFundAccountName(cashAccountMeta),
        institutionId,
        // 所有人跟着资金账户走：同机构下多位成员都有基金账户时，家账簿靠账户组认人。
        groupId: String(cashAccountMeta.AccountGroup?.id ?? "").trim() || null,
      };
      fundAccount = pendingInstitutionFundAccount.name;
      issues.push({
        level: "warning",
        code: "WILL_CREATE_INSTITUTION_FUND_ACCOUNT",
        message: `WILL_CREATE_INSTITUTION_FUND_ACCOUNT:${pendingInstitutionFundAccount.name}`,
      });
    }
  }

  // 同一勾选的另一半：仍缺资金账户时，复用基金账户同机构的电子钱包，
  // 没有则在导入阶段创建（预览不阻断，仅提示将创建）。
  let pendingInstitutionCashAccount: { name: string; institutionId: string } | null = null;
  if (needsCashAccount && !cashAccountMeta && ctx.createInstitutionAccounts && fundAccountMeta) {
    const resolvedCash = await resolveInstitutionCashAccount(ctx, fundAccountMeta);
    if (resolvedCash.existing) {
      cashAccountMeta = resolvedCash.existing;
      cashAccount = resolvedCash.existing.name;
    } else if (resolvedCash.pending) {
      pendingInstitutionCashAccount = resolvedCash.pending;
      cashAccount = resolvedCash.pending.name;
      issues.push({
        level: "warning",
        code: "WILL_CREATE_INSTITUTION_CASH_ACCOUNT",
        message: `WILL_CREATE_INSTITUTION_CASH_ACCOUNT:${resolvedCash.pending.name}`,
      });
    }
  }

  if (!date) issues.push({ level: "error", message: "缺少日期" });
  if (!subtype) issues.push({ level: "error", message: "基金动作无效，仅支持买入、赎回、现金分红、红利再投" });
  if (!fundAccount) issues.push({ level: "error", message: "缺少基金账户" });
  else if (!fundAccountMeta && !pendingInstitutionFundAccount) issues.push({ level: "error", message: `基金账户“${fundAccount}”未匹配` });
  else if (fundAccountMeta && !isPureInvestmentAccount(fundAccountMeta)) issues.push({ level: "error", message: `基金账户“${fundAccount}”不是开放式基金账户` });

  if (needsCashAccount && !cashAccount) {
    issues.push({ level: "error", code: "MISSING_CASH_ACCOUNT", message: "MISSING_CASH_ACCOUNT" });
  } else if (cashAccount) {
    if (!cashAccountMeta && !pendingInstitutionCashAccount) issues.push({ level: "error", message: `资金账户“${cashAccount}”未匹配，无法建立资金流水关联` });
    else if (cashAccountMeta && isPureInvestmentAccount(cashAccountMeta)) issues.push({ level: "error", message: `资金账户“${cashAccount}”不是资金侧账户` });
  }
  if (!fundCode) issues.push({ level: "error", message: "缺少基金代码" });
  else if (!supportedFundCode) issues.push({ level: "error", code: "INVALID_FUND_CODE", message: "INVALID_FUND_CODE" });
  const canResolveDividendReinvestUnits =
    subtype === "dividend_reinvest" &&
    (parsePositiveNumber(input.units) != null || (amount > 0 && parsePositiveNumber(input.nav) != null));
  if (subtype === "dividend_reinvest" ? !canResolveDividendReinvestUnits : !(amount > 0)) {
    issues.push({ level: "error", message: "金额无效" });
  }

  let confirmDays: number | null = null;
  let arrivalDays: number | null = null;
  let confirmDate = normalizeImportDatePart(String(input.confirmDate ?? "").trim()) ?? null;
  let nav = parseUserPositiveNumber(input, "nav", sourceCalculatedFields);
  let fee = parseUserNonNegativeNumber(input, "fee", sourceCalculatedFields);
  const feeRateInput = sourceCalculatedFields.has("feeRate")
    ? null
    : parseNonNegativeNumber(input.feeRateInput ?? input.feeRate);
  let units = parseUserPositiveNumber(input, "units", sourceCalculatedFields);
  let feeRate: number | null = fee == null ? feeRateInput : 0;
  let fundName = firstUsableFundName(fundCode, input.fundName, contextFundCodeUsed ? ctx.requestContext?.fundName : null);
  let arrivalDate = normalizeImportDatePart(String(input.arrivalDate ?? "").trim()) ?? null;
  const remark = String(input.remark ?? "").trim();
  const tags = parseTagNamesInput(input.tags).join(",");

  if (fundAccountMeta && fundCode && supportedFundCode && date) {
    const confirmRule = await memoizedAccountFundLookup(
      ctx,
      `confirm|${fundAccountMeta.id}|${fundCode}`,
      () => getFundConfirmRule(fundAccountMeta.id, fundCode),
    );
    confirmDays = confirmRule.days;
    arrivalDays = confirmRule.arrivalDays;
    // 确认日留空按确认库 T+N 推算（不再固定 T+0）
    if (!confirmDate) {
      confirmDate = addImportTradingDays(date, confirmDays, fundAccountMeta.tradingCalendar);
    }
    // 到账日留空按「确认日 + 到账天数」推算；买入、赎回、现金分红同一口径
    if (!arrivalDate && confirmDate && (
      subtype === "buy" ||
      (subtype === "buy_failed" && source === "regular_invest_refund") ||
      subtype === "redeem" ||
      subtype === "switch_out" ||
      subtype === "dividend_cash"
    )) {
      arrivalDate = addImportTradingDays(confirmDate, arrivalDays, fundAccountMeta.tradingCalendar);
    }

    if (fee == null && feeRateInput != null) {
      fee = Number((amount * (feeRateInput / 100)).toFixed(2));
      calculatedFields.add("fee");
    } else if (fee == null) {
      const feeType = subtype === "redeem" ? "redeem" : "buy";
      const baseDate = confirmDate ? toUtcDate(confirmDate) : toUtcDate(date);
      const feeRateKey = `${fundAccountMeta.id}|${fundCode}|${feeType}`;
      let feeRateRaw = await memoizedAccountFundLookup(
        ctx,
        `feeDate|${feeRateKey}|${baseDate.toISOString().slice(0, 10)}`,
        () => getFundFeeRateByDate(fundAccountMeta.id, fundCode, baseDate, feeType).catch(() => 0),
      );
      if (!feeRateRaw) {
        feeRateRaw = await memoizedAccountFundLookup(
          ctx,
          `fee|${feeRateKey}`,
          () => getFundFeeRate(fundAccountMeta.id, fundCode, feeType).catch(() => 0),
        );
      }
      feeRate = feeRateRaw || 0;
      calculatedFields.add("feeRate");
      if (feeRate > 0 && (subtype === "buy" || subtype === "redeem")) {
        fee = Number((amount * (feeRate / 100)).toFixed(2));
        calculatedFields.add("fee");
      }
    } else {
      feeRate = 0;
    }

    // 净值留空时优先用行内数据反推（份额+金额→净值，与确认份额公式同源：份额=(金额-手续费)/净值），
    // 避免大批量缺净值时逐行查缓存/回源外部接口拖慢预览；反推不出再按确认日查净值缓存。
    if (nav == null && units != null && units > 0 && amount > 0 && (subtype === "buy" || subtype === "dividend_reinvest")) {
      const derivedNav = (Math.abs(amount) - (fee ?? 0)) / units;
      if (Number.isFinite(derivedNav) && derivedNav > 0) {
        nav = Number(derivedNav.toFixed(4));
        calculatedFields.add("nav");
      }
    }

    if (nav == null && confirmDate && (subtype === "buy" || subtype === "redeem" || subtype === "dividend_reinvest")) {
      const navDate = toUtcDate(confirmDate);
      const navKey = `${fundAccountMeta.id}:${fundCode}:${confirmDate}`;
      let navLookup = ctx.navLookupCache.get(navKey);
      if (!navLookup) {
        // 预览模式只读缓存：缓存没有就先留空（后台预取补上后由前端静默回填）。
        // 否则每行都会在 enrich 里现抓一次外部接口，冷缓存时又是一行几秒。
        navLookup = getFundNav(
          fundCode,
          navDate,
          fundAccountMeta.id,
          ctx.navCacheOnly ? { network: false } : undefined,
        ).catch(() => null);
        ctx.navLookupCache.set(navKey, navLookup);
      }
      const navData = await navLookup;
      if (navData?.dateMatch && navData.nav > 0) {
        nav = navData.nav;
        calculatedFields.add("nav");
        fundName = fundName ?? normalizeUsableFundName(navData.name, fundCode);
      }
    }

    if ((subtype === "buy" || subtype === "dividend_reinvest") && units == null && nav != null) {
      const fundUnitsDecimals = normalizeFundUnitsDecimals(fundAccountMeta.fundUnitsDecimals);
      units = calculateConfirmedBuyUnits({
        grossAmount: amount,
        refundAmount: 0,
        fee: subtype === "buy" ? fee : 0,
        nav,
        roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
      });
      calculatedFields.add("units");
    }
  }

  if (!fundName && fundCode && supportedFundCode) fundName = await resolveFundNameByCode(ctx, fundCode);
  if (!fundName && fundCode) fundName = fundCode;

  return {
    rawText: String(input.rawText ?? "").trim() || JSON.stringify(input),
    date,
    fundSubtype: subtype,
    source,
    cashAccount,
    fundAccount,
    fundCode,
    fundName,
    amount,
    units,
    nav,
    fee,
    confirmDate,
    arrivalDate,
    remark,
    tags,
    feeRate,
    confirmDays,
    arrivalDays,
    cashAccountId: isDividendReinvest ? null : cashAccountMeta?.id ?? null,
    fundAccountId: fundAccountMeta?.id ?? null,
    fundProductType: fundAccountMeta?.investProductType ?? "fund",
    pendingInstitutionCashAccount,
    pendingInstitutionFundAccount,
    calculatedFields: sortedCalculatedFields(calculatedFields),
    issues,
  };
}

async function createFundTransaction(tx: Prisma.TransactionClient, householdId: string, item: FundImportEnrichedItem) {
  if (!item.fundAccountId) throw new Error("基金账户未匹配");
  const fundAccount = await tx.account.findUnique({
    where: { id: item.fundAccountId },
    select: { id: true, name: true, investProductType: true, fundUnitsDecimals: true, tradingCalendar: true },
  });
  if (!fundAccount) throw new Error("基金账户不存在");
  const subtype = normalizeSubtype(item.fundSubtype);
  const source = normalizeSource(item.source, subtype, item.fundSubtype);
  const amountAbs = Math.abs(item.amount);
  const redeemLike = subtype === "redeem";
  const isDividendCash = subtype === "dividend_cash";
  const isDividendReinvest = subtype === "dividend_reinvest";
  const isBuyFailedRefund = subtype === "buy_failed" && source === "regular_invest_refund";
  const finalFundSubtype = isDividendReinvest ? FundSubtype.buy : subtype as FundSubtype;
  const cashAccount = !isDividendReinvest && item.cashAccountId
    ? await tx.account.findUnique({ where: { id: item.cashAccountId }, select: { id: true, name: true } })
    : null;
  if (!isDividendReinvest && item.cashAccount && !item.cashAccountId) throw new Error(`资金账户“${item.cashAccount}”未匹配，无法建立资金流水关联`);
  if (!isDividendReinvest && item.cashAccountId && !cashAccount) throw new Error(`资金账户“${item.cashAccount || item.cashAccountId}”不存在，无法建立资金流水关联`);

  const confirmDate = item.confirmDate ? toUtcDate(item.confirmDate) : null;
  const arrivalDate = item.arrivalDate ? toUtcDate(item.arrivalDate) : (
    item.confirmDate && (subtype === "buy" || isBuyFailedRefund || subtype === "redeem" || subtype === "switch_out" || subtype === "dividend_cash")
      ? toUtcDate(addTradingDaysUtc(item.confirmDate, item.arrivalDays ?? 2, fundAccount.tradingCalendar))
      : null
  );
  const recordDate = toUtcDate(item.date);
  const importFundUnitsDecimals = normalizeFundUnitsDecimals(fundAccount.fundUnitsDecimals);
  const normalizedUnits = (subtype === "buy" || isDividendReinvest) && item.units == null && item.nav != null
    ? calculateConfirmedBuyUnits({
      grossAmount: amountAbs,
      refundAmount: 0,
      fee: subtype === "buy" ? item.fee : 0,
      nav: item.nav,
      roundUnits: (value) => roundFundUnits(value, importFundUnitsDecimals),
    })
    : item.units;
  const storedFundName = normalizeUsableFundName(item.fundName, item.fundCode) ?? item.fundCode;

  const cashFlows: FundCashFlowInput[] = [];
  if (cashAccount && !isDividendReinvest) {
    const cashAmount = redeemLike || isDividendCash || isBuyFailedRefund ? amountAbs : -amountAbs;
    const kind = isBuyFailedRefund
      ? FundCashFlowKind.refund_in
      : redeemLike
        ? FundCashFlowKind.redeem_in
        : isDividendCash
          ? FundCashFlowKind.dividend_in
          : FundCashFlowKind.buy_out;
    cashFlows.push({
      kind,
      date: isBuyFailedRefund || redeemLike || isDividendCash ? arrivalDate ?? recordDate : recordDate,
      accountId: cashAccount.id,
      accountName: cashAccount.name,
      amount: cashAmount,
      source,
      note: item.remark || storedFundName,
    });
  }

  const created = await createFundTransactionWithCashFlows(tx, {
    householdId,
    fundAccountId: fundAccount.id,
    cashAccountId: isDividendReinvest ? null : cashAccount?.id ?? null,
    fundCode: item.fundCode,
    fundName: storedFundName,
    fundProductType: item.fundProductType ?? "fund",
    fundSubtype: finalFundSubtype,
    source,
    applyDate: recordDate,
    confirmDate,
    arrivalDate,
    grossAmount: isDividendReinvest ? 0 : amountAbs,
    refundAmount: isBuyFailedRefund ? amountAbs : 0,
    arrivalAmount: isDividendReinvest ? null : redeemLike || isDividendCash || isBuyFailedRefund ? amountAbs : null,
    fee: isDividendReinvest ? null : item.fee ?? null,
    nav: item.nav ?? null,
    units: normalizedUnits ?? null,
    note: item.remark || null,
    cashFlows,
  });

  return {
    id: created.cashEntry?.id ?? created.fundTransaction.id,
    fundTransactionId: created.fundTransaction.id,
    cashEntryId: created.cashEntry?.id ?? null,
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as null | {
      mode?: "preview" | "import";
      items?: FundImportInput[] | FundImportEnrichedItem[];
      context?: FundImportRequestContext | null;
      /** 缺账户时是否在同机构下自动创建（资金账户 / 基金账户两个方向都管）。 */
      createInstitutionAccounts?: boolean;
      /** 旧字段名（翻成「创建同机构基金账户」之前的前端版本），仍兼容。 */
      createFundInstitutionCashAccount?: boolean;
    };
    const mode = body?.mode === "import" ? "import" : "preview";
    const createInstitutionAccounts =
      body?.createInstitutionAccounts === true || body?.createFundInstitutionCashAccount === true;
    if (mode === "import" && isReadOnly(await getCurrentUser())) {
      return NextResponse.json(
        { ok: false, code: "READ_ONLY", error: "Read-only users cannot import data." },
        { status: 403, headers: corsHeaders() },
      );
    }
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) {
      return NextResponse.json({ ok: false, code: "MISSING_IMPORT_ITEMS", error: "缺少导入记录" }, { status: 400, headers: corsHeaders() });
    }

    const ctx = await buildImportContext();
    ctx.requestContext = await resolveFundImportRequestContext(ctx, body?.context);
    ctx.createInstitutionAccounts = createInstitutionAccounts;
    // 先把缺失的净值按基金批量补进缓存，逐行 enrich 才不会一行一次外部请求。
    // 预览只等 1.2 秒：宁可先给明细、净值列空着，也不要用户盯着转圈等外部接口；
    // 导入则必须等（份额按净值算），保持原来的完整等待。
    let navPreload: { stillFetching: boolean } = { stillFetching: false };
    if (mode === "preview") {
      // 预览只读缓存（ctx 默认就是缓存优先），真正落库的导入必须拿到净值（份额要靠它算）
      navPreload = await preloadImportNavCacheForPreview(items as FundImportInput[]);
    } else {
      await preloadImportNavCache(items as FundImportInput[]);
      ctx.navCacheOnly = false;
    }
    const enrichedItems = await mapWithConcurrency(
      items as FundImportInput[],
      ENRICH_CONCURRENCY,
      (item) => enrichImportItem(ctx, item),
    );

    if (mode === "preview") {
      // navMissingCount：还有几行没拿到净值（可能仍在后台抓，也可能当天没有净值）。
      // 前端据此隔几秒静默回填一次，补到就补、补不到就保持空白让用户手填。
      const navMissingCount = enrichedItems.filter(
        (item) => item.nav == null && /^\d{6}$/.test(String(item.fundCode ?? "").trim()),
      ).length;
      return NextResponse.json(
        {
          ok: true,
          items: enrichedItems,
          navMissingCount,
          navPending: navPreload.stillFetching && navMissingCount > 0,
        },
        { headers: corsHeaders() },
      );
    }

    const blockingIssues = enrichedItems.flatMap((item, index) =>
      item.issues.filter((issue) => issue.level === "error").map((issue) => `第 ${index + 1} 条：${issue.message}`),
    );
    if (blockingIssues.length > 0) {
      return NextResponse.json(
        { ok: false, code: "IMPORT_VALIDATION_FAILED", error: `导入前校验未通过：${blockingIssues.join("；")}` },
        { status: 400, headers: corsHeaders() },
      );
    }

    const { householdId } = await getHouseholdScope();
    const createdInstitutionCashAccounts: Array<{ id: string; name: string; kind: string }> = [];
    const createdInstitutionFundAccounts: Array<{ id: string; name: string; kind: string }> = [];
    const institutionCashAccountIdByName = new Map<string, string>();
    const institutionFundAccountIdByName = new Map<string, string>();
    const created = await prisma.$transaction(async (tx) => {
      const rows: Array<Awaited<ReturnType<typeof createFundTransaction>>> = [];
      for (const item of enrichedItems) {
        // 勾选「缺少账户时在同机构下自动创建」时，先落地**同机构基金账户**：
        // 机构来自资金账户（支付宝），所有人跟着资金账户的账户组走，
        // 产品类型固定 fund —— 这样下次同机构再来账单，名字里带机构名就能直接命中。
        if (item.pendingInstitutionFundAccount && !item.fundAccountId) {
          const pending = item.pendingInstitutionFundAccount;
          const nameKey = `${pending.institutionId}::${pending.name}`;
          let accountId = institutionFundAccountIdByName.get(nameKey) ?? null;
          if (!accountId) {
            const existing = await tx.account.findFirst({
              where: {
                householdId,
                name: pending.name,
                kind: AccountKind.investment,
                institutionId: pending.institutionId,
                isPlaceholder: { not: true },
              },
              select: { id: true },
            });
            if (existing) {
              accountId = existing.id;
            } else {
              const groupId = pending.groupId ?? (await tx.accountGroup.findFirst({
                where: { householdId },
                orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
                select: { id: true },
              }))?.id ?? null;
              if (groupId) {
                const createdAccount = await tx.account.create({
                  data: {
                    name: pending.name,
                    kind: AccountKind.investment,
                    investProductType: FundProductType.fund,
                    institutionId: pending.institutionId,
                    currency: "CNY",
                    groupId,
                    householdId,
                    isActive: true,
                  },
                  select: { id: true, name: true, kind: true },
                });
                accountId = createdAccount.id;
                createdInstitutionFundAccounts.push({ id: createdAccount.id, name: createdAccount.name, kind: createdAccount.kind });
              }
            }
          }
          if (accountId) institutionFundAccountIdByName.set(nameKey, accountId);
          if (accountId) {
            item.fundAccountId = accountId;
            item.fundAccount = pending.name;
          }
        }

        // 同一勾选的另一半：先落地同机构电子钱包账户
        if (item.pendingInstitutionCashAccount && !item.cashAccountId) {
          const pending = item.pendingInstitutionCashAccount;
          const nameKey = `${pending.institutionId}::${pending.name}`;
          let accountId = institutionCashAccountIdByName.get(nameKey) ?? null;
          if (!accountId) {
            const existing = await tx.account.findFirst({
              where: { householdId, name: pending.name, kind: AccountKind.ewallet, institutionId: pending.institutionId, isPlaceholder: { not: true } },
              select: { id: true },
            });
            if (existing) {
              accountId = existing.id;
            } else {
              const group = await tx.accountGroup.findFirst({
                where: { householdId },
                orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
                select: { id: true },
              });
              if (group) {
                const createdAccount = await tx.account.create({
                  data: {
                    name: pending.name,
                    kind: AccountKind.ewallet,
                    institutionId: pending.institutionId,
                    currency: "CNY",
                    groupId: group.id,
                    householdId,
                    isActive: true,
                  },
                  select: { id: true, name: true, kind: true },
                });
                accountId = createdAccount.id;
                createdInstitutionCashAccounts.push({ id: createdAccount.id, name: createdAccount.name, kind: createdAccount.kind });
              }
            }
            if (accountId) institutionCashAccountIdByName.set(nameKey, accountId);
          }
          if (accountId) {
            item.cashAccountId = accountId;
            item.cashAccount = pending.name;
          }
        }
        rows.push(await createFundTransaction(tx, householdId, item));
        const cashEntryId = rows[rows.length - 1]?.cashEntryId ?? null;
        if (cashEntryId && item.tags) {
          await attachEntryTagsByNames({
            tx,
            entryId: cashEntryId,
            householdId,
            names: parseTagNamesInput(item.tags),
          });
        }
      }
      return rows;
    }, {
      maxWait: 10_000,
      timeout: 60_000,
    });

    const fundAccountIds = new Set<string>();
    const cashAccountIds = new Set<string>();
    for (const item of enrichedItems) {
      if (item.fundAccountId) fundAccountIds.add(item.fundAccountId);
      if (item.cashAccountId) cashAccountIds.add(item.cashAccountId);
    }

    for (const accountId of fundAccountIds) {
      const fundCodes = Array.from(new Set(enrichedItems.filter((item) => item.fundAccountId === accountId).map((item) => item.fundCode)));
      await recalcFundPositions(accountId, fundCodes).catch(() => {});
      await recalcAndSaveAccountBalance(accountId).catch(() => {});
    }
    for (const accountId of cashAccountIds) {
      if (!fundAccountIds.has(accountId)) await recalcAndSaveAccountBalance(accountId).catch(() => {});
    }

    return NextResponse.json(
      {
        ok: true,
        createdCount: created.length,
        ids: created.map((item) => item.id),
        items: enrichedItems,
        createdCashAccounts: createdInstitutionCashAccounts,
        createdFundAccounts: createdInstitutionFundAccounts,
      },
      { headers: corsHeaders() },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "IMPORT_FAILED", error: error instanceof Error ? error.message : "基金导入失败" },
      { status: 500, headers: corsHeaders() },
    );
  }
}
