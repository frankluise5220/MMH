import { prisma } from "@/lib/db/prisma";
import { revalidatePath } from "next/cache";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { AccountKind, TransactionType, FundSubtype, RegularInvestStatus, IntervalUnit } from "@prisma/client";
import { EntryRowActions } from "@/components/EntryRowActions";
import { TransactionFormModal } from "@/components/TransactionFormModal";
import { InvestmentFormModal, type InvestmentEntry, type InvestmentDefaults } from "@/components/InvestmentFormModal";
import { FillNavButton } from "@/components/FillNavButton";
import { FundShell } from "@/components/FundShell";
import { RegularInvestForm } from "@/components/RegularInvestForm";
import { RegularInvestActionButtons } from "@/components/RegularInvestActionButtons";


import { RefreshNavButton } from "@/components/RefreshNavButton";
import EditBillAmount from "@/components/EditBillAmount";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getFundConfirmDays, setFundConfirmDays, setFundConfirmDaysInTx } from "@/lib/fund/confirmDays";
import { setFundFeeRateByDate, getFundFeeRateByDate, setFundFeeRateInTx } from "@/lib/fund/feeRate";
import { computeInvestBalances, computePositionDisplay } from "@/lib/invest-balance";
import { syncMissingFundEntries } from "@/lib/fund/syncMissingEntries";
import { formatMoney } from "@/lib/format";
import { getFundNav } from "@/lib/fund/navCache";

export const dynamic = "force-dynamic";

import { startOfDayUtc, addDaysUtc, addMonthsUtc, toStatementMonth, creditCardCycle, toNumber, lastDayOfMonthUtc, clampDay, addWorkdaysUtc } from "@/lib/date-utils";

function formatType(type: string) {
  if (type === "expense") return "支出";
  if (type === "income") return "收入";
  if (type === "transfer") return "转账";
  if (type === "investment") return "投资";
  return type;
}

import { subtypeDisplay } from "@/lib/investment-config";

function fundSubtypeInfo(subtype: string | null | undefined, source: string | null | undefined, _amount: number) {
  const base = subtypeDisplay(subtype, source);
  // source-based overrides for buy subtype (定投/红利转投/转入)
  if (subtype === "buy" && source) {
    const srcLabels: Record<string, { label: string; cls: string; textCls?: string }> = {
      regular_invest: { label: "定投", cls: "bg-blue-50 text-blue-600" },
      dividend: { label: "红利转投", cls: "bg-emerald-50 text-emerald-600", textCls: "text-emerald-600" },
      switch: { label: "转入", cls: "bg-blue-50 text-blue-600" },
    };
    return srcLabels[source] ?? base;
  }
  return base;
}

function ymdUtc(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function cycleForStatementMonth(statementMonth: string, billingDay: number, repaymentDay: number | null | undefined, now: Date) {
  const today = startOfDayUtc(now);
  const m = statementMonth.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  if (!Number.isFinite(y) || !Number.isFinite(monthIndex)) return null;

  const end = new Date(Date.UTC(y, monthIndex, clampDay(y, monthIndex, billingDay)));
  const prevEnd = new Date(Date.UTC(y, monthIndex - 1, clampDay(y, monthIndex - 1, billingDay)));
  const start = addDaysUtc(prevEnd, 1);
  const nextEnd = addDaysUtc(end, 1);
  const isCurrentCycle = today.getTime() >= start.getTime() && today.getTime() < nextEnd.getTime();

  const due =
    repaymentDay && repaymentDay >= 1
      ? (() => {
          const dueMonthOffset = repaymentDay <= billingDay ? 1 : 0;
          const dueMonth = end.getUTCMonth() + dueMonthOffset;
          const dueYear = end.getUTCFullYear() + Math.floor(dueMonth / 12);
          const dueMonthNorm = ((dueMonth % 12) + 12) % 12;
          return new Date(Date.UTC(dueYear, dueMonthNorm, clampDay(dueYear, dueMonthNorm, repaymentDay)));
        })()
      : null;

  return { start, end, due, today, isCurrentCycle };
}

function buildCategoryPathLabels(categories: Array<{ id: string; name: string; type: string; parentId: string | null }>) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const memo = new Map<string, string[]>();

  function pathNames(id: string): string[] {
    const cached = memo.get(id);
    if (cached) return cached;
    const c = byId.get(id);
    if (!c) return [];
    const seen = new Set<string>();
    const names: string[] = [];
    let cur: typeof c | undefined = c;
    while (cur) {
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      names.push(cur.name);
      if (!cur.parentId) break;
      const parent = byId.get(cur.parentId);
      if (!parent) break;
      if (parent.type !== cur.type) break;
      cur = parent;
    }
    names.reverse();
    memo.set(id, names);
    return names;
  }

  const typeLabel = (type: string) => (type === "expense" ? "支出" : type === "income" ? "收入" : type);
  const labelById = new Map<string, string>();
  for (const c of categories) {
    const names = pathNames(c.id);
    labelById.set(c.id, `${typeLabel(c.type)}.${names.join(".")}`);
  }
  return labelById;
}

function parseMoneyInput(value: FormDataEntryValue | null) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return 0;
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return 0;
  return n;
}

async function updateEntryRow(formData: FormData) {
  "use server";

  const entryId = String(formData.get("entryId") ?? "").trim();
  if (!entryId) return;

  const dateStr = String(formData.get("date") ?? "").trim();
  const inflow = parseMoneyInput(formData.get("inflow"));
  const outflow = parseMoneyInput(formData.get("outflow"));
  const accountIdRaw = String(formData.get("accountId") ?? "").trim();
  const categoryIdRaw = String(formData.get("categoryId") ?? "").trim();
  const categoryName = String(formData.get("categoryName") ?? "").trim();
  const tagsText = String(formData.get("tags") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const memo = String(formData.get("memo") ?? "").trim();

  const tagNames = tagsText
    .split(/[)]/)
    .map((s) => s.trim())
    .filter(Boolean);

  await prisma.$transaction(async (tx) => {
    const entry = await tx.txRecord.findUnique({
      where: { id: entryId },
      include: {},
    });
    if (!entry) return;

    const date =
      dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : entry.date;

    let amount = 0;
    if (inflow > 0) amount = Math.abs(inflow);
    else if (outflow > 0) amount = -Math.abs(outflow);
    else amount = 0;

    let categoryId: string | null = categoryIdRaw || null;
    let nextCategoryName: string | null = null;
    if (categoryId) {
      const found = await tx.category.findUnique({ where: { id: categoryId } });
      if (!found) categoryId = null;
      nextCategoryName = found?.name ?? null;
    } else {
      nextCategoryName = categoryName || null;
      categoryId = nextCategoryName
        ? (await tx.category.findFirst({ where: { name: nextCategoryName } }))?.id ?? null
        : null;
    }

    const siblings = await tx.txRecord.findMany({
      where: { id: entry.id },
      select: { id: true, type: true },
    });
    const currentEntry = siblings[0];

    let nextAccountId: string | null = entry.accountId;
    let nextAccountName: string = entry.accountName;
    if (accountIdRaw) {
      const acc = await tx.account.findUnique({ where: { id: accountIdRaw } });
      if (acc) {
        nextAccountId = acc.id;
        nextAccountName = acc.name;
      }
    }

    const nextStatementMonth = await (async () => {
      if (!nextAccountId) return null;
      const acc = await tx.account.findUnique({ where: { id: nextAccountId }, select: { kind: true, billingDay: true } });
      if (!acc) return null;
      if (acc.kind !== AccountKind.bank_credit && acc.kind !== AccountKind.loan) return null;
      if (!acc.billingDay) return null;
      return toStatementMonth(date, acc.billingDay);
    })();

    const nextType: TransactionType =
        amount > 0
          ? TransactionType.income
          : amount < 0
            ? TransactionType.expense
            : entry.type;

      await tx.txRecord.update({
        where: { id: entryId },
        data: { amount, categoryId, categoryName: nextCategoryName, accountId: nextAccountId, accountName: nextAccountName, statementMonth: nextStatementMonth },
      });

      await tx.txRecord.update({
        where: { id: entry.id },
        data: {
          date,
          type: nextType,
          note: note || null,
        },
      });

if (tagNames.length) {
      const tagIds: string[] = [];
      for (const name of tagNames) {
        const existing = await tx.tag.findFirst({ where: { name } });
        if (existing?.id) {
          tagIds.push(existing.id);
          continue;
        }
        try {
          const created = await tx.tag.create({ data: { name } });
          tagIds.push(created.id);
        } catch {
          const retry = await tx.tag.findFirst({ where: { name } });
          if (retry?.id) tagIds.push(retry.id);
        }
      }

      await tx.entryTag.deleteMany({ where: { entryId } });
      if (tagIds.length) {
        await tx.entryTag.createMany({
          data: tagIds.map((tagId) => ({ entryId, tagId })),
          skipDuplicates: true,
        });
      }
    } else {
      await tx.entryTag.deleteMany({ where: { entryId } });
    }
  });

  revalidatePath("/");
  revalidatePath("/", "layout");
  revalidatePath("/overview");
  revalidatePath("/accounts");
}

async function createTransaction(formData: FormData) {
  "use server";

  const type = String(formData.get("type") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const amountRaw = parseMoneyInput(formData.get("amount") ?? null);
  const amountAbs = amountRaw > 0 ? Math.abs(amountRaw) : 0;
  const note = String(formData.get("note") ?? "").trim();

  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();

  if (!amountAbs) {
    return { ok: false as const, error: "金额不正确" };
  }

  try {
    if (type === "transfer") {
      const fromAccountId = String(formData.get("fromAccountId") ?? "").trim();
      const toAccountId = String(formData.get("toAccountId") ?? "").trim();
      if (!fromAccountId || !toAccountId) return { ok: false as const, error: "转账需要选择转出/转入账户" };
      if (fromAccountId === toAccountId) return { ok: false as const, error: "转出/转入账户不能相同" };

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

        await tx.txRecord.create({
          data: {accountId: fromAcc.id,
            accountName: fromAcc.name,
            toAccountId: toAcc.id,
            toAccountName: toAcc.name,
            amount: -amountAbs,
            type: TransactionType.transfer,
            date,
            note: note || null,
            statementMonth: toStatementMonthValue,
          },
        });
      });

      await recalcAndSaveAccountBalance(fromAccountId).catch(() => {});
      await recalcAndSaveAccountBalance(toAccountId).catch(() => {});
    } else if (type === "expense") {
      const accountId = String(formData.get("accountId") ?? "").trim();
      const categoryId = String(formData.get("categoryId") ?? "").trim();
      if (!accountId) return { ok: false as const, error: "请选择账户" };

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

        await tx.txRecord.create({
          data: {accountId: acc.id,
            accountName: acc.name,
            categoryId: cat?.id ?? null,
            categoryName: cat?.name ?? null,
            amount: -amountAbs,
            type: TransactionType.expense,
            date,
            note: note || null,
            statementMonth,
          },
        });
      });

      await recalcAndSaveAccountBalance(accountId).catch(() => {});
    } else if (type === "income") {
      const accountId = String(formData.get("accountId") ?? "").trim();
      const categoryId = String(formData.get("categoryId") ?? "").trim();

      await prisma.$transaction(async (tx) => {
        const [acc, cat] = await Promise.all([
          accountId ? tx.account.findUnique({ where: { id: accountId }, include: { Institution: true } }) : Promise.resolve(null),
          categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
        ]);

        const statementMonth =
          acc && (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
            ? toStatementMonth(date, acc.billingDay)
            : null;

        await tx.txRecord.create({
          data: { accountId: acc?.id ?? undefined,
            accountName: acc?.name ?? "未知账户",
            categoryId: cat?.id ?? undefined,
            categoryName: cat?.name ?? undefined,
            amount: amountAbs,
            type: TransactionType.income,
            date,
            note: note || undefined,
            statementMonth: statementMonth ?? undefined,
          } as any,
        });
      });

      if (accountId) await recalcAndSaveAccountBalance(accountId).catch(() => {});
    } else if (type === "investment") {
      const accountId = String(formData.get("accountId") ?? "").trim();
      const subtype = String(formData.get("subtype") ?? "buy").trim();
      let fundCode = String(formData.get("fundCode") ?? "").trim() || null;
      const fundProductType = String(formData.get("fundProductType") ?? "").trim() || null;
      const fundUnitsRaw = parseFloat(String(formData.get("fundUnits") ?? ""));
  const fundNavRaw = parseFloat(String(formData.get("fundNav") ?? ""));
  const fundFeeRaw = parseFloat(String(formData.get("fundFee") ?? ""));
      const fundConfirmDateStr = String(formData.get("fundConfirmDate") ?? "").trim();
      const fundArrivalDateStr = String(formData.get("fundArrivalDate") ?? "").trim();
      const fundArrivalAmountRaw = parseFloat(String(formData.get("fundArrivalAmount") ?? ""));
      const cashAccountIdInput = String(formData.get("cashAccountId") ?? "").trim() || null;
      const fundConfirmDate = fundConfirmDateStr ? new Date(fundConfirmDateStr) : null;
      const fundArrivalDate = fundArrivalDateStr ? new Date(fundArrivalDateStr) : null;
      const fundArrivalAmount = Number.isFinite(fundArrivalAmountRaw) && fundArrivalAmountRaw > 0 ? fundArrivalAmountRaw : null;
      const fundUnits = Number.isFinite(fundUnitsRaw) && fundUnitsRaw > 0 ? fundUnitsRaw : null;
      const fundNav = Number.isFinite(fundNavRaw) && fundNavRaw > 0 ? fundNavRaw : null;
      const fundFee = Number.isFinite(fundFeeRaw) && fundFeeRaw > 0 ? fundFeeRaw : null;

      if (!fundCode && note) {
        const codeMatch = note.match(/\b(\d{6})\b/);
        if (codeMatch) fundCode = codeMatch[1];
      }

      if (!accountId) return { ok: false as const, error: "请选择账户" };

      const redeemLike = subtype === "redeem" || subtype === "switch_out";
      const validSubtypes = Object.values(FundSubtype);
      const fundSubtypeValue: FundSubtype = validSubtypes.includes(subtype as FundSubtype) ? (subtype as FundSubtype) : FundSubtype.buy;

      const isDividendCash = fundSubtypeValue === FundSubtype.dividend_cash;
      const isDividendReinvest = fundSubtypeValue === FundSubtype.dividend_reinvest;

      // Map source field: dividend_reinvest → source='dividend', otherwise use form source or 'manual'
      const sourceValue = isDividendReinvest ? "dividend" : (String(formData.get("source") ?? "manual").trim() || "manual");
      // dividend_reinvest → fundSubtype='buy'
      const finalFundSubtype: FundSubtype = isDividendReinvest ? FundSubtype.buy : fundSubtypeValue;

      await prisma.$transaction(async (tx) => {
        // accountId 统一为投资账户（基金账户）
        const investAcc = await tx.account.findUnique({ where: { id: accountId } });
        if (!investAcc) throw new Error("账户不存在");
        if (investAcc.kind !== AccountKind.investment) throw new Error("请选择投资账户");

        const cashAcc = cashAccountIdInput
          ? await tx.account.findUnique({ where: { id: cashAccountIdInput }, select: { id: true, name: true, kind: true } })
          : null;

        const entryFundCode = fundCode || null;
        // fundCode 字段只存真正的基金代码（6位数字），不存账户名
        // fundName 用于显示名称：有备注用备注，有真实基金代码用基金名称（由UI查询），否则留null
        const entryFundName = note || fundCode || null;


        // 创建 TxRecord，直接包含所有基金字段
        // 规则：toAccountId = 资金收到方
        // buy/dividend_cash: accountId=现金(发起), toAccountId=投资(接收)
        // redeem/switch_out: accountId=投资(发起), toAccountId=现金(接收)
        // dividend_reinvest: accountId=投资(发起), toAccountId=投资(接收)
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
          // 现金红利：投资账户(发起) → 现金账户(接收)，金额为正（资金流入现金账户）
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

        await tx.txRecord.create({
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
            fundConfirmDate: fundConfirmDate ?? undefined,
            fundArrivalDate: fundArrivalDate ?? undefined,
            fundArrivalAmount: fundArrivalAmount ?? undefined,
            note: note || undefined,
          },
        });
      });

      await recalcFundPositions(accountId, fundCode ? [fundCode] : undefined).catch(() => {});
      await recalcAndSaveAccountBalance(accountId).catch(() => {});
      if (cashAccountIdInput && cashAccountIdInput !== accountId) {
        await recalcAndSaveAccountBalance(cashAccountIdInput).catch(() => {});
      }
    } else {
      return { ok: false as const, error: "类型不正确" };
    }

    revalidatePath("/");
    revalidatePath("/overview");
    revalidatePath("/accounts");
    revalidatePath("/invest");
    revalidatePath("/funds");
    return { ok: true as const };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "记账失败";
    return { ok: false as const, error: msg };
  }
}

