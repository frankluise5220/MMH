import { NextResponse } from "next/server";
import { z } from "zod";
import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

type Db = typeof prisma;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

function getProvidedApiKey(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const key = req.headers.get("x-api-key");
  return key?.trim() || null;
}

function requireApiKey(req: Request) {
  const required = (process.env.STATEMENT_API_KEY ?? "").trim();
  if (!required) return { ok: true as const };
  const provided = getProvidedApiKey(req);
  if (!provided || provided !== required) return { ok: false as const };
  return { ok: true as const };
}

const ParsedItemSchema = z.object({
  rawText: z.string(),
  type: z.enum(["expense", "income", "transfer", "investment"]),
  date: z.string().optional(),
  amount: z.number().finite().min(0),
  account: z.string().optional(),
  fromAccount: z.string().optional(),
  toAccount: z.string().optional(),
  category: z.string().optional(),
  remark: z.string().optional(),
  counterparty: z.string().optional(),
  _meta: z.object({
    institutionName: z.string().optional(),
    cardNumberMasked: z.string().optional(),
    creditLimit: z.number().optional(),
    billingDay: z.number().int().min(1).max(31).optional(),
    repaymentDay: z.number().int().min(1).max(31).optional(),
  }).optional(),
});

type ParsedItem = z.infer<typeof ParsedItemSchema>;

function parseDate(date?: string) {
  if (!date) return new Date();
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return new Date();
  return d;
}

