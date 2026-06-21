/**
 * API: /api/v1/transactions/detail
 *
 * 交易详情的增删改查接口
 *
 * GET    ?accountId=&page=&pageSize=  查询交易列表（已有）
 * POST   JSON body                    创建交易
 * PUT    JSON body { id, ... }         更新交易
 * DELETE ?id=xxx 或 POST { id }         删除交易（软删除）
 *
 * 接受的实体类型: TxRecord.id
 *
 * 认证方式（混合）：
 * - cookie session（浏览器用户）
 * - X-Api-Key header（Android 客户端，用密码验证）
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { AccountKind, TransactionType, FundSubtype } from "@prisma/client";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getFundConfirmDays, getFundArrivalDays, setFundConfirmDaysInTx } from "@/lib/fund/confirmDays";
import { setFundFeeRateByDateInTx } from "@/lib/fund/feeRate";
import { toNumber, addWorkdaysUtc, toStatementMonth } from "@/lib/date-utils";
import { logger } from "@/lib/logger";
import { compareDetailEntriesAsc, compareDetailEntriesDesc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";

export const runtime = "nodejs";

/* ────────────────── HELPERS ────────────────── */

function parseMoney(val: unknown): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = parseFloat(val);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toDateOrNull(val: unknown): Date | null {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mapEntryTags(entry: { EntryTag: Array<{ tagId: string; Tag: { name: string; color: string | null } | null }> }) {
  return entry.EntryTag.map((et) => ({
    tagId: et.tagId,
    Tag: et.Tag ? { name: et.Tag.name, color: et.Tag.color } : null,
  }));
}

function effectiveAmountForAccount(
  entry: { amount: unknown; accountId: string | null; toAccountId: string | null },
  accountId: string,
) {
  const amount = toNumber(entry.amount);
  return entry.toAccountId === accountId ? Math.abs(amount) : amount;
}

/* ────────────────── GET ────────────────── */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const accountId = (url.searchParams.get("accountId") ?? "").trim();
  const entryId = (url.searchParams.get("id") ?? "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "20", 10) || 20), 200);

  try {
    const { hidFilter } = await getHouseholdScope();

    // Single record lookup by ID
    if (entryId) {
      const record = await prisma.txRecord.findUnique({
        where: { id: entryId },
        include: {
          EntryTag: { include: { Tag: true } },
          account: { include: { Institution: { select: { name: true } } } },
          toAccount: { include: { Institution: { select: { name: true } } } },
        },
      });
      if (!record || record.deletedAt || record.householdId !== hidFilter.householdId) {
        return NextResponse.json({ ok: false, error: "记录不存在" }, { status: 404 });
      }
      const entry = {
        id: record.id,
        date: record.date.toISOString().slice(0, 10),
        amount: toNumber(record.amount),
        type: record.type,
        categoryId: record.categoryId,
        categoryName: record.categoryName,
        accountId: record.accountId,
        accountName: record.accountName,
        accountInstitutionName: record.account?.Institution?.name ?? "",
        toAccountId: record.toAccountId,
        toAccountName: record.toAccountName,
        toAccountInstitutionName: record.toAccount?.Institution?.name ?? "",
        note: record.note,
        fundSubtype: record.fundSubtype,
        fundCode: record.fundCode,
        fundName: record.fundName,
        fundProductType: record.fundProductType,
        fundNav: record.fundNav ? toNumber(record.fundNav) : null,
        fundUnits: record.fundUnits ? toNumber(record.fundUnits) : null,
        fundFee: record.fundFee ? toNumber(record.fundFee) : null,
        fundConfirmDate: record.fundConfirmDate?.toISOString().slice(0, 10) ?? null,
        fundArrivalDate: record.fundArrivalDate?.toISOString().slice(0, 10) ?? null,
        fundArrivalAmount: record.fundArrivalAmount ? toNumber(record.fundArrivalAmount) : null,
        source: record.source,
        entryTags: mapEntryTags(record),
      };
      return NextResponse.json({ ok: true, data: entry });
    }

    if (!accountId) {
      return NextResponse.json({ ok: false, error: "缺少 accountId" }, { status: 400 });
    }

    const [account, totalCount, allEntries] = await Promise.all([
      prisma.account.findUnique({ where: { id: accountId } }),
      prisma.txRecord.count({
        where: {
          OR: [{ accountId }, { toAccountId: accountId }],
          deletedAt: null,
          ...hidFilter,
        },
      }),
      prisma.txRecord.findMany({
        where: {
          OR: [{ accountId }, { toAccountId: accountId }],
          deletedAt: null,
          ...hidFilter,
        },
        include: {
          EntryTag: { include: { Tag: true } },
          account: { include: { Institution: { select: { name: true } } } },
          toAccount: { include: { Institution: { select: { name: true } } } },
        },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      }),
    ]);

    if (!account) {
      return NextResponse.json({ ok: false, error: "账户不存在" }, { status: 404 });
    }

    const orderedEntries = [...allEntries].sort((a, b) => compareDetailEntriesDesc(a, b, accountId));
    const ascEntries = [...orderedEntries].sort((a, b) => compareDetailEntriesAsc(a, b, accountId));
    const runningBalanceById = new Map<string, number>();
    let runningBalance = 0;
    for (const entry of ascEntries) {
      runningBalance += effectiveAmountForAccount(entry, accountId);
      runningBalanceById.set(entry.id, runningBalance);
    }

    const pagedEntries = orderedEntries.slice((page - 1) * pageSize, page * pageSize);
    const entries = pagedEntries.map((e) => ({
      id: e.id,
      date: getDetailEntryDisplayDate(e, accountId).toISOString().slice(0, 10),
      createdAt: e.createdAt?.toISOString?.() ?? null,
      amount: toNumber(e.amount),
      runningBalance: runningBalanceById.get(e.id) ?? null,
      type: e.type,
      categoryId: e.categoryId,
      categoryName: e.categoryName,
      accountId: e.accountId,
      accountName: e.accountName,
      accountInstitutionName: e.account?.Institution?.name ?? "",
      toAccountId: e.toAccountId,
      toAccountName: e.toAccountName,
      toAccountInstitutionName: e.toAccount?.Institution?.name ?? "",
      note: e.note,
      fundSubtype: e.fundSubtype,
      fundCode: e.fundCode,
      fundName: e.fundName,
      fundProductType: e.fundProductType,
      fundNav: e.fundNav ? toNumber(e.fundNav) : null,
      fundUnits: e.fundUnits ? toNumber(e.fundUnits) : null,
      fundFee: e.fundFee ? toNumber(e.fundFee) : null,
      fundConfirmDate: e.fundConfirmDate?.toISOString().slice(0, 10) ?? null,
      fundArrivalDate: e.fundArrivalDate?.toISOString().slice(0, 10) ?? null,
      fundArrivalAmount: e.fundArrivalAmount ? toNumber(e.fundArrivalAmount) : null,
      source: e.source,
      entryTags: mapEntryTags(e),
    }));

    return NextResponse.json({
      ok: true,
      data: {
        accountId: account.id,
        accountBalance: toNumber(account.balance),
        totalCount,
        page,
        pageSize,
        entries,
      },
    });
  } catch (err) {
    console.error("GET /api/v1/transactions/detail error:", err);
    return NextResponse.json({ ok: false, error: "服务器错误" }, { status: 500 });
  }
}

/* ────────────────── POST (CREATE) ────────────────── */

/**
 * POST /api/v1/transactions/detail
 * 创建交易记录
 *
 * Body (JSON):
 *   type: "expense" | "income" | "transfer" | "investment"
 *   date: string (YYYY-MM-DD)
 *   amount: number
 *   accountId: string
 *   categoryId?: string
 *   categoryName?: string
 *   toAccountId?: string (transfer)
 *   toAccountName?: string
 *   note?: string
 *   tagIds?: string[]
 *   --- investment fields ---
 *   fundCode?: string
 *   fundName?: string
 *   fundProductType?: "fund" | "money" | "wealth" | "deposit"
 *   fundSubtype?: "buy" | "redeem" | "dividend_reinvest" | "dividend_cash" | "regular_invest" | "switch_in" | "switch_out" | "buy_failed"
 *   fundNav?: number
 *   fundUnits?: number
 *   fundFee?: number
 *   fundConfirmDate?: string (YYYY-MM-DD)
 *   fundArrivalDate?: string (YYYY-MM-DD)
 *   fundArrivalAmount?: number
 *   cashAccountId?: string
 *   source?: string (default "manual")
 *
 * 返回: { ok: true, data: { id, ... } } | { ok: false, error }
 */
export async function POST(req: Request) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ ok: false, error: "无效的请求体" }, { status: 400 });
    }

    const type = String(body.type ?? "").trim();
    const dateStr = String(body.date ?? "").trim();
    const amountAbs = Math.abs(parseMoney(body.amount));
    const note = String(body.note ?? "").trim();
    const tagIdsRaw = body.tagIds;
    const tagIds: string[] = Array.isArray(tagIdsRaw)
      ? tagIdsRaw.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];

    const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
    const { householdId } = ctx;

    if (!amountAbs) {
      return NextResponse.json({ ok: false, error: "金额不正确" }, { status: 400 });
    }

    let createdId: string | undefined;

    if (type === "transfer") {
      const fromAccountId = String(body.fromAccountId ?? body.accountId ?? "").trim();
      const toAccountId = String(body.toAccountId ?? "").trim();
      if (!fromAccountId || !toAccountId) {
        return NextResponse.json({ ok: false, error: "转账需要选择转出/转入账户" }, { status: 400 });
      }
      if (fromAccountId === toAccountId) {
        return NextResponse.json({ ok: false, error: "转出/转入账户不能相同" }, { status: 400 });
      }

      await prisma.$transaction(async (tx) => {
        const [fromAcc, toAcc] = await Promise.all([
          tx.account.findUnique({ where: { id: fromAccountId }, include: { Institution: true } }),
          tx.account.findUnique({ where: { id: toAccountId }, include: { Institution: true } }),
        ]);
        if (!fromAcc || !toAcc) throw new Error("账户不存在");

        const toStatementMonthValue =
          (toAcc.kind === AccountKind.bank_credit || toAcc.kind === AccountKind.loan) && toAcc.billingDay
            ? toStatementMonth(date, toAcc.billingDay)
            : null;

        const created = await tx.txRecord.create({
          data: {
            accountId: fromAcc.id,
            accountName: fromAcc.name,
            toAccountId: toAcc.id,
            toAccountName: toAcc.name,
            amount: -amountAbs,
            type: TransactionType.transfer,
            date,
            note: note || null,
            statementMonth: toStatementMonthValue,
            householdId,
          },
        });
        createdId = created.id;

        if (tagIds.length > 0) {
          await tx.entryTag.createMany({ data: tagIds.map((tagId) => ({ entryId: created.id, tagId })) });
        }
      });

      await recalcAndSaveAccountBalance(fromAccountId).catch(logger.catchLog("操作失败", "route.ts"));
      await recalcAndSaveAccountBalance(toAccountId).catch(logger.catchLog("操作失败", "route.ts"));
    } else if (type === "expense") {
      const accountId = String(body.accountId ?? "").trim();
      const categoryId = String(body.categoryId ?? "").trim();
      if (!accountId) {
        return NextResponse.json({ ok: false, error: "请选择账户" }, { status: 400 });
      }

      await prisma.$transaction(async (tx) => {
        const [acc, cat] = await Promise.all([
          tx.account.findUnique({ where: { id: accountId }, include: { Institution: true } }),
          categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
        ]);
        if (!acc) throw new Error("账户不存在");
        if (acc.kind === AccountKind.investment) throw new Error("基金/理财账户不参与收支记账");

        const statementMonth =
          (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
            ? toStatementMonth(date, acc.billingDay)
            : null;

        const created = await tx.txRecord.create({
          data: {
            accountId: acc.id,
            accountName: acc.name,
            categoryId: cat?.id ?? null,
            categoryName: cat?.name ?? null,
            amount: -amountAbs,
            type: TransactionType.expense,
            date,
            note: note || null,
            statementMonth,
            householdId,
          },
        });
        createdId = created.id;

        if (tagIds.length > 0) {
          await tx.entryTag.createMany({ data: tagIds.map((tagId) => ({ entryId: created.id, tagId })) });
        }
      });

      await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("操作失败", "route.ts"));
    } else if (type === "income") {
      const accountId = String(body.accountId ?? "").trim();
      const categoryId = String(body.categoryId ?? "").trim();

      await prisma.$transaction(async (tx) => {
        const [acc, cat] = await Promise.all([
          accountId ? tx.account.findUnique({ where: { id: accountId }, include: { Institution: true } }) : Promise.resolve(null),
          categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
        ]);

        const statementMonth =
          acc && (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
            ? toStatementMonth(date, acc.billingDay)
            : null;

        const created = await tx.txRecord.create({
          data: {
            accountId: acc?.id ?? undefined,
            accountName: acc?.name ?? "未知账户",
            categoryId: cat?.id ?? undefined,
            categoryName: cat?.name ?? undefined,
            amount: amountAbs,
            type: TransactionType.income,
            date,
            note: note || undefined,
            statementMonth: statementMonth ?? undefined,
            householdId,
          } as any,
        });
        createdId = created.id;

        if (tagIds.length > 0) {
          await tx.entryTag.createMany({ data: tagIds.map((tagId) => ({ entryId: created.id, tagId })) });
        }
      });

      if (accountId) await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("操作失败", "route.ts"));
    } else if (type === "investment") {
      const accountId = String(body.accountId ?? "").trim();
      const subtype = String(body.fundSubtype ?? "buy").trim();
      let fundCode = String(body.fundCode ?? "").trim() || null;
      const fundProductType = String(body.fundProductType ?? "").trim() || null;
      const fundUnitsRaw = parseMoney(body.fundUnits);
      const fundNavRaw = parseMoney(body.fundNav);
      const fundFeeRaw = parseMoney(body.fundFee);
      const fundConfirmDateStr = String(body.fundConfirmDate ?? "").trim();
      const fundArrivalDateStr = String(body.fundArrivalDate ?? "").trim();
      const fundArrivalAmountRaw = parseMoney(body.fundArrivalAmount);
      const cashAccountIdInput = String(body.cashAccountId ?? "").trim() || null;
      const fundConfirmDate = fundConfirmDateStr ? new Date(fundConfirmDateStr) : null;
      const fundArrivalDate = fundArrivalDateStr ? new Date(fundArrivalDateStr) : null;
      const fundArrivalAmount = fundArrivalAmountRaw > 0 ? fundArrivalAmountRaw : null;
      const fundUnits = fundUnitsRaw > 0 ? fundUnitsRaw : null;
      const fundNav = fundNavRaw > 0 ? fundNavRaw : null;
      const fundFee = fundFeeRaw > 0 ? fundFeeRaw : null;

      if (!fundCode && note) {
        const codeMatch = note.match(/\b(\d{6})\b/);
        if (codeMatch) fundCode = codeMatch[1];
      }

      if (!accountId) {
        return NextResponse.json({ ok: false, error: "请选择账户" }, { status: 400 });
      }

      const redeemLike = subtype === "redeem" || subtype === "switch_out";
      const validSubtypes = Object.values(FundSubtype);
      const fundSubtypeValue: FundSubtype = validSubtypes.includes(subtype as FundSubtype)
        ? (subtype as FundSubtype)
        : FundSubtype.buy;

      const isDividendCash = fundSubtypeValue === FundSubtype.dividend_cash;
      const isDividendReinvest = fundSubtypeValue === FundSubtype.dividend_reinvest;

      const sourceValue = isDividendReinvest
        ? "dividend"
        : (String(body.source ?? "manual").trim() || "manual");
      const finalFundSubtype: FundSubtype = isDividendReinvest ? FundSubtype.buy : fundSubtypeValue;

      await prisma.$transaction(async (tx) => {
        const investAcc = await tx.account.findUnique({ where: { id: accountId } });
        if (!investAcc) throw new Error("账户不存在");
        if (investAcc.kind !== AccountKind.investment) throw new Error("请选择投资账户");

        const cashAcc = cashAccountIdInput
          ? await tx.account.findUnique({ where: { id: cashAccountIdInput }, select: { id: true, name: true, kind: true } })
          : null;

        const entryFundCode = fundCode || null;
        const entryFundName = note || fundCode || null;

        let recordAccountId: string;
        let recordAccountName: string;
        let recordToAccountId: string;
        let recordToAccountName: string;
        let signedAmount: number;

        if (redeemLike) {
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = cashAcc?.id ?? investAcc.id;
          recordToAccountName = cashAcc?.name ?? investAcc.name;
          signedAmount = fundArrivalAmount ?? Math.max(0, amountAbs - (fundFee ?? 0));
        } else if (isDividendReinvest) {
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = investAcc.id;
          recordToAccountName = investAcc.name;
          signedAmount = -amountAbs;
        } else if (isDividendCash && cashAcc) {
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = cashAcc.id;
          recordToAccountName = cashAcc.name;
          signedAmount = amountAbs;
        } else {
          recordAccountId = cashAcc?.id ?? investAcc.id;
          recordAccountName = cashAcc?.name ?? investAcc.name;
          recordToAccountId = investAcc.id;
          recordToAccountName = investAcc.name;
          signedAmount = -amountAbs;
        }

        const applyDateStr = date.toISOString().slice(0, 10);
        const shouldComputeArrival = finalFundSubtype === FundSubtype.buy && !redeemLike && !isDividendCash && !isDividendReinvest;
        let computedConfirmDate: Date | null = fundConfirmDate;
        let computedArrivalDate: Date | null = fundArrivalDate;

        if (shouldComputeArrival && entryFundCode) {
          const confirmStr = computedConfirmDate
            ? computedConfirmDate.toISOString().slice(0, 10)
            : addWorkdaysUtc(applyDateStr, await getFundConfirmDays(investAcc.id, entryFundCode));
          computedConfirmDate = new Date(`${confirmStr}T00:00:00.000Z`);

          if (!computedArrivalDate) {
            const arrivalStr = addWorkdaysUtc(confirmStr, await getFundArrivalDays(investAcc.id, entryFundCode));
            computedArrivalDate = new Date(`${arrivalStr}T00:00:00.000Z`);
          }
        }

        const created = await tx.txRecord.create({
          data: {
            date,
            type: TransactionType.investment,
            accountId: recordAccountId,
            accountName: recordAccountName,
            toAccountId: recordToAccountId,
            toAccountName: recordToAccountName,
            amount: signedAmount,
            fundCode: entryFundCode,
            fundName: entryFundName,
            fundProductType: fundProductType as "fund" | "money" | "wealth" | "deposit" | null | undefined,
            fundSubtype: finalFundSubtype,
            source: sourceValue,
            fundUnits: fundUnits ?? undefined,
            fundNav: fundNav ?? undefined,
            fundFee: fundFee ?? undefined,
            fundConfirmDate: computedConfirmDate ?? undefined,
            fundArrivalDate: computedArrivalDate ?? undefined,
            fundArrivalAmount: fundArrivalAmount ?? undefined,
            note: note || undefined,
            householdId,
          },
        });
        createdId = created.id;

        if (tagIds.length > 0) {
          await tx.entryTag.createMany({ data: tagIds.map((tagId) => ({ entryId: created.id, tagId })) });
        }
      });

      await recalcFundPositions(accountId, fundCode ? [fundCode] : undefined).catch(logger.catchLog("操作失败", "route.ts"));
      await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("操作失败", "route.ts"));
      if (cashAccountIdInput && cashAccountIdInput !== accountId) {
        await recalcAndSaveAccountBalance(cashAccountIdInput).catch(logger.catchLog("操作失败", "route.ts"));
      }
    } else {
      return NextResponse.json({ ok: false, error: "类型不正确" }, { status: 400 });
    }

    // 返回刚创建的记录
    if (createdId) {
      const created = await prisma.txRecord.findUnique({
        where: { id: createdId },
        include: {
          EntryTag: { include: { Tag: true } },
          account: { include: { Institution: { select: { name: true } } } },
          toAccount: { include: { Institution: { select: { name: true } } } },
        },
      });
      if (created) {
        return NextResponse.json({
          ok: true,
          data: {
            id: created.id,
            date: created.date.toISOString().slice(0, 10),
            amount: toNumber(created.amount),
            type: created.type,
            categoryId: created.categoryId,
            categoryName: created.categoryName,
            accountId: created.accountId,
            accountName: created.accountName,
            accountInstitutionName: created.account?.Institution?.name ?? "",
            toAccountId: created.toAccountId,
            toAccountName: created.toAccountName,
            toAccountInstitutionName: created.toAccount?.Institution?.name ?? "",
            note: created.note,
            fundSubtype: created.fundSubtype,
            fundCode: created.fundCode,
            fundName: created.fundName,
            fundProductType: created.fundProductType,
            fundNav: created.fundNav ? toNumber(created.fundNav) : null,
            fundUnits: created.fundUnits ? toNumber(created.fundUnits) : null,
            fundFee: created.fundFee ? toNumber(created.fundFee) : null,
            fundConfirmDate: created.fundConfirmDate?.toISOString().slice(0, 10) ?? null,
            fundArrivalDate: created.fundArrivalDate?.toISOString().slice(0, 10) ?? null,
            fundArrivalAmount: created.fundArrivalAmount ? toNumber(created.fundArrivalAmount) : null,
            source: created.source,
            entryTags: mapEntryTags(created),
          },
        });
      }
    }

    return NextResponse.json({ ok: true, data: { id: createdId } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "创建失败";
    console.error("POST /api/v1/transactions/detail error:", err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/* ────────────────── PUT (UPDATE) ────────────────── */

/**
 * PUT /api/v1/transactions/detail
 * 更新交易记录
 *
 * Body (JSON):
 *   id: string (必填)
 *   date?: string (YYYY-MM-DD)
 *   amount?: number
 *   type?: "expense" | "income" | "transfer" | "investment"
 *   accountId?: string
 *   categoryId?: string
 *   toAccountId?: string
 *   toAccountName?: string
 *   note?: string
 *   tagIds?: string[]
 *   --- investment fields ---
 *   fundCode?: string
 *   fundName?: string
 *   fundProductType?: string
 *   fundSubtype?: string
 *   fundNav?: number
 *   fundUnits?: number
 *   fundFee?: number
 *   fundConfirmDate?: string
 *   fundArrivalDate?: string
 *   fundArrivalAmount?: number
 *   cashAccountId?: string
 *   keepFundDetail?: boolean
 *
 * 返回: { ok: true, data: { id, ... } } | { ok: false, error }
 */
export async function PUT(req: Request) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ ok: false, error: "无效的请求体" }, { status: 400 });
    }

    const entryId = String(body.id ?? body.entryId ?? "").trim();
    if (!entryId) {
      return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });
    }

    const type = String(body.type ?? "").trim();
    const dateStr = String(body.date ?? "").trim();
    const amountRaw = parseMoney(body.amount);
    const amountAbs = amountRaw > 0 ? Math.abs(amountRaw) : 0;
    const note = String(body.note ?? "").trim();
    const tagIdsRaw = body.tagIds;
    const tagIds: string[] = Array.isArray(tagIdsRaw)
      ? tagIdsRaw.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];

    const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
    if (!amountAbs) {
      return NextResponse.json({ ok: false, error: "金额不正确" }, { status: 400 });
    }

    const { householdId } = ctx;

    let oldAccountId: string | undefined;
    let oldToAccountId: string | undefined;
    let investmentAccId: string | undefined;

    await prisma.$transaction(async (tx) => {
      const entry = await tx.txRecord.findUnique({ where: { id: entryId } });
      if (!entry) throw new Error("记录不存在");
      if (entry.householdId && entry.householdId !== householdId) {
        throw new Error("记录不属于当前账簿");
      }

      // Save old account IDs for balance recalculation
      oldAccountId = entry.accountId ?? undefined;
      oldToAccountId = entry.toAccountId ?? undefined;

      // Update tags: delete old, create new
      await tx.entryTag.deleteMany({ where: { entryId } });
      if (tagIds.length > 0) {
        await tx.entryTag.createMany({ data: tagIds.map((tagId) => ({ entryId, tagId })) });
      }

      if (type === "transfer") {
        const fromAccountId = String(body.fromAccountId ?? body.accountId ?? "").trim();
        const toAccountId = String(body.toAccountId ?? "").trim();
        if (!fromAccountId || !toAccountId) throw new Error("转账需要选择转出/转入账户");
        if (fromAccountId === toAccountId) throw new Error("转出/转入账户不能相同");

        const [fromAcc, toAcc] = await Promise.all([
          tx.account.findUnique({ where: { id: fromAccountId } }),
          tx.account.findUnique({ where: { id: toAccountId } }),
        ]);
        if (!fromAcc || !toAcc) throw new Error("账户不存在");

        const toStatementMonthValue =
          (toAcc.kind === AccountKind.bank_credit || toAcc.kind === AccountKind.loan) && toAcc.billingDay
            ? toStatementMonth(date, toAcc.billingDay)
            : null;

        await tx.txRecord.update({
          where: { id: entryId },
          data: {
            amount: -amountAbs,
            accountId: fromAcc.id,
            accountName: fromAcc.name,
            toAccountId: toAcc.id,
            toAccountName: toAcc.name,
            categoryId: null,
            categoryName: null,
            statementMonth: toStatementMonthValue,
          },
        });
        await tx.txRecord.update({
          where: { id: entry.id },
          data: { date, type: TransactionType.transfer, note: note || null },
        });
        return;
      }

      if (type === "investment") {
        const accountIdFormData = String(body.accountId ?? body.investAccountId ?? "").trim();
        const cashAccountIdFormData = String(body.cashAccountId ?? "").trim();
        const fundCode = String(body.fundCode ?? "").trim() || null;
        const productType = String(body.fundProductType ?? "fund").trim();
        const subtype = String(body.fundSubtype ?? "buy").trim();
        const redeemLike = subtype === "redeem" || subtype === "switch_out";
        const cashReceivingLike = redeemLike || subtype === "dividend_cash";

        const investAcc = accountIdFormData ? await tx.account.findUnique({ where: { id: accountIdFormData } }) : null;
        if (!investAcc) throw new Error("请选择投资账户");
        investmentAccId = investAcc.id;

        let cashAccId: string | null = null;
        let cashAccName: string | null = null;
        if (cashAccountIdFormData) {
          const cashAcc = await tx.account.findUnique({ where: { id: cashAccountIdFormData } });
          if (cashAcc) { cashAccId = cashAcc.id; cashAccName = cashAcc.name; }
        }
        if (!cashAccId) {
          if (redeemLike) {
            if (entry.toAccountId) {
              const acc = await tx.account.findUnique({ where: { id: entry.toAccountId } });
              if (acc) { cashAccId = acc.id; cashAccName = acc.name; }
            }
          } else {
            if (entry.accountId && entry.accountId !== investAcc.id) {
              const acc = await tx.account.findUnique({ where: { id: entry.accountId } });
              if (acc) { cashAccId = acc.id; cashAccName = acc.name; }
            }
          }
        }

        let recordAccountId: string;
        let recordAccountName: string;
        let recordToAccountId: string;
        let recordToAccountName: string;
        let signedAmount: number;

        const fundArrivalAmount = parseMoney(body.fundArrivalAmount);
        const fundFee = parseMoney(body.fundFee);

        if (cashReceivingLike) {
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = cashAccId ?? investAcc.id;
          recordToAccountName = cashAccName ?? investAcc.name;
          signedAmount = subtype === "dividend_cash"
            ? amountAbs
            : (fundArrivalAmount > 0
                ? fundArrivalAmount
                : Math.max(0, amountAbs - (fundFee > 0 ? fundFee : 0)));
        } else {
          recordAccountId = cashAccId ?? investAcc.id;
          recordAccountName = cashAccName ?? investAcc.name;
          recordToAccountId = investAcc.id;
          recordToAccountName = investAcc.name;
          signedAmount = -amountAbs;
        }

        await tx.txRecord.update({
          where: { id: entryId },
          data: {
            amount: signedAmount,
            accountId: recordAccountId,
            accountName: recordAccountName,
            categoryId: null,
            categoryName: null,
            toAccountId: recordToAccountId,
            toAccountName: recordToAccountName,
            fundCode: fundCode || null,
            fundProductType: (productType as any) || null,
            fundSubtype: (subtype as any) || null,
            note: note || null,
          },
        });

        await tx.txRecord.update({
          where: { id: entry.id },
          data: { date, type: TransactionType.investment, note: note || null },
        });

        await recalcFundPositions(investAcc.id, fundCode ? [fundCode] : undefined).catch(logger.catchLog("操作失败", "route.ts"));
        return;
      }

      if (type !== "expense" && type !== "income") throw new Error("类型不正确");

      const accountId = String(body.accountId ?? "").trim();
      const categoryId = String(body.categoryId ?? "").trim();
      const keepFundDetail = body.keepFundDetail === true;

      const [acc, cat] = await Promise.all([
        accountId ? tx.account.findUnique({ where: { id: accountId } }) : Promise.resolve(null),
        categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
      ]);
      if (!acc) throw new Error("请选择账户");
      if (acc.kind === AccountKind.investment) throw new Error("基金/理财账户不参与收支记账");

      const isFundTransaction = entry.toAccountId && entry.fundProductType;

      if (isFundTransaction) {
        if (keepFundDetail) {
          await tx.txRecord.update({
            where: { id: entryId },
            data: {
              accountId: entry.toAccountId ?? undefined,
              accountName: entry.toAccountName ?? "",
              amount: Math.abs(toNumber(entry.amount)),
            } as any,
          });
        } else {
          await tx.txRecord.update({
            where: { id: entryId },
            data: {
              toAccountId: null,
              toAccountName: null,
              fundCode: null,
              fundProductType: null,
              fundSubtype: null,
              fundUnits: null,
              fundNav: null,
              fundFee: null,
              fundConfirmDate: null,
              fundArrivalDate: null,
              fundArrivalAmount: null,
            },
          });
        }
      }

      const statementMonth =
        (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
          ? toStatementMonth(date, acc.billingDay)
          : null;

      await tx.txRecord.update({
        where: { id: entryId },
        data: {
          amount: type === "income" ? amountAbs : -amountAbs,
          accountId: acc.id,
          accountName: acc.name,
          categoryId: cat ? cat.id : null,
          categoryName: cat?.name ?? null,
          statementMonth,
          toAccountId: null,
          toAccountName: null,
          fundCode: null,
          fundProductType: null,
        },
      });

      await tx.txRecord.update({
        where: { id: entry.id },
        data: {
          date,
          type: type === "income" ? TransactionType.income : TransactionType.expense,
          note: note || null,
        },
      });
    });

    // 重算余额：所有涉及的旧/新账户
    const accountsToRecalc = new Set<string>();
    if (oldAccountId) accountsToRecalc.add(oldAccountId);
    if (oldToAccountId) accountsToRecalc.add(oldToAccountId);

    if (type === "transfer") {
      const fromAccountId = String(body.fromAccountId ?? body.accountId ?? "").trim();
      const toAccountId = String(body.toAccountId ?? "").trim();
      if (fromAccountId) accountsToRecalc.add(fromAccountId);
      if (toAccountId) accountsToRecalc.add(toAccountId);
    } else if (type === "investment") {
      if (investmentAccId) accountsToRecalc.add(investmentAccId);
      const cashId = String(body.cashAccountId ?? "").trim();
      if (cashId) accountsToRecalc.add(cashId);
    } else if (type === "expense" || type === "income") {
      const accountId = String(body.accountId ?? "").trim();
      if (accountId) accountsToRecalc.add(accountId);
    }

    for (const acctId of accountsToRecalc) {
      await recalcAndSaveAccountBalance(acctId).catch(logger.catchLog("操作失败", "route.ts"));
    }

    // 返回更新后的记录
    const updated = await prisma.txRecord.findUnique({
      where: { id: entryId },
      include: {
        EntryTag: { include: { Tag: true } },
        account: { include: { Institution: { select: { name: true } } } },
        toAccount: { include: { Institution: { select: { name: true } } } },
      },
    });

    if (!updated) {
      return NextResponse.json({ ok: false, error: "更新后记录不存在" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      data: {
        id: updated.id,
        date: updated.date.toISOString().slice(0, 10),
        amount: toNumber(updated.amount),
        type: updated.type,
        categoryId: updated.categoryId,
        categoryName: updated.categoryName,
        accountId: updated.accountId,
        accountName: updated.accountName,
        accountInstitutionName: updated.account?.Institution?.name ?? "",
        toAccountId: updated.toAccountId,
        toAccountName: updated.toAccountName,
        toAccountInstitutionName: updated.toAccount?.Institution?.name ?? "",
        note: updated.note,
        fundSubtype: updated.fundSubtype,
        fundCode: updated.fundCode,
        fundName: updated.fundName,
        fundProductType: updated.fundProductType,
        fundNav: updated.fundNav ? toNumber(updated.fundNav) : null,
        fundUnits: updated.fundUnits ? toNumber(updated.fundUnits) : null,
        fundFee: updated.fundFee ? toNumber(updated.fundFee) : null,
        fundConfirmDate: updated.fundConfirmDate?.toISOString().slice(0, 10) ?? null,
        fundArrivalDate: updated.fundArrivalDate?.toISOString().slice(0, 10) ?? null,
        fundArrivalAmount: updated.fundArrivalAmount ? toNumber(updated.fundArrivalAmount) : null,
        source: updated.source,
        entryTags: mapEntryTags(updated),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "更新失败";
    console.error("PUT /api/v1/transactions/detail error:", err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/* ────────────────── DELETE ────────────────── */

/**
 * DELETE /api/v1/transactions/detail?id=xxx
 *
 * 软删除一条交易记录
 *
 * 返回: { ok: true } | { ok: false, error }
 */
export async function DELETE(req: Request) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const url = new URL(req.url);
    const id = (url.searchParams.get("id") ?? "").trim();

    if (!id) {
      return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });
    }

    const { householdId } = ctx;

    // Find the record first
    const txRecord = await prisma.txRecord.findUnique({ where: { id } });

    if (!txRecord) {
      return NextResponse.json({ ok: false, error: `记录不存在 (id: ${id})` }, { status: 404 });
    }

    // Verify household
    if (txRecord.householdId && txRecord.householdId !== householdId) {
      return NextResponse.json({ ok: false, error: "记录不属于当前账簿" }, { status: 403 });
    }

    // Soft delete
    await prisma.txRecord.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    // Recalculate balances for affected accounts
    const accountsToRecalc = new Set<string>();
    if (txRecord.accountId) accountsToRecalc.add(txRecord.accountId);
    if (txRecord.toAccountId) accountsToRecalc.add(txRecord.toAccountId);

    // If fund transaction, recalc positions too
    if (txRecord.fundCode && txRecord.fundProductType) {
      const isRedeemLike = txRecord.fundSubtype === "redeem" || txRecord.fundSubtype === "switch_out";
      const investmentAccId = isRedeemLike ? txRecord.accountId : txRecord.toAccountId;
      if (investmentAccId) {
        await recalcFundPositions(investmentAccId, [txRecord.fundCode]).catch(logger.catchLog("操作失败", "route.ts"));
      }
    }

    for (const acctId of accountsToRecalc) {
      await recalcAndSaveAccountBalance(acctId).catch(logger.catchLog("操作失败", "route.ts"));
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "删除失败";
    console.error("DELETE /api/v1/transactions/detail error:", err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