async function editInvestment(formData: FormData) {
  "use server";
  const entryId = String(formData.get("entryId") ?? "").trim();
  const subtype = String(formData.get("subtype") ?? "buy").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const amountRaw = parseFloat(String(formData.get("amount") ?? ""));
  const memo = String(formData.get("memo") ?? "").trim();
  const fundCode = String(formData.get("fundCode") ?? "").trim() || null;
  const fundName = String(formData.get("fundName") ?? "").trim() || null;
  const fundProductType = String(formData.get("fundProductType") ?? "").trim() || null;

  // 检测字段是否被传递（用于区分"不更新"vs"清空")
  const hasFundUnits = formData.has("fundUnits");
  const hasFundNav = formData.has("fundNav");
  const hasFundFee = formData.has("fundFee");
  const hasFundConfirmDate = formData.has("fundConfirmDate");
  const hasCashAccountId = formData.has("cashAccountId");
  const hasFundArrivalDate = formData.has("fundArrivalDate");
  const hasFundArrivalAmount = formData.has("fundArrivalAmount");
  const hasConfirmDays = formData.has("confirmDays");
  const hasFeeRate = formData.has("feeRate");

  const fundUnitsStr = String(formData.get("fundUnits") ?? "").trim();
  const fundNavStr = String(formData.get("fundNav") ?? "").trim();
  const fundFeeStr = String(formData.get("fundFee") ?? "").trim();
  const fundConfirmDateStr = String(formData.get("fundConfirmDate") ?? "").trim();
  const cashAccountIdStr = String(formData.get("cashAccountId") ?? "").trim();
  const fundArrivalDateStr = String(formData.get("fundArrivalDate") ?? "").trim();
  const fundArrivalAmountStr = String(formData.get("fundArrivalAmount") ?? "").trim();
  const confirmDaysStr = String(formData.get("confirmDays") ?? "").trim();
  const feeRateStr = String(formData.get("feeRate") ?? "").trim();

  // 空字符串 → null（清空），有值 → 数值
  const fundUnitsRaw = fundUnitsStr ? parseFloat(fundUnitsStr) : NaN;
  const fundNavRaw = fundNavStr ? parseFloat(fundNavStr) : NaN;
  const fundFeeRaw = fundFeeStr ? parseFloat(fundFeeStr) : NaN;
  const fundArrivalAmountRaw = fundArrivalAmountStr ? parseFloat(fundArrivalAmountStr) : NaN;
  const confirmDaysRaw = confirmDaysStr ? parseInt(confirmDaysStr, 10) : NaN;
  const feeRateRaw = feeRateStr ? parseFloat(feeRateStr) : NaN;

  const fundUnits: number | null | undefined = hasFundUnits
    ? (Number.isFinite(fundUnitsRaw) && fundUnitsRaw > 0 ? fundUnitsRaw : null)
    : undefined; // undefined 表示不更新
  const fundNav: number | null | undefined = hasFundNav
    ? (Number.isFinite(fundNavRaw) && fundNavRaw > 0 ? fundNavRaw : null)
    : undefined;
  const fundFee: number | null | undefined = hasFundFee
    ? (Number.isFinite(fundFeeRaw) && fundFeeRaw >= 0 ? fundFeeRaw : null)
    : undefined;
  const fundConfirmDate = hasFundConfirmDate
    ? (fundConfirmDateStr ? new Date(fundConfirmDateStr) : null)
    : undefined;
  const cashAccountId = hasCashAccountId
    ? (cashAccountIdStr || null)
    : undefined;
  const fundArrivalDate = hasFundArrivalDate
    ? (fundArrivalDateStr ? new Date(fundArrivalDateStr) : null)
    : undefined;
  const fundArrivalAmount: number | null | undefined = hasFundArrivalAmount
    ? (Number.isFinite(fundArrivalAmountRaw) && fundArrivalAmountRaw > 0 ? fundArrivalAmountRaw : null)
    : undefined;
  const confirmDays: number | null | undefined = hasConfirmDays
    ? (Number.isFinite(confirmDaysRaw) && confirmDaysRaw >= 0 ? confirmDaysRaw : null)
    : undefined;
  const feeRate: number | null | undefined = hasFeeRate
    ? (Number.isFinite(feeRateRaw) && feeRateRaw >= 0 ? feeRateRaw : null)
    : undefined;

  if (!entryId) return { ok: false as const, error: "缺少参数" };
  const amountAbs = Number.isFinite(amountRaw) ? Math.abs(amountRaw) : 0;
  if (!amountAbs) return { ok: false as const, error: "金额不正确" };
  if (!dateStr) return { ok: false as const, error: "申请日期不能为空" };
  const date = new Date(dateStr);
  const redeemLike = subtype === "redeem" || subtype === "switch_out";
  const validSubtypes = Object.values(FundSubtype);
  const fundSubtypeValue: FundSubtype = validSubtypes.includes(subtype as FundSubtype) ? (subtype as FundSubtype) : FundSubtype.buy;
  const isDividendReinvest = fundSubtypeValue === FundSubtype.dividend_reinvest;
  const isDividendCash = fundSubtypeValue === FundSubtype.dividend_cash;
  const signedAmount = redeemLike ? (fundArrivalAmount ?? Math.max(0, amountAbs - (fundFee ?? 0))) : (isDividendCash ? amountAbs : -amountAbs);

  try {
    // 直接查询 TxRecord
    const txRecord = await prisma.txRecord.findUnique({
      where: { id: entryId },
    });

    if (!txRecord) return { ok: false as const, error: "基金记录不存在" };

    // 买入类：accountId=资金账户(发起), toAccountId=投资账户(接收)
    // 赎回/现金红利/buy_failed退回：accountId=投资账户(发起), toAccountId=资金账户(接收)
    const isRedeemOrRefund = txRecord.fundSubtype === "redeem" || txRecord.fundSubtype === "switch_out"
      || txRecord.fundSubtype === "dividend_cash"
      || (txRecord.fundSubtype === "buy_failed" && txRecord.source === "regular_invest_refund");
    const oldInvestmentAccId = (isRedeemOrRefund ? txRecord.accountId : txRecord.toAccountId) ?? "";
    const oldCashAccId = (isRedeemOrRefund ? txRecord.toAccountId : txRecord.accountId) ?? "";
    const oldFundCode = txRecord.fundCode;

    // 检测是否有新的基金账户（通过toAccountId字段传递）
    const hasNewToAccountId = formData.has("toAccountId");
    const newToAccountIdStr = String(formData.get("toAccountId") ?? "").trim();
    const newToAccountId = hasNewToAccountId && newToAccountIdStr ? newToAccountIdStr : null;

    await prisma.$transaction(async (tx) => {
      // 先查询资金账户信息（如果需要）
      const cashAccountInfo = cashAccountId
        ? await tx.account.findUnique({ where: { id: cashAccountId }, select: { id: true, name: true } })
        : null;

      // 查询新基金账户信息（如果需要）
      const newInvestmentAccountInfo = newToAccountId
        ? await tx.account.findUnique({ where: { id: newToAccountId }, select: { id: true, name: true } })
        : null;

      // 构建 TxRecord 更新数据
      const sourceValue = isDividendReinvest ? "dividend" : (String(formData.get("source") ?? txRecord.source ?? "manual").trim() || "manual");
      const finalFundSubtype: FundSubtype = isDividendReinvest ? FundSubtype.buy : fundSubtypeValue;
      const updateData: any = {
        date,
        fundCode,
        fundName,
        fundProductType,
        fundSubtype: finalFundSubtype,
        source: sourceValue,
        fundUnits: fundUnits ?? null,
        fundNav: fundNav ?? null,
        fundFee: fundFee ?? null,
        fundConfirmDate: fundConfirmDate ?? null,
        fundArrivalDate: fundArrivalDate ?? null,
        fundArrivalAmount: fundArrivalAmount ?? null,
        note: memo || null,
      };

        // buy_failed 退回：与赎回同方向(accountId=投资, toAccountId=现金)
        const isBuyFailedRefund = fundSubtypeValue === FundSubtype.buy_failed && txRecord.source === "regular_invest_refund";

        // 处理基金账户和资金账户（使用表单方向，可能与数据库记录不同）
        if (redeemLike || isDividendCash || isBuyFailedRefund) {
          // 赎回/转出/现金红利/buy_failed退回：accountId=投资账户(发起), toAccountId=现金账户(接收)
          if (newInvestmentAccountInfo) {
            updateData.accountId = newInvestmentAccountInfo.id;
            updateData.accountName = newInvestmentAccountInfo.name;
          }
          if (cashAccountInfo) {
            updateData.toAccountId = cashAccountInfo.id;
            updateData.toAccountName = cashAccountInfo.name;
          } else {
            updateData.toAccountId = newToAccountId ?? oldInvestmentAccId;
            updateData.toAccountName = newInvestmentAccountInfo?.name ?? txRecord.accountName ?? "";
          }
          updateData.amount = isDividendCash ? amountAbs : signedAmount;
          updateData.deletedAt = null;
        } else {
          // 买入/dividend_reinvest：toAccountId=投资账户(接收)
          if (newInvestmentAccountInfo) {
            updateData.toAccountId = newInvestmentAccountInfo.id;
            updateData.toAccountName = newInvestmentAccountInfo.name;
          }
          // accountId 和 amount
          if (cashAccountInfo) {
            updateData.accountId = cashAccountInfo.id;
            updateData.accountName = cashAccountInfo.name;
            updateData.amount = signedAmount;
            updateData.deletedAt = null;
          } else if (fundSubtypeValue === FundSubtype.dividend_reinvest) {
            const investmentAccId = newInvestmentAccountInfo?.id ?? oldInvestmentAccId;
            updateData.accountId = investmentAccId;
            updateData.accountName = newInvestmentAccountInfo?.name ?? txRecord.toAccountName ?? "";
            updateData.amount = amountAbs;
          } else {
            const fallbackAccountId = newToAccountId ?? oldInvestmentAccId;
            updateData.accountId = fallbackAccountId;
            updateData.accountName = newInvestmentAccountInfo?.name ?? txRecord.toAccountName ?? "";
            updateData.amount = signedAmount;
            updateData.deletedAt = null;
          }
        }

      await tx.txRecord.update({
        where: { id: entryId },
        data: updateData,
      });
    });

    // 重算持仓：如果基金账户变更，需要重算旧账户和新账户
    const finalInvestmentAccId = newToAccountId ?? oldInvestmentAccId;
    const recalcCodes = Array.from(new Set([oldFundCode, fundCode].filter((code): code is string => !!code)));

    if (oldInvestmentAccId && oldInvestmentAccId !== finalInvestmentAccId) {
      // 基金账户变更：重算旧账户和新账户
      await recalcFundPositions(oldInvestmentAccId, recalcCodes.length > 0 ? recalcCodes : undefined).catch((e) => { console.error("editInvestment recalc old fund positions:", e); });
      await recalcFundPositions(finalInvestmentAccId, recalcCodes.length > 0 ? recalcCodes : undefined).catch((e) => { console.error("editInvestment recalc new fund positions:", e); });
    } else if (finalInvestmentAccId) {
      // 基金账户未变更：只重算该账户
      await recalcFundPositions(finalInvestmentAccId, recalcCodes.length > 0 ? recalcCodes : undefined).catch((e) => { console.error("editInvestment recalc fund positions:", e); });
    }

    // 重算投资账户余额
    await recalcAndSaveAccountBalance(finalInvestmentAccId).catch((e) => { console.error("editInvestment recalc invest balance:", e); });
    if (oldInvestmentAccId && oldInvestmentAccId !== finalInvestmentAccId) {
      await recalcAndSaveAccountBalance(oldInvestmentAccId).catch((e) => { console.error("editInvestment recalc old invest balance:", e); });
    }

    // 重算资金账户余额（如果资金账户变更）
    if (oldCashAccId && oldCashAccId !== finalInvestmentAccId) {
      await recalcAndSaveAccountBalance(oldCashAccId).catch((e) => { console.error("editInvestment recalc old cash balance:", e); });
    }
    if (cashAccountId && cashAccountId !== oldCashAccId && cashAccountId !== finalInvestmentAccId) {
      await recalcAndSaveAccountBalance(cashAccountId).catch((e) => { console.error("editInvestment recalc new cash balance:", e); });
    }

    // 更新 T+N 确认天数到统一确认天数库
    if (finalInvestmentAccId && fundCode && confirmDays !== undefined && confirmDays !== null) {
      await setFundConfirmDays(finalInvestmentAccId, fundCode, confirmDays).catch(() => {});
    }

    // 更新费率到统一费率库，并按申购/赎回分开保存
    if (finalInvestmentAccId && fundCode && feeRate !== undefined && feeRate !== null) {
      await setFundFeeRateByDate(finalInvestmentAccId, fundCode, feeRate, date, redeemLike ? "redeem" : "buy").catch(() => {});
    }

    revalidatePath("/");
    revalidatePath("/invest");
    revalidatePath("/overview");
    revalidatePath("/funds");
    revalidatePath("/accounts");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "保存失败" };
  }
}

