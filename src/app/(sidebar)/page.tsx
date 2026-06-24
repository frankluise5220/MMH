import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { AccountKind, TransactionType, FundSubtype, RegularInvestStatus, IntervalUnit } from "@prisma/client";
import { kindLabel } from "@/lib/account-kinds";
import { EntryRowActions } from "@/components/EntryRowActions";
import { BasicDetailBatchDeleteButton, BasicDetailBatchReplaceButton, BasicDetailRowCheckbox, BasicDetailSelectAll, BasicDetailSelectionProvider, BasicDetailBatchDeleteMessage } from "@/components/BasicDetailSelection";
import { TransactionFormModal } from "@/components/TransactionFormModal";
import { InvestmentFormModal, type InvestmentEntry, type InvestmentDefaults } from "@/components/InvestmentFormModal";
import { WealthFormModal } from "@/components/WealthFormModal";
import { DepositFormModal } from "@/components/DepositFormModal";
import { FillNavButton } from "@/components/FillNavButton";
import { DebtShell } from "@/components/DebtShell";
import { DebtTransactionModal } from "@/components/DebtTransactionModal";
import { FundShell } from "@/components/FundShell";
import { RegularInvestForm } from "@/components/RegularInvestForm";
import { RegularInvestActionButtons } from "@/components/RegularInvestActionButtons";
import { DashboardOverview } from "@/components/DashboardOverview";
import { DetailViewClient, type DetailEntry } from "@/components/DetailViewClient";


import { RefreshNavButton } from "@/components/RefreshNavButton";
import EditBillAmount from "@/components/EditBillAmount";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download, Upload } from "lucide-react";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { computeAccountDisplayBalances, recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getFundArrivalDays, getFundConfirmDays, setFundConfirmDays, setFundConfirmDaysInTx, setFundArrivalDays, setFundArrivalDaysInTx } from "@/lib/fund/confirmDays";
import { setFundFeeRateByDate, getFundFeeRateByDate, setFundFeeRateByDateInTx } from "@/lib/fund/feeRate";
import { syncMissingFundEntries } from "@/lib/fund/syncMissingEntries";
import { formatMoney } from "@/lib/format";
import { LiveAccountBalance } from "@/components/LiveAccountBalance";
import { getFundNav } from "@/lib/fund/navCache";
import { getCachedHouseholdScope, getHouseholdScope } from "@/lib/server/household-scope";
import { loadCommonData, loadSelectedAccount, loadEntriesForAccount, loadInvestAccountData, loadInvestBalances } from "@/lib/server/cached-data";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import { compareDetailEntriesAsc, compareDetailEntriesDesc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { buildFlatAccountOptions } from "@/lib/account-display";
import { debtActionLabel } from "@/lib/debt";
import {
  buildCreditCardCyclePersistRows,
  computeCreditBillCascade,
  cycleForStatementMonth,
  fillMissingCreditBillSummaries,
  mergeCreditBillSummariesWithCascade,
} from "@/lib/credit/billing";

export const dynamic = "force-dynamic";

import { addDaysUtc, toStatementMonth, creditCardCycle, toNumber, addWorkdaysUtc } from "@/lib/date-utils";

function formatType(type: string) {
  if (type === "expense") return "支出";
  if (type === "income") return "收入";
  if (type === "transfer") return "转账";
  if (type === "investment") return "投资";
  return type;
}

import { subtypeDisplay } from "@/lib/investment-config";
import { LinkDateRangeFilter, LinkNumberRangeFilter, LinkTableColumnFilter } from "@/components/TableColumnFilter";

type DetailFilterColumn = "date" | "flow" | "type" | "related" | "remark";

const DETAIL_EMPTY_VALUE = "(空)";
const DETAIL_FILTER_SEPARATOR = "\u001F";
const DETAIL_FILTER_PARAM_BY_COLUMN: Record<DetailFilterColumn, string> = {
  date: "detailFilterDate",
  flow: "detailFilterFlow",
  type: "detailFilterType",
  related: "detailFilterRelated",
  remark: "detailFilterRemark",
};

function parseDetailFilterParam(value: string | undefined) {
  if (!value) return [];
  return value.split(DETAIL_FILTER_SEPARATOR).map((v) => v.trim()).filter(Boolean);
}

function serializeDetailFilterValues(values: string[]) {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean))).join(DETAIL_FILTER_SEPARATOR);
}

function detailFilterSort(a: string, b: string) {
  if (a === DETAIL_EMPTY_VALUE) return 1;
  if (b === DETAIL_EMPTY_VALUE) return -1;
  return a.localeCompare(b, "zh-CN");
}

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

function toValidDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function toIsoOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? date.toISOString() : null;
}

function toYmdOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? ymdUtc(date) : null;
}

