import { NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { defaultModel, localProvider } from "@/lib/ai/config";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";

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
  amount: z.number(),
  account: z.string().optional(),
  fromAccount: z.string().optional(),
  toAccount: z.string().optional(),
  category: z.string().optional(),
  remark: z.string().optional(),
  counterparty: z.string().optional(),
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

async function resolveAccountId(tx: Db, accountName?: string) {
  if (!accountName) return null;
  const found = await tx.account.findFirst({ where: { name: accountName } });
  return found?.id ?? null;
}

async function ensureDefaultAccountGroupId(tx: Db) {
  const existing = await tx.accountGroup.findFirst({ where: { name: "未指定" } });
  if (existing?.id) return existing.id;
  const legacy = await tx.accountGroup.findFirst({ where: { name: "默认" } });
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
      },
    });
    return created.id;
  } catch {
    const retry = await tx.accountGroup.findFirst({ where: { name: "未指定" } });
    return retry?.id ?? null;
  }
}

async function ensureAccountId(tx: Db, accountName?: string) {
  const name = normalizeAccountCell(accountName);
  if (!name) return null;
  const existingId = await resolveAccountId(tx, name);
  if (existingId) return existingId;
  const groupId = await ensureDefaultAccountGroupId(tx);
  if (!groupId) return null;
  try {
    const created = await tx.account.create({
      data: {
        name,
        groupId,
      },
    });
    return created.id;
  } catch {
    return (await resolveAccountId(tx, name)) ?? null;
  }
}

async function resolveCategoryId(tx: Db, categoryName?: string) {
  if (!categoryName) return null;
  const found = await tx.category.findFirst({ where: { name: categoryName } });
  return found?.id ?? null;
}

async function createTransactionFromItem(tx: Db, item: ParsedItem, defaultAccountName?: string) {
  const date = parseDate(item.date);

  const shouldUseDoubleEntry =
    item.type === "transfer" ||
    (item.type === "investment" && !!item.fromAccount && !!item.toAccount);

  if (shouldUseDoubleEntry) {
    const fromAccountName = normalizeAccountCell(item.fromAccount);
    const toAccountName = normalizeAccountCell(item.toAccount);

    const [fromAccountId, toAccountId] = await Promise.all([
      ensureAccountId(tx, fromAccountName),
      ensureAccountId(tx, toAccountName),
    ]);

    const fromStatementMonth = await statementMonthForAccountId(tx, fromAccountId, date);

    const amountAbs = Math.abs(item.amount);

    // For investment transactions, detect fund fields
    let fundCode: string | null = null;
    let fundSubtype: string | null = null;

    if (item.type === "investment") {
      const rawText = item.remark ?? item.rawText ?? "";
      const fundCodeMatch = rawText.match(/\b(\d{6})\b/);
      fundCode = fundCodeMatch ? fundCodeMatch[1] : null;
      const isRedeem = /赎回|卖出/.test(rawText);
      fundSubtype = isRedeem ? "redeem" : "buy";
    }

    const transaction = await tx.txRecord.create({
      data: {
        type: item.type as any,
        date,
        amount: -amountAbs,
        accountId: fromAccountId ?? "",
        accountName: fromAccountName || "未识别账户",
        toAccountId,
        toAccountName: toAccountName || "未识别账户",
        note: item.remark ?? item.rawText,
        statementMonth: fromStatementMonth,
        // Add fund fields for investment type
        ...(item.type === "investment" && fundCode ? {
          fundCode,
          fundProductType: "fund",
          fundSubtype: fundSubtype as any,
        } : {}),
      },
    });

    return transaction;
  }

  const accountName = pickAccountName(item.account, defaultAccountName);
  const [accountId, categoryId] = await Promise.all([
    ensureAccountId(tx, accountName),
    resolveCategoryId(tx, item.category),
  ]);
  const statementMonth = await statementMonthForAccountId(tx, accountId, date);

  const sign = item.type === "income" ? 1 : -1;
  const amount = sign * Math.abs(item.amount);

  // For investment transactions, detect fund fields
  let fundCode: string | null = null;
  let fundSubtype: string | null = null;

  if (item.type === "investment") {
    const rawText = item.remark ?? item.rawText ?? "";
    const fundCodeMatch = rawText.match(/\b(\d{6})\b/);
    fundCode = fundCodeMatch ? fundCodeMatch[1] : null;
    const isRedeem = /赎回|卖出/.test(rawText);
    fundSubtype = isRedeem ? "redeem" : "buy";
  }

  const transaction = await tx.txRecord.create({
    data: {
      type: item.type as any,
      date,
      amount,
      accountId: accountId ?? "",
      accountName: accountName || "未识别账户",
      categoryId,
      categoryName: item.category ?? null,
      note: item.remark ?? item.rawText,
      statementMonth,
      // Add fund fields for investment type
      ...(item.type === "investment" && fundCode ? {
        fundCode,
        fundProductType: "fund",
        fundSubtype: fundSubtype as any,
      } : {}),
    },
  });

  return transaction;
}