async function fillFundNavFromCache(formData: FormData) {
  "use server";

  const entryId = String(formData.get("entryId") ?? "").trim();
  if (!entryId) return { ok: false as const, error: "缺少 entryId" };

  try {
    const txRecord = await prisma.txRecord.findUnique({
      where: { id: entryId },
      select: {
        id: true,
        accountId: true,
        toAccountId: true,
        fundCode: true,
        fundConfirmDate: true,
        date: true,
        amount: true,
        fundSubtype: true,
        fundFee: true,
      },
    });

    if (!txRecord) return { ok: false as const, error: "基金记录不存在" };
    if (!txRecord.fundCode) return { ok: false as const, error: "该记录无基金代码" };

    // 买入类：accountId=资金账户, toAccountId=投资账户
    // 赎回类：accountId=投资账户, toAccountId=资金账户
    const isRedeemFill = txRecord.fundSubtype === "redeem" || txRecord.fundSubtype === "switch_out";
    const investmentAccId = isRedeemFill ? txRecord.accountId : txRecord.toAccountId;
    if (!investmentAccId) return { ok: false as const, error: "该记录没有关联投资账户" };

    const applyDate = ymdUtc(txRecord.date);
    const confirmDate = txRecord.fundConfirmDate
      ? ymdUtc(txRecord.fundConfirmDate)
      : addWorkdaysUtc(applyDate, await getFundConfirmDays(investmentAccId, txRecord.fundCode));
    const navDate = new Date(`${confirmDate}T00:00:00.000Z`);
    const navData = await getFundNav(txRecord.fundCode, navDate);

    if (!navData) {
      return { ok: false as const, error: `API 未能获取 ${txRecord.fundCode} 在 ${confirmDate} 的净值，确认日期可能是非交易日，或基金查询API未配置` };
    }
    if (!navData.dateMatch) {
      return { ok: false as const, error: `${txRecord.fundCode} 在 ${confirmDate} 无净值，该日期可能是非交易日，请检查确认日期是否正确` };
    }

    const nav = navData.nav;
    const amount = Math.abs(toNumber(txRecord.amount));

    // 从费率库查询费率（按确认日期）
    const feeType = isRedeemFill ? "redeem" : "buy";
    const feeRate = await getFundFeeRateByDate(investmentAccId, txRecord.fundCode, navDate, feeType);
    const fee = amount * feeRate;
    const principal = amount - fee;
    const units = nav > 0 ? principal / nav : null;

    // 更新净值、确认日期、手续费、份额
    const updateData: {
      fundConfirmDate: Date;
      fundNav: number;
      fundFee: number;
      fundUnits?: number;
      fundName?: string;
    } = {
      fundConfirmDate: navDate,
      fundNav: nav,
      fundFee: fee,
    };
    if (units != null) {
      updateData.fundUnits = Number(units.toFixed(6));
    }
    if (navData.name) {
      updateData.fundName = navData.name;
    }

    await prisma.txRecord.update({
      where: { id: entryId },
      data: updateData,
    });

    await recalcFundPositions(investmentAccId, [txRecord.fundCode]).catch(() => {});
    revalidatePath("/");
    revalidatePath("/invest");
    revalidatePath("/overview");
    return { ok: true as const, nav, units: units != null ? Number(units.toFixed(6)) : null, fee, confirmDate };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "获取净值失败" };
  }
}



async function createRegularInvest(formData: FormData) {
  "use server";
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "createRegularInvest") return { ok: false as const, error: "intent 不匹配" };

  const accountId = String(formData.get("accountId") ?? "").trim();
  const fundCode = String(formData.get("fundCode") ?? "").trim();
  const fundName = String(formData.get("fundName") ?? "").trim() || fundCode;
  const amountRaw = parseFloat(String(formData.get("amount") ?? ""));
  const intervalUnit = String(formData.get("intervalUnit") ?? "month").trim();
  const intervalValueRaw = parseInt(String(formData.get("intervalValue") ?? "1"), 10);
  const startDateStr = String(formData.get("startDate") ?? "").trim();
  const endDateStr = String(formData.get("endDate") ?? "").trim();
  const totalRunsRaw = String(formData.get("totalRuns") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim() || null;
  const feeRateRaw = String(formData.get("feeRate") ?? "").trim();
  const confirmDaysRaw = String(formData.get("confirmDays") ?? "").trim();
  const skipPendingPreceding = formData.get("skipPendingPreceding") !== "false"; // default true

  if (!accountId || !fundCode || !amountRaw || !startDateStr) {
    return { ok: false as const, error: "缺少必填字段" };
  }
  if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
    return { ok: false as const, error: "金额不正确" };
  }

  const fundAcc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!fundAcc) return { ok: false as const, error: "基金账户不存在" };

  const cashAcc = cashAccountId
    ? await prisma.account.findUnique({ where: { id: cashAccountId }, select: { id: true, name: true } })
    : null;

  const startDate = new Date(startDateStr);
  // 跳过周末
  const dayOfWeek = startDate.getUTCDay();
  if (dayOfWeek === 0) startDate.setUTCDate(startDate.getUTCDate() + 1);
  else if (dayOfWeek === 6) startDate.setUTCDate(startDate.getUTCDate() + 2);

  const feeRate = feeRateRaw ? parseFloat(feeRateRaw) : null;
  const confirmDays = confirmDaysRaw ? parseInt(confirmDaysRaw, 10) : null;
  const intervalValue = Number.isFinite(intervalValueRaw) && intervalValueRaw > 0 ? intervalValueRaw : 1;
  const endDate = endDateStr ? new Date(endDateStr) : null;
  const totalRuns = totalRunsRaw ? parseInt(totalRunsRaw, 10) : null;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.regularInvestPlan.create({
        data: {
          accountId,
          accountName: fundAcc.name,
          cashAccountId: cashAccountId || null,
          cashAccountName: cashAcc?.name || null,
          fundCode,
          fundName,
          amount: amountRaw,
          intervalUnit: intervalUnit as IntervalUnit,
          intervalValue,
          startDate,
          nextRunDate: startDate,
          endDate: endDate && Number.isFinite(endDate.getTime()) ? endDate : null,
          totalRuns: totalRuns && Number.isFinite(totalRuns) && totalRuns > 0 ? totalRuns : null,
          status: RegularInvestStatus.active,
          feeRate: feeRate != null && Number.isFinite(feeRate) ? feeRate : null,
          confirmDays: confirmDays != null && Number.isFinite(confirmDays) ? confirmDays : null,
          skipPendingPreceding,
        },
      });

      // 同步更新确认天数和手续费率统一库（与 API Route 保持一致）
      const newDays = confirmDays != null && Number.isFinite(confirmDays) ? confirmDays : 1;
      const newRate = feeRate != null && Number.isFinite(feeRate) ? feeRate : 0;
      if (accountId && fundCode) {
        await setFundConfirmDaysInTx(tx, accountId, fundCode, newDays);
        await setFundFeeRateInTx(tx, accountId, fundCode, newRate);
      }
    });

    revalidatePath("/");
    revalidatePath("/invest");
    revalidatePath("/overview");
    revalidatePath("/funds");
    revalidatePath("/accounts");
    revalidatePath("/regular-invest");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "创建失败" };
  }
}

async function regularInvestAction(formData: FormData) {
  "use server";
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "regularInvestAction") return { ok: false as const, error: "intent 不匹配" };

  const planId = String(formData.get("planId") ?? "").trim();
  const actionType = String(formData.get("action") ?? "").trim();

  if (!planId) return { ok: false as const, error: "缺少 planId" };

  const plan = await prisma.regularInvestPlan.findUnique({ where: { id: planId } });
  if (!plan) return { ok: false as const, error: "计划不存在" };

  try {
    if (actionType === "pause") {
      if (plan.status !== RegularInvestStatus.active) {
        return { ok: false as const, error: "只有活跃状态的计划才能暂停" };
      }
      await prisma.regularInvestPlan.update({
        where: { id: planId },
        data: { status: RegularInvestStatus.paused },
      });
    } else if (actionType === "resume") {
      if (plan.status !== RegularInvestStatus.paused) {
        return { ok: false as const, error: "只有暂停状态的计划才能恢复" };
      }
      // 恢复时重新计算下次执行日期
      const now = new Date();
      const nextRun = plan.lastRunDate
        ? new Date(plan.lastRunDate.getTime() + (plan.intervalUnit === "day" ? plan.intervalValue * 86400000 : plan.intervalUnit === "week" ? plan.intervalValue * 7 * 86400000 : plan.intervalUnit === "biweek" ? plan.intervalValue * 14 * 86400000 : 30 * 86400000))
        : plan.nextRunDate;
      const actualNextRun = nextRun < now ? new Date(now.getTime() + (plan.intervalUnit === "day" ? plan.intervalValue * 86400000 : plan.intervalUnit === "week" ? plan.intervalValue * 7 * 86400000 : plan.intervalUnit === "biweek" ? plan.intervalValue * 14 * 86400000 : 30 * 86400000)) : nextRun;
      // 跳过周末
      const dow = actualNextRun.getUTCDay();
      if (dow === 0) actualNextRun.setUTCDate(actualNextRun.getUTCDate() + 1);
      else if (dow === 6) actualNextRun.setUTCDate(actualNextRun.getUTCDate() + 2);

      await prisma.regularInvestPlan.update({
        where: { id: planId },
        data: { status: RegularInvestStatus.active, nextRunDate: actualNextRun },
      });
    } else if (actionType === "stop") {
      if (plan.status === RegularInvestStatus.stopped || plan.status === RegularInvestStatus.completed) {
        return { ok: false as const, error: "计划已终止或已完成" };
      }
      await prisma.regularInvestPlan.update({
        where: { id: planId },
        data: { status: RegularInvestStatus.stopped },
      });
    } else {
      return { ok: false as const, error: "未知操作类型" };
    }

    revalidatePath("/");
    revalidatePath("/invest");
    revalidatePath("/overview");
    revalidatePath("/funds");
    revalidatePath("/accounts");
    revalidatePath("/regular-invest");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "操作失败" };
  }
}

async function updateRegularInvest(formData: FormData) {
  "use server";
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "updateRegularInvest") return { ok: false as const, error: "intent 不匹配" };

  const planId = String(formData.get("planId") ?? "").trim();
  if (!planId) return { ok: false as const, error: "缺少 planId" };

  const plan = await prisma.regularInvestPlan.findUnique({ where: { id: planId } });
  if (!plan) return { ok: false as const, error: "计划不存在" };

  const fundName = String(formData.get("fundName") ?? "").trim();
  const amountRaw = parseFloat(String(formData.get("amount") ?? ""));
  const intervalUnit = String(formData.get("intervalUnit") ?? "").trim();
  const intervalValueRaw = parseInt(String(formData.get("intervalValue") ?? "1"), 10);
  const startDateStr = String(formData.get("startDate") ?? "").trim();
  const endDateStr = String(formData.get("endDate") ?? "").trim();
  const totalRunsRaw = String(formData.get("totalRuns") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim() || null;
  const feeRateRaw = String(formData.get("feeRate") ?? "").trim();
  const confirmDaysRaw = String(formData.get("confirmDays") ?? "").trim();

  const updateData: any = {};
  if (fundName) updateData.fundName = fundName;
  if (Number.isFinite(amountRaw) && amountRaw > 0) updateData.amount = amountRaw;
  if (intervalUnit) updateData.intervalUnit = intervalUnit as IntervalUnit;
  if (Number.isFinite(intervalValueRaw) && intervalValueRaw > 0) updateData.intervalValue = intervalValueRaw;
  if (startDateStr) updateData.startDate = new Date(startDateStr);
  if (endDateStr) {
    const endDate = new Date(endDateStr);
    if (Number.isFinite(endDate.getTime())) updateData.endDate = endDate;
  } else if (formData.has("endDate")) {
    updateData.endDate = null;
  }
  if (totalRunsRaw) {
    const totalRuns = parseInt(totalRunsRaw, 10);
    if (Number.isFinite(totalRuns) && totalRuns > 0) updateData.totalRuns = totalRuns;
  } else if (formData.has("totalRuns")) {
    updateData.totalRuns = null;
  }
  if (cashAccountId != null) {
    updateData.cashAccountId = cashAccountId;
    if (cashAccountId) {
      const cashAcc = await prisma.account.findUnique({ where: { id: cashAccountId }, select: { name: true } });
      updateData.cashAccountName = cashAcc?.name || null;
    } else {
      updateData.cashAccountName = null;
    }
  }
  if (feeRateRaw) {
    const feeRate = parseFloat(feeRateRaw);
    if (Number.isFinite(feeRate)) updateData.feeRate = feeRate;
  } else if (formData.has("feeRate")) {
    updateData.feeRate = null;
  }
  if (confirmDaysRaw) {
    const confirmDays = parseInt(confirmDaysRaw, 10);
    if (Number.isFinite(confirmDays)) updateData.confirmDays = confirmDays;
  } else if (formData.has("confirmDays")) {
    updateData.confirmDays = null;
  }

  try {
    await prisma.regularInvestPlan.update({
      where: { id: planId },
      data: updateData,
    });

    revalidatePath("/");
    revalidatePath("/invest");
    revalidatePath("/overview");
    revalidatePath("/funds");
    revalidatePath("/accounts");
    revalidatePath("/regular-invest");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "更新失败" };
  }
}

async function deleteRegularInvest(formData: FormData) {
  "use server";
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "deleteRegularInvest") return { ok: false as const, error: "intent 不匹配" };

  const planId = String(formData.get("planId") ?? "").trim();
  if (!planId) return { ok: false as const, error: "缺少 planId" };

  const plan = await prisma.regularInvestPlan.findUnique({ where: { id: planId } });
  if (!plan) return { ok: false as const, error: "计划不存在" };

  const deleteRecords = formData.get("deleteRecords") === "1";

  try {
    if (deleteRecords && plan.accountId) {
      // 软删除关联的交易记录
      await prisma.txRecord.updateMany({
        where: { regularInvestPlanId: planId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }

    await prisma.regularInvestPlan.delete({ where: { id: planId } });

    if (plan.accountId && plan.fundCode) {
      await recalcFundPositions(plan.accountId, [plan.fundCode]).catch(() => {});
    }

    revalidatePath("/");
    revalidatePath("/invest");
    revalidatePath("/overview");
    revalidatePath("/funds");
    revalidatePath("/accounts");
    revalidatePath("/regular-invest");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "删除失败" };
  }
}

/** 定投操作的统一入口：根据 intent 分发到不同的 Server Action */
async function regularInvestFormAction(formData: FormData) {
  "use server";
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent === "createRegularInvest") return createRegularInvest(formData);
  if (intent === "regularInvestAction") return regularInvestAction(formData);
  if (intent === "updateRegularInvest") return updateRegularInvest(formData);
  if (intent === "deleteRegularInvest") return deleteRegularInvest(formData);
  return { ok: false as const, error: "未知 intent" };
}