function escapeCsvCell(value: string) {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function buildCsvDataUri(rows: string[][]) {
  const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
  return `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${csv}`)}`;
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
    // If the first path name matches the type label (e.g. root "支出" = type "支出"), don't duplicate it
    const prefix = names[0] === typeLabel(c.type) ? "" : `${typeLabel(c.type)}.`;
    labelById.set(c.id, `${prefix}${names.join(".")}`);
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
  const { householdId } = await getHouseholdScope();

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

  // Client-side handles refresh via mmh:fund:refresh
}

async function createTransaction(formData: FormData) {
  "use server";

  const type = String(formData.get("type") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const amountRaw = parseMoneyInput(formData.get("amount") ?? null);
  const amountAbs = amountRaw > 0 ? Math.abs(amountRaw) : 0;
  const note = String(formData.get("note") ?? "").trim();
  const tagIdsRaw = String(formData.get("tagIds") ?? "[]");
  const tagIds: string[] = JSON.parse(tagIdsRaw).filter((id: string) => typeof id === "string" && id.length > 0);

  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
  const { householdId } = await getHouseholdScope();

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

        const created = await tx.txRecord.create({
          data: {accountId: fromAcc.id,
            accountName: fromAcc.name,
            toAccountId: toAcc.id,
            toAccountName: toAcc.name,
            amount: -amountAbs,
            type: TransactionType.transfer,
            date,
            note: note || null,
            statementMonth: toStatementMonthValue,
            ...{ householdId },
          },
        });
        if (tagIds.length > 0) {
          await tx.entryTag.createMany({ data: tagIds.map(tagId => ({ entryId: created.id, tagId })) });
        }
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

        const created = await tx.txRecord.create({
          data: {accountId: acc.id,
            accountName: acc.name,
            categoryId: cat?.id ?? null,
            categoryName: cat?.name ?? null,
            amount: -amountAbs,
            type: TransactionType.expense,
            date,
            note: note || null,
            statementMonth,
            ...{ householdId },
          },
        });
        if (tagIds.length > 0) {
          await tx.entryTag.createMany({ data: tagIds.map(tagId => ({ entryId: created.id, tagId })) });
        }
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

        const created = await tx.txRecord.create({
          data: { accountId: acc?.id ?? undefined,
            accountName: acc?.name ?? "未知账户",
            categoryId: cat?.id ?? undefined,
            categoryName: cat?.name ?? undefined,
            amount: amountAbs,
            type: TransactionType.income,
            date,
            note: note || undefined,
            statementMonth: statementMonth ?? undefined,
            ...{ householdId },
          } as any,
        });
        if (tagIds.length > 0) {
          await tx.entryTag.createMany({ data: tagIds.map(tagId => ({ entryId: created.id, tagId })) });
        }
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
        // fundName 只存基金名称，不用备注兜底，避免“红利转投”等备注污染基金名称显示
        const fundNameInput = String(formData.get("fundName") ?? "").trim();
        const entryFundName = fundNameInput || fundCode || null;


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

        const applyDateStr = date.toISOString().slice(0, 10);
        const shouldComputeArrival = finalFundSubtype === FundSubtype.buy && !redeemLike && !isDividendCash && !isDividendReinvest;
        let computedConfirmDate: Date | null = fundConfirmDate;
        let computedArrivalDate: Date | null = fundArrivalDate;

        if (shouldComputeArrival && entryFundCode) {
          const confirmStr = computedConfirmDate
            ? computedConfirmDate.toISOString().slice(0, 10)
            : addWorkdaysUtc(applyDateStr, await getFundConfirmDays(investAcc.id, entryFundCode));
          if (confirmStr < applyDateStr) console.warn(`[createTransaction] confirmDate ${confirmStr} < applyDate ${applyDateStr}`);
          computedConfirmDate = new Date(`${confirmStr}T00:00:00.000Z`);

          if (!computedArrivalDate) {
            const arrivalStr = addWorkdaysUtc(confirmStr, await getFundArrivalDays(investAcc.id, entryFundCode));
            computedArrivalDate = new Date(`${arrivalStr}T00:00:00.000Z`);
          }
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
            fundConfirmDate: computedConfirmDate ?? undefined,
            fundArrivalDate: computedArrivalDate ?? undefined,
            fundArrivalAmount: fundArrivalAmount ?? undefined,
            note: note || undefined,
            ...{ householdId },
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

    if (type === "investment") revalidateAfterInvestChange();
    else revalidateAfterTxChange();
    return { ok: true as const };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "记账失败";
    return { ok: false as const, error: msg };
  }
}

async function createDebtTransaction(formData: FormData) {
  "use server";

  const mode = String(formData.get("mode") ?? "").trim();
  const debtAccountId = String(formData.get("debtAccountId") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const principal = parseMoneyInput(formData.get("principal"));
  const interest = parseMoneyInput(formData.get("interest"));
  const note = String(formData.get("note") ?? "").trim();
  const { householdId } = await getHouseholdScope();

  if (!["borrow_in", "repay_out", "lend_out", "collect_in"].includes(mode)) {
    return { ok: false as const, error: "操作类型不正确" };
  }
  if (!debtAccountId || !cashAccountId) {
    return { ok: false as const, error: "请选择往来对象账户和资金账户" };
  }
  if (debtAccountId === cashAccountId) {
    return { ok: false as const, error: "往来对象账户与资金账户不能相同" };
  }
  if (principal <= 0) {
    return { ok: false as const, error: "请输入正确的金额" };
  }
  if (interest < 0) {
    return { ok: false as const, error: "利息不能小于 0" };
  }

  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();

  try {
    await prisma.$transaction(async (tx) => {
      const [debtAccount, cashAccount] = await Promise.all([
        tx.account.findUnique({ where: { id: debtAccountId } }),
        tx.account.findUnique({ where: { id: cashAccountId } }),
      ]);

      if (!debtAccount || debtAccount.kind !== AccountKind.loan) {
        throw new Error("往来对象账户不存在");
      }
      if (!cashAccount || cashAccount.kind === AccountKind.investment || cashAccount.kind === AccountKind.loan) {
        throw new Error("资金账户不正确");
      }

      const transferFromAccount = mode === "borrow_in" || mode === "collect_in" ? debtAccount : cashAccount;
      const transferToAccount = mode === "borrow_in" || mode === "collect_in" ? cashAccount : debtAccount;
      const transferStatementMonth =
        (transferToAccount.kind === AccountKind.bank_credit || transferToAccount.kind === AccountKind.loan) &&
        transferToAccount.billingDay
          ? toStatementMonth(date, transferToAccount.billingDay)
          : null;

      await tx.txRecord.create({
        data: {
          accountId: transferFromAccount.id,
          accountName: transferFromAccount.name,
          toAccountId: transferToAccount.id,
          toAccountName: transferToAccount.name,
          amount: -Math.abs(principal),
          type: TransactionType.transfer,
          date,
          note: note || null,
          statementMonth: transferStatementMonth,
          source: `debt_${mode}`,
          householdId,
        },
      });

      if (interest > 0 && (mode === "repay_out" || mode === "collect_in")) {
        const interestType = mode === "repay_out" ? TransactionType.expense : TransactionType.income;
        const interestCategoryName = mode === "repay_out" ? "利息支出" : "利息";
        const interestCategory = await tx.category.findFirst({
          where: {
            householdId,
            type: interestType === TransactionType.expense ? "expense" : "income",
            name: interestCategoryName,
          },
        });

        await tx.txRecord.create({
          data: {
            accountId: cashAccount.id,
            accountName: cashAccount.name,
            amount: mode === "repay_out" ? -Math.abs(interest) : Math.abs(interest),
            type: interestType,
            date,
            categoryId: interestCategory?.id ?? null,
            categoryName: interestCategory?.name ?? interestCategoryName,
            note: note ? `${note} 利息` : "利息",
            householdId,
          },
        });
      }
    });

    await Promise.all([
      recalcAndSaveAccountBalance(debtAccountId).catch(() => {}),
      recalcAndSaveAccountBalance(cashAccountId).catch(() => {}),
    ]);
    revalidateAfterTxChange();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "借还款失败" };
  }
}

async function editInvestment(formData: FormData) {
  "use server";
  const { householdId } = await getHouseholdScope();
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
  const hasArrivalDays = formData.has("arrivalDays");

  const fundUnitsStr = String(formData.get("fundUnits") ?? "").trim();
  const fundNavStr = String(formData.get("fundNav") ?? "").trim();
  const fundFeeStr = String(formData.get("fundFee") ?? "").trim();
  const fundConfirmDateStr = String(formData.get("fundConfirmDate") ?? "").trim();
  const cashAccountIdStr = String(formData.get("cashAccountId") ?? "").trim();
  const fundArrivalDateStr = String(formData.get("fundArrivalDate") ?? "").trim();
  const fundArrivalAmountStr = String(formData.get("fundArrivalAmount") ?? "").trim();
  const confirmDaysStr = String(formData.get("confirmDays") ?? "").trim();
  const arrivalDaysStr = String(formData.get("arrivalDays") ?? "").trim();
  const feeRateStr = String(formData.get("feeRate") ?? "").trim();

  // 空字符串 → null（清空），有值 → 数值
  const fundUnitsRaw = fundUnitsStr ? parseFloat(fundUnitsStr) : NaN;
  const fundNavRaw = fundNavStr ? parseFloat(fundNavStr) : NaN;
  const fundFeeRaw = fundFeeStr ? parseFloat(fundFeeStr) : NaN;
  const fundArrivalAmountRaw = fundArrivalAmountStr ? parseFloat(fundArrivalAmountStr) : NaN;
  const confirmDaysRaw = confirmDaysStr ? parseInt(confirmDaysStr, 10) : NaN;
  const arrivalDaysRaw = arrivalDaysStr ? parseInt(arrivalDaysStr, 10) : NaN;
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
  const arrivalDays: number | null | undefined = hasArrivalDays
    ? (Number.isFinite(arrivalDaysRaw) && arrivalDaysRaw >= 0 ? arrivalDaysRaw : null)
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
            updateData.toAccountId = oldCashAccId || null;
            updateData.toAccountName = txRecord.toAccountName ?? "";
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

    // 更新入账天数到统一入账天数库
    if (finalInvestmentAccId && fundCode && arrivalDays !== undefined && arrivalDays !== null) {
      await setFundArrivalDays(finalInvestmentAccId, fundCode, arrivalDays).catch(() => {});
    }
    }

    // 更新费率到统一费率库，并按申购/赎回分开保存
    if (finalInvestmentAccId && fundCode && feeRate !== undefined && feeRate !== null) {
      await setFundFeeRateByDate(finalInvestmentAccId, fundCode, feeRate, date, redeemLike ? "redeem" : "buy").catch(() => {});
    }

    revalidateAfterInvestChange();
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
    const arrivalDays = await getFundArrivalDays(investmentAccId, txRecord.fundCode);
    const arrivalDateStr = arrivalDays > 0 ? addWorkdaysUtc(confirmDate, arrivalDays) : confirmDate;
    const arrivalDate = new Date(Date.UTC(parseInt(arrivalDateStr.slice(0, 4)), parseInt(arrivalDateStr.slice(5, 7)) - 1, parseInt(arrivalDateStr.slice(8, 10))));
    const feeType = isRedeemFill ? "redeem" : "buy";
    const feeRateRaw = await getFundFeeRateByDate(investmentAccId, txRecord.fundCode, navDate, feeType);
    const feeRate = feeRateRaw / 100;
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
      fundArrivalDate?: Date;
    } = {
      fundConfirmDate: navDate,
      fundNav: nav,
      fundFee: fee,
      fundArrivalDate: arrivalDate,
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
    // revalidation handled by FundShell optimistic update


    return { ok: true as const, nav, units: units != null ? Number(units.toFixed(6)) : null, fee, confirmDate, arrivalDate: arrivalDateStr };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "获取净值失败" };
  }
}



async function createRegularInvest(formData: FormData) {
  "use server";
  const { householdId } = await getHouseholdScope();
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
  const arrivalDaysRaw = String(formData.get("arrivalDays") ?? "").trim();
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
  const arrivalDays = arrivalDaysRaw ? parseInt(arrivalDaysRaw, 10) : null;
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
          arrivalDays: arrivalDays != null && Number.isFinite(arrivalDays) ? arrivalDays : null,
          skipPendingPreceding,
          ...{ householdId },
        },
      });

      // 同步更新确认天数和手续费率统一库（与 API Route 保持一致）
      const newDays = confirmDays != null && Number.isFinite(confirmDays) ? confirmDays : 1;
      const newRate = feeRate != null && Number.isFinite(feeRate) ? feeRate : 0;
      if (accountId && fundCode) {
        await setFundConfirmDaysInTx(tx, accountId, fundCode, newDays);
        await setFundFeeRateByDateInTx(tx, accountId, fundCode, newRate, startDate, "buy");
        const newArrivalDays = arrivalDays != null && Number.isFinite(arrivalDays) ? arrivalDays : 0;
        await setFundArrivalDaysInTx(tx, accountId, fundCode, newArrivalDays);
      }
    });







    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "创建失败" };
  }
}

async function regularInvestAction(formData: FormData) {
  "use server";
  const { householdId } = await getHouseholdScope();
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "regularInvestAction") return { ok: false as const, error: "intent 不匹配" };

  const planId = String(formData.get("planId") ?? "").trim();
  const actionType = String(formData.get("action") ?? "").trim();

  if (!planId) return { ok: false as const, error: "缺少 planId" };

  const plan = await prisma.regularInvestPlan.findUnique({ where: { id: planId } });
  if (!plan) return { ok: false as const, error: "计划不存在" };
  if (householdId && plan.householdId && plan.householdId !== householdId) return { ok: false as const, error: "越权操作" };

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

    // Client-side handles page refresh via router.refresh() + mmh:fund:refresh
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "操作失败" };
  }
}

async function updateRegularInvest(formData: FormData) {
  "use server";
  const { householdId } = await getHouseholdScope();
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "updateRegularInvest") return { ok: false as const, error: "intent 不匹配" };

  const planId = String(formData.get("planId") ?? "").trim();
  if (!planId) return { ok: false as const, error: "缺少 planId" };

  const plan = await prisma.regularInvestPlan.findUnique({ where: { id: planId } });
  if (!plan) return { ok: false as const, error: "计划不存在" };
  if (householdId && plan.householdId && plan.householdId !== householdId) return { ok: false as const, error: "越权操作" };

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

  const arrivalDaysRaw = String(formData.get("arrivalDays") ?? "").trim();
  if (arrivalDaysRaw) {
    const arrivalDays = parseInt(arrivalDaysRaw, 10);
    if (Number.isFinite(arrivalDays)) updateData.arrivalDays = arrivalDays;
  } else if (formData.has("arrivalDays")) {
    updateData.arrivalDays = null;
  }

  try {
    await prisma.regularInvestPlan.update({
      where: { id: planId },
      data: updateData,
    });

    if (updateData.arrivalDays != null) {
      const updatedPlan = await prisma.regularInvestPlan.findUnique({ where: { id: planId } });
      if (updatedPlan?.accountId && updatedPlan?.fundCode) {
        await setFundArrivalDays(updatedPlan.accountId, updatedPlan.fundCode, updateData.arrivalDays).catch(() => {});
      }
    }

    // Client-side handles page refresh
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "更新失败" };
  }
}

async function deleteRegularInvest(formData: FormData) {
  "use server";
  const { householdId } = await getHouseholdScope();
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "deleteRegularInvest") return { ok: false as const, error: "intent 不匹配" };

  const planId = String(formData.get("planId") ?? "").trim();
  if (!planId) return { ok: false as const, error: "缺少 planId" };

  const plan = await prisma.regularInvestPlan.findUnique({ where: { id: planId } });
  if (!plan) return { ok: false as const, error: "计划不存在" };
  if (householdId && plan.householdId && plan.householdId !== householdId) return { ok: false as const, error: "越权操作" };

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

    // Client-side handles page refresh
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
  const tagIdsRaw = String(formData.get("tagIds") ?? "[]");
  const tagIds: string[] = JSON.parse(tagIdsRaw).filter((id: string) => typeof id === "string" && id.length > 0);

  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
  if (!amountAbs) return { ok: false as const, error: "金额不正确" };

  try {
    let investRecalcAccountId: string | null = null;
    let investRecalcFundCode: string | null = null;
    await prisma.$transaction(async (tx) => {
      const entry = await tx.txRecord.findUnique({
        where: { id: entryId },

      });
      if (!entry) throw new Error("记录不存 ");

      // Update tags: delete old, create new
      await tx.entryTag.deleteMany({ where: { entryId } });
      if (tagIds.length > 0) {
        await tx.entryTag.createMany({ data: tagIds.map(tagId => ({ entryId, tagId })) });
      }

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
            date,
            type: TransactionType.transfer,
            note: note || null,
          },
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
            date,
            type: TransactionType.investment,
            note: note || null,
          },
        });

        investRecalcAccountId = investAcc.id;
        investRecalcFundCode = fundCode || null;
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

      const statementMonth =
        (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
          ? toStatementMonth(date, acc.billingDay)
          : null;

      const expenseOrIncomeData: Record<string, unknown> = {
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
        date,
        type: type === "income" ? TransactionType.income : TransactionType.expense,
        note: note || null,
      };
      if (isFundTransaction && !keepFundDetail) {
        expenseOrIncomeData.fundSubtype = null;
        expenseOrIncomeData.fundUnits = null;
        expenseOrIncomeData.fundNav = null;
        expenseOrIncomeData.fundFee = null;
        expenseOrIncomeData.fundConfirmDate = null;
        expenseOrIncomeData.fundArrivalDate = null;
        expenseOrIncomeData.fundArrivalAmount = null;
      }

      await tx.txRecord.update({
        where: { id: entryId },
        data: expenseOrIncomeData,
      });
    });

    if (investRecalcAccountId) {
      await recalcFundPositions(
        investRecalcAccountId,
        investRecalcFundCode ? [investRecalcFundCode] : undefined,
      ).catch(() => {});
    }

    if (type === "investment") revalidateAfterInvestChange();
    else revalidateAfterTxChange();
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

  // Client-side handles page refresh
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
    debtPerson?: string;
    detailAll?: string;
    detailFilterDate?: string;
    detailFilterFlow?: string;
    detailFilterType?: string;
    detailFilterRelated?: string;
    detailFilterRemark?: string;
    detailDateFrom?: string;
    detailDateTo?: string;
    detailInFrom?: string;
    detailInTo?: string;
    detailOutFrom?: string;
    detailOutTo?: string;
  }>;
}) {
  const params = await searchParams;
  await connection();
  const accountId = typeof params?.accountId === "string" ? params.accountId.trim() : "";
  const accountName = typeof params?.account === "string" ? params.account.trim() : "";
  // 如果没有选择账户，默认跳转到概览页
  if (!accountId && !accountName && params?.view !== "debt") {
    redirect("/overview");
  }
  const viewParam = params?.view === "bill" ? "bill" : params?.view === "detail" ? "detail" : params?.view === "investfund" ? "investfund" : params?.view === "investmoney" ? "investmoney" : params?.view === "regularinvest" ? "regularinvest" : params?.view === "debt" ? "debt" : "";
  const debtPersonParam = typeof params?.debtPerson === "string" ? params.debtPerson.trim() : "";
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
  const detailAll = params?.detailAll === "1";
  const detailDateFrom = typeof params?.detailDateFrom === "string" ? params.detailDateFrom.trim() : "";
  const detailDateTo = typeof params?.detailDateTo === "string" ? params.detailDateTo.trim() : "";
  const detailInFrom = typeof params?.detailInFrom === "string" ? params.detailInFrom.trim() : "";
  const detailInTo = typeof params?.detailInTo === "string" ? params.detailInTo.trim() : "";
  const detailOutFrom = typeof params?.detailOutFrom === "string" ? params.detailOutFrom.trim() : "";
  const detailOutTo = typeof params?.detailOutTo === "string" ? params.detailOutTo.trim() : "";
  const detailColumnFilters: Record<DetailFilterColumn, string[]> = {
    date: parseDetailFilterParam(params?.detailFilterDate),
    flow: parseDetailFilterParam(params?.detailFilterFlow),
    type: parseDetailFilterParam(params?.detailFilterType),
    related: parseDetailFilterParam(params?.detailFilterRelated),
    remark: parseDetailFilterParam(params?.detailFilterRemark),
  };
  const hasDetailFilters =
    !!(detailDateFrom || detailDateTo || detailInFrom || detailInTo || detailOutFrom || detailOutTo) ||
    Object.values(detailColumnFilters).some((values) => values.length > 0);
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
  const fundUnitsDecimalsRaw = Number(cookieStore.get("mmh_fund_units_decimals")?.value ?? 2);
  const fundUnitsDecimals = Number.isFinite(fundUnitsDecimalsRaw) ? Math.min(Math.max(Math.round(fundUnitsDecimalsRaw), 0), 6) : 2;
  const ctx = await getCachedHouseholdScope();
  const { hidFilter, householdId } = ctx;
  // 颜色辅助函数
  const upCls = isRedUp ? "text-red-600" : "text-emerald-700";
  const downCls = isRedUp ? "text-emerald-700" : "text-red-600";
  const pnlCls = (n: number) => n > 0 ? upCls : n < 0 ? downCls : "text-slate-600";
  const pnlBinCls = (cond: boolean) => cond ? upCls : downCls;

  // Common data: 跨账户共享，跨请求缓存
  const common = await loadCommonData(hidFilter);
  const { categories, accounts, tags, groups, institutions } = common;
  // selectedAccount: per-account，请求级缓存去重
  const selectedAccount = await loadSelectedAccount(accountId || undefined, hidFilter);
  const isBillAccount =
    (selectedAccount?.kind === AccountKind.bank_credit || selectedAccount?.kind === AccountKind.loan) ||
    !!selectedAccount?.billingDay;
  const isDebtAccount = selectedAccount?.kind === AccountKind.loan;
  const isInvestAccount = selectedAccount?.kind === AccountKind.investment;
  const isOverview = !viewParam && !accountId && !accountName;
  const view: "bill" | "detail" | "investfund" | "investmoney" | "regularinvest" | "debt" | "overview" =
    isDebtAccount
      ? "debt"
      : viewParam
        ? viewParam
        : isBillAccount
          ? "bill"
          : isInvestAccount
            ? (selectedAccount?.investProductType === "money" ? "investmoney" : "investfund")
            : isOverview
              ? "overview"
              : "detail";
  const needsDetailEntries = view === "detail";

  const legacyNames = (() => {
    if (!selectedAccount) return [];
    const set = new Set<string>();
    set.add(selectedAccount.name);
    const inst = (selectedAccount.Institution?.name ?? "").trim();
    if (inst) set.add(`${inst}·${selectedAccount.name}`);
    return [...set].filter(Boolean);
  })();

  const hid = { householdId };
  const where = accountId
    ? {
        OR: [{ accountId }, { toAccountId: accountId }],
        deletedAt: null,
        ...hid,
      }
    : accountName
      ? { accountName: accountName, deletedAt: null, ...hid }
      : { deletedAt: null, account: { kind: { not: AccountKind.investment }, ...hidFilter } };

  const rawEntries = needsDetailEntries
    ? accountId
      ? await loadEntriesForAccount(accountId, JSON.stringify(hidFilter))
      : await prisma.txRecord.findMany({
          where,
          include: { EntryTag: { include: { Tag: true } } },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          take: 5000,
        })
    : [];
  const toDateValue = (value: unknown) => {
    return toValidDate(value) ?? new Date(0);
  };
  const entryDisplayDate = (e: (typeof rawEntries)[number]) => getDetailEntryDisplayDate(e, accountId);
  const entries = [...rawEntries].sort((a, b) => compareDetailEntriesDesc(a, b, accountId));
  const getDetailFilterColumnValue = (e: (typeof entries)[number], column: DetailFilterColumn) => {
    const amount = toNumber(e.amount);
    const effectiveAmount = !accountId ? amount : e.toAccountId === accountId ? Math.abs(amount) : amount;
    if (column === "date") return entryDisplayDate(e).toISOString().slice(0, 10);
    if (column === "flow") return effectiveAmount >= 0 ? "流入" : "流出";
    if (column === "type") return e.type === "investment" && e.fundSubtype ? (fundSubtypeInfo(e.fundSubtype, e.source, amount)?.label ?? formatType(e.type)) : formatType(e.type);
    if (column === "related") {
      const related = accountId && e.toAccountId === accountId ? (e.accountName ?? "") : (e.toAccountName ?? "");
      return related.trim() || DETAIL_EMPTY_VALUE;
    }
    return (e.note ?? "").trim() || DETAIL_EMPTY_VALUE;
  };
  const detailFilterOptions: Record<DetailFilterColumn, string[]> = {
    date: Array.from(new Set(entries.map((e) => getDetailFilterColumnValue(e, "date")))).sort(detailFilterSort),
    flow: Array.from(new Set(entries.map((e) => getDetailFilterColumnValue(e, "flow")))).sort(detailFilterSort),
    type: Array.from(new Set(entries.map((e) => getDetailFilterColumnValue(e, "type")))).sort(detailFilterSort),
    related: Array.from(new Set(entries.map((e) => getDetailFilterColumnValue(e, "related")))).sort(detailFilterSort),
    remark: Array.from(new Set(entries.map((e) => getDetailFilterColumnValue(e, "remark")))).sort(detailFilterSort),
  };

  const detailDateInRange = (v: string) => {
    let f = detailDateFrom;
    let t = detailDateTo;
    if (f && t && f > t) {
      const tmp = f; f = t; t = tmp;
    }
    if (!f && !t) return true;
    if (!v) return false;
    if (f && v < f) return false;
    if (t && v > t) return false;
    return true;
  };

  const parseRangeNumber = (v: string) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const detailInFromN = parseRangeNumber(detailInFrom);
  const detailInToN = parseRangeNumber(detailInTo);
  const detailOutFromN = parseRangeNumber(detailOutFrom);
  const detailOutToN = parseRangeNumber(detailOutTo);

  const detailNumberInRange = (n: number, fromN: number | null, toN: number | null) => {
    let f = fromN;
    let t = toN;
    if (f != null && t != null && f > t) {
      const tmp = f; f = t; t = tmp;
    }
    if (f != null && n < f) return false;
    if (t != null && n > t) return false;
    return true;
  };

  const filteredEntries = entries.filter((e) => (Object.keys(detailColumnFilters) as DetailFilterColumn[]).every((column) => {
    const allowedValues = detailColumnFilters[column];
    const v = getDetailFilterColumnValue(e, column);
    if (allowedValues.length > 0 && !allowedValues.includes(v)) return false;
    if (column === "date" && (detailDateFrom || detailDateTo) && !detailDateInRange(v)) return false;
    return true;
  }));
  const filteredEntries2 = filteredEntries.filter((e) => {
    const amount = toNumber(e.amount);
    const effectiveAmount = !accountId ? amount : e.toAccountId === accountId ? Math.abs(amount) : amount;
    const inflow = effectiveAmount > 0 ? effectiveAmount : null;
    const outflow = effectiveAmount < 0 ? -effectiveAmount : null;
    if ((detailInFromN != null || detailInToN != null)) {
      if (inflow == null) return false;
      if (!detailNumberInRange(inflow, detailInFromN, detailInToN)) return false;
    }
    if ((detailOutFromN != null || detailOutToN != null)) {
      if (outflow == null) return false;
      if (!detailNumberInRange(outflow, detailOutFromN, detailOutToN)) return false;
    }
    return true;
  });
  const detailTotalPages = Math.max(1, Math.ceil(filteredEntries2.length / pageSize));
  const safeDetailPage = detailAll ? 1 : Math.min(detailPage, detailTotalPages);
  const pagedEntries = detailAll ? filteredEntries2 : filteredEntries2.slice((safeDetailPage - 1) * pageSize, safeDetailPage * pageSize);
  const normalExportRows = (() => {
    const rows = [["日期", "类型", "流出", "流入", "账户", "对向账户", "备注"]];
    for (const e of filteredEntries2) {
      const amount = toNumber(e.amount);
      const effectiveAmount = !accountId ? amount : e.toAccountId === accountId ? Math.abs(amount) : amount;
      const outflow = effectiveAmount < 0 ? String(-effectiveAmount) : "";
      const inflow = effectiveAmount > 0 ? String(effectiveAmount) : "";
      const accountLabel = accountId && e.toAccountId === accountId ? (e.toAccountName ?? "") : (e.accountName ?? "");
      const counterAccountLabel = e.type === TransactionType.transfer || e.type === TransactionType.investment
        ? (accountId && e.toAccountId === accountId ? (e.accountName ?? "") : (e.toAccountName ?? ""))
        : "";
      rows.push([
        entryDisplayDate(e).toISOString().slice(0, 10),
        formatType(e.type),
        outflow,
        inflow,
        accountLabel,
        counterAccountLabel,
        e.note ?? "",
      ]);
    }
    return rows;
  })();
  const normalExportHref = buildCsvDataUri(normalExportRows);
  const normalExportFilename = `${selectedAccount?.name || accountName || "全部账户"}-资金明细.csv`;

  const categoryLabels = buildCategoryPathLabels(categories);
  const expenseCategories = categories
    .filter((c) => c.type === "expense")
    .map((c) => ({ ...c, label: categoryLabels.get(c.id) ?? c.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
  const incomeCategories = categories
    .filter((c) => c.type === "income")
    .map((c) => ({ ...c, label: categoryLabels.get(c.id) ?? c.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));

  const cashDisplayBalanceByAccountId = await computeAccountDisplayBalances(
    accounts
      .filter((account) => account.kind !== AccountKind.investment)
      .map((account) => ({ id: account.id, kind: account.kind, billingDay: account.billingDay })),
    hidFilter,
  );
  const investBalByAccountId = new Map(Object.entries(await loadInvestBalances(JSON.stringify(hidFilter))));

  const total = filteredEntries.reduce(
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

  const totalNetWorthValue = accounts.reduce((sum, account) => {
    if (account.kind === AccountKind.investment) {
      return sum + (investBalByAccountId.get(account.id)?.marketValue ?? toNumber(account.balance));
    }
    return sum + (cashDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance));
  }, 0);
  const monthGrowthValue = 0; // TODO: Real calculation

  const balanceByEntryId = new Map<string, number>();
  if (where) {
    const asc = [...rawEntries].sort((a, b) => compareDetailEntriesAsc(a, b, accountId));
    let running = 0;
    for (const e of asc) {
      const amount = toNumber(e.amount);
      const isToAccount = accountId && e.toAccountId === accountId;
      running += isToAccount ? Math.abs(amount) : amount;
      balanceByEntryId.set(e.id, running);
    }
  }

  const selectedAccountLabel = (() => {
    if (view === "debt") return "借入/借出";
    if (selectedAccount) {
      const inst = (selectedAccount.Institution?.name ?? "").trim();
      const accountLabel = inst ? `${inst}·${selectedAccount.name}` : selectedAccount.name;
      if (selectedAccount.kind === AccountKind.investment) return accountLabel;
      const group = (selectedAccount.AccountGroup?.name ?? "").trim();
      return [group, accountLabel].filter(Boolean).join(" / ");
    }
    return accountName || "";
  })();

  const accountOptions = accounts.map((a) => ({
    id: a.id,
    kind: a.kind,
    label: a.Institution?.name ? `${a.Institution?.name}·${a.name}` : a.name,
    groupId: a.groupId ?? "",
    groupName: a.AccountGroup?.name ?? "",
    investProductType: a.investProductType,
    subLabel: kindLabel(a.kind),
  }));

  // Build hierarchical SmartSelect options: grouped by AccountGroup (isHeader),
  // ungrouped accounts shown flat with institution as subLabel
  type SSOpt = { id: string; label: string; subLabel?: string; isHeader?: boolean; isGroup?: boolean; parentId?: string };
  function buildAccountSSOptions(filter?: (a: typeof accountOptions[number]) => boolean): SSOpt[] {
    const filtered = filter ? accountOptions.filter(filter) : accountOptions;
    const grouped = filtered.filter(a => a.groupId);
    const ungrouped = filtered.filter(a => !a.groupId);

    // Build group header entries
    const groupHeaders: SSOpt[] = groups
      .filter(g => grouped.some(a => a.groupId === g.id))
      .map(g => ({ id: `group:${g.id}`, label: g.name, isHeader: true }));

    // Build grouped account entries (parentId → group header)
    const groupedItems: SSOpt[] = grouped.map(a => ({
      id: a.id,
      label: a.label,
      subLabel: a.subLabel,
      parentId: `group:${a.groupId}`,
    }));

    // Build ungrouped account entries (no parentId)
    const ungroupedItems: SSOpt[] = ungrouped.map(a => ({
      id: a.id,
      label: a.label,
      subLabel: a.subLabel,
    }));

    return [...groupHeaders, ...groupedItems, ...ungroupedItems];
  }

  const spendingAccountOptions = accounts
    .filter((a) => a.kind !== AccountKind.investment)
    .map((a) => ({
      id: a.id,
      label: a.Institution?.name ? `${a.Institution.name}·${a.name}` : a.name,
      groupId: a.groupId ?? "",
      groupName: a.AccountGroup?.name ?? "",
      subLabel: kindLabel(a.kind),
    }));
  const investmentAccountOptions = accounts
    .filter((a) => a.kind === AccountKind.investment)
    .map((a) => ({
      id: a.id,
      name: a.name,
      label: a.Institution?.name ? `${a.Institution.name}·${a.name}` : a.name,
      groupId: a.groupId ?? "",
      groupName: a.AccountGroup?.name ?? "",
      investProductType: a.investProductType,
      subLabel: kindLabel(a.kind),
    }));
  const accountLabelById = new Map(accountOptions.map((a) => [a.id, a.label]));
  const investmentProductTypeByAccountId = new Map(investmentAccountOptions.map((a) => [a.id, a.investProductType]));
  const investmentProductTypeByAccountIdObj = Object.fromEntries(investmentProductTypeByAccountId);

  // Pre-computed hierarchical SS options for modal props
  const allAccountSSOptions = buildAccountSSOptions(); // all accounts for transfer dropdown
  const cashAccountSSOptions = buildAccountSSOptions(a => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet");
  const spendingAccountSSOptions = buildAccountSSOptions(a => a.kind !== "investment");
  const investmentAccountSSOptions = buildFlatAccountOptions(accountOptions.filter(a => a.kind === "investment"));
  // Flat lists for components that don't use SS hierarchy (backward compat)
  const cashAccountList = accountOptions.filter(a => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet").map(a => ({ id: a.id, label: a.label, subLabel: a.subLabel }));
  const investmentAccountList = accountOptions.filter(a => a.kind === "investment").map(a => ({ id: a.id, label: a.label, subLabel: a.subLabel }));

  // NestedAddModal fieldData for groups & institutions
  const nestedFieldData = {
    groupId: groups.map(g => ({ id: g.id, name: g.name })),
    institutionId: institutions.map(it => ({ id: it.id, name: it.name, type: it.type ?? "" })),
  };

  const debtAccounts = accounts.filter((account) => account.kind === AccountKind.loan);
  const debtRowMap = new Map<string, {
    key: string;
    name: string;
    payable: number;
    receivable: number;
    net: number;
    accountCount: number;
    accountIds: string[];
    accountLabels: string[];
  }>();

  for (const account of debtAccounts) {
    const institutionName = (account.Institution?.name ?? "").trim();
    const rowKey = institutionName
      ? `institution:${account.institutionId ?? institutionName}`
      : `account:${account.id}`;
    const rowName = institutionName || account.name;
    const balance = cashDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance);
    const current = debtRowMap.get(rowKey) ?? {
      key: rowKey,
      name: rowName,
      payable: 0,
      receivable: 0,
      net: 0,
      accountCount: 0,
      accountIds: [],
      accountLabels: [],
    };
    current.accountCount += 1;
    current.accountIds.push(account.id);
    current.accountLabels.push(institutionName ? `${institutionName}·${account.name}` : account.name);
    current.net += balance;
    if (balance >= 0) current.receivable += balance;
    else current.payable += Math.abs(balance);
    debtRowMap.set(rowKey, current);
  }

  const debtRows = Array.from(debtRowMap.values()).sort(
    (a, b) => (b.payable + b.receivable) - (a.payable + a.receivable),
  );
  const derivedDebtKey = selectedAccount?.kind === AccountKind.loan
    ? (((selectedAccount.Institution?.name ?? "").trim()
        ? `institution:${selectedAccount.institutionId ?? (selectedAccount.Institution?.name ?? "").trim()}`
        : `account:${selectedAccount.id}`))
    : "";
  const selectedDebtKey = debtRows.some((row) => row.key === debtPersonParam)
    ? debtPersonParam
    : debtRows.some((row) => row.key === derivedDebtKey)
      ? derivedDebtKey
      : debtRows[0]?.key ?? "";
  const selectedDebtRow = debtRows.find((row) => row.key === selectedDebtKey) ?? null;
  const totalDebtPayable = debtRows.reduce((sum, row) => sum + row.payable, 0);
  const totalDebtReceivable = debtRows.reduce((sum, row) => sum + row.receivable, 0);

  const debtEntriesRaw =
    view === "debt" && debtAccounts.length > 0
      ? await prisma.txRecord.findMany({
          where: {
            deletedAt: null,
            ...hid,
            OR: [
              { accountId: { in: debtAccounts.map((account) => account.id) } },
              { toAccountId: { in: debtAccounts.map((account) => account.id) } },
            ],
          },
          include: { EntryTag: { include: { Tag: true } } },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          take: 3000,
        })
      : [];
  const selectedDebtAccountIds = new Set(selectedDebtRow?.accountIds ?? []);
  const debtAccountLabelById = new Map(
    debtAccounts.map((account) => [
      account.id,
      (account.Institution?.name ? `${account.Institution.name}·${account.name}` : account.name),
    ]),
  );
  const filteredDebtEntries = debtEntriesRaw.filter(
    (entry) => selectedDebtAccountIds.has(entry.accountId ?? "") || selectedDebtAccountIds.has(entry.toAccountId ?? ""),
  );
  const debtBalanceByEntryId = new Map<string, number>();
  let runningDebtBalance = 0;
  for (const entry of [...filteredDebtEntries].sort((a, b) => compareDetailEntriesAsc(a, b))) {
    const amount = toNumber(entry.amount);
    const isToDebtAccount = selectedDebtAccountIds.has(entry.toAccountId ?? "");
    const displayAmount = isToDebtAccount ? Math.abs(amount) : amount;
    runningDebtBalance += displayAmount;
    debtBalanceByEntryId.set(entry.id, runningDebtBalance);
  }
  const debtDetailEntries = filteredDebtEntries
    .map((entry) => {
      const amount = toNumber(entry.amount);
      const isToDebtAccount = selectedDebtAccountIds.has(entry.toAccountId ?? "");
      const displayAmount = isToDebtAccount ? Math.abs(amount) : amount;
      const relatedAccountId = isToDebtAccount ? (entry.toAccountId ?? "") : (entry.accountId ?? "");
      const inferredDirection = (selectedDebtRow?.net ?? 0) >= 0 ? "receivable" : "payable";
      const transferActionLabel =
        entry.source === "debt_borrow_in"
          ? "借入"
          : entry.source === "debt_repay_out"
            ? "还款"
            : entry.source === "debt_lend_out"
              ? "借出"
              : entry.source === "debt_collect_in"
                ? "收回"
                : debtActionLabel({
                    direction: inferredDirection,
                    isDebtAccountFromSide: !isToDebtAccount,
                  });
      return {
        id: entry.id,
        date: entryDisplayDate(entry).toISOString().slice(0, 10),
        typeLabel: entry.type === TransactionType.transfer ? transferActionLabel : (entry.categoryName || formatType(entry.type)),
        relatedAccountLabel: debtAccountLabelById.get(relatedAccountId) ?? "-",
        note: entry.note ?? "",
        amount: displayAmount,
        balance: debtBalanceByEntryId.get(entry.id) ?? 0,
        edit:
          entry.type === TransactionType.transfer
            ? {
                type: "transfer" as const,
                date: entryDisplayDate(entry).toISOString().slice(0, 10),
                amount: Math.abs(amount),
                note: entry.note ?? "",
                fromAccountId: entry.accountId ?? "",
                toAccountId: entry.toAccountId ?? "",
              }
            : {
                type: entry.type === TransactionType.income ? "income" as const : "expense" as const,
                date: entryDisplayDate(entry).toISOString().slice(0, 10),
                amount: Math.abs(amount),
                note: entry.note ?? "",
                accountId: entry.accountId ?? "",
                categoryId: entry.categoryId ?? "",
              },
      };
    });

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
  const billSummaries = fillMissingCreditBillSummaries({
    months: billMonthsForList,
    summaryByMonth: billSummaryByMonth,
    billingDay: selectedAccount?.billingDay ?? 1,
    repaymentDay: selectedAccount?.repaymentDay ?? null,
    now: new Date(),
  });

  const {
    overrideByMonth,
    allMonthsForCascade,
    effectiveBillByMonth,
    cumulativeByMonth,
  } = computeCreditBillCascade({
    monthsForCascade: billMonthsForCumulative,
    summaryByMonth: billSummaryByMonth,
    overrides: billOverrides.map((override) => ({
      statementMonth: override.statementMonth,
      amount: Number(override.amount),
    })),
  });
  const creditCardCyclePersistRows = buildCreditCardCyclePersistRows({
    billingDay: selectedAccount?.billingDay ?? 1,
    repaymentDay: selectedAccount?.repaymentDay ?? null,
    months: allMonthsForCascade,
    summaryByMonth: billSummaryByMonth,
    effectiveBillByMonth,
    cumulativeByMonth,
    overrideByMonth,
    now: new Date(),
  });

  if (isBillAccount && selectedAccount) {
    await Promise.all(
      creditCardCyclePersistRows.map(async (row) => {
        await prisma.creditCardCycle.upsert({
          where: { accountId_statementMonth: { accountId: selectedAccount.id, statementMonth: row.statementMonth } },
          create: {
            accountId: selectedAccount.id,
            statementMonth: row.statementMonth,
            periodStart: row.periodStart,
            periodEnd: row.periodEnd,
            dueDate: row.dueDate,
            expenseAbs: String(row.expenseAbs),
            income: String(row.income),
            paid: String(row.paid),
            rawBill: String(row.rawBill),
            effectiveBill: String(row.effectiveBill),
            cumulativeRemain: String(row.cumulativeRemain),
            cumulativeOverpaid: String(row.cumulativeOverpaid),
            isCurrentCycle: row.isCurrentCycle,
            isLocked: row.isLocked,
            lockSource: row.lockSource,
          },
          update: {
            periodStart: row.periodStart,
            periodEnd: row.periodEnd,
            dueDate: row.dueDate,
            expenseAbs: String(row.expenseAbs),
            income: String(row.income),
            paid: String(row.paid),
            rawBill: String(row.rawBill),
            effectiveBill: String(row.effectiveBill),
            cumulativeRemain: String(row.cumulativeRemain),
            cumulativeOverpaid: String(row.cumulativeOverpaid),
            isCurrentCycle: row.isCurrentCycle,
            isLocked: row.isLocked,
            lockSource: row.lockSource,
          },
        });
      }),
    );
  }

  const billSummariesWithCumulative = mergeCreditBillSummariesWithCascade(
    billSummaries,
    effectiveBillByMonth,
    cumulativeByMonth,
  );

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

  const selectedAccountBalanceValue = selectedAccount
    ? selectedAccount.kind === AccountKind.investment
      ? investBalByAccountId.get(selectedAccount.id)?.marketValue ?? toNumber(selectedAccount.balance)
      : cashDisplayBalanceByAccountId.get(selectedAccount.id) ?? toNumber(selectedAccount.balance)
    : 0;

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
            include: { EntryTag: { include: { Tag: true } } },
            orderBy: [{ date: "desc" }, { createdAt: "desc" }],
            take: 500,
          });
          return { cycleEntries };
        })()
      : null;

  const investDataParams = JSON.stringify({
    fundSortParam,
    fundSortDirParam,
    fundPageSize,
    fundPage,
    fundCodeParam,
  });
  const investDataHidFilter = JSON.stringify(hidFilter);
  const investmoneyData = view === "investmoney" && accountId
    ? await loadInvestAccountData(investDataHidFilter, accountId, investDataParams)
    : null;
  const investfundData = view === "investfund" && accountId
    ? await loadInvestAccountData(investDataHidFilter, accountId, investDataParams)
    : null;

  // 定投计划数据加载
  const regularInvestData = viewParam === "regularinvest" && accountId && selectedAccount
    ? await (async () => {
        const plans = await prisma.regularInvestPlan.findMany({
          where: { accountId, ...hidFilter },
          orderBy: { nextRunDate: "asc" },
        });
        return { plans };
      })()
    : null;

  const baseQuery = new URLSearchParams();
  if (accountId) baseQuery.set("accountId", accountId);
  else if (accountName) baseQuery.set("account", accountName);
  const withDetailParams = (mutate?: (q: URLSearchParams) => void) => {
    const q = new URLSearchParams(baseQuery);
    q.set("view", "detail");
    q.set("pageSize", String(pageSize));
    if (!detailAll) q.set("detailPage", String(safeDetailPage));
    else q.set("detailAll", "1");
    (Object.keys(detailColumnFilters) as DetailFilterColumn[]).forEach((column) => {
      const value = serializeDetailFilterValues(detailColumnFilters[column]);
      if (value) q.set(DETAIL_FILTER_PARAM_BY_COLUMN[column], value);
    });
    if (detailDateFrom) q.set("detailDateFrom", detailDateFrom);
    if (detailDateTo) q.set("detailDateTo", detailDateTo);
    if (detailInFrom) q.set("detailInFrom", detailInFrom);
    if (detailInTo) q.set("detailInTo", detailInTo);
    if (detailOutFrom) q.set("detailOutFrom", detailOutFrom);
    if (detailOutTo) q.set("detailOutTo", detailOutTo);
    mutate?.(q);
    return `/?${q.toString()}`;
  };
  const hrefDetail = (() => {
    const q = new URLSearchParams(baseQuery);
    q.set("view", "detail");
    if (hideZeroBills) q.set("hideZeroBills", "1");
    if (hideSettledBills) q.set("hideSettledBills", "1");
    return `/?${q.toString()}`;
  })();
  const hrefAllDetails = withDetailParams((q) => {
    q.set("detailAll", "1");
    q.delete("detailPage");
  });
  const hrefPagedDetails = withDetailParams((q) => {
    q.delete("detailAll");
    q.set("detailPage", "1");
  });
  const hrefBill = (() => {
    const q = new URLSearchParams(baseQuery);
    q.set("view", "bill");
    if (selectedBillMonth) q.set("billMonth", selectedBillMonth);
    if (hideZeroBills) q.set("hideZeroBills", "1");
    if (hideSettledBills) q.set("hideSettledBills", "1");
    return `/?${q.toString()}`;
  })();

  const renderDetailFilterHeader = (column: DetailFilterColumn, label: string, className: string) => {
    const activeValues = detailColumnFilters[column];
    const options = detailFilterOptions[column];
    const hasDateRange = column === "date" && !!(detailDateFrom || detailDateTo);
    const active = activeValues.length > 0 || hasDateRange;
    return (
      <th className={className}>
        {column === "date" ? (() => {
          const clearHref = active ? withDetailParams((q) => {
            q.delete(DETAIL_FILTER_PARAM_BY_COLUMN.date);
            q.delete("detailDateFrom");
            q.delete("detailDateTo");
            q.set("detailPage", "1");
          }) : null;
          const current = new URLSearchParams(withDetailParams().slice(2));
          current.delete(DETAIL_FILTER_PARAM_BY_COLUMN.date);
          current.delete("detailDateFrom");
          current.delete("detailDateTo");
          current.set("detailPage", "1");
          const hiddenInputs = Array.from(current.entries()).map(([k, v]) => ({ name: k, value: v }));
          const badgeText = hasDateRange ? "范围" : (activeValues.length > 0 ? String(activeValues.length) : null);
          return (
            <LinkDateRangeFilter
              label={label}
              from={detailDateFrom}
              to={detailDateTo}
              badgeText={badgeText}
              clearHref={clearHref}
              hiddenInputs={hiddenInputs}
            />
          );
        })() : (() => {
          const clearHref = active ? withDetailParams((q) => { q.delete(DETAIL_FILTER_PARAM_BY_COLUMN[column]); q.set("detailPage", "1"); }) : null;
          const items = options.map((value) => {
            const nextValues = activeValues.includes(value) ? activeValues.filter((v) => v !== value) : [...activeValues, value];
            const href = withDetailParams((q) => {
              const serialized = serializeDetailFilterValues(nextValues);
              if (serialized) q.set(DETAIL_FILTER_PARAM_BY_COLUMN[column], serialized);
              else q.delete(DETAIL_FILTER_PARAM_BY_COLUMN[column]);
              q.set("detailPage", "1");
            });
            return { value, href, checked: activeValues.includes(value) };
          });
          const badgeText = activeValues.length > 0 ? String(activeValues.length) : null;
          return (
            <LinkTableColumnFilter
              label={label}
              badgeText={badgeText}
              items={items}
              clearHref={clearHref}
            />
          );
        })()}
      </th>
    );
  };

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

  // Convert pagedEntries to serializable format for DetailViewClient
  const pagedDetailEntries: DetailEntry[] = (pagedEntries || []).map((e) => ({
    id: e.id,
    date: entryDisplayDate(e).toISOString().slice(0, 10),
    createdAt: toIsoOrNull(e.createdAt),
    amount: toNumber(e.amount),
    runningBalance: balanceByEntryId.get(e.id) ?? null,
    type: e.type,
    categoryId: e.categoryId,
    categoryName: e.categoryName,
    accountId: e.accountId,
    accountName: e.accountName,
    toAccountId: e.toAccountId,
    toAccountName: e.toAccountName,
    note: e.note,
    fundSubtype: e.fundSubtype,
    fundCode: e.fundCode,
    fundName: e.fundName,
    source: e.source,
    fundProductType: e.fundProductType,
    fundUnits: e.fundUnits != null ? toNumber(e.fundUnits) : null,
    fundNav: e.fundNav != null ? toNumber(e.fundNav) : null,
    fundFee: e.fundFee != null ? toNumber(e.fundFee) : null,
    fundConfirmDate: toIsoOrNull(e.fundConfirmDate),
    fundArrivalDate: toIsoOrNull(e.fundArrivalDate),
    fundArrivalAmount: e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null,
    entryTags: (e.EntryTag || []).map((et: any) => ({
      tagId: et.tagId,
      Tag: et.Tag ? { name: et.Tag.name, color: et.Tag.color } : null,
    })),
  }));

  return (
    <div className="flex h-full w-full bg-transparent">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="page-header">
          <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2 md:px-5">
            <div className="flex min-w-0 flex-wrap items-center gap-3 text-sm">
              <span className="page-title">{selectedAccountLabel || "全部账户"}</span>
              {view === "debt" ? (
                <span className={`tabular-nums font-semibold ${pnlCls(totalDebtReceivable - totalDebtPayable)}`}>
                  {formatMoney(totalDebtReceivable - totalDebtPayable)}
                </span>
              ) : !selectedAccount ? (
                <LiveAccountBalance mode="total" initialValue={totalNetWorthValue} isRedUp={isRedUp} />
              ) : view === "investmoney" && investmoneyData ? (
                <span className={`tabular-nums font-semibold ${pnlCls(investmoneyData.totalMarketValue)}`}>{formatMoney(investmoneyData.totalMarketValue)}</span>
              ) : view === "investfund" && investfundData ? (
                <span className={`tabular-nums font-semibold ${pnlCls(investfundData.totalMarketValue)}`}>{formatMoney(investfundData.totalMarketValue)}</span>
              ) : (
                <LiveAccountBalance mode="account" accountId={selectedAccount.id} initialValue={selectedAccountBalanceValue} isRedUp={isRedUp} />
              )}
              {isBillAccount && view !== "debt" && (
                <div className="flex items-center gap-2">
                  <a href={hrefBill} className={`h-8 px-3 rounded-[10px] border text-xs flex items-center ${view === "bill" ? "border-blue-200 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>账单</a>
                  <a href={hrefDetail} className={`h-8 px-3 rounded-[10px] border text-xs flex items-center ${view === "detail" ? "border-blue-200 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>明细</a>
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
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
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                holdings={(view === "investfund" ? investfundData : investmoneyData)?.positions.map(p => ({ fundCode: p.fundCode, name: p.name, units: p.units })) ?? undefined}
                allEntries={(view === "investfund" ? investfundData : investmoneyData)?.allEntries.map(e => ({
                  date: toYmdOrNull(e.date) ?? "",
                  fundConfirmDate: toYmdOrNull(e.fundConfirmDate),
                  fundArrivalDate: toYmdOrNull(e.fundArrivalDate),
                  fundCode: e.fundCode ?? "",
                  fundSubtype: e.fundSubtype ?? "",
                  fundUnits: e.fundUnits != null ? Number(e.fundUnits) : null,
                  source: e.source ?? null,
                })) ?? undefined}
                createAction={createTransaction}
              />
            ) : view === "regularinvest" && selectedAccount ? (
              <RegularInvestForm accountId={selectedAccount.id} accountLabel={selectedAccountLabel} cashAccounts={cashAccountList} cashAccountSSOptions={cashAccountSSOptions} investmentAccountSSOptions={investmentAccountSSOptions} nestedFieldData={nestedFieldData} action={regularInvestFormAction} showTriggerButton={false} />
            ) : view === "debt" ? (
              <DebtTransactionModal
                debtAccounts={(selectedDebtRow?.accountIds ?? []).map((id) => ({
                  id,
                  label: debtAccountLabelById.get(id) ?? id,
                  subLabel: "借入/借出",
                }))}
                cashAccounts={cashAccountList}
                defaultDebtAccountId={selectedDebtRow?.accountIds?.[0] ?? ""}
                defaultCashAccountId={cashAccountList[0]?.id ?? ""}
                action={createDebtTransaction}
              />
            ) : (
              <>
              <TransactionFormModal
                accounts={spendingAccountOptions} transferAccounts={accountOptions}
                accountSSOptions={spendingAccountSSOptions} transferAccountSSOptions={allAccountSSOptions}
                nestedFieldData={nestedFieldData}
                expenseCategories={expenseCategories.map((c) => ({ id: c.id, label: c.label, parentId: c.parentId, type: c.type }))}
                incomeCategories={incomeCategories.map((c) => ({ id: c.id, label: c.label, parentId: c.parentId, type: c.type }))}
                defaultAccountId={accountId || undefined}
                lastRepayToAccountId={lastRepayToAccountId} lastRepayFromAccountId={lastRepayFromAccountId}
                isCreditCardAccount={isBillAccount} showInvestment={isInvestAccount} action={createTransaction} editAction={updateTransactionFromDialog}
                allTags={tags.map(t => ({ id: t.id, name: t.name, color: t.color }))}
              />
              <InvestmentFormModal
                mode="edit"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                accountProductType={selectedAccount?.investProductType ?? null}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                createAction={createTransaction}
                editAction={editInvestment}
              />
              <WealthFormModal
                mode="edit"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                nestedFieldData={nestedFieldData}
                createAction={createTransaction}
                editAction={editInvestment}
              />
              <DepositFormModal
                mode="edit"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                nestedFieldData={nestedFieldData}
                createAction={createTransaction}
                editAction={editInvestment}
              />
              {isBillAccount && !isInvestAccount ? <a href="/invest" className="h-8 px-3 rounded-[10px] border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50 flex items-center">投资</a> : null}
              </>
            )}
            </div>
          </div>
        </header>

        <div className="flex flex-1 flex-col overflow-hidden bg-transparent">
          {isOverview ? (
            <DashboardOverview 
              totalNetWorth={totalNetWorthValue} 
              monthGrowth={monthGrowthValue} 
              isRedUp={isRedUp}
              createAction={createTransaction}
            />
          ) : view === "bill" && isBillAccount ? (
            <div className="flex-1 overflow-auto bg-transparent">
              <div className="space-y-4 p-4 md:p-5">
                {billSummariesWithCumulative.length > 0 ? (
                  <div className="panel-surface overflow-hidden">
                    <div className="panel-header">
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
                                className={`hover:bg-blue-50/40 ${active ? "bg-blue-50" : ""}`}
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

                <div className="panel-surface overflow-hidden">
                  <div className="panel-header block">
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
                            const date = toYmdOrNull(e.date) ?? "";
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
                                      tagIds: e.EntryTag?.map((et: any) => et.tagId) ?? [],
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
                                      tagIds: e.EntryTag?.map((et: any) => et.tagId) ?? [],
                                    };
                            return (
                              <tr key={e.id} className="hover:bg-blue-50/40">
                                <td className="px-4 py-2 border-b border-slate-100 tabular-nums">
                                  <span className="text-xs text-slate-700">{date}</span>
                                </td>
                                <td className="px-3 py-2 border-b border-slate-100">
                                  <span className="text-xs text-slate-700">{categoryLabel}</span>
                                </td>
                                <td className="px-3 py-2 border-b border-slate-100 text-slate-600 truncate max-w-[520px]" title={e.note ?? ""}>
                                  {e.EntryTag && e.EntryTag.length > 0 && (
                                    <span className="inline-flex flex-wrap gap-1 mr-1">
                                      {e.EntryTag.map((et: any) => {
                                        const c = et.Tag?.color || "#3B82F6";
                                        return <span key={et.tagId} className="text-[10px] px-1 py-0.5 rounded-full border" style={{ backgroundColor: c + "18", color: c, borderColor: c + "60" }}>{et.Tag?.name}</span>;
                                      })}
                                    </span>
                                  )}
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
          ) : view === "debt" ? (
            <DebtShell
              rows={debtRows.map((row) => ({
                key: row.key,
                name: row.name,
                payable: row.payable,
                receivable: row.receivable,
                net: row.net,
                accountCount: row.accountCount,
              }))}
              selectedKey={selectedDebtKey}
              entries={debtDetailEntries}
              totalPayable={totalDebtPayable}
              totalReceivable={totalDebtReceivable}
            />
          ) : view === "investmoney" && investmoneyData ? (
            <FundShell
              key={`investmoney-${accountId}`}
              view="investmoney"
              initialFundCode={investmoneyData.selectedFundCode}
              positions={investmoneyData.positions}
              clearedPositions={investmoneyData.clearedPositions}
              allEntries={JSON.parse(JSON.stringify(investmoneyData.allEntries))}
              totalMarketValue={investmoneyData.totalMarketValue}
              totalCost={investmoneyData.totalCost}
              totalHistoricalProfit={investmoneyData.totalHistoricalProfit}
              confirmDaysMap={investmoneyData.confirmDaysMap}
              feeRateMap={investmoneyData.feeRateMap}
              initialShowCleared={showCleared}
              baseQuery={baseQuery.toString()}
              accountId={accountId}
              selectedAccount={JSON.parse(JSON.stringify(selectedAccount ?? {}))}
              selectedAccountLabel={selectedAccountLabel}
              accountOptions={accountOptions}
              cashAccounts={cashAccountList}
              investmentAccounts={investmentAccountList}
              cashAccountSSOptions={cashAccountSSOptions}
              investmentAccountSSOptions={investmentAccountSSOptions}
              nestedFieldData={nestedFieldData}
              createAction={createTransaction}
              editAction={editInvestment}
              fillNavAction={fillFundNavFromCache}
              regularInvestFormAction={regularInvestFormAction}
              lastUsedCashAccount={lastUsedCashAccount}
              isRedUp={isRedUp}
              fundUnitsDecimals={fundUnitsDecimals}
            />
          ) : view === "investfund" && investfundData ? (
            <FundShell
              key={`investfund-${accountId}`}
              view="investfund"
              initialFundCode={investfundData.selectedFundCode}
              positions={investfundData.positions}
              clearedPositions={investfundData.clearedPositions}
              allEntries={JSON.parse(JSON.stringify(investfundData.allEntries))}
              totalMarketValue={investfundData.totalMarketValue}
              totalCost={investfundData.totalCost}
              totalHistoricalProfit={investfundData.totalHistoricalProfit}
              confirmDaysMap={investfundData.confirmDaysMap}
              feeRateMap={investfundData.feeRateMap}
              initialShowCleared={showCleared}
              baseQuery={baseQuery.toString()}
              accountId={accountId}
              selectedAccount={JSON.parse(JSON.stringify(selectedAccount ?? {}))}
              selectedAccountLabel={selectedAccountLabel}
              accountOptions={accountOptions}
              cashAccounts={cashAccountList}
              investmentAccounts={investmentAccountList}
              cashAccountSSOptions={cashAccountSSOptions}
              investmentAccountSSOptions={investmentAccountSSOptions}
              nestedFieldData={nestedFieldData}
              createAction={createTransaction}
              editAction={editInvestment}
              fillNavAction={fillFundNavFromCache}
              regularInvestFormAction={regularInvestFormAction}
              lastUsedCashAccount={lastUsedCashAccount}
              isRedUp={isRedUp}
              fundUnitsDecimals={fundUnitsDecimals}
            />
          ) : (
            <div className="flex-1 min-h-0 flex flex-col bg-transparent p-4 md:p-5">
              <div className="panel-surface flex min-h-0 flex-1 flex-col overflow-hidden">
                <BasicDetailSelectionProvider>
                <BasicDetailBatchDeleteMessage />
                <div className="panel-header shrink-0">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-semibold text-slate-800">资金明细</div>
                    <Link href="/batch-import" className="h-7 px-2 rounded border border-slate-200 bg-white text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-1" title="导入账单记录">
                      <Upload className="w-3 h-3" />导入
                    </Link>
                    <a href={normalExportHref} download={normalExportFilename} className="h-7 px-2 rounded border border-slate-200 bg-white text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-1" title="导出当前资金明细 CSV">
                      <Download className="w-3 h-3" />导出
                    </a>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-xs text-slate-600">共 {filteredEntries2.length} 条{hasDetailFilters ? ` / 原 ${entries.length} 条` : ""}</span>
                    <span className="text-xs text-slate-400 mx-1">|</span>
                    <span className="text-xs text-slate-600">每页</span>
                    {[10, 20, 40].map((n) => {
                      const href = withDetailParams((q) => { q.set("pageSize", String(n)); q.set("detailPage", "1"); q.delete("detailAll"); });
                      const active = !detailAll && pageSize === n;
                      return <a key={n} href={href} className={`h-7 px-2 rounded border inline-flex items-center justify-center ${active ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>{n}</a>;
                    })}
                    <a href={hrefAllDetails} className={`h-7 px-2 rounded border inline-flex items-center justify-center ${detailAll ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`} title="当前账户全部记录不分页显示">全部</a>
                    <span className="text-xs text-slate-600">条</span>
                    <span className="text-slate-400">|</span>
                    {!detailAll && safeDetailPage > 1 ? (
                      <a href={withDetailParams((q) => { q.set("detailPage", "1"); q.delete("detailAll"); })} className="h-7 w-7 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-400 hover:bg-slate-50" title="第一页"><ChevronsLeft className="h-3.5 w-3.5"/></a>
                    ) : (
                      <span className="h-7 w-7 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300 cursor-not-allowed" title={detailAll ? "全部模式" : "已是第一页"}><ChevronsLeft className="h-3.5 w-3.5"/></span>
                    )}
                    {!detailAll && safeDetailPage > 1 ? (
                      <a href={withDetailParams((q) => { q.set("detailPage", String(safeDetailPage - 1)); q.delete("detailAll"); })} className="h-7 w-7 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50" title="上一页"><ChevronLeft className="h-3.5 w-3.5"/></a>
                    ) : (
                      <span className="h-7 w-7 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300 cursor-not-allowed" title={detailAll ? "全部模式" : "已是第一页"}><ChevronLeft className="h-3.5 w-3.5"/></span>
                    )}
                    <span className="min-w-10 text-center text-xs text-slate-500">{detailAll ? "全部" : `${safeDetailPage}/${detailTotalPages}`}</span>
                    {!detailAll && safeDetailPage < detailTotalPages ? (
                      <a href={withDetailParams((q) => { q.set("detailPage", String(safeDetailPage + 1)); q.delete("detailAll"); })} className="h-7 w-7 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50" title="下一页"><ChevronRight className="h-3.5 w-3.5"/></a>
                    ) : (
                      <span className="h-7 w-7 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300 cursor-not-allowed" title={detailAll ? "全部模式" : "已是最后一页"}><ChevronRight className="h-3.5 w-3.5"/></span>
                    )}
                    {!detailAll && safeDetailPage < detailTotalPages ? (
                      <a href={withDetailParams((q) => { q.set("detailPage", String(detailTotalPages)); q.delete("detailAll"); })} className="h-7 w-7 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-400 hover:bg-slate-50" title="最后一页"><ChevronsRight className="h-3.5 w-3.5"/></a>
                    ) : (
                      <span className="h-7 w-7 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300 cursor-not-allowed" title={detailAll ? "全部模式" : "已是最后一页"}><ChevronsRight className="h-3.5 w-3.5"/></span>
                    )}
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-auto">
                  <table className="min-w-[1240px] w-full table-fixed border-separate border-spacing-0">
                    <colgroup>
                      <col className="w-[44px]" />
                      <col className="w-[112px]" />
                      <col className="w-[112px]" />
                      <col className="w-[112px]" />
                      <col className="w-[104px]" />
                      <col className="w-[180px]" />
                      <col className="w-[124px]" />
                      <col className="w-[280px]" />
                      <col className="w-[72px]" />
                      <col className="w-[100px]" />
                    </colgroup>
                    <thead className="sticky top-0 z-10 bg-white">
                      <tr>
                        <th className="w-9 px-3 py-2 border-b border-slate-200 text-left">
                          <BasicDetailSelectAll ids={pagedEntries.map((e) => e.id)} />
                        </th>
                        {renderDetailFilterHeader("date", "日期", "text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200")}
                        <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                          {(() => {
                            const active = !!(detailInFrom || detailInTo);
                            const clearHref = active ? withDetailParams((q) => {
                              q.delete("detailInFrom");
                              q.delete("detailInTo");
                              q.set("detailPage", "1");
                            }) : null;
                            const current = new URLSearchParams(withDetailParams().slice(2));
                            current.delete("detailInFrom");
                            current.delete("detailInTo");
                            current.set("detailPage", "1");
                            const hiddenInputs = Array.from(current.entries()).map(([k, v]) => ({ name: k, value: v }));
                            return (
                              <LinkNumberRangeFilter
                                label="流入"
                                fromName="detailInFrom"
                                toName="detailInTo"
                                from={detailInFrom}
                                to={detailInTo}
                                badgeText={active ? "范围" : null}
                                clearHref={clearHref}
                                hiddenInputs={hiddenInputs}
                                fromPlaceholder="例如 100"
                                toPlaceholder="例如 1000"
                              />
                            );
                          })()}
                        </th>
                        <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                          {(() => {
                            const active = !!(detailOutFrom || detailOutTo);
                            const clearHref = active ? withDetailParams((q) => {
                              q.delete("detailOutFrom");
                              q.delete("detailOutTo");
                              q.set("detailPage", "1");
                            }) : null;
                            const current = new URLSearchParams(withDetailParams().slice(2));
                            current.delete("detailOutFrom");
                            current.delete("detailOutTo");
                            current.set("detailPage", "1");
                            const hiddenInputs = Array.from(current.entries()).map(([k, v]) => ({ name: k, value: v }));
                            return (
                              <LinkNumberRangeFilter
                                label="流出"
                                fromName="detailOutFrom"
                                toName="detailOutTo"
                                from={detailOutFrom}
                                to={detailOutTo}
                                badgeText={active ? "范围" : null}
                                clearHref={clearHref}
                                hiddenInputs={hiddenInputs}
                                fromPlaceholder="例如 100"
                                toPlaceholder="例如 1000"
                              />
                            );
                          })()}
                        </th>
                        {renderDetailFilterHeader("type", "活动类型", "text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200")}
                        {renderDetailFilterHeader("related", "关联账户", "text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200")}
                        <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">余额</th>
                        {renderDetailFilterHeader("remark", "备注", "text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200")}
                        <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">附件</th>
                        <th className="w-24 px-2 py-2 border-b border-slate-200 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <BasicDetailBatchReplaceButton accountOptions={accountOptions.map((a) => ({ id: a.id, label: a.label }))} />
                            <BasicDetailBatchDeleteButton />
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <DetailViewClient
                      accountId={accountId}
                      isInvestAccount={isInvestAccount}
                      initialEntries={pagedDetailEntries}
                      accountOptions={accountOptions.map((a) => ({ id: a.id, label: a.label }))}
                      investmentProductTypeByAccountId={investmentProductTypeByAccountIdObj}
                    />
                  </table>
                </div>
                </BasicDetailSelectionProvider>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
    );
  }
