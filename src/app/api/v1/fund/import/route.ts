import { NextResponse } from "next/server";
import { AccountKind, FundSubtype, Prisma, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  buildImportAccountCandidates,
  buildImportAccountInputCandidates,
  normalizeImportAccountMatchKey,
  resolveImportAccountIdFromList,
} from "@/lib/account-import-match";
import { getFundConfirmRule, normalizeNonNegativeDays, setFundConfirmRuleInTx } from "@/lib/fund/confirmDays";
import { getFundFeeRate, getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision-core";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { addTradingDaysUtc } from "@/lib/date-utils";

export const runtime = "nodejs";

/**
 * POST /api/v1/fund/import
 *
 * Body:
 * - mode: "preview" | "import"
 * - items: fund import rows using the template contract fields
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
  investProductType: string | null;
  tradingCalendar: string | null;
  billingDay: number | null;
  fundUnitsDecimals: number | null;
  numberMasked: string | null;
  Institution: { name: string | null; shortName?: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
};

type PreviewIssue = {
  level: "error" | "warning";
  message: string;
};

type FundImportInput = {
  rawText?: string;
  date?: string;
  fundSubtype?: string;
  source?: string;
  cashAccount?: string;
  fundAccount?: string;
  fundCode?: string;
  fundName?: string;
  amount?: number;
  units?: number | null;
  nav?: number | null;
  fee?: number | null;
  confirmDate?: string | null;
  arrivalDate?: string | null;
  remark?: string;
};

type FundImportPreviewItem = {
  rawText: string;
  date: string;
  fundSubtype: string;
  source: string;
  cashAccount: string;
  fundAccount: string;
  fundCode: string;
  fundName: string;
  amount: number;
  units: number | null;
  nav: number | null;
  fee: number | null;
  confirmDate: string | null;
  arrivalDate: string | null;
  remark: string;
  feeRate: number | null;
  confirmDays: number | null;
  arrivalDays: number | null;
  cashAccountId: string | null;
  fundAccountId: string | null;
  fundProductType: string | null;
  issues: PreviewIssue[];
};

type FundImportRuleOverride = {
  fundAccountId?: string | null;
  fundAccount?: string | null;
  fundCode?: string | null;
  confirmDays?: number | null;
  arrivalDays?: number | null;
};

type ImportContext = {
  householdId: string;
  accountIdByMatchKey: Map<string, string>;
  accountLookupRows: AccountLookupRow[];
};

type ParsedRuleOverride = {
  fundAccountId: string | null;
  fundAccountKey: string | null;
  fundCode: string;
  confirmDays?: number;
  arrivalDays?: number;
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

function isPureInvestmentAccount(account: Pick<AccountLookupRow, "kind" | "investProductType"> | null | undefined) {
  return !!account && account.kind === AccountKind.investment && account.investProductType !== "deposit";
}

function toUtcDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function formatDate(date: Date | null | undefined) {
  return date ? date.toISOString().slice(0, 10) : null;
}

function parseDate(date?: string) {
  const value = String(date ?? "").trim();
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return toUtcDate(dt.toISOString().slice(0, 10));
}

function parsePositiveNumber(value: unknown): number | null {
  const num = Number(String(value ?? "").replace(/[,，￥¥\s]/g, ""));
  if (!Number.isFinite(num)) return null;
  const abs = Math.abs(num);
  return abs > 0 ? abs : null;
}

function normalizeSubtype(raw: string) {
  const value = String(raw ?? "").trim();
  if (!value) return "buy";
  if (value === "refund" || value === "returned" || value === "buy_refund") return "buy_failed";
  const valid = new Set(["buy", "redeem", "dividend_cash", "dividend_reinvest", "buy_failed"]);
  return valid.has(value) ? value : "buy";
}

function normalizeSource(raw: string, subtype: string, rawSubtype?: string) {
  const rawValue = String(raw ?? "").trim();
  const rawSubtypeValue = String(rawSubtype ?? "").trim();
  const isRefundAlias = rawSubtypeValue === "refund" || rawSubtypeValue === "returned" || rawSubtypeValue === "buy_refund";

  let value = rawValue;
  if (value === "regular_invest_refund" && subtype !== "buy_failed") {
    value = "regular_invest";
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

function indexAccountLookup(
  map: Map<string, string>,
  account: AccountLookupRow,
) {
  for (const candidate of buildImportAccountCandidates(account)) {
    const key = normalizeImportAccountMatchKey(candidate);
    if (key) map.set(key, account.id);
  }
}

async function buildImportContext(): Promise<ImportContext> {
  const { householdId } = await getHouseholdScope();
  const accounts = await prisma.account.findMany({
    where: { householdId, isPlaceholder: { not: true } },
    select: {
      id: true,
      name: true,
      kind: true,
      investProductType: true,
      tradingCalendar: true,
      billingDay: true,
      fundUnitsDecimals: true,
      numberMasked: true,
      Institution: { select: { name: true, shortName: true } },
      AccountAlias: { select: { alias: true } },
    },
  });
  const accountIdByMatchKey = new Map<string, string>();
  for (const account of accounts) indexAccountLookup(accountIdByMatchKey, account);
  return {
    householdId,
    accountIdByMatchKey,
    accountLookupRows: accounts,
  };
}

async function resolveAccount(
  ctx: ImportContext,
  accountName: string,
): Promise<AccountLookupRow | null> {
  const normalizedTarget = normalizeImportAccountMatchKey(accountName);
  if (!normalizedTarget) return null;
  const cachedId = ctx.accountIdByMatchKey.get(normalizedTarget);
  if (cachedId) return ctx.accountLookupRows.find((item) => item.id === cachedId) ?? null;
  const resolvedId = resolveImportAccountIdFromList(accountName, ctx.accountLookupRows);
  if (resolvedId) {
    for (const candidate of buildImportAccountInputCandidates(accountName)) {
      const key = normalizeImportAccountMatchKey(candidate);
      if (key) ctx.accountIdByMatchKey.set(key, resolvedId);
    }
    return ctx.accountLookupRows.find((item) => item.id === resolvedId) ?? null;
  }
  for (const account of ctx.accountLookupRows) {
    for (const candidate of buildImportAccountCandidates(account)) {
      const key = normalizeImportAccountMatchKey(candidate);
      if (!key) continue;
      if ((key.length >= 3 || normalizedTarget.length >= 3) && (normalizedTarget.includes(key) || key.includes(normalizedTarget))) {
        ctx.accountIdByMatchKey.set(normalizedTarget, account.id);
        return account;
      }
    }
  }
  return null;
}

function buildRuleOverrideMap(overrides: FundImportRuleOverride[] | undefined) {
  const map = new Map<string, ParsedRuleOverride>();
  for (const override of overrides ?? []) {
    const fundCode = String(override.fundCode ?? "").trim();
    if (!fundCode) continue;
    const fundAccountId = String(override.fundAccountId ?? "").trim() || null;
    const fundAccountKey = normalizeImportAccountMatchKey(String(override.fundAccount ?? "").trim()) || null;
    if (!fundAccountId && !fundAccountKey) continue;
    const key = `${fundAccountId ?? fundAccountKey}::${fundCode}`;
    const next: ParsedRuleOverride = {
      fundAccountId,
      fundAccountKey,
      fundCode,
    };
    if (override.confirmDays != null) {
      next.confirmDays = normalizeNonNegativeDays(override.confirmDays, 0);
    }
    if (override.arrivalDays != null) {
      next.arrivalDays = normalizeNonNegativeDays(override.arrivalDays, 2);
    }
    map.set(key, next);
  }
  return map;
}

function findRuleOverride(
  overrideMap: Map<string, ParsedRuleOverride>,
  fundAccountMeta: AccountLookupRow | null,
  fundAccount: string,
  fundCode: string,
) {
  const normalizedFundCode = String(fundCode ?? "").trim();
  if (!normalizedFundCode) return null;
  if (fundAccountMeta?.id) {
    const matched = overrideMap.get(`${fundAccountMeta.id}::${normalizedFundCode}`);
    if (matched) return matched;
  }
  const accountKey = normalizeImportAccountMatchKey(fundAccount);
  if (!accountKey) return null;
  return overrideMap.get(`${accountKey}::${normalizedFundCode}`) ?? null;
}

async function enrichPreviewItem(
  ctx: ImportContext,
  input: FundImportInput,
  overrideMap: Map<string, ParsedRuleOverride>,
): Promise<FundImportPreviewItem> {
  const date = String(input.date ?? "").trim();
  const rawSubtype = String(input.fundSubtype ?? "");
  const subtype = normalizeSubtype(rawSubtype);
  const source = normalizeSource(String(input.source ?? ""), subtype, rawSubtype);
  const cashAccount = String(input.cashAccount ?? "").trim();
  const fundAccount = String(input.fundAccount ?? "").trim();
  const fundCode = String(input.fundCode ?? "").trim();
  const amount = amountForSubtype(Number(input.amount ?? 0), subtype);
  const issues: PreviewIssue[] = [];

  const [cashAccountMeta, fundAccountMeta] = await Promise.all([
    cashAccount ? resolveAccount(ctx, cashAccount) : Promise.resolve(null),
    fundAccount ? resolveAccount(ctx, fundAccount) : Promise.resolve(null),
  ]);

  if (!date) issues.push({ level: "error", message: "缺少日期" });
  if (!fundAccount) issues.push({ level: "error", message: "缺少基金账户" });
  else if (!fundAccountMeta) issues.push({ level: "error", message: `基金账户“${fundAccount}”未匹配` });
  else if (!isPureInvestmentAccount(fundAccountMeta)) issues.push({ level: "error", message: `基金账户“${fundAccount}”不是开放式基金账户` });

  if (cashAccount && !cashAccountMeta) issues.push({ level: "warning", message: `资金账户“${cashAccount}”未匹配` });
  if (!fundCode) issues.push({ level: "error", message: "缺少基金代码" });
  if (!(amount > 0)) issues.push({ level: "error", message: "金额无效" });

  let confirmDays: number | null = null;
  let arrivalDays: number | null = null;
  let confirmDate = String(input.confirmDate ?? "").trim() || null;
  let nav = parsePositiveNumber(input.nav);
  let fee = parsePositiveNumber(input.fee);
  let units = parsePositiveNumber(input.units);
  let feeRate: number | null = null;
  let fundName = String(input.fundName ?? "").trim();
  let arrivalDate = String(input.arrivalDate ?? "").trim() || null;
  const remark = String(input.remark ?? "").trim();

  if (fundAccountMeta && fundCode && date) {
    const override = findRuleOverride(overrideMap, fundAccountMeta, fundAccount, fundCode);
    const confirmRule = await getFundConfirmRule(fundAccountMeta.id, fundCode);
    confirmDays = override?.confirmDays ?? confirmRule.days;
    arrivalDays = override?.arrivalDays ?? confirmRule.arrivalDays;
    if (!confirmRule.exists && !override) {
      issues.push({ level: "warning", message: `未找到 ${fundCode} 的确认天数配置，当前按 T+${confirmDays} 预览` });
    }
    if (!confirmDate && (subtype === "buy" || (subtype === "buy_failed" && source === "regular_invest_refund"))) {
      confirmDate = addTradingDaysUtc(date, confirmDays, fundAccountMeta.tradingCalendar);
    } else if (!confirmDate) {
      confirmDate = date;
    }
    if (!arrivalDate && (subtype === "buy" || (subtype === "buy_failed" && source === "regular_invest_refund")) && confirmDate && arrivalDays != null) {
      arrivalDate = addTradingDaysUtc(confirmDate, arrivalDays, fundAccountMeta.tradingCalendar);
    }

    if (!fee) {
      const feeType = subtype === "redeem" ? "redeem" : "buy";
      const baseDate = confirmDate ? toUtcDate(confirmDate) : toUtcDate(date);
      let feeRateRaw = await getFundFeeRateByDate(fundAccountMeta.id, fundCode, baseDate, feeType).catch(() => 0);
      if (!feeRateRaw) {
        feeRateRaw = await getFundFeeRate(fundAccountMeta.id, fundCode, feeType).catch(() => 0);
      }
      feeRate = feeRateRaw || 0;
      if (feeRate > 0 && (subtype === "buy" || subtype === "redeem")) {
        fee = Number((amount * (feeRate / 100)).toFixed(2));
      }
    } else {
      feeRate = 0;
    }
  }

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
    feeRate,
    confirmDays,
    arrivalDays,
    cashAccountId: cashAccountMeta?.id ?? null,
    fundAccountId: fundAccountMeta?.id ?? null,
    fundProductType: fundAccountMeta?.investProductType ?? "fund",
    issues,
  };
}

async function createFundTransaction(tx: Prisma.TransactionClient, householdId: string, item: FundImportPreviewItem) {
  if (!item.fundAccountId) throw new Error("基金账户未匹配");
  const fundAccount = await tx.account.findUnique({
    where: { id: item.fundAccountId },
    select: { id: true, name: true, investProductType: true, fundUnitsDecimals: true, tradingCalendar: true },
  });
  if (!fundAccount) throw new Error("基金账户不存在");
  const cashAccount = item.cashAccountId
    ? await tx.account.findUnique({ where: { id: item.cashAccountId }, select: { id: true, name: true } })
    : null;

  const subtype = normalizeSubtype(item.fundSubtype);
  const source = normalizeSource(item.source, subtype, item.fundSubtype);
  const amountAbs = Math.abs(item.amount);
  const redeemLike = subtype === "redeem";
  const isDividendCash = subtype === "dividend_cash";
  const isDividendReinvest = subtype === "dividend_reinvest";
  const isBuyFailedRefund = subtype === "buy_failed" && source === "regular_invest_refund";

  let accountId: string;
  let accountName: string;
  let toAccountId: string | null;
  let toAccountName: string | null;
  let signedAmount: number;

  if (redeemLike || isDividendCash || isBuyFailedRefund) {
    accountId = fundAccount.id;
    accountName = fundAccount.name;
    toAccountId = cashAccount?.id ?? null;
    toAccountName = cashAccount?.name ?? null;
    signedAmount = amountAbs;
  } else if (isDividendReinvest) {
    accountId = fundAccount.id;
    accountName = fundAccount.name;
    toAccountId = fundAccount.id;
    toAccountName = fundAccount.name;
    signedAmount = -amountAbs;
  } else {
    accountId = cashAccount?.id ?? fundAccount.id;
    accountName = cashAccount?.name ?? fundAccount.name;
    toAccountId = fundAccount.id;
    toAccountName = fundAccount.name;
    signedAmount = -amountAbs;
  }

  const confirmDate = item.confirmDate ? toUtcDate(item.confirmDate) : null;
  const arrivalDate = item.arrivalDate ? toUtcDate(item.arrivalDate) : (
    (subtype === "buy" || isBuyFailedRefund) && item.confirmDate && item.arrivalDays != null
      ? toUtcDate(addTradingDaysUtc(item.confirmDate, item.arrivalDays, fundAccount.tradingCalendar))
      : null
  );
  const recordDate = toUtcDate(item.date);
  const importFundUnitsDecimals = normalizeFundUnitsDecimals(fundAccount.fundUnitsDecimals);
  const normalizedUnits = subtype === "buy" && item.units == null && item.nav != null
    ? calculateConfirmedBuyUnits({
      grossAmount: amountAbs,
      refundAmount: 0,
      fee: item.fee,
      nav: item.nav,
      roundUnits: (value) => roundFundUnits(value, importFundUnitsDecimals),
    })
    : item.units;

  const created = await tx.txRecord.create({
    data: {
      householdId,
      type: TransactionType.investment,
      date: recordDate,
      accountId,
      accountName,
      toAccountId,
      toAccountName,
      amount: signedAmount,
      fundCode: item.fundCode,
      fundName: item.fundName || item.fundCode,
      fundProductType: (item.fundProductType as "fund" | "money" | "wealth" | "deposit" | "metal" | null) ?? "fund",
      fundSubtype: subtype as FundSubtype,
      source,
      fundUnits: normalizedUnits ?? undefined,
      fundNav: item.nav ?? undefined,
      fundFee: item.fee ?? undefined,
      fundConfirmDate: confirmDate ?? undefined,
      fundArrivalDate: arrivalDate ?? undefined,
      note: item.remark || undefined,
    },
  });

  return created;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as null | {
      mode?: "preview" | "import";
      items?: FundImportInput[] | FundImportPreviewItem[];
      overrides?: FundImportRuleOverride[];
    };
    const mode = body?.mode === "import" ? "import" : "preview";
    const items = Array.isArray(body?.items) ? body.items : [];
    const overrideMap = buildRuleOverrideMap(Array.isArray(body?.overrides) ? body.overrides : []);
    if (items.length === 0) {
      return NextResponse.json({ ok: false, error: "缺少导入记录" }, { status: 400, headers: corsHeaders() });
    }

    const ctx = await buildImportContext();
    const previewItems = await Promise.all(items.map((item) => enrichPreviewItem(ctx, item as FundImportInput, overrideMap)));

    if (mode === "preview") {
      return NextResponse.json({ ok: true, items: previewItems }, { headers: corsHeaders() });
    }

    const blockingIssues = previewItems.flatMap((item, index) =>
      item.issues.filter((issue) => issue.level === "error").map((issue) => `第 ${index + 1} 条：${issue.message}`),
    );
    if (blockingIssues.length > 0) {
      return NextResponse.json(
        { ok: false, error: `导入前校验未通过：${blockingIssues.join("；")}` },
        { status: 400, headers: corsHeaders() },
      );
    }

    const { householdId } = await getHouseholdScope();
    const created = await prisma.$transaction(async (tx) => {
      const rows: Array<Awaited<ReturnType<typeof createFundTransaction>>> = [];
      const persistedRuleKeys = new Set<string>();
      for (const item of previewItems) {
        if (item.fundAccountId && item.fundCode) {
          const ruleKey = `${item.fundAccountId}::${item.fundCode}`;
          const override = overrideMap.get(ruleKey);
          if (override && !persistedRuleKeys.has(ruleKey)) {
            await setFundConfirmRuleInTx(
              tx,
              item.fundAccountId,
              item.fundCode,
              override.confirmDays ?? item.confirmDays ?? 0,
              override.arrivalDays ?? item.arrivalDays ?? 2,
            );
            persistedRuleKeys.add(ruleKey);
          }
        }
        rows.push(await createFundTransaction(tx, householdId, item));
      }
      await syncFundTransactionsFromTxRecords(rows.map((row) => row.id), tx);
      return rows;
    }, {
      maxWait: 10_000,
      timeout: 60_000,
    });

    const fundAccountIds = new Set<string>();
    const cashAccountIds = new Set<string>();
    for (const item of previewItems) {
      if (item.fundAccountId) fundAccountIds.add(item.fundAccountId);
      if (item.cashAccountId) cashAccountIds.add(item.cashAccountId);
    }

    for (const accountId of fundAccountIds) {
      const fundCodes = Array.from(new Set(previewItems.filter((item) => item.fundAccountId === accountId).map((item) => item.fundCode)));
      await recalcFundPositions(accountId, fundCodes).catch(() => {});
      await recalcAndSaveAccountBalance(accountId).catch(() => {});
    }
    for (const accountId of cashAccountIds) {
      if (!fundAccountIds.has(accountId)) await recalcAndSaveAccountBalance(accountId).catch(() => {});
    }

    return NextResponse.json(
      { ok: true, createdCount: created.length, ids: created.map((item) => item.id), items: previewItems },
      { headers: corsHeaders() },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "基金导入失败" },
      { status: 500, headers: corsHeaders() },
    );
  }
}