function fallbackParse(text: string): ParsedItem[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((rawText) => {
    const dateMatch = rawText.match(/\b(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/);
    const date = dateMatch
      ? `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`
      : undefined;

    const nums = rawText.match(/(\d+(?:\.\d+)?)/g) ?? [];
    const amount = nums.length ? Number(nums[nums.length - 1]) : 0;

    const isTransfer = /转账|转入|转出|转给|转到|转\s*给|转\s*到|从.*到|从.*给/.test(rawText);
    if (isTransfer) {
      const fromMatch = rawText.match(/从([^，,\s]+?)(?:转|到|给)/);
      const toMatch = rawText.match(/(?:到|给)([^，,\s]+)$/);
      return {
        rawText,
        type: "transfer",
        date,
        amount,
        fromAccount: fromMatch?.[1],
        toAccount: toMatch?.[1],
        remark: rawText,
      };
    }

    const isIncome = /收入|工资|报销|退款|返现|返利/.test(rawText);
    return {
      rawText,
      type: isIncome ? "income" : "expense",
      date,
      amount,
      remark: rawText,
    };
  });
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
    text?: string;
    import?: boolean;
    defaultAccountName?: string;
  };

  const text = (body?.text ?? "").trim();
  const shouldImport = body?.import !== false;
  const defaultAccountName = body?.defaultAccountName;

  if (!text) {
    return NextResponse.json(
      { ok: false, error: "缺少 text" },
      { status: 400, headers: corsHeaders() },
    );
  }

  const model = localProvider(defaultModel);

  const system = [
    "你是家庭记账助手，负责把一段账单文本解析为结构化数据。",
    "输入可能是一整期账单的多行文本，每行可能是一条记录，也可能是一条记录的片段。",
    "输出必须严格符合给定的 JSON Schema。",
    "amount 始终为正数（绝对值）。",
    "type=transfer 时，必须给出 fromAccount 和 toAccount（尽量从文本推断）。",
    "type=investment 时，如果能识别资金从哪个账户流出、流入到哪个投资账户，尽量给出 fromAccount 和 toAccount。",
    "type=expense|income 时，尽量给出 account。",
    "date 尽量输出 YYYY-MM-DD；如果文本没有日期，可以省略。",
    "rawText 必须保留原始行文本。",
  ].join("\n");

  let items: ParsedItem[];
  let trace: string[] = [];

  try {
    const { object } = await generateObject({
      model,
      schema: z.object({ items: z.array(ParsedItemSchema) }),
      system,
      prompt: text,
    });
    items = object.items;
    trace = [
      `输入字符数：${text.length}`,
      `解析条数：${items.length}`,
      `模型：${defaultModel}`,
    ];
  } catch {
    items = fallbackParse(text);
    trace = [
      `输入字符数：${text.length}`,
      `解析条数：${items.length}`,
      "模型调用失败，已使用规则解析",
    ];
  }

  if (!shouldImport) {
    return NextResponse.json(
      { ok: true, items, imported: false, trace },
      { headers: corsHeaders() },
    );
  }

  try {
    const created: Awaited<ReturnType<typeof createTransactionFromItem>>[] = [];
    for (const item of items) {
      created.push(await createTransactionFromItem(prisma, item, defaultAccountName));
    }

    revalidateAfterTxChange();
    return NextResponse.json(
      {
        ok: true,
        items,
        imported: true,
        createdCount: created.length,
        ids: created.map((t) => t.id),
        message: `已导入 ${created.length} 条记录`,
        trace,
      },
      { headers: corsHeaders() },
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : "导入失败";
    return NextResponse.json(
      { ok: false, error },
      { status: 500, headers: corsHeaders() },
    );
  }
}