async function updateTransactionFromDialog(formData: FormData) {
  "use server";

  const entryId = String(formData.get("entryId") ?? "").trim();
  if (!entryId) return { ok: false as const, error: "缺少 entryId" };

  const type = String(formData.get("type") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const amountRaw = parseMoneyInput(formData.get("amount") ?? null);
  const amountAbs = amountRaw > 0 ? Math.abs(amountRaw) : 0;
  const note = String(formData.get("note") ?? "").trim();

  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
  if (!amountAbs) return { ok: false as const, error: "金额不正确" };

  try {
    await prisma.$transaction(async (tx) => {
      const entry = await tx.txRecord.findUnique({
        where: { id: entryId },
        
      });
      if (!entry) throw new Error("记录不存 ");

      if (type === "transfer") {
        const fromAccountId = String(formData.get("fromAccountId") ?? "").trim();
        const toAccountId = String(formData.get("toAccountId") ?? "").trim();
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
        // 编辑模式：accountId=投资账户(统一), cashAccountId=资金账户
        const accountIdFormData = String(formData.get("accountId") ?? "").trim();
        const cashAccountIdFormData = String(formData.get("cashAccountId") ?? "").trim();
        const fundCode = String(formData.get("fundCode") ?? "").trim();
        const productType = String(formData.get("productType") ?? "fund").trim();
        const subtype = String(formData.get("subtype") ?? "buy").trim();
        const redeemLike = subtype === "redeem" || subtype === "switch_out";

        const investAcc = accountIdFormData ? await tx.account.findUnique({ where: { id: accountIdFormData } }) : null;
        if (!investAcc) throw new Error("请选择投资账户");

        // 资金账户：优先用表单传入的，否则从原始记录推断
        let cashAccId: string | null = null;
        let cashAccName: string | null = null;
        if (cashAccountIdFormData) {
          const cashAcc = await tx.account.findUnique({ where: { id: cashAccountIdFormData } });
          if (cashAcc) { cashAccId = cashAcc.id; cashAccName = cashAcc.name; }
        }
        // 回退：从原始记录推断资金账户
        if (!cashAccId) {
          if (redeemLike) {
            // 赎回记录：toAccountId 是资金账户（接收方）
            if (entry.toAccountId) {
              const acc = await tx.account.findUnique({ where: { id: entry.toAccountId } });
              if (acc) { cashAccId = acc.id; cashAccName = acc.name; }
            }
          } else {
            // 买入记录：accountId 是资金账户（发起方）
            if (entry.accountId && entry.accountId !== investAcc.id) {
              const acc = await tx.account.findUnique({ where: { id: entry.accountId } });
              if (acc) { cashAccId = acc.id; cashAccName = acc.name; }
            }
          }
        }

        // 确定记录方向：toAccountId = 资金收到方
        let recordAccountId: string;
        let recordAccountName: string;
        let recordToAccountId: string;
        let recordToAccountName: string;
        let signedAmount: number;

        const fundArrivalAmount = parseFloat(String(formData.get("fundArrivalAmount") ?? ""));
        const fundFee = parseFloat(String(formData.get("fundFee") ?? ""));

        if (redeemLike) {
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = cashAccId ?? investAcc.id;
          recordToAccountName = cashAccName ?? investAcc.name;
          signedAmount = Number.isFinite(fundArrivalAmount) && fundArrivalAmount > 0
            ? fundArrivalAmount
            : Math.max(0, amountAbs - (Number.isFinite(fundFee) && fundFee > 0 ? fundFee : 0));
        } else {
          recordAccountId = cashAccId ?? investAcc.id;
          recordAccountName = cashAccName ?? investAcc.name;
          recordToAccountId = investAcc.id;
          recordToAccountName = investAcc.name;
          signedAmount = -amountAbs;
        }

        // 更新 TxRecord
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

        await recalcFundPositions(investAcc.id, fundCode ? [fundCode] : undefined).catch(() => {});
        return;
      }

      if (type !== "expense" && type !== "income") throw new Error("类型不正确");
      const accountId = String(formData.get("accountId") ?? "").trim();
      const categoryId = String(formData.get("categoryId") ?? "").trim();
      const keepFundDetail = formData.get("keepFundDetail") === "true";

      const [acc, cat] = await Promise.all([
        accountId ? tx.account.findUnique({ where: { id: accountId } }) : Promise.resolve(null),
        categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
      ]);
      if (!acc) throw new Error("请选择账户");
      if (acc.kind === AccountKind.investment) throw new Error("基金/理财账户不参与收支记账");

      // 检查是否是基金交易（通过 toAccountId + fundProductType）
      const isFundTransaction = entry.toAccountId && entry.fundProductType;

      if (isFundTransaction) {
        if (keepFundDetail) {
          // 保留基金明细，但清空资金账户关联
          await tx.txRecord.update({
            where: { id: entryId },
            data: {
              accountId: entry.toAccountId ?? undefined,
              accountName: entry.toAccountName ?? "",
              amount: Math.abs(Number(entry.amount)), // 改为正数
            } as any,
          });
        } else {
          // 清空基金字段，转为普通交易
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

    revalidatePath("/");
    revalidatePath("/overview");
    revalidatePath("/accounts");
    return { ok: true as const };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "保存失败";
    return { ok: false as const, error: msg };
  }
}

async function backfillStatementMonthForAccount(formData: FormData) {
  "use server";

  const accountId = String(formData.get("accountId") ?? "").trim();
  if (!accountId) return;

  await prisma.$transaction(async (tx) => {
    const acc = await tx.account.findUnique({
      where: { id: accountId },
      include: { Institution: true },
    });
    if (!acc?.billingDay) return;
    if (acc.kind !== AccountKind.bank_credit && acc.kind !== AccountKind.loan) return;

    const inst = (acc.Institution?.name ?? "").trim();
    const legacyNames = [acc.name, inst ? `${inst}·${acc.name}` : ""].filter(Boolean);

    const rows = await tx.txRecord.findMany({
      where: {
        statementMonth: null,
        deletedAt: null,
        OR: [
          { accountId: acc.id },
          ...(legacyNames.length ? [{ accountName: { in: legacyNames } }] : []),
        ],
      },
      select: { id: true, date: true },
      take: 20000,
    });

    const byMonth = new Map<string, string[]>();
    for (const r of rows) {
      const m = toStatementMonth(r.date, acc.billingDay);
      const list = byMonth.get(m) ?? [];
      list.push(r.id);
      byMonth.set(m, list);
    }

    for (const [m, ids] of byMonth.entries()) {
      await tx.txRecord.updateMany({
        where: { id: { in: ids } },
        data: { statementMonth: m },
      });
    }
  });

  revalidatePath("/");
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{
    account?: string;
    accountId?: string;
    view?: string;
    billMonth?: string;
    hideZeroBills?: string;
    hideSettledBills?: string;
    billMonthsLimit?: string;
    billPage?: string;
    pageSize?: string;
    detailPage?: string;
    symbol?: string;
    fundCode?: string;
    fundSort?: string;
    fundSortDir?: string;
    fundPageSize?: string;
    fundPage?: string;
    showCleared?: string;
  }>;
}) {
  const params = await searchParams;
  await connection();
  const accountId = typeof params?.accountId === "string" ? params.accountId.trim() : "";
  const accountName = typeof params?.account === "string" ? params.account.trim() : "";
  const viewParam = params?.view === "bill" ? "bill" : params?.view === "detail" ? "detail" : params?.view === "investfund" ? "investfund" : params?.view === "investmoney" ? "investmoney" : params?.view === "regularinvest" ? "regularinvest" : "";
  const billMonthParam = typeof params?.billMonth === "string" ? params.billMonth.trim() : "";
  const hideZeroBills = params?.hideZeroBills === "1";
  const hideSettledBills = params?.hideSettledBills === "1";
  const billMonthsLimitParam = typeof params?.billMonthsLimit === "string" ? parseInt(params.billMonthsLimit, 10) : 999;
  const billMonthsLimit = Number.isFinite(billMonthsLimitParam) && billMonthsLimitParam > 0 ? billMonthsLimitParam : 999;
  const billPageParam = typeof params?.billPage === "string" ? parseInt(params.billPage, 10) : 1;
  const billPage = Number.isFinite(billPageParam) && billPageParam >= 1 ? billPageParam : 1;
  const pageSizeParam = typeof params?.pageSize === "string" ? parseInt(params.pageSize, 10) : 20;
  const pageSize = [10, 20, 40].includes(pageSizeParam) ? pageSizeParam : 20;
  const detailPageParam = typeof params?.detailPage === "string" ? parseInt(params.detailPage, 10) : 1;
  const detailPage = Number.isFinite(detailPageParam) && detailPageParam >= 1 ? detailPageParam : 1;
  const fundCodeParam = typeof params?.fundCode === "string" ? params.fundCode.trim() : "";
  const fundSortParam = typeof params?.fundSort === "string" ? params.fundSort.trim() : "marketValue";
  const fundSortDirParam = params?.fundSortDir === "asc" ? "asc" : "desc";
  const fundPageSizeParam = typeof params?.fundPageSize === "string" ? parseInt(params.fundPageSize, 10) : 20;
  const fundPageSize = [10, 20, 40].includes(fundPageSizeParam) ? fundPageSizeParam : 20;
  const fundPageParam = typeof params?.fundPage === "string" ? parseInt(params.fundPage, 10) : 1;
  const fundPage = Number.isFinite(fundPageParam) && fundPageParam >= 1 ? fundPageParam : 1;
  const showCleared = params?.showCleared === "1";

  // 读取涨跌颜色方案
  const cookieStore = await cookies();
  const colorScheme = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") as "red_up_green_down" | "green_up_red_down";
  const isRedUp = colorScheme === "red_up_green_down";
  // 颜色辅助函数
  const upCls = isRedUp ? "text-red-600" : "text-emerald-700";
  const downCls = isRedUp ? "text-emerald-700" : "text-red-600";
  const pnlCls = (n: number) => n > 0 ? upCls : n < 0 ? downCls : "text-slate-600";
  const pnlBinCls = (cond: boolean) => cond ? upCls : downCls;

  const [categories, selectedAccount, accounts] = await Promise.all([
    prisma.category.findMany({
      orderBy: [{ type: "asc" }, { name: "asc" }],
    }),
    accountId
      ? prisma.account.findUnique({ where: { id: accountId }, include: { Institution: true, AccountGroup: true } })
      : null,
    prisma.account.findMany({
      include: { Institution: true },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    }),
  ]);

  const legacyNames = (() => {
    if (!selectedAccount) return [];
    const set = new Set<string>();
    set.add(selectedAccount.name);
    const inst = (selectedAccount.Institution?.name ?? "").trim();
    if (inst) set.add(`${inst}·${selectedAccount.name}`);
    return [...set].filter(Boolean);
  })();

  const where = accountId
    ? legacyNames.length
      ? {
          OR: [
            { accountId },
            { toAccountId: accountId },
            ...legacyNames.map((n) => ({ accountName: n })),
          ],
          deletedAt: null,
        }
      : {
          OR: [{ accountId }, { toAccountId: accountId }],
          deletedAt: null,
        }
    : accountName
      ? { accountName: accountName, deletedAt: null }
      : { deletedAt: null, account: { kind: { not: AccountKind.investment } } };

  const entries = await prisma.txRecord.findMany({
    where,
    include: { EntryTag: { include: { Tag: true } } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 5000,
  });
  const detailTotalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const safeDetailPage = Math.min(detailPage, detailTotalPages);
  const pagedEntries = entries.slice((safeDetailPage - 1) * pageSize, safeDetailPage * pageSize);

  const isBillAccount =
    (selectedAccount?.kind === AccountKind.bank_credit || selectedAccount?.kind === AccountKind.loan) ||
    !!selectedAccount?.billingDay;
  const isInvestAccount = selectedAccount?.kind === AccountKind.investment;
  const view = viewParam ? viewParam : isBillAccount ? "bill" : isInvestAccount ? (selectedAccount?.investProductType === "money" ? "investmoney" : "investfund") : "detail";

  const categoryLabels = buildCategoryPathLabels(categories);
  const expenseCategories = categories
    .filter((c) => c.type === "expense")
    .map((c) => ({ ...c, label: categoryLabels.get(c.id) ?? c.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
  const incomeCategories = categories
    .filter((c) => c.type === "income")
    .map((c) => ({ ...c, label: categoryLabels.get(c.id) ?? c.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));

  const total = entries.reduce(
    (acc, e) => {
      const amount = toNumber(e.amount);
      const isInvestAccountEntry = accountId && (e.toAccountId === accountId || e.accountId === accountId);
      // 确定对当前账户而言的资金方向
      // 规则：toAccountId = 资金收到方
      // 对于当前账户：资金流入当前账户 → 正数(in)，流出 → 负数(out)
      const effectiveAmount = isInvestAccountEntry
        ? (e.toAccountId === accountId ? Math.abs(amount) : amount)
        : (!accountId ? amount : (e.toAccountId === accountId ? Math.abs(amount) : amount));
      if (effectiveAmount >= 0) acc.in += effectiveAmount;
      else acc.out += -effectiveAmount;
      acc.net += effectiveAmount;
      return acc;
    },
    { in: 0, out: 0, net: 0 },
  );

  const balanceByEntryId = new Map<string, number>();
  if (where) {
    const asc = await prisma.txRecord.findMany({
      where,
      include: {},
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      take: 5000,
    });
    let running = 0;
    for (const e of asc) {
      const amount = toNumber(e.amount);
      const isToAccount = accountId && e.toAccountId === accountId;
      running += isToAccount ? Math.abs(amount) : amount;
      balanceByEntryId.set(e.id, running);
    }
  }

  const selectedAccountLabel = (() => {
    if (selectedAccount) {
      const inst = (selectedAccount.Institution?.name ?? "").trim();
      return inst ? `${inst}·${selectedAccount.name}` : selectedAccount.name;
    }
    return accountName || "";
  })();

  const accountOptions = accounts.map((a) => ({
    id: a.id,
    kind: a.kind,
    label: a.Institution?.name ? `${a.Institution?.name}·${a.name}` : a.name,
  }));
  const spendingAccountOptions = accounts
    .filter((a) => a.kind !== AccountKind.investment)
    .map((a) => ({
      id: a.id,
      label: a.Institution?.name ? `${a.Institution.name}·${a.name}` : a.name,
    }));
  const investmentAccountOptions = accounts
    .filter((a) => a.kind === AccountKind.investment)
    .map((a) => ({
      id: a.id,
      name: a.name,
      label: a.Institution?.name ? `${a.Institution.name}·${a.name}` : a.name,
    }));
  const accountLabelById = new Map(accountOptions.map((a) => [a.id, a.label]));

  // 查询最近使用的资金账户
  const lastUsedCashAccount = isInvestAccount && accountId
    ? await prisma.txRecord.findFirst({
        where: {
          toAccountId: accountId,
          fundProductType: { not: null },
          accountId: { not: accountId },
          deletedAt: null,
        },
        orderBy: { createdAt: "desc" },
        select: { accountId: true },
      })
    : null;

  const billScope = selectedAccount
    ? {
        OR: [
          { accountId: selectedAccount.id },
          { toAccountId: selectedAccount.id },
          ...legacyNames.map((n) => ({ accountName: n })),
        ],
      }
    : undefined;

  const availableBillMonths =
    isBillAccount && selectedAccount
      ? await prisma.txRecord
          .groupBy({
            by: ["statementMonth"],
            where: {
              statementMonth: { not: null },
              deletedAt: null,
              AND: [...(billScope ? [billScope] : [])],
            },
            _count: { _all: true },
            orderBy: { statementMonth: "desc" },
          })
          .then((rows) => rows.map((r) => r.statementMonth).filter((m): m is string => !!m))
      : [];

  const selectedBillMonth = /^(\d{4})-(\d{2})$/.test(billMonthParam) ? billMonthParam : "";

  const creditCardBill =
    isBillAccount && selectedAccount?.billingDay
      ? await (async () => {
          const base = selectedBillMonth
            ? cycleForStatementMonth(selectedBillMonth, selectedAccount.billingDay ?? 1, selectedAccount.repaymentDay ?? null, new Date())
            : creditCardCycle(new Date(), selectedAccount.billingDay ?? 1, selectedAccount.repaymentDay ?? null);
          if (!base) return null;

          const { start, end, due, today, isCurrentCycle } = base;
          const repayEnd = due && due.getTime() < today.getTime() ? due : today;
          const statementMonth = selectedBillMonth || toStatementMonth(end, selectedAccount.billingDay ?? 1);

          const cycleMatch = {
            OR: statementMonth
              ? [
                  { statementMonth, deletedAt: null },
                  {
                    statementMonth: null,
                    date: { gte: start, lt: addDaysUtc(end, 1) }, deletedAt: null,
                  },
                ]
              : [{ date: { gte: start, lt: addDaysUtc(end, 1) }, deletedAt: null }],
          };
          const repaymentMatch = {
            amount: { lt: 0 },
            toAccountId: selectedAccount.id,
            type: TransactionType.transfer,
            deletedAt: null,
            date: { gte: addDaysUtc(end, 1), lt: addDaysUtc(repayEnd, 1) },
          };
          const [expenseAgg, incomeAgg, transferIncomeAgg, paidAgg] = await Promise.all([
            prisma.txRecord.aggregate({
              where: {
                AND: [cycleMatch, ...(billScope ? [billScope] : []), { type: TransactionType.expense }],
              },
              _sum: { amount: true },
            }),
            prisma.txRecord.aggregate({
              where: {
                AND: [cycleMatch, ...(billScope ? [billScope] : []), { type: TransactionType.income }],
              },
              _sum: { amount: true },
            }),
            prisma.txRecord.aggregate({
              where: {
                AND: [
                  cycleMatch,
                  ...(billScope ? [billScope] : []),
                  { type: TransactionType.transfer },
                  { toAccountId: selectedAccount.id },
                  { amount: { lt: 0 } },
                ],
              },
              _sum: { amount: true },
            }),
            prisma.txRecord.aggregate({
              where: {
                AND: [repaymentMatch, ...(billScope ? [billScope] : [])],
              },
              _sum: { amount: true },
            }),
          ]);

          const transferIncome = Math.max(0, -toNumber(transferIncomeAgg._sum.amount ?? 0));
          const netCycle = toNumber(expenseAgg._sum.amount ?? 0) + toNumber(incomeAgg._sum.amount ?? 0) + transferIncome;
          const bill = Math.max(0, -netCycle);
          const paid = Math.max(0, -toNumber(paidAgg._sum.amount ?? 0));
          const remainRaw = bill - paid;
          const remain = Math.max(0, remainRaw);
          const overpaid = Math.max(0, -remainRaw);

          return { start, end, due, repayEnd, bill, paid, remain, overpaid, statementMonth, isCurrentCycle };
        })()
      : null;

  const currentStatementMonth = (() => {
    if (!isBillAccount || !selectedAccount?.billingDay) return "";
    const base = creditCardCycle(new Date(), selectedAccount.billingDay ?? 1, selectedAccount.repaymentDay ?? null);
    if (!base) return "";
    return toStatementMonth(base.end, selectedAccount.billingDay ?? 1);
  })();

  const settledBillMonth = (() => {
    if (!currentStatementMonth) return "";
    const m = currentStatementMonth.match(/^(\d{4})-(\d{2})$/);
    if (!m) return "";
    const y = Number(m[1]);
    const monthIndex = Number(m[2]) - 1;
    const d = new Date(Date.UTC(y, monthIndex - 1, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  })();

  const lastRepayToAccountId = await (async () => {
    if (!isBillAccount || !selectedAccount) return undefined;
    const lastEntry = await prisma.txRecord.findFirst({
      where: {
        accountId: selectedAccount.id,
        type: TransactionType.transfer,
        amount: { gt: 0 },
      },
      orderBy: { date: "desc" },
      take: 1,
    });
    if (!lastEntry) return undefined;
    return lastEntry.toAccountId ?? undefined;
  })();

  const lastRepayFromAccountId = await (async () => {
    if (!isBillAccount || !selectedAccount) return undefined;
    const lastEntry = await prisma.txRecord.findFirst({
      where: {
        accountId: selectedAccount.id,
        type: TransactionType.transfer,
        amount: { gt: 0 },
      },
      orderBy: { date: "desc" },
      take: 1,
    });
    if (!lastEntry) return undefined;
    return lastEntry.toAccountId ?? undefined;
  })();

  const billMonthsForList = (() => {
    const months = new Set<string>();
    for (const m of availableBillMonths) months.add(m);
    if (currentStatementMonth) months.add(currentStatementMonth);
    if (selectedBillMonth) months.add(selectedBillMonth);

    if (months.size > 0 && !hideZeroBills) {
      const sorted = Array.from(months).sort((a, b) => a.localeCompare(b));
      const earliest = sorted[0];
      const latest = sorted[sorted.length - 1];
      const [ey, em] = earliest.split("-").map(Number);
      const [ly, lm] = latest.split("-").map(Number);
      for (let y = ey; y <= ly; y++) {
        const startM = y === ey ? em : 1;
        const endM = y === ly ? lm : 12;
        for (let m = startM; m <= endM; m++) {
          months.add(`${y}-${String(m).padStart(2, "0")}`);
        }
      }
    }

    return Array.from(months)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, billMonthsLimit);
  })();

  const billMonthsForCumulative = (() => {
    const merged = new Set<string>();
    if (currentStatementMonth) merged.add(currentStatementMonth);
    if (selectedBillMonth) merged.add(selectedBillMonth);
    for (const m of availableBillMonths) merged.add(m);

    const arr = Array.from(merged).sort((a, b) => a.localeCompare(b));
    if (arr.length === 0) return arr;
    const [ey, em] = arr[0]!.split("-").map(Number);
    const [ly, lm] = arr[arr.length - 1]!.split("-").map(Number);
    const full: string[] = [];
    for (let y = ey; y <= ly; y++) {
      const startM = y === ey ? em : 1;
      const endM = y === ly ? lm : 12;
      for (let m = startM; m <= endM; m++) {
        full.push(`${y}-${String(m).padStart(2, "0")}`);
      }
    }
    return full;
  })();

  const billSummariesAll =
    isBillAccount && selectedAccount?.billingDay && billMonthsForCumulative.length
      ? await Promise.all(
          billMonthsForCumulative.map(async (m) => {
            const base = cycleForStatementMonth(m, selectedAccount.billingDay ?? 1, selectedAccount.repaymentDay ?? null, new Date());
            if (!base) return null;

            const { start, end, due, today, isCurrentCycle } = base;
            const repayEnd = due && due.getTime() < today.getTime() ? due : today;

            const cycleWindow = {
              OR: [
                { statementMonth: m, deletedAt: null },
                {
                  statementMonth: null,
                  date: { gte: start, lt: addDaysUtc(end, 1) }, deletedAt: null,
                },
              ],
            };

            const [expenseAgg, incomeAgg, paidAgg, billPeriodTransferAgg] = await Promise.all([
              prisma.txRecord.aggregate({
                where: {
                  AND: [
                    cycleWindow,
                    ...(billScope ? [billScope] : []),
                    { type: TransactionType.expense },
                  ],
                },
                _sum: { amount: true },
              }),
              prisma.txRecord.aggregate({
                where: {
                  AND: [
                    cycleWindow,
                    ...(billScope ? [billScope] : []),
                    { type: TransactionType.income },
                  ],
                },
                _sum: { amount: true },
              }),
              prisma.txRecord.aggregate({
                where: {
                  AND: [
                    ...(billScope ? [billScope] : []),
                    { toAccountId: selectedAccount.id },
                    { amount: { lt: 0 } },
                    {
                      type: TransactionType.transfer,
                      date: { gte: addDaysUtc(end, 1), lt: addDaysUtc(repayEnd, 1) },
                    },
                  ],
                },
                _sum: { amount: true },
              }),
              prisma.txRecord.aggregate({
                where: {
                  AND: [
                    cycleWindow,
                    ...(billScope ? [billScope] : []),
                    { type: TransactionType.transfer },
                    { toAccountId: selectedAccount.id },
                    { amount: { lt: 0 } },
                  ],
                },
                _sum: { amount: true },
              }),
            ]);

            const expenseAbs = Math.max(0, -toNumber(expenseAgg._sum.amount ?? 0));
            const billPeriodTransferIncome = Math.max(0, -toNumber(paidAgg._sum.amount ?? 0));
            const income = Math.max(0, toNumber(incomeAgg._sum.amount ?? 0) + billPeriodTransferIncome);
            const netCycle = toNumber(expenseAgg._sum.amount) + toNumber(incomeAgg._sum.amount) + billPeriodTransferIncome;
            const bill = Math.max(0, -netCycle);
            const paid = Math.max(0, -toNumber(billPeriodTransferAgg._sum.amount ?? 0));
            const remainRaw = bill - paid;
            const remain = Math.max(0, remainRaw);
            const overpaid = Math.max(0, -remainRaw);

            return { month: m, start, end, due, bill, paid, remain, overpaid, expenseAbs, income, isCurrentCycle };
          }),
        ).then((xs) => xs.filter((x): x is NonNullable<typeof x> => !!x))
      : [];

  const billSummaryByMonth = new Map(billSummariesAll.map((s) => [s.month, s]));

  const billOverrides = isBillAccount && selectedAccount
    ? await prisma.billOverride.findMany({
        where: { accountId: selectedAccount.id },
        orderBy: { statementMonth: "desc" },
      })
    : [];
  const billSummaries = billMonthsForList
    .map((m) => {
      const existing = billSummaryByMonth.get(m);
      if (existing) return existing;
      const base = cycleForStatementMonth(m, selectedAccount?.billingDay ?? 1, selectedAccount?.repaymentDay ?? null, new Date());
      if (!base) return null;
      return { month: m, start: base.start, end: base.end, due: base.due, bill: 0, paid: 0, remain: 0, overpaid: 0, expenseAbs: 0, income: 0, isCurrentCycle: base.isCurrentCycle };
    })
    .filter((s): s is NonNullable<typeof s> => !!s);

  const overrideByMonth = new Map<string, number>(billOverrides.filter(o => o.statementMonth != null).map((o) => [o.statementMonth as string, Number(o.amount)]));

  const allMonthsForCascade = (() => {
    const monthSet = new Set(billMonthsForCumulative);
    const merged: { month: string; bill: number; paid: number }[] = [];
    for (const m of Array.from(monthSet).sort((a, b) => b.localeCompare(a))) {
      const s = billSummaryByMonth.get(m);
      if (s) merged.push({ month: m, bill: s.bill, paid: s.paid });
      else merged.push({ month: m, bill: 0, paid: 0 });
    }
    return merged;
  })();

  const effectiveBillByMonth = (() => {
    const map = new Map<string, number>();
    const logItems: string[] = [];
    let prevEffective = 0;
    for (const s of allMonthsForCascade) {
      const override = overrideByMonth.get(s.month);
      const effective = override !== undefined ? override : (prevEffective + s.bill);
      map.set(s.month, effective);
      prevEffective = effective;
      const rem = effective - s.paid;
      logItems.push(`${s.month}:bill=${s.bill},override=${override ?? "none"},eb=${effective},paid=${s.paid},rem=${rem}`);
    }
    console.log(`[cascade] ${logItems.join(" | ")}`);
    return map;
  })();

  const cumulativeByMonth = (() => {
    const cumByMonth = new Map<string, { cumulativeRemain: number; cumulativeOverpaid: number }>();
    for (const s of allMonthsForCascade) {
      const eb = effectiveBillByMonth.get(s.month) ?? s.bill;
      const afterPaid = eb - s.paid;
      cumByMonth.set(s.month, {
        cumulativeRemain: Math.max(0, afterPaid),
        cumulativeOverpaid: Math.max(0, -afterPaid),
      });
    }
    return cumByMonth;
  })();

  if (isBillAccount && selectedAccount) {
    await Promise.all(
      allMonthsForCascade.map(async (s) => {
        const base = billSummaryByMonth.get(s.month) ?? cycleForStatementMonth(s.month, selectedAccount.billingDay ?? 1, selectedAccount.repaymentDay ?? null, new Date());
        if (!base) return;
        const effectiveBill = effectiveBillByMonth.get(s.month) ?? s.bill;
        const cum = cumulativeByMonth.get(s.month);
        const hasOverride = overrideByMonth.has(s.month);
        await prisma.creditCardCycle.upsert({
          where: { accountId_statementMonth: { accountId: selectedAccount.id, statementMonth: s.month } },
          create: {
            accountId: selectedAccount.id,
            statementMonth: s.month,
            periodStart: base.start,
            periodEnd: base.end,
            dueDate: base.due ?? null,
            expenseAbs: String((base as any).expenseAbs ?? 0),
            income: String((base as any).income ?? 0),
            paid: String((base as any).paid ?? 0),
            rawBill: String((base as any).bill ?? 0),
            effectiveBill: String(effectiveBill),
            cumulativeRemain: String(cum?.cumulativeRemain ?? 0),
            cumulativeOverpaid: String(cum?.cumulativeOverpaid ?? 0),
            isCurrentCycle: Boolean((base as any).isCurrentCycle),
            isLocked: hasOverride,
            lockSource: hasOverride ? "override" : null,
          },
          update: {
            periodStart: base.start,
            periodEnd: base.end,
            dueDate: base.due ?? null,
            expenseAbs: String((base as any).expenseAbs ?? 0),
            income: String((base as any).income ?? 0),
            paid: String((base as any).paid ?? 0),
            rawBill: String((base as any).bill ?? 0),
            effectiveBill: String(effectiveBill),
            cumulativeRemain: String(cum?.cumulativeRemain ?? 0),
            cumulativeOverpaid: String(cum?.cumulativeOverpaid ?? 0),
            isCurrentCycle: Boolean((base as any).isCurrentCycle),
            isLocked: hasOverride,
            lockSource: hasOverride ? "override" : null,
          },
        });
      }),
    );
  }

  const billSummariesWithCumulative = (() => {
    if (!billSummaries.length) return [];
    return billSummaries
      .map((s) => {
        const cum = cumulativeByMonth.get(s.month);
        const effectiveBill = effectiveBillByMonth.get(s.month) ?? s.bill;
        return {
          ...s,
          effectiveBill,
          cumulativeRemain: cum?.cumulativeRemain ?? s.remain,
          cumulativeOverpaid: cum?.cumulativeOverpaid ?? s.overpaid,
        };
      });
  })();

  const persistedCycles = isBillAccount && selectedAccount
    ? await prisma.creditCardCycle.findMany({
        where: { accountId: selectedAccount.id },
        orderBy: { statementMonth: "desc" },
      })
    : [];

  const displayBillRows = (() => {
    if (isBillAccount) {
      const rows = persistedCycles.map((p) => ({
        month: p.statementMonth,
        start: p.periodStart,
        end: p.periodEnd,
        due: p.dueDate,
        bill: Number(p.rawBill),
        paid: Number(p.paid),
        remain: Number(p.cumulativeRemain),
        overpaid: Number(p.cumulativeOverpaid),
        expenseAbs: Number(p.expenseAbs),
        income: Number(p.income),
        isCurrentCycle: p.isCurrentCycle,
        effectiveBill: Number(p.effectiveBill),
        cumulativeRemain: Number(p.cumulativeRemain),
        cumulativeOverpaid: Number(p.cumulativeOverpaid),
      }));
      return rows
        .filter((s) => hideZeroBills ? !(s.expenseAbs === 0 && s.income === 0 && s.bill === 0 && s.paid === 0 && !s.isCurrentCycle) : true)
        .filter((s) => hideSettledBills ? !(s.paid >= s.effectiveBill && s.effectiveBill > 0 && !s.isCurrentCycle) : true);
    }
    return billSummariesWithCumulative
      .filter((s) => hideZeroBills ? !(s.expenseAbs === 0 && s.income === 0 && s.bill === 0 && s.paid === 0 && !s.isCurrentCycle) : true)
      .filter((s) => hideSettledBills ? !(s.paid >= s.effectiveBill && s.effectiveBill > 0 && !s.isCurrentCycle) : true);
  })();

  const billListPageSize = 12;
  const totalPages = Math.ceil(displayBillRows.length / billListPageSize);
  const currentPage = Math.min(billPage, totalPages || 1);
  const pagedBillSummaries = displayBillRows.slice((currentPage - 1) * billListPageSize, currentPage * billListPageSize);

  const creditBillMonth = creditCardBill?.statementMonth ?? "";

  const cumulativeRemainValue = (() => {
    if (!currentStatementMonth) return creditCardBill?.remain ?? 0;
    const effective = effectiveBillByMonth.get(currentStatementMonth);
    const cum = cumulativeByMonth.get(currentStatementMonth);
    if (effective !== undefined) return effective;
    return cum?.cumulativeRemain ?? creditCardBill?.remain ?? 0;
  })();

  const investBalByAccountId = isInvestAccount ? await computeInvestBalances() : new Map();

  if (selectedAccount) {
    const agg = await prisma.txRecord.aggregate({
      where: { accountId: selectedAccount.id },
      _sum: { amount: true },
    });
    const txSum = toNumber(agg._sum.amount);
    const newBalance = isBillAccount
      ? String(-cumulativeRemainValue)
      : String(txSum);
    await prisma.account.update({
      where: { id: selectedAccount.id },
      data: { balance: newBalance },
    });

    if (selectedAccount.kind === AccountKind.investment) {
      const investDetail = investBalByAccountId.get(selectedAccount.id);
      await prisma.account.update({
        where: { id: selectedAccount.id },
        data: { balance: String(investDetail?.marketValue ?? 0) },
      });
    }
  }

  const creditCardBillDetails =
    view === "bill" && creditCardBill && isBillAccount
      ? await (async () => {
          const { start, end } = creditCardBill;
          const statementMonth = creditCardBill.statementMonth ?? null;
          const cycleMatch = {
            type: { in: [TransactionType.expense, TransactionType.income, TransactionType.transfer, TransactionType.investment] },
            deletedAt: null,
            OR: statementMonth
              ? [
                  { statementMonth, deletedAt: null },
                  {
                    statementMonth: null,
                    date: { gte: start, lt: addDaysUtc(end, 1) }, deletedAt: null,
                  },
                ]
              : [{ date: { gte: start, lt: addDaysUtc(end, 1) }, deletedAt: null }],
          };
          const cycleEntries = await prisma.txRecord.findMany({
            where: {
              AND: [cycleMatch, ...(billScope ? [billScope] : [])],
            },
            include: {},
            orderBy: [{ date: "desc" }, { createdAt: "desc" }],
            take: 500,
          });
          return { cycleEntries };
        })()
      : null;

  const investmoneyAccount = viewParam === "investmoney" && accountId
    ? await prisma.account.findUnique({ where: { id: accountId } })
    : null;

  const investmoneyData = viewParam === "investmoney" && investmoneyAccount
    ? await (async () => {
        // ── 显示层：持仓数据统一从 fundHolding 表读取 ──
        const positionDisplay = await computePositionDisplay(investmoneyAccount.id);
        const sortedPositions = [...positionDisplay.positions].sort((a, b) => {
          const dir = fundSortDirParam === "asc" ? 1 : -1;
          let value = 0;
          switch (fundSortParam) {
            case "fundCode": value = a.fundCode.localeCompare(b.fundCode); break;
            case "cost": value = a.cost - b.cost; break;
            case "floatingPnL": value = a.floatingPnL - b.floatingPnL; break;
            case "floatingPnLRate": value = a.floatingPnLRate - b.floatingPnLRate; break;
            case "historicalProfit": value = a.historicalProfit - b.historicalProfit; break;
            case "marketValue":
            default: value = a.marketValue - b.marketValue; break;
          }
          return value * dir;
        });
        positionDisplay.positions = sortedPositions;
        // 清仓基金排序
        const sortedCleared = [...positionDisplay.clearedPositions].sort((a, b) => {
          const dir = fundSortDirParam === "asc" ? 1 : -1;
          let value = 0;
          switch (fundSortParam) {
            case "fundCode": value = a.fundCode.localeCompare(b.fundCode); break;
            case "firstBuyDate": value = a.firstBuyDate.localeCompare(b.firstBuyDate); break;
            case "clearedDate": value = a.clearedDate.localeCompare(b.clearedDate); break;
            case "returnRate": value = a.returnRate - b.returnRate; break;
            case "historicalProfit": value = a.historicalProfit - b.historicalProfit; break;
            case "clearedDate":
            default: value = a.clearedDate.localeCompare(b.clearedDate); break;
          }
          return value * dir;
        });
        positionDisplay.clearedPositions = sortedCleared;
        const selectedFundCode = fundCodeParam || (positionDisplay.positions.length > 0 ? positionDisplay.positions[0]!.fundCode : (positionDisplay.clearedPositions.length > 0 ? positionDisplay.clearedPositions[0]!.fundCode : ""));
        // ── 显示层：交易流水从 TxRecord 查询（不按 fundCode 过滤，全量加载后前端切换） ──
        // 买入记录 toAccountId=投资账户，赎回记录 accountId=投资账户 → 需同时查两个字段
        const fundEntries = await prisma.txRecord.findMany({
          where: {
            deletedAt: null,
            fundCode: { not: null },
            OR: [
              { toAccountId: investmoneyAccount.id },
              { accountId: investmoneyAccount.id },
            ],
          },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        });
        // 批量查询费率（按 fundCode + feeType 取最新一条）
        const feeRateRecords = await prisma.fundFeeRate.findMany({
          where: { accountId: investmoneyAccount.id },
          orderBy: { effectiveDate: "desc" },
        });
        const feeRateMap = new Map<string, string>();
        for (const fr of feeRateRecords) {
          const key = `${fr.fundCode}:${fr.feeType}`;
          if (!feeRateMap.has(key)) {
            feeRateMap.set(key, String(fr.rate));
          }
        }
        // 批量查询确认天数（按 fundCode）
        const confirmDaysRecords = await prisma.fundConfirmDays.findMany({
          where: { accountId: investmoneyAccount.id },
        });
        const confirmDaysMap = new Map<string, number>();
        for (const cd of confirmDaysRecords) {
          confirmDaysMap.set(cd.fundCode, cd.days ?? 0);
        }
        // pendingByCode 直接从持仓数据获取
        const pendingByCode = new Map<string, number>();
        for (const p of positionDisplay.positions) {
          if (p.pendingCost > 0) {
            pendingByCode.set(p.fundCode, p.pendingCost);
          }
        }
        // 前端过滤：只显示选中基金的明细
        const filteredFundEntries = selectedFundCode ? fundEntries.filter(e => e.fundCode === selectedFundCode) : fundEntries;
        // 分页
        const totalEntries = filteredFundEntries.length;
        const totalPages = Math.max(1, Math.ceil(totalEntries / fundPageSize));
        const safePage = Math.min(fundPage, totalPages);
        const pagedFundEntries = filteredFundEntries.slice((safePage - 1) * fundPageSize, safePage * fundPageSize);
        return { ...positionDisplay, filteredEntries: pagedFundEntries, allEntries: fundEntries, totalEntries, totalPages, safePage, selectedFundCode, pendingByCode, feeRateMap, confirmDaysMap };
      })()
    : null;

  const investfundAccount = viewParam === "investfund" && accountId
    ? await prisma.account.findUnique({ where: { id: accountId } })
    : null;

  const investfundData = viewParam === "investfund" && investfundAccount
    ? await (async () => {
        // ── 显示层：持仓数据统一从 fundHolding 表读取 ──
        const positionDisplay = await computePositionDisplay(investfundAccount.id);
        const sortedPositions = [...positionDisplay.positions].sort((a, b) => {
          const dir = fundSortDirParam === "asc" ? 1 : -1;
          let value = 0;
          switch (fundSortParam) {
            case "fundCode": value = a.fundCode.localeCompare(b.fundCode); break;
            case "cost": value = a.cost - b.cost; break;
            case "floatingPnL": value = a.floatingPnL - b.floatingPnL; break;
            case "floatingPnLRate": value = a.floatingPnLRate - b.floatingPnLRate; break;
            case "historicalProfit": value = a.historicalProfit - b.historicalProfit; break;
            case "marketValue":
            default: value = a.marketValue - b.marketValue; break;
          }
          return value * dir;
        });
        positionDisplay.positions = sortedPositions;
        // 清仓基金排序
        const sortedCleared = [...positionDisplay.clearedPositions].sort((a, b) => {
          const dir = fundSortDirParam === "asc" ? 1 : -1;
          let value = 0;
          switch (fundSortParam) {
            case "fundCode": value = a.fundCode.localeCompare(b.fundCode); break;
            case "firstBuyDate": value = a.firstBuyDate.localeCompare(b.firstBuyDate); break;
            case "clearedDate": value = a.clearedDate.localeCompare(b.clearedDate); break;
            case "returnRate": value = a.returnRate - b.returnRate; break;
            case "historicalProfit": value = a.historicalProfit - b.historicalProfit; break;
            case "clearedDate":
            default: value = a.clearedDate.localeCompare(b.clearedDate); break;
          }
          return value * dir;
        });
        positionDisplay.clearedPositions = sortedCleared;
        const selectedFundCode = fundCodeParam || (positionDisplay.positions.length > 0 ? positionDisplay.positions[0]!.fundCode : (positionDisplay.clearedPositions.length > 0 ? positionDisplay.clearedPositions[0]!.fundCode : ""));
        // ── 显示层：交易流水从 TxRecord 查询（不按 fundCode 过滤，全量加载后前端切换） ──
        // 买入记录 toAccountId=投资账户，赎回记录 accountId=投资账户 → 需同时查两个字段
        const fundEntries = await prisma.txRecord.findMany({
          where: {
            deletedAt: null,
            fundCode: { not: null },
            OR: [
              { toAccountId: investfundAccount.id },
              { accountId: investfundAccount.id },
            ],
          },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        });
        // 批量查询费率（按 fundCode + feeType 取最新一条）
        const feeRateRecords2 = await prisma.fundFeeRate.findMany({
          where: { accountId: investfundAccount.id },
          orderBy: { effectiveDate: "desc" },
        });
        const feeRateMap2 = new Map<string, string>();
        for (const fr of feeRateRecords2) {
          const key = `${fr.fundCode}:${fr.feeType}`;
          if (!feeRateMap2.has(key)) {
            feeRateMap2.set(key, String(fr.rate));
          }
        }
        // 批量查询确认天数（按 fundCode）
        const confirmDaysRecords2 = await prisma.fundConfirmDays.findMany({
          where: { accountId: investfundAccount.id },
        });
        const confirmDaysMap2 = new Map<string, number>();
        for (const cd of confirmDaysRecords2) {
          confirmDaysMap2.set(cd.fundCode, cd.days ?? 0);
        }
        // pendingByCode 直接从持仓数据获取
        const pendingByCode = new Map<string, number>();
        for (const p of positionDisplay.positions) {
          if (p.pendingCost > 0) {
            pendingByCode.set(p.fundCode, p.pendingCost);
          }
        }
        // 前端过滤：只显示选中基金的明细
        const filteredFundEntries2 = selectedFundCode ? fundEntries.filter(e => e.fundCode === selectedFundCode) : fundEntries;
        // 分页
        const totalEntries2 = filteredFundEntries2.length;
        const totalPages2 = Math.max(1, Math.ceil(totalEntries2 / fundPageSize));
        const safePage2 = Math.min(fundPage, totalPages2);
        const pagedFundEntries2 = filteredFundEntries2.slice((safePage2 - 1) * fundPageSize, safePage2 * fundPageSize);
        return { ...positionDisplay, filteredEntries: pagedFundEntries2, allEntries: fundEntries, totalEntries: totalEntries2, totalPages: totalPages2, safePage: safePage2, selectedFundCode, pendingByCode, feeRateMap: feeRateMap2, confirmDaysMap: confirmDaysMap2 };
      })()
    : null;

  // 定投计划数据加载
  const regularInvestData = viewParam === "regularinvest" && accountId && selectedAccount
    ? await (async () => {
        const plans = await prisma.regularInvestPlan.findMany({
          where: { accountId },
          orderBy: { nextRunDate: "asc" },
        });
        return { plans };
      })()
    : null;

  const baseQuery = new URLSearchParams();
  if (accountId) baseQuery.set("accountId", accountId);
  else if (accountName) baseQuery.set("account", accountName);
  const hrefDetail = (() => {
    const q = new URLSearchParams(baseQuery);
    q.set("view", "detail");
    if (hideZeroBills) q.set("hideZeroBills", "1");
    if (hideSettledBills) q.set("hideSettledBills", "1");
    return `/?${q.toString()}`;
  })();
  const hrefBill = (() => {
    const q = new URLSearchParams(baseQuery);
    q.set("view", "bill");
    if (selectedBillMonth) q.set("billMonth", selectedBillMonth);
    if (hideZeroBills) q.set("hideZeroBills", "1");
    if (hideSettledBills) q.set("hideSettledBills", "1");
    return `/)${q.toString()}`;
  })();

  const renderFundSortHeader = (
    viewName: "investmoney" | "investfund",
    sortKey: string,
    label: string,
    className: string,
    selectedFundCode?: string,
  ) => {
    const defaultSortKey = showCleared ? "clearedDate" : "marketValue";
    const active = fundSortParam === sortKey || (!fundSortParam && sortKey === defaultSortKey);
    const nextDir = active && fundSortDirParam === "desc" ? "asc" : "desc";
    const q = new URLSearchParams(baseQuery);
    q.set("view", viewName);
    q.set("fundSort", sortKey);
    q.set("fundSortDir", nextDir);
    q.set("fundPageSize", String(fundPageSize));
    if (selectedFundCode) q.set("fundCode", selectedFundCode);
    if (showCleared) q.set("showCleared", "1");
    const justify = className.includes("text-left") ? "justify-start" : "justify-end";
    return (
      <th className={className}>
        <Link href={`/?${q.toString()}`} className={`inline-flex items-center gap-1 hover:text-blue-700 ${justify} ${active ? "text-blue-700" : ""}`} title={`按${label}${nextDir === "asc" ? "正序" : "倒序"}排列`}>
          <span>{label}</span>
          {active ? <span className="text-[10px]">{fundSortDirParam === "asc" ? "↑" : "↓"}</span> : <span className="text-[10px] text-slate-300">↕</span>}
        </Link>
      </th>
    );
  };

  return (
    <div className="flex h-full w-full">
      <div className="flex-1 flex flex-col min-w-0 bg-slate-50 relative">
        <header className="shrink-0 border-b border-slate-200 bg-white">
          <div className="h-12 flex items-center justify-between px-4">
            <div className="flex items-center gap-3 text-sm">
              <span className="font-semibold text-slate-800">{selectedAccountLabel || "全部账户"}</span>
              {isBillAccount && view === "bill" && cumulativeRemainValue > 0 ? (
                <span className="tabular-nums font-semibold text-red-500">{formatMoney(-cumulativeRemainValue)}</span>
              ) : view === "investmoney" && investmoneyData ? (
                <span className="tabular-nums font-semibold text-emerald-700">{formatMoney(investmoneyData.totalMarketValue)}</span>
              ) : view === "investfund" && investfundData ? (
                <span className="tabular-nums font-semibold text-emerald-700">{formatMoney(investfundData.totalMarketValue)}</span>
              ) : (
                <span className={`tabular-nums font-semibold ${pnlCls(total.net)}`}>{formatMoney(total.net)}</span>
              )}
              {isBillAccount && (
                <div className="flex items-center gap-2">
                  <a href={hrefBill} className={`h-7 px-2 rounded-md border text-xs flex items-center ${view === "bill" ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>账单</a>
                  <a href={hrefDetail} className={`h-7 px-2 rounded-md border text-xs flex items-center ${view === "detail" ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>明细</a>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
            {((view === "investfund" || view === "investmoney") && selectedAccount) ? (
              <InvestmentFormModal
                mode="create"
                accountId={selectedAccount.id}
                accountProductType={selectedAccount.investProductType ?? null}
                defaults={{
                  fundCode: (view === "investfund" ? investfundData : investmoneyData)?.selectedFundCode ?? undefined,
                  fundName: (view === "investfund" ? investfundData : investmoneyData)?.positions.find(p => p.fundCode === ((view === "investfund" ? investfundData : investmoneyData)?.selectedFundCode))?.name ?? undefined,
                  fundUnits: (view === "investfund" ? investfundData : investmoneyData)?.positions.find(p => p.fundCode === ((view === "investfund" ? investfundData : investmoneyData)?.selectedFundCode))?.units ?? undefined,
                }}
                cashAccounts={accountOptions.filter(a => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet").map(a => ({ id: a.id, label: a.label }))}
                investmentAccounts={investmentAccountOptions}
                holdings={(view === "investfund" ? investfundData : investmoneyData)?.positions.map(p => ({ fundCode: p.fundCode, name: p.name, units: p.units })) ?? undefined}
                createAction={createTransaction}
              />
            ) : view === "regularinvest" && selectedAccount ? (
              <RegularInvestForm accountId={selectedAccount.id} accountLabel={selectedAccountLabel} cashAccounts={accountOptions.filter(a => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet").map(a => ({ id: a.id, label: a.label }))} action={regularInvestFormAction} showTriggerButton={false} />
            ) : (
              <>
              <TransactionFormModal
                accounts={spendingAccountOptions} transferAccounts={accountOptions} investmentAccounts={investmentAccountOptions}
                expenseCategories={expenseCategories.map((c) => ({ id: c.id, label: c.label }))}
                incomeCategories={incomeCategories.map((c) => ({ id: c.id, label: c.label }))}
                defaultAccountId={accountId || undefined}
                lastRepayToAccountId={lastRepayToAccountId} lastRepayFromAccountId={lastRepayFromAccountId}
                isCreditCardAccount={isBillAccount} action={createTransaction} editAction={updateTransactionFromDialog}
              />
              {isBillAccount && !isInvestAccount ? <a href="/invest" className="h-8 px-3 rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50 flex items-center">投资</a> : null}
              </>
            )}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-hidden flex flex-col">
          {view === "bill" && isBillAccount ? (
            <div className="flex-1 overflow-auto bg-white">
              <div className="p-4 space-y-4">
                {billSummariesWithCumulative.length > 0 ? (
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-800">账单列表</span>
                        <a
                          href={(() => {
                            const q = new URLSearchParams(baseQuery);
                            q.set("view", "bill");
                            if (selectedAccount?.id) q.set("accountId", selectedAccount.id);
                            if (selectedBillMonth) q.set("billMonth", selectedBillMonth);
                            if (hideZeroBills) q.set("hideZeroBills", "1");
                            if (hideSettledBills) q.set("hideSettledBills", "1");
                            return `/?${q.toString()}`;
                          })()}
                          className="h-6 px-1.5 rounded border text-xs flex items-center border-blue-300 bg-blue-50 text-blue-700"
                        >
                          全部
                        </a>
                        {totalPages > 1 && (
                          <div className="flex items-center gap-0.5 ml-1">
                            {currentPage > 1 ? (
                              <>
                                <a href={(() => { const q = new URLSearchParams(baseQuery); q.set("view", "bill"); if (selectedAccount?.id) q.set("accountId", selectedAccount.id); if (selectedBillMonth) q.set("billMonth", selectedBillMonth); if (hideZeroBills) q.set("hideZeroBills", "1"); if (hideSettledBills) q.set("hideSettledBills", "1"); q.set("billPage", "1"); return `/?${q.toString()}`; })()} className="h-6 px-1 rounded border border-slate-200 bg-white text-slate-500 text-xs hover:bg-slate-50"><ChevronsLeft className="h-3.5 w-3.5" /></a>
                                <a href={(() => { const q = new URLSearchParams(baseQuery); q.set("view", "bill"); if (selectedAccount?.id) q.set("accountId", selectedAccount.id); if (selectedBillMonth) q.set("billMonth", selectedBillMonth); if (hideZeroBills) q.set("hideZeroBills", "1"); if (hideSettledBills) q.set("hideSettledBills", "1"); q.set("billPage", String(currentPage - 1)); return `/?${q.toString()}`; })()} className="h-6 px-1 rounded border border-slate-200 bg-white text-slate-600 text-xs hover:bg-slate-50"><ChevronLeft className="h-3 w-3" /></a>
                              </>
                            ) : null}
                            <span className="text-xs text-slate-500 px-1">{currentPage}/{totalPages}</span>
                            {currentPage < totalPages ? (
                              <>
                                <a href={(() => { const q = new URLSearchParams(baseQuery); q.set("view", "bill"); if (selectedAccount?.id) q.set("accountId", selectedAccount.id); if (selectedBillMonth) q.set("billMonth", selectedBillMonth); if (hideZeroBills) q.set("hideZeroBills", "1"); if (hideSettledBills) q.set("hideSettledBills", "1"); q.set("billPage", String(currentPage + 1)); return `/?${q.toString()}`; })()} className="h-6 px-1 rounded border border-slate-200 bg-white text-slate-600 text-xs hover:bg-slate-50"><ChevronRight className="h-3 w-3" /></a>
                                <a href={(() => { const q = new URLSearchParams(baseQuery); q.set("view", "bill"); if (selectedAccount?.id) q.set("accountId", selectedAccount.id); if (selectedBillMonth) q.set("billMonth", selectedBillMonth); if (hideZeroBills) q.set("hideZeroBills", "1"); if (hideSettledBills) q.set("hideSettledBills", "1"); q.set("billPage", String(totalPages)); return `/?${q.toString()}`; })()} className="h-6 px-1 rounded border border-slate-200 bg-white text-slate-500 text-xs hover:bg-slate-50"><ChevronsRight className="h-3 w-3" /></a>
                              </>
                            ) : null}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <a
                          href={(() => {
                            const q = new URLSearchParams(baseQuery);
                            q.set("view", "bill");
                            if (selectedAccount?.id) q.set("accountId", selectedAccount.id);
                            if (selectedBillMonth) q.set("billMonth", selectedBillMonth);
                            if (hideZeroBills) q.delete("hideZeroBills");
                            else q.set("hideZeroBills", "1");
                            if (hideSettledBills) q.set("hideSettledBills", "1");
                            return `/?${q.toString()}`;
                          })()}
                          className={`h-7 px-2 rounded-md border text-xs flex items-center ${
                            hideZeroBills
                              ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                          }`}
                        >
                          隐藏 0 收支
                        </a>
                        <a
                          href={(() => {
                            const q = new URLSearchParams(baseQuery);
                            q.set("view", "bill");
                            if (selectedBillMonth) q.set("billMonth", selectedBillMonth);
                            if (hideZeroBills) q.set("hideZeroBills", "1");
                            if (hideSettledBills) q.delete("hideSettledBills");
                            else q.set("hideSettledBills", "1");
                            return `/?${q.toString()}`;
                          })()}
                          className={`h-7 px-2 rounded-md border text-xs flex items-center ${
                            hideSettledBills
                              ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                          }`}
                        >
                          隐藏已还
                        </a>
                      </div>
                    </div>
                    <div className="overflow-auto">
                      <table className="min-w-[980px] w-full border-separate border-spacing-0">
                        <thead className="sticky top-0 z-10">
                          <tr className="bg-white">
                            <th className="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200">账单</th>
                            <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">周期</th>
                            <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">支出</th>
                            <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">退/收入</th>
                            <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">账单金额</th>
                            <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">还款</th>
                          </tr>
                        </thead>
                        <tbody className="text-sm">
                          {pagedBillSummaries.map((s) => {
                            const q = new URLSearchParams(baseQuery);
                            q.set("view", "bill");
                            q.set("billMonth", s.month);
                            q.set("billPage", String(currentPage));
                            if (selectedAccount?.id) q.set("accountId", selectedAccount.id);
                            if (hideZeroBills) q.set("hideZeroBills", "1");
                            if (hideSettledBills) q.set("hideSettledBills", "1");
                            const href = `/?${q.toString()}`;
                            const active = selectedBillMonth === s.month || creditCardBill?.statementMonth === s.month;
                            return (
                              <tr
                                key={s.month}
                                className={`hover:bg-slate-50 ${active ? "bg-blue-100" : ""}`}
                              >
                                <td className="px-4 py-2 border-b border-slate-100">
                                  <a href={href} className="block">
                                    <span className={`text-xs font-semibold ${s.isCurrentCycle ? "text-amber-600" : "text-blue-700"}`}>
                                      {s.month}{s.isCurrentCycle ? "（未出账单）" : s.month === settledBillMonth ? "（本期账单）" : ""}
                                    </span>
                                  </a>
                                </td>
                                <td className="px-3 py-2 border-b border-slate-100">
                                  <a href={href} className="block">
                                    <span className="text-xs text-slate-700 tabular-nums">
                                      {ymdUtc(s.start)} ~ {ymdUtc(s.end)}
                                    </span>
                                  </a>
                                </td>
                                <td className="px-3 py-2 border-b border-slate-100 text-right tabular-nums">
                                  <a href={href} className="block">
                                    <span className="text-xs text-red-600">{formatMoney(s.expenseAbs)}</span>
                                  </a>
                                </td>
                                <td className="px-3 py-2 border-b border-slate-100 text-right tabular-nums">
                                  <a href={href} className="block">
                                    <span className="text-xs text-emerald-700">{formatMoney(s.income)}</span>
                                  </a>
                                </td>
                                <td className="px-3 py-2 border-b border-slate-100 text-right tabular-nums">
                                  <EditBillAmount accountId={selectedAccount?.id ?? ""} statementMonth={s.month} currentAmount={s.effectiveBill} hasOverride={billOverrides.some((o) => o.statementMonth === s.month)} />
                                </td>
                                <td className="px-3 py-2 border-b border-slate-100">
                                  <a href={href} className="block">
                                    <span className="text-xs text-slate-700 tabular-nums">{s.due ? ymdUtc(s.due) : "-"}</span>
                                  </a>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
                    <div className="text-sm font-semibold text-slate-800">
                      {creditCardBill?.statementMonth ? `账单明细 (${creditCardBill.statementMonth})` : "账单明细"}
                    </div>
                    {creditCardBill ? (
                      <div className="mt-1 text-xs text-slate-500 tabular-nums">
                        周期：{ymdUtc(creditCardBill.start)} ~ {ymdUtc(creditCardBill.end)} 共 {creditCardBill.isCurrentCycle ? "未出账单" : "本期账单"}
                        <EditBillAmount accountId={selectedAccount?.id ?? ""} statementMonth={creditBillMonth ?? ""} currentAmount={effectiveBillByMonth.get(creditBillMonth ?? "") ?? creditCardBill.bill} hasOverride={billOverrides.some((o) => o.statementMonth === creditBillMonth)} />
                      </div>
                    ) : null}
                  </div>
                  <div className="overflow-auto">
                    <table className="min-w-[900px] w-full border-separate border-spacing-0">
                      <thead className="sticky top-0 z-10">
                        <tr className="bg-white">
                          <th className="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200">日期</th>
                          <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">类别</th>
                          <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">备注</th>
                          <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">资金来源</th>
                          <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">金额</th>
                          <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">操作</th>
                        </tr>
                      </thead>
                      <tbody className="text-sm">
                        {creditCardBillDetails?.cycleEntries?.length ? (
                          creditCardBillDetails!.cycleEntries.map((e) => {
                            const date = e.date.toISOString().slice(0, 10);
                            const amount = toNumber(e.amount);
                            const isTransferToCurrentBillAccount =
                              e.type === "transfer" && !!selectedAccount?.id && e.toAccountId === selectedAccount.id;
                            const displayAmount = isTransferToCurrentBillAccount ? Math.abs(amount) : amount;
                            const sourceAccountLabel = isTransferToCurrentBillAccount ? (e.accountName ?? "") : "";
                            const categoryLabel =
                              e.type === "expense" || e.type === "income"
                                ? e.categoryId
                                  ? categoryLabels.get(e.categoryId) ?? e.categoryName ?? "未分类"
                                  : e.categoryName ?? "未分类"
                                : isTransferToCurrentBillAccount
                                  ? "还款" : formatType(e.type);
                            const editType =
                              e.type === "investment"
                                ? ("investment" as const)
                                : e.type === "transfer"
                                  ? ("transfer" as const)
                                  : e.type;
                            const siblingEntries: any[] = [];
                            const fundDetailEntry = siblingEntries.find((s) => s.id !== e.id && s.fundSubtype === "buy");
                            const editPayload =
                              editType === "investment"
                                ? {
                                    type: "investment" as const,
                                    date,
                                    amount: Math.abs(amount),
                                    note: e.note ?? "",
                                    accountId: (e.fundSubtype === "redeem" || e.fundSubtype === "switch_out")
                                      ? e.accountId ?? ""   // 赎回：accountId 是投资账户
                                      : e.toAccountId ?? "", // 买入：toAccountId 是投资账户
                                    cashAccountId: (e.fundSubtype === "redeem" || e.fundSubtype === "switch_out")
                                      ? e.toAccountId ?? ""   // 赎回：toAccountId 是资金账户（接收方）
                                      : e.accountId ?? "",    // 买入：accountId 是资金账户（发起方）
                                    fundCode: e.fundCode ?? undefined,
                                    fundSubtype: e.fundSubtype ?? "buy",
                                    categoryId: "",
                                    entryId: e.id,
                                    hasFundDetail: !!fundDetailEntry,
                                  }
                                : editType === "transfer"
                                  ? {
                                      type: "transfer" as const,
                                      date,
                                      amount: Math.abs(amount),
                                      note: e.note ?? "",
                                      fromAccountId: e.accountId ?? "",
                                      toAccountId: e.toAccountId ?? "",
                                      fromAccountLabel: e.accountName ?? "",
                                      toAccountLabel: e.toAccountName ?? "",
                                      categoryId: "",
                                      entryId: e.id,
                                    }
                                  : {
                                      type: editType as "expense" | "income",
                                      date,
                                      amount: Math.abs(amount),
                                      note: e.note ?? "",
                                      accountId: e.accountId ?? "",
                                      categoryId: e.categoryId ?? "",
                                      categoryLabel: categoryLabel,
                                      entryId: e.id,
                                    };
                            return (
                              <tr key={e.id} className="hover:bg-slate-50">
                                <td className="px-4 py-2 border-b border-slate-100 tabular-nums">
                                  <span className="text-xs text-slate-700">{date}</span>
                                </td>
                                <td className="px-3 py-2 border-b border-slate-100">
                                  <span className="text-xs text-slate-700">{categoryLabel}</span>
                                </td>
                                <td className="px-3 py-2 border-b border-slate-100 text-slate-600 truncate max-w-[520px]" title={e.note ?? ""}>
                                  <span className="text-xs text-slate-600">{e.note ?? ""}</span>
                                </td>
                                <td className="px-3 py-2 border-b border-slate-100 text-slate-600">
                                  <span className="text-xs text-slate-700">{sourceAccountLabel}</span>
                                </td>
                                <td className="px-3 py-2 border-b border-slate-100 text-right tabular-nums">
                                  <span className={`text-xs font-medium ${pnlCls(displayAmount)}`}>
                                    {formatMoney(displayAmount)}
                                  </span>
                                </td>
                                <td className="px-3 py-2 border-b border-slate-100 text-right">
                                  <EntryRowActions
                                    entryId={e.id}
                                    edit={editPayload ?? undefined}
                                  />
                                </td>
                              </tr>
                            );
                          })) : (
                          <tr>
                            <td className="px-4 py-6 text-slate-500" colSpan={6}>
                              暂无计入本期账单的记录
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          ) : view === "investmoney" && investmoneyData ? (
            <FundShell
              view="investmoney"
              initialFundCode={investmoneyData.selectedFundCode}
              positions={investmoneyData.positions}
              clearedPositions={investmoneyData.clearedPositions}
              allEntries={JSON.parse(JSON.stringify(investmoneyData.allEntries))}
              totalMarketValue={investmoneyData.totalMarketValue}
              totalCost={investmoneyData.totalCost}
              totalHistoricalProfit={investmoneyData.totalHistoricalProfit}
              confirmDaysMap={Object.fromEntries(investmoneyData.confirmDaysMap)}
              feeRateMap={Object.fromEntries(investmoneyData.feeRateMap)}
              initialShowCleared={showCleared}
              baseQuery={baseQuery.toString()}
              accountId={accountId}
              selectedAccount={JSON.parse(JSON.stringify(selectedAccount ?? {}))}
              selectedAccountLabel={selectedAccountLabel}
              accountOptions={accountOptions}
              cashAccounts={accountOptions.filter(a => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet").map(a => ({ id: a.id, label: a.label }))}
              investmentAccounts={accountOptions.filter(a => a.kind === "investment").map(a => ({ id: a.id, label: a.label }))}
              createAction={createTransaction}
              editAction={editInvestment}
              fillNavAction={fillFundNavFromCache}
              regularInvestFormAction={regularInvestFormAction}
              lastUsedCashAccount={lastUsedCashAccount}
              isRedUp={isRedUp}
            />
          ) : view === "investfund" && investfundData ? (
            <FundShell
              view="investfund"
              initialFundCode={investfundData.selectedFundCode}
              positions={investfundData.positions}
              clearedPositions={investfundData.clearedPositions}
              allEntries={JSON.parse(JSON.stringify(investfundData.allEntries))}
              totalMarketValue={investfundData.totalMarketValue}
              totalCost={investfundData.totalCost}
              totalHistoricalProfit={investfundData.totalHistoricalProfit}
              confirmDaysMap={Object.fromEntries(investfundData.confirmDaysMap)}
              feeRateMap={Object.fromEntries(investfundData.feeRateMap)}
              initialShowCleared={showCleared}
              baseQuery={baseQuery.toString()}
              accountId={accountId}
              selectedAccount={JSON.parse(JSON.stringify(selectedAccount ?? {}))}
              selectedAccountLabel={selectedAccountLabel}
              accountOptions={accountOptions}
              cashAccounts={accountOptions.filter(a => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet").map(a => ({ id: a.id, label: a.label }))}
              investmentAccounts={accountOptions.filter(a => a.kind === "investment").map(a => ({ id: a.id, label: a.label }))}
              createAction={createTransaction}
              editAction={editInvestment}
              fillNavAction={fillFundNavFromCache}
              regularInvestFormAction={regularInvestFormAction}
              lastUsedCashAccount={lastUsedCashAccount}
              isRedUp={isRedUp}
            />
          ) : (
            <div className="flex-1 min-h-0 flex flex-col p-4 bg-slate-50">
              <div className="flex-1 min-h-0 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
                <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
                  <div className="text-sm font-semibold text-slate-800">资金明细</div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-xs text-slate-600">共 {entries.length} 条</span>
                    <span className="text-xs text-slate-400 mx-1">|</span>
                    <span className="text-xs text-slate-600">每页</span>
                    {[10, 20, 40].map((n) => {
                      const href = (() => { const q = new URLSearchParams(baseQuery); q.set("view", "detail"); q.set("pageSize", String(n)); q.set("detailPage", "1"); if (selectedAccount?.id) q.set("accountId", selectedAccount.id); return `/?${q.toString()}`; })();
                      const active = pageSize === n;
                      return <a key={n} href={href} className={`h-7 px-2 rounded border inline-flex items-center justify-center ${active ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>{n}</a>;
                    })}
                    <span className="text-xs text-slate-600">条</span>
                    {detailTotalPages > 1 && (
                      <>
                        <span className="text-slate-400">|</span>
                        {safeDetailPage > 1 && (
                          <>
                            <a href={(() => { const q = new URLSearchParams(baseQuery); q.set("view", "detail"); q.set("detailPage", "1"); q.set("pageSize", String(pageSize)); if (selectedAccount?.id) q.set("accountId", selectedAccount.id); return `/?${q.toString()}`; })()} className="h-7 w-7 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-400 hover:bg-slate-50"><ChevronsLeft className="h-3.5 w-3.5"/></a>
                            <a href={(() => { const q = new URLSearchParams(baseQuery); q.set("view", "detail"); q.set("detailPage", String(safeDetailPage - 1)); q.set("pageSize", String(pageSize)); if (selectedAccount?.id) q.set("accountId", selectedAccount.id); return `/?${q.toString()}`; })()} className="h-7 w-7 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50"><ChevronLeft className="h-3.5 w-3.5"/></a>
                          </>
                        )}
                        <span className="text-xs text-slate-500">{safeDetailPage}/{detailTotalPages}</span>
                        {safeDetailPage < detailTotalPages && (
                          <>
                            <a href={(() => { const q = new URLSearchParams(baseQuery); q.set("view", "detail"); q.set("detailPage", String(safeDetailPage + 1)); q.set("pageSize", String(pageSize)); if (selectedAccount?.id) q.set("accountId", selectedAccount.id); return `/?${q.toString()}`; })()} className="h-7 w-7 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50"><ChevronRight className="h-3.5 w-3.5"/></a>
                            <a href={(() => { const q = new URLSearchParams(baseQuery); q.set("view", "detail"); q.set("detailPage", String(detailTotalPages)); q.set("pageSize", String(pageSize)); if (selectedAccount?.id) q.set("accountId", selectedAccount.id); return `/?${q.toString()}`; })()} className="h-7 w-7 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-400 hover:bg-slate-50"><ChevronsRight className="h-3.5 w-3.5"/></a>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-auto">
                  <table className="min-w-[1000px] w-full border-separate border-spacing-0">
                    <thead className="sticky top-0 z-10 bg-white">
                      <tr>
                        <th className="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200">日期</th>
                        <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">流入</th>
                        <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">流出</th>
                        <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">活动类型</th>
                        {!isInvestAccount && <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">关联账户</th>}
                        <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">余额</th>
                        <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">备注</th>
                        <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">附件</th>
                        <th className="text-right text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">操作</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm">
                      {pagedEntries.length ? (pagedEntries.map((e) => {
                        const date = e.date.toISOString().slice(0, 10);
                        const amount = toNumber(e.amount);
                        const effectiveAmount = !accountId ? amount : e.toAccountId === accountId ? Math.abs(amount) : amount;
                        const inflow = effectiveAmount > 0 ? effectiveAmount : null;
                        const outflow = effectiveAmount < 0 ? -effectiveAmount : null;
                        const balance = where ? balanceByEntryId.get(e.id) ?? null : null;
                        const activity = e.type === "investment" && e.fundSubtype ? (() => { const info = fundSubtypeInfo(e.fundSubtype, e.source, amount); return info ? info.label : formatType(e.type); })() : formatType(e.type);
                        const editPayload = e.type !== "investment" ? undefined : { id: e.id, transactionId: e.id, date: e.date.toISOString().slice(0, 10), type: e.type, amount: toNumber(e.amount), note: e.note, fundCode: e.fundCode, fundName: e.fundName, fundUnits: e.fundUnits != null ? toNumber(e.fundUnits) : null, fundNav: e.fundNav != null ? toNumber(e.fundNav) : null, fundFee: e.fundFee != null ? toNumber(e.fundFee) : null, fundProductType: e.fundProductType, fundSubtype: e.fundSubtype, source: e.source, accountId: e.accountId, toAccountId: e.toAccountId, toAccountName: e.toAccountName, fundArrivalDate: e.fundArrivalDate?.toISOString().slice(0,10), fundArrivalAmount: e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null };
                        const otherEditPayload = e.type !== "investment" ? { id: e.id, transactionId: e.id, date: e.date.toISOString().slice(0, 10), type: e.type, amount: toNumber(e.amount), note: e.note, categoryId: e.categoryId, categoryName: e.categoryName, accountId: e.accountId, accountName: e.accountName, toAccountId: e.toAccountId, toAccountName: e.toAccountName } : undefined;
                        const toAccountLabel = e.toAccountId ? (accountOptions.find((a: any) => a.id === e.toAccountId)?.label?.split("·").pop() ?? e.toAccountName) : null;
                        return (
                          <tr key={e.id} className="hover:bg-slate-50">
                            <td className="px-4 py-1 border-b border-slate-100 text-xs tabular-nums text-slate-600">{date}</td>
                            <td className="px-3 py-1 border-b border-slate-100 text-right tabular-nums text-slate-700">{inflow !== null ? formatMoney(inflow) : ""}</td>
                            <td className="px-3 py-1 border-b border-slate-100 text-right tabular-nums text-slate-700">{outflow !== null ? formatMoney(outflow) : ""}</td>
                            <td className="px-3 py-1 border-b border-slate-100">
                              {e.type === "investment" && e.fundSubtype ? (() => { const info = fundSubtypeInfo(e.fundSubtype, e.source, amount); return info ? <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${info.cls}`}>{info.label}</span> : <span className="text-xs text-slate-700">{activity}</span>; })() : <span className="text-xs text-slate-700">{activity}</span>}
                            </td>
                            {!isInvestAccount && <td className="px-3 py-1 border-b border-slate-100 text-xs text-slate-500">{e.type === "transfer" && toAccountLabel ? toAccountLabel : e.type === "investment" && e.toAccountName ? e.toAccountName : <span className="text-slate-300">-</span>}</td>}
                            <td className="px-3 py-1 border-b border-slate-100 text-right tabular-nums text-slate-700"><span className="text-xs">{balance !== null ? formatMoney(balance) : ""}</span></td>
                            <td className="px-3 py-1 border-b border-slate-100 text-slate-500 truncate max-w-[240px]" title={e.note ?? ""}><span className="text-xs text-slate-500">{e.note ?? ""}</span></td>
                            <td className="px-3 py-1 border-b border-slate-100 text-slate-400"></td>
                            <td className="px-2 py-1 border-b border-slate-100"><EntryRowActions entryId={e.id} edit={(e.type !== "investment" ? otherEditPayload : editPayload) as any} /></td>
                          </tr>
                        );
                      })
                    ) : (<tr><td className="px-4 py-6 text-xs text-slate-500" colSpan={isInvestAccount ? 8 : 9}>暂无记录</td></tr>)
                    }
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
    );
  }
