import { NextRequest, NextResponse } from "next/server";
import { AccountKind, Prisma, StockTransactionAction, TransactionType } from "@prisma/client";

import {
  buildImportAccountCandidates,
  normalizeImportAccountMatchKey,
} from "@/lib/account-import-match";
import { normalizeCurrency, resolveSameCurrencyTransfer } from "@/lib/currency";
import { formatDateUtc } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import {
  ensureBrokerageCashAccountForStockAccount,
  isCashLikeBrokerageFundingKind,
} from "@/lib/server/brokerage-cash-account";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { findRecentManualTransactionDuplicate } from "@/lib/server/transaction-dedupe";
import { ensureStockTransactionCashFlow, stockCashAmount } from "@/lib/stock/cashFlow";
import { calculateStockTransactionFeesByDate } from "@/lib/stock/feeRule";
import { getStockClosePriceByDate } from "@/lib/stock/priceCache";
import { recalcStockPositions } from "@/lib/stock/recalcPosition";
import { getCurrentUser, isReadOnly } from "@/lib/server/auth";
import {
  getStockSecurityByCode,
  inferStockMarketFromCode,
  normalizeStockCode,
  normalizeStockMarket,
  normalizeUsableStockName,
  resolveOrCreateStockSecurity,
} from "@/lib/stock/securities";
import {
  ENTRY_ORIGIN_EXCEL_IMPORT,
  TRANSACTION_SOURCE_MANUAL,
  statementMonthForTransfer,
} from "@/lib/transaction-semantics";

export const runtime = "nodejs";

const STOCK_IMPORT_ACTIONS = new Set<string>([
  ...Object.values(StockTransactionAction),
  "bank_transfer",
]);

const GENERIC_BANK_ACCOUNT_INPUT_KEYS = new Set([
  "\u501f\u8bb0\u5361",
  "\u501f\u8bb0\u5361\u8d26\u6237",
  "\u50a8\u84c4\u5361",
  "\u50a8\u84c4\u5361\u8d26\u6237",
  "\u94f6\u884c\u5361",
  "\u94f6\u884c\u8d26\u6237",
  "\u73b0\u91d1",
  "\u73b0\u91d1\u8d26\u6237",
  "\u94b1\u5305",
  "\u7535\u5b50\u94b1\u5305",
  "debit card",
  "debit card account",
  "bank card",
  "bank account",
  "cash",
  "cash account",
  "wallet",
  "e-wallet",
].map(normalizeImportAccountMatchKey));

const STOCK_IMPORT_COMPONENT_FEE_FIELDS = [
  "commission",
  "stampTax",
  "transferFee",
  "exchangeFee",
  "regulatoryFee",
  "otherFee",
] as const;

const STOCK_IMPORT_FEE_FIELDS = [
  "fee",
  ...STOCK_IMPORT_COMPONENT_FEE_FIELDS,
] as const;

const STOCK_IMPORT_CALCULATED_FIELDS = [
  "price",
  "grossAmount",
  "netAmount",
  ...STOCK_IMPORT_FEE_FIELDS,
  "totalFee",
  "cashAmount",
] as const;

type StockImportComponentFeeField = typeof STOCK_IMPORT_COMPONENT_FEE_FIELDS[number];
type StockImportFeeField = typeof STOCK_IMPORT_FEE_FIELDS[number];
type StockImportCalculatedField = typeof STOCK_IMPORT_CALCULATED_FIELDS[number];

const STOCK_IMPORT_CALCULATED_FIELD_SET = new Set<string>(STOCK_IMPORT_CALCULATED_FIELDS);

