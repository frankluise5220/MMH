import { NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { AccountKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { defaultModel, localProvider } from "@/lib/ai/config";
import { formatAccountDisplayName, formatDisplayInstitutionName } from "@/lib/account-display";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";

export const runtime = "nodejs";

type Db = typeof prisma | Prisma.TransactionClient;
type AccountLookupRow = {
  id: string;
  name: string;
  kind: AccountKind;
  billingDay: number | null;
  Institution: { name: string | null; shortName?: string | null } | null;
};
type ImportContext = {
  householdId: string;
  accountIdByMatchKey: Map<string, string>;
  accountMetaById: Map<string, { kind: AccountKind; billingDay: number | null }>;
  categoryIdByName: Map<string, string>;
  tagIdByName: Map<string, string>;
  defaultAccountGroupId: string | null;
};

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

async function isInternalImportRequest(req: Request) {
  if (req.headers.get("x-internal-import") !== "batch-import") return false;
  await getHouseholdScope();
  return true;
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
  tags: z.string().optional(),
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

function normalizeAccountMatchKey(value?: string) {
  return String(value ?? "")
    .trim()
    .replace(/[·•\-—\s]/g, "")
    .toLowerCase();
}

function buildAccountMatchCandidates(account: {
  name: string;
  Institution?: { name: string | null; shortName?: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
}) {
  const fullInstitutionName = formatDisplayInstitutionName(account.Institution, false);
  const shortInstitutionName = formatDisplayInstitutionName(account.Institution, true);
  const candidates = new Set<string>([
    account.name,
    formatAccountDisplayName(account.name, fullInstitutionName),
    formatAccountDisplayName(account.name, shortInstitutionName),
  ]);
  // Also add variants without separator
  if (fullInstitutionName) candidates.add(`${fullInstitutionName}${account.name}`);
  if (shortInstitutionName) candidates.add(`${shortInstitutionName}${account.name}`);
  // Add aliases
  if (account.AccountAlias) {
    for (const al of account.AccountAlias) {
      candidates.add(al.alias);
    }
  }
  return Array.from(candidates);
}

function indexAccountLookup(
  map: Map<string, string>,
  account: { id: string; name: string; Institution?: { name: string | null; shortName?: string | null } | null; AccountAlias?: Array<{ alias: string }> | null },
) {
  for (const candidate of buildAccountMatchCandidates(account)) {
    const key = normalizeAccountMatchKey(candidate);
    if (key) map.set(key, account.id);
  }
}

async function resolveAccountId(ctx: ImportContext, tx: Db, accountName?: string) {
  if (!accountName) return null;
  const normalizedTarget = normalizeAccountMatchKey(accountName);
  if (!normalizedTarget) return null;
  const cached = ctx.accountIdByMatchKey.get(normalizedTarget);
  if (cached) return cached;

  // Load all accounts with aliases for matching
  const accounts = await tx.account.findMany({
    where: { householdId: ctx.householdId },
    select: {
      id: true,
      name: true,
      kind: true,
      billingDay: true,
      Institution: {
        select: {
          name: true,
          shortName: true,
        },
      },
      AccountAlias: { select: { alias: true } },
    },
  });

  // Index all accounts
  for (const account of accounts) {
    indexAccountLookup(ctx.accountIdByMatchKey, account);
    ctx.accountMetaById.set(account.id, { kind: account.kind, billingDay: account.billingDay });
  }

  // Exact match
  const exact = ctx.accountIdByMatchKey.get(normalizedTarget);
  if (exact) return exact;

  // Partial match: target contains account key or vice versa
  for (const account of accounts) {
    for (const candidate of buildAccountMatchCandidates(account)) {
      const key = normalizeAccountMatchKey(candidate);
      if (!key) continue;
      if (key.length >= 3 && (normalizedTarget.includes(key) || key.includes(normalizedTarget))) {
        ctx.accountIdByMatchKey.set(normalizedTarget, account.id);
        return account.id;
      }
    }
  }

  return null;
}

async function ensureDefaultAccountGroupId(ctx: ImportContext, tx: Db) {
  if (ctx.defaultAccountGroupId) return ctx.defaultAccountGroupId;
  const existing = await tx.accountGroup.findFirst({ where: { name: "未指定", householdId: ctx.householdId } });
  if (existing?.id) return existing.id;
  const legacy = await tx.accountGroup.findFirst({ where: { name: "默认", householdId: ctx.householdId } });
  if (legacy?.id) {
    try {
      await tx.accountGroup.update({ where: { id: legacy.id }, data: { name: "未指定" } });
    } catch {}
    ctx.defaultAccountGroupId = legacy.id;
    return legacy.id;
  }
  try {
    const created = await tx.accountGroup.create({
      data: {
        name: "未指定",
        sortOrder: 0,
        householdId: ctx.householdId,
      },
    });
    ctx.defaultAccountGroupId = created.id;
    return created.id;
  } catch {
    const retry = await tx.accountGroup.findFirst({ where: { name: "未指定", householdId: ctx.householdId } });
    ctx.defaultAccountGroupId = retry?.id ?? null;
    return retry?.id ?? null;
  }
}

async function ensureAccountId(ctx: ImportContext, tx: Db, accountName?: string) {
  const name = normalizeAccountCell(accountName);
  if (!name) return null;
  const existingId = await resolveAccountId(ctx, tx, name);
  if (existingId) return existingId;
  const groupId = await ensureDefaultAccountGroupId(ctx, tx);
  if (!groupId) return null;
  try {
    const created = await tx.account.create({
      data: {
        name,
        groupId,
        householdId: ctx.householdId,
        currency: "CNY",
        kind: AccountKind.other,
        isActive: true,
      },
    });
    indexAccountLookup(ctx.accountIdByMatchKey, { id: created.id, name: created.name, Institution: null });
    ctx.accountMetaById.set(created.id, { kind: created.kind, billingDay: created.billingDay });
    return created.id;
  } catch {
    return (await resolveAccountId(ctx, tx, name)) ?? null;
  }
}

function resolveCategoryId(ctx: ImportContext, categoryName?: string) {
  if (!categoryName) return null;
  return ctx.categoryIdByName.get(categoryName.trim()) ?? null;
}

function parseTagNames(tags?: string) {
  return Array.from(
    new Set(
      String(tags ?? "")
        .split(/[，,、；;]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function resolveTagIds(ctx: ImportContext, tags?: string) {
  const names = parseTagNames(tags);
  if (names.length === 0) return [];
  return names.map((name) => ctx.tagIdByName.get(name)).filter((id): id is string => Boolean(id));
}

async function attachTags(ctx: ImportContext, tx: Db, entryId: string, tags?: string) {
  const tagIds = resolveTagIds(ctx, tags);
  if (tagIds.length === 0) return;
  await tx.entryTag.createMany({
    data: tagIds.map((tagId) => ({ entryId, tagId })),
    skipDuplicates: true,
  });
}

function statementMonthForAccountMeta(ctx: ImportContext, accountId: string | null, date: Date) {
  if (!accountId) return null;
  const meta = ctx.accountMetaById.get(accountId);
  if (!meta) return null;
  if (meta.kind !== AccountKind.bank_credit && meta.kind !== AccountKind.loan) return null;
  if (!meta.billingDay) return null;
  return toStatementMonth(date, meta.billingDay);
}

async function buildImportContext(): Promise<ImportContext> {
  const { householdId } = await getHouseholdScope();
  const [accounts, categories, tags, defaultGroup] = await Promise.all([
    prisma.account.findMany({
      where: { householdId },
      select: {
        id: true,
        name: true,
        kind: true,
        billingDay: true,
        Institution: {
          select: {
            name: true,
            shortName: true,
          },
        },
      },
    }),
    prisma.category.findMany({
      where: {
        OR: [{ householdId }, { householdId: null }],
      },
      select: { id: true, name: true },
      orderBy: [{ householdId: "desc" }, { id: "asc" }],
    }),
    prisma.tag.findMany({
      where: { householdId },
      select: { id: true, name: true },
    }),
    prisma.accountGroup.findFirst({
      where: { householdId, name: "未指定" },
      select: { id: true },
    }),
  ]);

  const ctx: ImportContext = {
    householdId,
    accountIdByMatchKey: new Map(),
    accountMetaById: new Map(),
    categoryIdByName: new Map(),
    tagIdByName: new Map(),
    defaultAccountGroupId: defaultGroup?.id ?? null,
  };

  for (const account of accounts) {
    indexAccountLookup(ctx.accountIdByMatchKey, account);
    ctx.accountMetaById.set(account.id, { kind: account.kind, billingDay: account.billingDay });
  }
  for (const category of categories) {
    if (!ctx.categoryIdByName.has(category.name)) ctx.categoryIdByName.set(category.name, category.id);
  }
  for (const tag of tags) {
    ctx.tagIdByName.set(tag.name, tag.id);
  }

  return ctx;
}

async function createTransactionFromItem(ctx: ImportContext, tx: Db, item: ParsedItem, defaultAccountName?: string) {
  const date = parseDate(item.date);

  const shouldUseDoubleEntry =
    item.type === "transfer" ||
    (item.type === "investment" && !!item.fromAccount && !!item.toAccount);

  if (shouldUseDoubleEntry) {
    const fromAccountName = normalizeAccountCell(item.fromAccount);
    const toAccountName = normalizeAccountCell(item.toAccount);

    const [fromAccountId, toAccountId] = await Promise.all([
      ensureAccountId(ctx, tx, fromAccountName),
      ensureAccountId(ctx, tx, toAccountName),
    ]);

    const sourceAccountId = fromAccountId ?? (toAccountId ? await ensureAccountId(ctx, tx, "未指定账户") : null);
    const sourceAccountName = fromAccountName || (toAccountId ? "未指定账户" : "未识别账户");
    const fromStatementMonth = statementMonthForAccountMeta(ctx, sourceAccountId, date);

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
        accountId: sourceAccountId ?? toAccountId ?? "",
        accountName: sourceAccountName,
        toAccountId,
        toAccountName: toAccountName || null,
        note: item.remark ?? item.rawText,
        statementMonth: fromStatementMonth,
        householdId: ctx.householdId,
        // Add fund fields for investment type
        ...(item.type === "investment" && fundCode ? {
          fundCode,
          fundProductType: "fund",
          fundSubtype: fundSubtype as any,
        } : {}),
      },
    });

    await attachTags(ctx, tx, transaction.id, item.tags);

    return transaction;
  }

  const accountName = pickAccountName(item.account, defaultAccountName);
  const [accountId, categoryId] = await Promise.all([
    ensureAccountId(ctx, tx, accountName),
    Promise.resolve(resolveCategoryId(ctx, item.category)),
  ]);
  const statementMonth = statementMonthForAccountMeta(ctx, accountId, date);

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
      accountId: accountId ?? (await ensureAccountId(ctx, tx, "未指定账户")) ?? "",
      accountName: accountName || "未识别账户",
      categoryId,
      categoryName: item.category ?? null,
      note: item.remark ?? item.rawText,
      statementMonth,
      householdId: ctx.householdId,
      // Add fund fields for investment type
      ...(item.type === "investment" && fundCode ? {
        fundCode,
        fundProductType: "fund",
        fundSubtype: fundSubtype as any,
      } : {}),
    },
  });

  await attachTags(ctx, tx, transaction.id, item.tags);

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
      const toMatch = rawText.match(/(?:到|给)([^，,\s]+?)(?=\s+\d|[，,\s]|$)/);
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
  const internalImport = await isInternalImportRequest(req).catch(() => false);
  if (!internalImport && !requireApiKey(req).ok) {
    return NextResponse.json(
      { ok: false, error: "未授权" },
      { status: 401, headers: corsHeaders() },
    );
  }

  const body = (await req.json().catch(() => null)) as null | {
    text?: string;
    items?: unknown;
    import?: boolean;
    defaultAccountName?: string;
  };

  const text = (body?.text ?? "").trim();
  const shouldImport = body?.import !== false;
  const defaultAccountName = body?.defaultAccountName;
  const bodyItems = Array.isArray(body?.items)
    ? z.array(ParsedItemSchema).safeParse(body.items)
    : null;

  if (!text && !bodyItems?.success) {
    return NextResponse.json(
      { ok: false, error: "缺少 text 或 items" },
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

  if (bodyItems?.success) {
    items = bodyItems.data;
    trace = [
      "使用客户端预览数据导入",
      `解析条数：${items.length}`,
    ];
  } else {
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
  }

  if (!shouldImport) {
    return NextResponse.json(
      { ok: true, items, imported: false, trace },
      { headers: corsHeaders() },
    );
  }

  try {
    const ctx = await buildImportContext();
    const created = await prisma.$transaction(async (tx) => {
      const rows: Awaited<ReturnType<typeof createTransactionFromItem>>[] = [];
      for (const item of items) {
        rows.push(await createTransactionFromItem(ctx, tx, item, defaultAccountName));
      }
      return rows;
    }, {
      maxWait: 10_000,
      timeout: 60_000,
    });

    const accountIdsToRecalc = new Set<string>();
    for (const row of created) {
      if (row.accountId) accountIdsToRecalc.add(row.accountId);
      if (row.toAccountId) accountIdsToRecalc.add(row.toAccountId);
    }
    for (const accountId of accountIdsToRecalc) {
      await recalcAndSaveAccountBalance(accountId);
    }

    // Client-side handles page refresh
    return NextResponse.json(
      {
        ok: true,
        items,
        imported: true,
        createdCount: created.length,
        ids: created.map((t) => t.id),
        recalculatedAccountCount: accountIdsToRecalc.size,
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