function addMonthsUtc(date: Date, months: number) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function toStatementMonth(date: Date, billingDay: number) {
  const day = date.getUTCDate();
  const monthBase = day <= billingDay ? date : addMonthsUtc(date, 1);
  const y = monthBase.getUTCFullYear();
  const m = String(monthBase.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

async function statementMonthForAccountId(tx: Db, accountId: string | null, date: Date) {
  if (!accountId) return null;
  const acc = await tx.account.findUnique({ where: { id: accountId }, select: { kind: true, billingDay: true } });
  if (!acc) return null;
  if (acc.kind !== AccountKind.bank_credit && acc.kind !== AccountKind.loan) return null;
  if (!acc.billingDay) return null;
  return toStatementMonth(date, acc.billingDay);
}

function normalizeAccountCell(value?: string) {
  const v = (value ?? "").trim();
  if (!v) return "";
  if (v === "无" || v === "-" || v.toLowerCase() === "none") return "";
  if (v === "未识别账户") return "";
  return v;
}

function pickAccountName(value?: string, defaultAccountName?: string) {
  const normalized = normalizeAccountCell(value);
  if (normalized) return normalized;
  const fallback = normalizeAccountCell(defaultAccountName);
  return fallback;
}

async function resolveAccountId(tx: Db, householdId: string, accountName?: string) {
  if (!accountName) return null;
  const found = await tx.account.findFirst({ where: { householdId, name: accountName } });
  return found?.id ?? null;
}

async function ensureDefaultAccountGroupId(tx: Db, householdId: string) {
  const existing = await tx.accountGroup.findFirst({ where: { householdId, name: "未指定" } });
  if (existing?.id) return existing.id;
  const legacy = await tx.accountGroup.findFirst({ where: { householdId, name: "默认" } });
  if (legacy?.id) {
    try {
      await tx.accountGroup.update({ where: { id: legacy.id }, data: { name: "未指定" } });
    } catch {}
    return legacy.id;
  }
  try {
    const created = await tx.accountGroup.create({
      data: {
        name: "未指定",
        sortOrder: 0,
        householdId,
      },
    });
    return created.id;
  } catch {
    const retry = await tx.accountGroup.findFirst({ where: { householdId, name: "未指定" } });
    return retry?.id ?? null;
  }
}

async function ensureAccountId(tx: Db, householdId: string, accountName?: string, _meta?: { institutionName?: string; cardNumberMasked?: string; creditLimit?: number; billingDay?: number; repaymentDay?: number; }) {
  const name = normalizeAccountCell(accountName);
  if (!name) return null;
  const existingId = await resolveAccountId(tx, householdId, name);
  if (existingId) return existingId;

  const groupId = await ensureDefaultAccountGroupId(tx, householdId);
  if (!groupId) return null;

  const isCreditCard = !!_meta?.institutionName;
  const accountData: {
    name: string;
    householdId: string;
    groupId: string;
    kind?: "bank_credit";
    institutionId?: string | null;
    numberMasked?: string | null;
    creditLimit?: number | null;
    billingDay?: number | null;
    repaymentDay?: number | null;
  } = { name, householdId, groupId };

  if (isCreditCard) {
    accountData.kind = "bank_credit";
    accountData.institutionId = null;
    accountData.numberMasked = _meta.cardNumberMasked ?? null;
    accountData.creditLimit = _meta.creditLimit ?? null;
    accountData.billingDay = _meta.billingDay ?? null;
    accountData.repaymentDay = _meta.repaymentDay ?? null;
  }

  try {
    const created = await tx.account.create({ data: accountData });
    return created.id;
  } catch {
    return (await resolveAccountId(tx, householdId, name)) ?? null;
  }
}

async function resolveCategoryId(tx: Db, householdId: string, categoryName?: string) {
  if (!categoryName) return null;
  const found = await tx.category.findFirst({ where: { householdId, name: categoryName } });
  return found?.id ?? null;
}

async function createTransactionFromItem(tx: Db, householdId: string, item: ParsedItem, defaultAccountName?: string) {
  const date = parseDate(item.date);
  const meta = item._meta;

  if (item.type === "transfer") {
    const from = normalizeAccountCell(item.fromAccount);
    const to = normalizeAccountCell(item.toAccount);
    if (!from || !to) {
      throw new Error("转账缺少转出/转入账户");
    }
  }

  const shouldUseDoubleEntry =
    item.type === "transfer" ||
    (item.type === "investment" && !!item.fromAccount && !!item.toAccount);

  const amountAbs = Number.isFinite(item.amount) ? Math.abs(item.amount) : 0;

  if (shouldUseDoubleEntry) {
    const fromAccountName = normalizeAccountCell(item.fromAccount);
    const toAccountName = normalizeAccountCell(item.toAccount);

    const [fromAccountId, toAccountId] = await Promise.all([
      ensureAccountId(tx, householdId, fromAccountName),
      ensureAccountId(tx, householdId, toAccountName),
    ]);

    const fromStatementMonth = await statementMonthForAccountId(tx, fromAccountId, date);

    // For investment type, query account kinds to determine fund fields
    let fundCode: string | null = null;
    let fundSubtype: string | null = null;
    let investAccId: string | null = null;
    let investAccName: string | null = null;

    if (item.type === "investment") {
      const rawText = item.rawText ?? "";
      const fundCodeMatch = rawText.match(/\b(\d{6})\b/);
      fundCode = fundCodeMatch ? fundCodeMatch[1] : null;
      const fromAccKind: any = await tx.account.findUnique({ where: { id: fromAccountId! } });
      const toAccKind: any = await tx.account.findUnique({ where: { id: toAccountId! } });
      const isFromInvest = fromAccKind?.kind === "investment";
      const isToInvest = toAccKind?.kind === "investment";
      investAccId = isToInvest ? toAccountId : isFromInvest ? fromAccountId : null;
      investAccName = isToInvest ? toAccountName : isFromInvest ? fromAccountName : null;
      const isRedeem = /赎回|卖出/.test(rawText);
      fundSubtype = isRedeem ? "redeem" : "buy";
    }

    const displayFundCode = investAccId && investAccName ? (fundCode || investAccName) : null;
    const txRecord = await tx.txRecord.create({
      data: {
        type: item.type as any,
        date,
        amount: -amountAbs,
        accountId: fromAccountId ?? undefined,
        accountName: fromAccountName || "未识别账户",
        toAccountId: investAccId || toAccountId || undefined,
        toAccountName: investAccName || toAccountName || "未识别账户",
        householdId,
        note: item.remark ?? item.rawText,
        statementMonth: fromStatementMonth ?? undefined,
        // Include fund fields in create if investment account identified
        ...(displayFundCode && item.type === "investment" ? {
          fundCode: displayFundCode,
          fundProductType: "fund",
          fundSubtype: fundSubtype as any,
        } : {}),
      } as any,
    });

    return txRecord;
  }

  const accountName = pickAccountName(item.account, defaultAccountName);
  const [accountId, categoryId] = await Promise.all([
    ensureAccountId(tx, householdId, accountName, meta),
    resolveCategoryId(tx, householdId, item.category),
  ]);
  const statementMonth = await statementMonthForAccountId(tx, accountId, date);

  const sign = item.type === "income" ? 1 : -1;
  const amount = sign * amountAbs;

  // For investment type, query account kind to determine fund fields
  let fundCode: string | null = null;
  let fundSubtype: string | null = null;
  let isInvestAccount = false;
  let investAccountName: string | null = null;

  if (item.type === "investment" && accountId) {
    const rawText = item.rawText ?? "";
    const fundCodeMatch = rawText.match(/\b(\d{6})\b/);
    fundCode = fundCodeMatch ? fundCodeMatch[1] : null;
    const acc = await tx.account.findUnique({ where: { id: accountId }, select: { kind: true, name: true } });
    isInvestAccount = acc?.kind === "investment";
    investAccountName = acc?.name ?? null;
    const isRedeem = /赎回|卖出/.test(rawText);
    fundSubtype = isRedeem ? "redeem" : "buy";
  }

  const displayFundCode = isInvestAccount && investAccountName ? (fundCode || investAccountName) : null;
  const txRecord = await tx.txRecord.create({
    data: {
      type: item.type as any,
      date,
      amount,
      accountId: accountId ?? "",
      accountName: accountName || "未识别账户",
      categoryId,
      categoryName: item.category ?? null,
      toAccountId: isInvestAccount ? accountId : null,
      toAccountName: isInvestAccount ? investAccountName : null,
      householdId,
      note: item.remark ?? item.rawText,
      statementMonth,
      // Include fund fields in create if investment account
      ...(displayFundCode ? {
        fundCode: displayFundCode,
        fundProductType: "fund",
        fundSubtype: fundSubtype as any,
      } : {}),
    },
  });

  return txRecord;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: Request) {
  if (!requireApiKey(req).ok) {
    return NextResponse.json(
      { ok: false, error: "未授权" },
      { status: 401, headers: corsHeaders() },
    );
  }

  const body = (await req.json().catch(() => null)) as null | {
    items?: unknown;
    defaultAccountName?: unknown;
  };

  const parse = z
    .object({
      items: z.array(ParsedItemSchema).min(1),
      defaultAccountName: z.string().optional(),
    })
    .safeParse(body);
  if (!parse.success) {
    return NextResponse.json(
      { ok: false, error: "items 格式不正确" },
      { status: 400, headers: corsHeaders() },
    );
  }

  const items = parse.data.items;
  const defaultAccountName = parse.data.defaultAccountName;
  const { householdId } = await getHouseholdScope();

  const created: { id: string }[] = [];
  const errors: Array<{ index: number; rawText: string; error: string }> = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const createdRecord = await createTransactionFromItem(prisma, householdId, item, defaultAccountName);
      created.push({ id: createdRecord.id });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "导入失败";
      errors.push({ index: i, rawText: item.rawText, error: msg });
    }
  }

  revalidateAfterTxChange();
  return NextResponse.json({
    ok: true,
    createdCount: created.length,
    skippedCount: errors.length,
    ids: created.map((t) => t.id),
    errors,
  }, { headers: corsHeaders() });
}