type AccountLookupRow = {
  id: string;
  name: string;
  kind: AccountKind;
  investProductType: string | null;
  currency: string | null;
  groupId: string;
  institutionId: string | null;
  numberMasked: string | null;
  isActive: boolean;
  createdAt: Date;
  Institution: { id: string; name: string | null; shortName: string | null; type: string | null } | null;
  AccountGroup: { id: string; name: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
};

type StockAccountRow = {
  id: string;
  householdId: string;
  groupId: string;
  institutionId: string | null;
  name: string;
  currency: string | null;
};

type ImportIssue = {
  level: "error" | "warning";
  code: string;
  message: string;
};

type StockImportInput = {
  rawText?: string;
  stockAccountId?: string | null;
  accountId?: string | null;
  tradeDate?: string | null;
  settleDate?: string | null;
  action?: string | null;
  market?: string | null;
  stockCode?: string | null;
  stockName?: string | null;
  quantity?: number | string | null;
  price?: number | string | null;
  grossAmount?: number | string | null;
  amount?: number | string | null;
  netAmount?: number | string | null;
  bankAccount?: string | null;
  bankAccountId?: string | null;
  cashAccount?: string | null;
  cashAccountId?: string | null;
  fee?: number | string | null;
  commission?: number | string | null;
  stampTax?: number | string | null;
  transferFee?: number | string | null;
  exchangeFee?: number | string | null;
  regulatoryFee?: number | string | null;
  otherFee?: number | string | null;
  externalLinkId?: string | null;
  note?: string | null;
  calculatedFields?: StockImportCalculatedField[] | null;
};

type StockImportRequestContext = {
  stockAccountId?: string | null;
  stockAccountName?: string | null;
};

type StockImportEnrichedItem = {
  rawText: string;
  stockAccountId: string;
  stockAccountName: string;
  tradeDate: string;
  settleDate: string | null;
  action: string;
  market: string;
  stockCode: string;
  stockName: string | null;
  securityId: string | null;
  quantity: number | null;
  price: number | null;
  grossAmount: number | null;
  netAmount: number | null;
  bankAccount: string;
  bankAccountId: string | null;
  cashAccountId: string | null;
  fee: number | null;
  commission: number | null;
  stampTax: number | null;
  transferFee: number | null;
  exchangeFee: number | null;
  regulatoryFee: number | null;
  otherFee: number | null;
  totalFee: number;
  cashAmount: number;
  calculatedFields: StockImportCalculatedField[];
  externalLinkId: string | null;
  note: string | null;
  duplicate: boolean;
  issues: ImportIssue[];
};

type ImportContext = {
  householdId: string;
  stockAccount: StockAccountRow;
  accountLookupRows: AccountLookupRow[];
  accountIdByMatchKey: Map<string, string>;
  brokerageCashAccount: AccountLookupRow | null | undefined;
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

function issue(level: ImportIssue["level"], code: string): ImportIssue {
  return { level, code, message: code };
}

function parseDateOnly(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T00:00:00.000Z`)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatParsedDate(value: unknown) {
  const date = parseDateOnly(value);
  return date ? formatDateUtc(date) : "";
}

function parseOptionalNumber(value: unknown) {
  if (value == null || value === "") return null;
  const num = Number(String(value).trim().replace(/[,，￥¥\s]/g, ""));
  return Number.isFinite(num) ? num : null;
}

function parseOptionalNonNegativeNumber(value: unknown) {
  const num = parseOptionalNumber(value);
  return num == null ? null : Math.abs(num);
}

function importCalculatedFieldSet(input: StockImportInput) {
  return new Set(
    (input.calculatedFields ?? []).filter((field): field is StockImportCalculatedField =>
      STOCK_IMPORT_CALCULATED_FIELD_SET.has(String(field)),
    ),
  );
}

function parseUserOptionalNumber(
  input: StockImportInput,
  field: keyof StockImportInput,
  calculatedFields: Set<StockImportCalculatedField>,
) {
  return calculatedFields.has(field as StockImportCalculatedField) ? null : parseOptionalNumber(input[field]);
}

function parseUserOptionalNonNegativeNumber(
  input: StockImportInput,
  field: StockImportFeeField,
  calculatedFields: Set<StockImportCalculatedField>,
) {
  return calculatedFields.has(field) ? null : parseOptionalNonNegativeNumber(input[field]);
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function stockImportComponentFeeTotal(fees: Record<StockImportComponentFeeField, number | null>) {
  return roundMoney(STOCK_IMPORT_COMPONENT_FEE_FIELDS.reduce((sum, field) => sum + Math.max(0, fees[field] ?? 0), 0));
}

function stockImportTotalFee(fees: Record<StockImportFeeField, number | null>) {
  return roundMoney(fees.fee != null ? Math.max(0, fees.fee) : stockImportComponentFeeTotal(fees));
}

function sortedCalculatedFields(fields: Set<StockImportCalculatedField>) {
  return STOCK_IMPORT_CALCULATED_FIELDS.filter((field) => fields.has(field));
}

function decimalString(value: number | null) {
  return value == null ? null : String(value);
}

function normalizeAction(value: unknown) {
  const action = String(value ?? "").trim();
  return STOCK_IMPORT_ACTIONS.has(action) ? action : "";
}

function isBankTransferAction(action: string) {
  return action === "bank_transfer";
}

function isCashStockAction(action: string) {
  return (
    action === StockTransactionAction.buy ||
    action === StockTransactionAction.sell ||
    action === StockTransactionAction.dividend ||
    action === StockTransactionAction.fee_adjustment ||
    action === StockTransactionAction.tax_adjustment
  );
}

function isBuySellAction(action: string) {
  return action === StockTransactionAction.buy || action === StockTransactionAction.sell;
}

function isShareOnlyAction(action: string) {
  return (
    action === StockTransactionAction.bonus_share ||
    action === StockTransactionAction.split_share ||
    action === StockTransactionAction.merge_share
  );
}

function indexAccountLookup(map: Map<string, string>, account: AccountLookupRow) {
  for (const candidate of buildImportAccountCandidates(account)) {
    const key = normalizeImportAccountMatchKey(candidate);
    if (key) map.set(key, account.id);
  }
}

async function assertStockAccount(stockAccountId: string, householdId: string) {
  const account = await prisma.account.findFirst({
    where: { id: stockAccountId, householdId, kind: AccountKind.investment, investProductType: "stock" },
    select: { id: true, householdId: true, groupId: true, institutionId: true, name: true, currency: true },
  });
  if (!account) throw new Error("Stock account not found");
  return account;
}

async function buildImportContext(req: NextRequest, stockAccountId: string): Promise<ImportContext> {
  const { householdId } = await getApiHouseholdScope(req);
  const stockAccount = await assertStockAccount(stockAccountId, householdId);
  const accounts = await prisma.account.findMany({
    where: { householdId, isPlaceholder: { not: true } },
    select: {
      id: true,
      name: true,
      kind: true,
      investProductType: true,
      currency: true,
      groupId: true,
      institutionId: true,
      numberMasked: true,
      isActive: true,
      createdAt: true,
      Institution: { select: { id: true, name: true, shortName: true, type: true } },
      AccountGroup: { select: { id: true, name: true } },
      AccountAlias: { select: { alias: true } },
    },
  });
  const accountIdByMatchKey = new Map<string, string>();
  for (const account of accounts) indexAccountLookup(accountIdByMatchKey, account);
  return {
    householdId,
    stockAccount,
    accountLookupRows: accounts,
    accountIdByMatchKey,
    brokerageCashAccount: undefined,
  };
}

function findAccountById(ctx: ImportContext, accountId: string | null | undefined) {
  const id = String(accountId ?? "").trim();
  return id ? ctx.accountLookupRows.find((item) => item.id === id) ?? null : null;
}

function accountLast4ForStrictMatch(account: AccountLookupRow) {
  const values = [
    account.numberMasked ?? "",
    account.name,
    ...(account.AccountAlias ?? []).map((alias) => alias.alias),
  ];
  for (const value of values) {
    const matches = Array.from(String(value ?? "").matchAll(/\d{4}(?!\d)/g));
    if (matches.length > 0) return matches[matches.length - 1][0];
  }
  return "";
}

function inputLast4ForStrictMatch(value: string) {
  const matches = Array.from(String(value ?? "").matchAll(/\d{4}(?!\d)/g));
  return matches.length > 0 ? matches[matches.length - 1][0] : "";
}

function hasExplicitAccountIdentity(account: AccountLookupRow, normalizedTarget: string) {
  const exactNames = [
    account.name,
    ...(account.AccountAlias ?? []).map((alias) => alias.alias),
  ].map(normalizeImportAccountMatchKey).filter(Boolean);
  if (exactNames.includes(normalizedTarget)) return true;
  const last4 = accountLast4ForStrictMatch(account);
  return !!last4 && normalizedTarget.includes(last4);
}

async function resolveAccount(ctx: ImportContext, accountName: string) {
  const normalizedTarget = normalizeImportAccountMatchKey(accountName);
  if (!normalizedTarget) return null;
  if (GENERIC_BANK_ACCOUNT_INPUT_KEYS.has(normalizedTarget)) return null;
  const exactMatches = ctx.accountLookupRows.filter((account) => {
    const exactNames = [
      account.name,
      ...(account.AccountAlias ?? []).map((alias) => alias.alias),
    ].map(normalizeImportAccountMatchKey).filter(Boolean);
    return exactNames.includes(normalizedTarget);
  });
  if (exactMatches.length === 1) return exactMatches[0];
  const targetLast4 = inputLast4ForStrictMatch(accountName);
  if (targetLast4) {
    const last4Matches = ctx.accountLookupRows.filter((account) => accountLast4ForStrictMatch(account) === targetLast4);
    if (last4Matches.length === 1) return last4Matches[0];
  }
  const matches = ctx.accountLookupRows.filter((account) => {
    const candidateMatched = buildImportAccountCandidates(account)
      .some((candidate) => normalizeImportAccountMatchKey(candidate) === normalizedTarget);
    return candidateMatched && hasExplicitAccountIdentity(account, normalizedTarget);
  });
  return matches.length === 1 ? matches[0] : null;
}

async function resolveAccountInput(
  ctx: ImportContext,
  accountId: string | null | undefined,
  accountName: string,
) {
  return findAccountById(ctx, accountId) ?? await resolveAccount(ctx, accountName);
}

function isCashLikeAccount(account: AccountLookupRow | null | undefined) {
  return !!account && isCashLikeBrokerageFundingKind(account.kind);
}

async function findExistingBrokerageCashAccount(ctx: ImportContext) {
  if (ctx.brokerageCashAccount !== undefined) return ctx.brokerageCashAccount;
  if (!ctx.stockAccount.institutionId) {
    ctx.brokerageCashAccount = null;
    return null;
  }
  const currency = ctx.stockAccount.currency?.trim() || "CNY";
  const account = await prisma.account.findFirst({
    where: {
      householdId: ctx.householdId,
      groupId: ctx.stockAccount.groupId,
      institutionId: ctx.stockAccount.institutionId,
      currency,
      isPlaceholder: { not: true },
      OR: [
        { kind: AccountKind.ewallet },
        { kind: AccountKind.cash },
        { kind: AccountKind.bank_debit },
      ],
    },
    select: {
      id: true,
      name: true,
      kind: true,
      investProductType: true,
      currency: true,
      groupId: true,
      institutionId: true,
      numberMasked: true,
      isActive: true,
      createdAt: true,
      Institution: { select: { id: true, name: true, shortName: true, type: true } },
      AccountGroup: { select: { id: true, name: true } },
      AccountAlias: { select: { alias: true } },
    },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  ctx.brokerageCashAccount = account;
  return account;
}

async function enrichImportItem(ctx: ImportContext, input: StockImportInput): Promise<StockImportEnrichedItem> {
  const issues: ImportIssue[] = [];
  const sourceCalculatedFields = importCalculatedFieldSet(input);
  const calculatedFields = new Set<StockImportCalculatedField>();
  const action = normalizeAction(input.action);
  const tradeDate = formatParsedDate(input.tradeDate);
  const parsedTradeDate = parseDateOnly(input.tradeDate);
  const settleDate = input.settleDate ? formatParsedDate(input.settleDate) || null : null;
  const externalLinkId = String(input.externalLinkId ?? "").trim() || null;
  const stockCode = normalizeStockCode(input.stockCode);
  const market = isBankTransferAction(action) && !stockCode
    ? ""
    : stockCode ? normalizeStockMarket(input.market || inferStockMarketFromCode(stockCode)) : normalizeStockMarket(input.market || "CN");
  const quantity = parseOptionalNonNegativeNumber(input.quantity);
  let price = sourceCalculatedFields.has("price") ? null : parseOptionalNonNegativeNumber(input.price);
  const buySellAction = isBuySellAction(action);
  const grossAmountRaw = sourceCalculatedFields.has("grossAmount")
    ? null
    : parseOptionalNumber(input.grossAmount ?? input.amount);
  const netAmountRaw = parseUserOptionalNumber(input, "netAmount", sourceCalculatedFields);
  let grossAmount: number | null = isBankTransferAction(action) ? grossAmountRaw ?? netAmountRaw : null;
  const rawBankAccount = String(input.bankAccount ?? input.cashAccount ?? "").trim();
  const rawBankAccountId = String(input.bankAccountId ?? input.cashAccountId ?? "").trim();
  const note = String(input.note ?? "").trim() || null;

  if (!tradeDate || !parsedTradeDate) issues.push(issue("error", "INVALID_TRADE_DATE"));
  if (!action) issues.push(issue("error", "INVALID_ACTION"));

  let bankAccount: AccountLookupRow | null = null;
  let bankAccountName = rawBankAccount;
  let bankAccountId: string | null = null;
  let cashAccountId: string | null = null;

  if (isBankTransferAction(action)) {
    bankAccount = await resolveAccountInput(ctx, rawBankAccountId, rawBankAccount);
    if (!rawBankAccount && !rawBankAccountId) {
      issues.push(issue("error", "BANK_ACCOUNT_REQUIRED"));
    } else if (!bankAccount) {
      issues.push(issue("error", "BANK_ACCOUNT_NOT_FOUND"));
    } else if (!isCashLikeAccount(bankAccount)) {
      issues.push(issue("error", "INVALID_BANK_ACCOUNT_KIND"));
    } else {
      bankAccountName = bankAccount.name;
      bankAccountId = bankAccount.id;
    }
    const brokerageCashAccount = await findExistingBrokerageCashAccount(ctx);
    if (!brokerageCashAccount && !ctx.stockAccount.institutionId) {
      issues.push(issue("error", "CASH_ACCOUNT_UNDETERMINED"));
    } else if (!brokerageCashAccount) {
      issues.push(issue("warning", "BROKERAGE_CASH_ACCOUNT_WILL_BE_CREATED"));
    } else if (bankAccount?.id === brokerageCashAccount.id) {
      issues.push(issue("error", "SAME_TRANSFER_ACCOUNTS"));
    }
    if (!grossAmount || grossAmount === 0) issues.push(issue("error", "AMOUNT_REQUIRED"));
  } else if (isCashStockAction(action)) {
    const explicitCashAccount = rawBankAccount || rawBankAccountId
      ? await resolveAccountInput(ctx, rawBankAccountId, rawBankAccount)
      : null;
    const brokerageCashAccount = explicitCashAccount ?? await findExistingBrokerageCashAccount(ctx);
    if (rawBankAccount || rawBankAccountId) {
      if (!explicitCashAccount) {
        issues.push(issue("error", "BANK_ACCOUNT_NOT_FOUND"));
      } else if (!isCashLikeAccount(explicitCashAccount) && explicitCashAccount.id !== ctx.stockAccount.id) {
        issues.push(issue("error", "INVALID_BANK_ACCOUNT_KIND"));
      }
    } else if (!brokerageCashAccount && !ctx.stockAccount.institutionId) {
      issues.push(issue("error", "CASH_ACCOUNT_UNDETERMINED"));
    } else if (!brokerageCashAccount) {
      issues.push(issue("warning", "BROKERAGE_CASH_ACCOUNT_WILL_BE_CREATED"));
    }
    if (brokerageCashAccount) {
      cashAccountId = brokerageCashAccount.id;
    }
  }

  let securityId: string | null = null;
  let stockName: string | null = null;
  if (!isBankTransferAction(action)) {
    if (!stockCode) {
      issues.push(issue("error", "MISSING_STOCK_CODE"));
    } else {
      const security = await getStockSecurityByCode(prisma, {
        householdId: ctx.householdId,
        market,
        stockCode,
      });
      const explicitStockName = normalizeUsableStockName(input.stockName, stockCode);
      securityId = security?.id ?? null;
      stockName = explicitStockName ?? normalizeUsableStockName(security?.stockName, stockCode);
      if (!stockName) {
        issues.push(issue("warning", "STOCK_NAME_UNRESOLVED"));
      }
      if (buySellAction && price == null && parsedTradeDate) {
        const closePrice = await getStockClosePriceByDate(prisma, {
          securityId,
          market,
          stockCode,
          priceDate: tradeDate,
          exchange: security?.exchange,
        }).catch(() => null);
        if (closePrice) {
          price = closePrice.closePrice;
          calculatedFields.add("price");
        }
      }
    }
  }

  if (!isBankTransferAction(action)) {
    const grossFromQuantity = quantity != null && price != null ? roundMoney(quantity * price) : null;
    if (buySellAction && grossFromQuantity != null) {
      grossAmount = grossFromQuantity;
      calculatedFields.add("grossAmount");
    } else if (!buySellAction && grossAmountRaw != null) {
      grossAmount = Math.abs(grossAmountRaw);
    }
  }

  if (buySellAction && (!quantity || !price || !grossAmount || grossAmount <= 0)) {
    issues.push(issue("error", "QUANTITY_AND_PRICE_REQUIRED"));
  }
  if ((action === StockTransactionAction.dividend || action === StockTransactionAction.fee_adjustment || action === StockTransactionAction.tax_adjustment) && (!grossAmount || grossAmount <= 0)) {
    issues.push(issue("error", "AMOUNT_REQUIRED"));
  }
  if (isShareOnlyAction(action) && !quantity) {
    issues.push(issue("error", "QUANTITY_REQUIRED"));
  }

  let fee = parseUserOptionalNonNegativeNumber(input, "fee", sourceCalculatedFields);
  let commission = parseUserOptionalNonNegativeNumber(input, "commission", sourceCalculatedFields);
  let stampTax = parseUserOptionalNonNegativeNumber(input, "stampTax", sourceCalculatedFields);
  let transferFee = parseUserOptionalNonNegativeNumber(input, "transferFee", sourceCalculatedFields);
  let exchangeFee = parseUserOptionalNonNegativeNumber(input, "exchangeFee", sourceCalculatedFields);
  let regulatoryFee = parseUserOptionalNonNegativeNumber(input, "regulatoryFee", sourceCalculatedFields);
  let otherFee = parseUserOptionalNonNegativeNumber(input, "otherFee", sourceCalculatedFields);
  const hasUserFeeInput = STOCK_IMPORT_FEE_FIELDS.some((field) => ({
    fee,
    commission,
    stampTax,
    transferFee,
    exchangeFee,
    regulatoryFee,
    otherFee,
  })[field] != null);

  if (fee != null) {
    commission = null;
    stampTax = null;
    transferFee = null;
    exchangeFee = null;
    regulatoryFee = null;
    otherFee = null;
  } else if (!hasUserFeeInput && buySellAction && parsedTradeDate && grossAmount && grossAmount > 0) {
    const fees = await calculateStockTransactionFeesByDate({
      accountId: ctx.stockAccount.id,
      tradeDate: parsedTradeDate,
      grossAmount: Math.abs(grossAmount),
      direction: action,
      securityId,
      market,
      stockCode,
    }).catch(() => ({
      fee,
      commission,
      stampTax,
      transferFee,
      exchangeFee,
      regulatoryFee,
      otherFee,
    }));
    fee = fees.fee;
    commission = fees.commission;
    stampTax = fees.stampTax;
    transferFee = fees.transferFee;
    exchangeFee = fees.exchangeFee;
    regulatoryFee = fees.regulatoryFee;
    otherFee = fees.otherFee;
    for (const field of STOCK_IMPORT_COMPONENT_FEE_FIELDS) {
      if ((fees[field] ?? null) != null) calculatedFields.add(field);
    }
  }

  let duplicate = false;
  if (externalLinkId) {
    duplicate = Boolean(await prisma.stockTransaction.findFirst({
      where: {
        householdId: ctx.householdId,
        stockAccountId: ctx.stockAccount.id,
        externalLinkId,
        deletedAt: null,
      },
      select: { id: true },
    }));
    if (duplicate) issues.push(issue("warning", "DUPLICATE_IMPORT_ROW"));
  }

  const totalFeeAmount = isBankTransferAction(action) ? 0 : stockImportTotalFee({
    fee,
    commission,
    stampTax,
    transferFee,
    exchangeFee,
    regulatoryFee,
    otherFee,
  });
  const hasComponentFee = stockImportComponentFeeTotal({
    commission,
    stampTax,
    transferFee,
    exchangeFee,
    regulatoryFee,
    otherFee,
  }) > 0;
  const hasCalculatedComponentFee = STOCK_IMPORT_COMPONENT_FEE_FIELDS.some((field) => calculatedFields.has(field));
  if (!isBankTransferAction(action) && fee == null && (hasUserFeeInput || hasComponentFee || hasCalculatedComponentFee)) {
    calculatedFields.add("totalFee");
  }

  let netAmount = netAmountRaw == null ? null : Math.abs(netAmountRaw);
  if (netAmount == null && grossAmount != null && isBankTransferAction(action)) {
    netAmount = Math.abs(grossAmount);
    calculatedFields.add("netAmount");
  } else if (netAmount == null && grossAmount != null && grossAmount > 0 && isCashStockAction(action)) {
    const grossAbs = Math.abs(grossAmount);
    if (action === StockTransactionAction.sell || action === StockTransactionAction.dividend) {
      netAmount = roundMoney(Math.max(0, grossAbs - totalFeeAmount));
    } else {
      netAmount = roundMoney(grossAbs + totalFeeAmount);
    }
    calculatedFields.add("netAmount");
  }

  const previewRow = {
    action: action as StockTransactionAction,
    grossAmount: Math.abs(grossAmount ?? 0),
    netAmount,
    fee,
    commission,
    stampTax,
    transferFee,
    exchangeFee,
    regulatoryFee,
    otherFee,
  };
  const cashAmount = isBankTransferAction(action)
    ? Math.abs(grossAmount ?? 0)
    : stockCashAmount(previewRow);
  if (isBankTransferAction(action) || isCashStockAction(action)) {
    calculatedFields.add("cashAmount");
  }

  return {
    rawText: String(input.rawText ?? "").trim() || JSON.stringify(input),
    stockAccountId: ctx.stockAccount.id,
    stockAccountName: ctx.stockAccount.name,
    tradeDate,
    settleDate,
    action,
    market,
    stockCode,
    stockName,
    securityId,
    quantity,
    price,
    grossAmount: grossAmount ?? null,
    netAmount,
    bankAccount: bankAccountName,
    bankAccountId,
    cashAccountId,
    fee,
    commission,
    stampTax,
    transferFee,
    exchangeFee,
    regulatoryFee,
    otherFee,
    totalFee: totalFeeAmount,
    cashAmount,
    calculatedFields: sortedCalculatedFields(calculatedFields),
    externalLinkId,
    note,
    duplicate,
    issues,
  };
}

function markDuplicateImportRows(items: StockImportEnrichedItem[]) {
  const seenExternalLinkIds = new Set<string>();
  for (const item of items) {
    if (!item.externalLinkId) continue;
    if (seenExternalLinkIds.has(item.externalLinkId)) {
      item.duplicate = true;
      if (!item.issues.some((rowIssue) => rowIssue.code === "DUPLICATE_IMPORT_ROW")) {
        item.issues.push(issue("warning", "DUPLICATE_IMPORT_ROW"));
      }
      continue;
    }
    seenExternalLinkIds.add(item.externalLinkId);
  }
  return items;
}

async function createStockImportTransaction(
  tx: Prisma.TransactionClient,
  ctx: ImportContext,
  item: StockImportEnrichedItem,
) {
  if (item.duplicate) return { skipped: true as const, id: null, cashAccountId: null, securityId: item.securityId };
  if (!item.tradeDate) throw new Error("Trade date is invalid");
  const tradeDate = parseDateOnly(item.tradeDate);
  if (!tradeDate) throw new Error("Trade date is invalid");
  const action = item.action as StockTransactionAction;
  const stockAccount = ctx.stockAccount;
  const security = await resolveOrCreateStockSecurity(tx, {
    householdId: ctx.householdId,
    market: item.market ? normalizeStockMarket(item.market) : inferStockMarketFromCode(item.stockCode),
    stockCode: normalizeStockCode(item.stockCode),
    stockName: normalizeUsableStockName(item.stockName, item.stockCode) ?? undefined,
    currency: normalizeCurrency(stockAccount.currency),
  });
  let cashAccount = item.cashAccountId
    ? await tx.account.findFirst({
        where: { id: item.cashAccountId, householdId: ctx.householdId },
        select: { id: true, name: true, kind: true, investProductType: true, currency: true },
      })
    : null;
  if (!cashAccount && isCashStockAction(action)) {
    cashAccount = await ensureBrokerageCashAccountForStockAccount(tx, stockAccount);
  }
  if (isCashStockAction(action) && !cashAccount) throw new Error("Cash account could not be resolved");

  const row = await tx.stockTransaction.create({
    data: {
      householdId: ctx.householdId,
      stockAccountId: stockAccount.id,
      cashAccountId: cashAccount?.id ?? null,
      securityId: security.id,
      market: security.market,
      stockCode: security.stockCode,
      stockName: normalizeUsableStockName(item.stockName, security.stockCode) ?? security.stockName,
      action,
      source: TRANSACTION_SOURCE_MANUAL,
      entryOrigin: ENTRY_ORIGIN_EXCEL_IMPORT,
      tradeDate,
      settleDate: item.settleDate ? parseDateOnly(item.settleDate) : null,
      grossAmount: String(Math.abs(item.grossAmount ?? 0)),
      netAmount: decimalString(item.netAmount),
      quantity: decimalString(item.quantity),
      price: decimalString(item.price),
      fee: decimalString(item.fee),
      commission: decimalString(item.commission),
      stampTax: decimalString(item.stampTax),
      transferFee: decimalString(item.transferFee),
      exchangeFee: decimalString(item.exchangeFee),
      regulatoryFee: decimalString(item.regulatoryFee),
      otherFee: decimalString(item.otherFee),
      externalLinkId: item.externalLinkId,
      note: item.note,
    },
  });

  await ensureStockTransactionCashFlow(tx, {
    householdId: ctx.householdId,
    row,
    stockAccount,
    cashAccount,
    metadata: { createdBy: "stocks-import-api" },
  });
  return { skipped: false as const, id: row.id, cashAccountId: cashAccount?.id ?? null, securityId: security.id };
}

async function createBankTransfer(
  tx: Prisma.TransactionClient,
  ctx: ImportContext,
  item: StockImportEnrichedItem,
) {
  const tradeDate = parseDateOnly(item.tradeDate);
  if (!tradeDate) throw new Error("Transfer date is invalid");
  const amount = item.grossAmount ?? item.netAmount ?? 0;
  const amountAbs = Math.abs(amount);
  if (!amountAbs) throw new Error("Transfer amount is invalid");
  const bankAccount = item.bankAccountId
    ? await tx.account.findFirst({
        where: { id: item.bankAccountId, householdId: ctx.householdId },
        select: { id: true, name: true, kind: true, currency: true, billingDay: true },
      })
    : null;
  if (!bankAccount) throw new Error("Bank account was not found");
  if (!isCashLikeBrokerageFundingKind(bankAccount.kind)) throw new Error("Bank account kind is invalid");
  const brokerageCashAccount = await ensureBrokerageCashAccountForStockAccount(tx, ctx.stockAccount);
  if (!brokerageCashAccount) throw new Error("Brokerage cash account could not be resolved");
  if (bankAccount.id === brokerageCashAccount.id) throw new Error("Bank account and brokerage cash account cannot be the same");

  const transferIn = amount > 0;
  const fromAccount = transferIn ? bankAccount : brokerageCashAccount;
  const toAccount = transferIn ? brokerageCashAccount : bankAccount;
  const currency = resolveSameCurrencyTransfer(fromAccount, toAccount);
  const transferAmount = -amountAbs;
  const duplicate = await findRecentManualTransactionDuplicate(tx, {
    householdId: ctx.householdId,
    type: TransactionType.transfer,
    date: tradeDate,
    accountId: fromAccount.id,
    toAccountId: toAccount.id,
    amount: transferAmount,
    categoryId: null,
    note: item.note ?? "",
    source: "manual",
  });
  if (duplicate) return { skipped: true as const, id: duplicate.id, accountIds: [fromAccount.id, toAccount.id] };

  const row = await tx.txRecord.create({
    data: {
      householdId: ctx.householdId,
      accountId: fromAccount.id,
      accountName: fromAccount.name,
      toAccountId: toAccount.id,
      toAccountName: toAccount.name,
      amount: transferAmount,
      type: TransactionType.transfer,
      date: tradeDate,
      note: item.note,
      toNote: item.note,
      currency,
      statementMonth: statementMonthForTransfer(tradeDate, fromAccount, toAccount),
      source: "stock_cash_transfer_import",
      entryOrigin: ENTRY_ORIGIN_EXCEL_IMPORT,
    },
  });
  return { skipped: false as const, id: row.id, accountIds: [fromAccount.id, toAccount.id] };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

/**
 * POST /api/v1/stocks/import
 *
 * Body:
 * - mode: "preview" | "import"; omitted mode defaults to preview
 * - context.stockAccountId: target stock investment account
 * - items: listed security import rows parsed from the workbook template
 * - fee is treated as the total fee. When it is present, split fee components
 *   are not added on top of it. When all fee fields are blank, buy/sell rows
 *   estimate split fees from stock fee rules.
 * - buy/sell rows need quantity and a price that is either user-entered or
 *   resolved from the trade-date close price cache/API during preview.
 * - preview items include calculatedFields for numeric values derived during
 *   enrichment, such as auto-filled price, gross amount, fee components, net
 *   amount, and cash amount.
 *
 * Success:
 * - preview: { ok: true, items }
 * - import: { ok: true, createdCount, skippedCount, ids, items }
 *
 * Failure:
 * - { ok: false, code, error }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as null | {
      mode?: "preview" | "import";
      context?: StockImportRequestContext | null;
      accountId?: string | null;
      stockAccountId?: string | null;
      items?: StockImportInput[] | StockImportEnrichedItem[];
    };
    const mode = body?.mode === "import" ? "import" : "preview";
    if (mode === "import" && isReadOnly(await getCurrentUser())) {
      return NextResponse.json(
        { ok: false, code: "READ_ONLY", error: "Read-only users cannot import data." },
        { status: 403, headers: corsHeaders() },
      );
    }
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) {
      return NextResponse.json({ ok: false, code: "MISSING_IMPORT_ITEMS", error: "Import items are required" }, { status: 400, headers: corsHeaders() });
    }
    const firstItem = items[0] as StockImportInput | undefined;
    const stockAccountId = String(
      body?.context?.stockAccountId ??
      body?.stockAccountId ??
      body?.accountId ??
      firstItem?.stockAccountId ??
      firstItem?.accountId ??
      "",
    ).trim();
    if (!stockAccountId) {
      return NextResponse.json({ ok: false, code: "STOCK_ACCOUNT_REQUIRED", error: "Stock account is required" }, { status: 400, headers: corsHeaders() });
    }

    const ctx = await buildImportContext(req, stockAccountId);
    const enrichedItems = markDuplicateImportRows(await Promise.all(items.map((item) => enrichImportItem(ctx, item as StockImportInput))));

    if (mode === "preview") {
      return NextResponse.json({ ok: true, items: enrichedItems }, { headers: corsHeaders() });
    }

    const blockingIssues = enrichedItems.flatMap((item, index) =>
      item.issues.filter((rowIssue) => rowIssue.level === "error").map((rowIssue) => `Row ${index + 1}: ${rowIssue.code}`),
    );
    if (blockingIssues.length > 0) {
      return NextResponse.json(
        { ok: false, code: "IMPORT_VALIDATION_FAILED", error: `Import validation failed: ${blockingIssues.join("; ")}` },
        { status: 400, headers: corsHeaders() },
      );
    }

    const created = await prisma.$transaction(async (tx) => {
      const rows: Array<{ id: string | null; skipped: boolean; accountIds: string[]; securityId?: string | null }> = [];
      for (const item of enrichedItems) {
        if (isBankTransferAction(item.action)) {
          const transfer = await createBankTransfer(tx, ctx, item);
          rows.push({ id: transfer.id, skipped: transfer.skipped, accountIds: transfer.accountIds });
        } else {
          const stockTx = await createStockImportTransaction(tx, ctx, item);
          rows.push({
            id: stockTx.id,
            skipped: stockTx.skipped,
            accountIds: [ctx.stockAccount.id, stockTx.cashAccountId].filter((id): id is string => Boolean(id)),
            securityId: stockTx.securityId,
          });
        }
      }
      return rows;
    }, {
      maxWait: 10_000,
      timeout: 60_000,
    });

    const accountIds = new Set<string>([ctx.stockAccount.id]);
    const securityIds = new Set<string>();
    for (const row of created) {
      for (const accountId of row.accountIds) accountIds.add(accountId);
      if (row.securityId) securityIds.add(row.securityId);
    }
    if (securityIds.size > 0) {
      await recalcStockPositions(ctx.stockAccount.id, Array.from(securityIds)).catch(() => undefined);
    }
    for (const accountId of accountIds) {
      await recalcAndSaveAccountBalance(accountId).catch(() => undefined);
    }
    await invalidateCreditCardCycleCacheForAccountIds(accountIds).catch(() => undefined);
    revalidateAfterInvestChange();

    return NextResponse.json({
      ok: true,
      createdCount: created.filter((row) => !row.skipped).length,
      skippedCount: created.filter((row) => row.skipped).length,
      ids: created.flatMap((row) => row.id ? [row.id] : []),
      accountIds: Array.from(accountIds),
      items: enrichedItems,
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "IMPORT_FAILED", error: error instanceof Error ? error.message : "Stock import failed" },
      { status: 500, headers: corsHeaders() },
    );
  }
}
