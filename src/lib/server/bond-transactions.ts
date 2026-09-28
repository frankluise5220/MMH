import { FundSubtype, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { normalizeCurrency } from "@/lib/currency";
import { toNumber } from "@/lib/date-utils";
import { resolveCategorySnapshot } from "@/lib/default-categories";
import { getInvestmentCategoryName } from "@/lib/investment-category";
import { recalcWealthPositions } from "@/lib/wealth-position";
import {
  applyEntryChangesToAccountBalances,
  BALANCE_ENTRY_SELECT,
  type EntryBalanceChange,
} from "@/lib/server/account-balance";
import { ensureBondPlansForLot } from "@/lib/server/bond-plan-tasks";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { attachEntryTags } from "@/lib/server/entry-tags";
import { upsertEntryBusinessCashFlowLink } from "@/lib/server/entry-business-link";
import { revalidateAfterFundShellChange } from "@/lib/server/revalidate";
import { resolveOrCreateWealthAccount } from "@/lib/server/wealth-account";

/**
 * 债券录入 / 编辑的专用落库路径。
 *
 * 债券**不复用理财（wealth）代码**：
 *   - 侧表是 bond_transactions（无份额/净值），不是 wealth_transactions；
 *   - 业务链接类型是 "bond"，不是 "wealth"；
 *   - 买入行本身就是一张「存单」（一个持仓），同一债单可以有多张存单；
 *   - 条款（期限/到期日/付息方式/首次付息日/计息基础）作为快照写在存单上，
 *     缺省回退债单主数据 BondProduct —— 付息因此按存单各自产生；
 *   - 付息/赎回/核销用 sourceBondTransactionId 指回所属存单。
 */
export type BondEntryInput = {
  householdId: string;
  date: Date;
  subtype: FundSubtype;
  /** 成交金额（恒为正数）。 */
  amount: number;
  /** 债券账户 id；买入时可留空，由资金来源账户推导/新建。 */
  bondAccountId: string;
  cashAccountId: string;
  productId: string | null;
  productName: string;
  /** 所属存单（bond_transactions.id）；子行留空时若该债单只有一张存单则自动归属。 */
  sourceLotId?: string | null;
  annualRate: number | null;
  termDays: number | null;
  maturityDate: Date | null;
  payoutFrequency: string | null;
  firstPayoutDate: Date | null;
  interestCalcBasis: string | null;
  interest: number | null;
  fee: number | null;
  arrivalDate: Date | null;
  arrivalAmount: number | null;
  note: string;
  tagIds?: readonly string[];
  /** 编辑模式：目标分录（cash TxRecord）id。 */
  editEntryId?: string | null;
  /** 编辑模式：目标债券交易（bond_transactions）id。 */
  editBusinessTransactionId?: string | null;
};

const CASH_IN_SUBTYPES = new Set<string>([FundSubtype.dividend_cash, FundSubtype.redeem, FundSubtype.switch_out]);

function bondYmdToDate(value: unknown): Date | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return new Date(`${text.slice(0, 10)}T00:00:00.000Z`);
}

function bondMoney(value: unknown): number {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const parsed = Number(raw.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function bondPositiveNumber(value: unknown): number | null {
  const parsed = Number.parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 债券弹窗 FormData → 债券录入输入（唯一真源）。
 *
 * 只认债券自己的字段名（bondTermDays / bondMaturityDate / bondPayoutFrequency /
 * bondFirstPayoutDate / bondInterestCalcBasis / bondSourceLotId），不复用理财语义。
 * 服务端动作（sidebar-actions）与 detail API（报表明细编辑）共用这一份解析，
 * 避免两条入口各写一套字段映射后漂移。
 */
export function bondEntryInputFromFormData(
  formData: FormData,
  householdId: string,
  edit?: { entryId?: string | null; businessTransactionId?: string | null },
): BondEntryInput {
  const subtypeRaw = String(formData.get("fundSubtype") ?? formData.get("subtype") ?? "").trim() || "buy";
  const validSubtypes = Object.values(FundSubtype);
  const subtype = validSubtypes.includes(subtypeRaw as FundSubtype) ? (subtypeRaw as FundSubtype) : FundSubtype.buy;
  const amount = Math.abs(bondMoney(formData.get("amount")));
  const dateText = String(formData.get("date") ?? "").trim();
  const date = dateText && !Number.isNaN(new Date(dateText).getTime()) ? new Date(dateText) : new Date();
  const termDaysRaw = Number.parseInt(String(formData.get("bondTermDays") ?? ""), 10);
  const arrivalAmount = bondMoney(formData.get("fundArrivalAmount"));
  const isCashIn = CASH_IN_SUBTYPES.has(subtype);
  let tagIds: string[] = [];
  try {
    const parsed = JSON.parse(String(formData.get("tagIds") ?? "[]"));
    tagIds = Array.isArray(parsed)
      ? parsed.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    tagIds = [];
  }
  return {
    householdId,
    date,
    subtype,
    amount,
    bondAccountId: String(formData.get("accountId") ?? formData.get("toAccountId") ?? "").trim(),
    cashAccountId: String(formData.get("cashAccountId") ?? "").trim(),
    productId: String(formData.get("wealthProductId") ?? "").trim() || null,
    productName: String(formData.get("fundName") ?? "").trim(),
    sourceLotId: String(formData.get("bondSourceLotId") ?? "").trim() || null,
    annualRate: bondPositiveNumber(formData.get("depositAnnualRate")),
    termDays: Number.isFinite(termDaysRaw) && termDaysRaw > 0 ? termDaysRaw : null,
    maturityDate: bondYmdToDate(formData.get("bondMaturityDate")),
    payoutFrequency: String(formData.get("bondPayoutFrequency") ?? "").trim() || null,
    firstPayoutDate: bondYmdToDate(formData.get("bondFirstPayoutDate")),
    interestCalcBasis: String(formData.get("bondInterestCalcBasis") ?? "").trim() || null,
    interest: formData.has("depositInterest") ? bondMoney(formData.get("depositInterest")) : null,
    fee: bondPositiveNumber(formData.get("fundFee")),
    arrivalDate: bondYmdToDate(formData.get("fundArrivalDate")) ?? (isCashIn ? date : null),
    arrivalAmount: arrivalAmount > 0 ? Math.abs(arrivalAmount) : null,
    note: String(formData.get("note") ?? formData.get("memo") ?? "").trim(),
    tagIds,
    editEntryId: edit?.entryId ?? null,
    editBusinessTransactionId: edit?.businessTransactionId ?? null,
  };
}

export function isBondCashInSubtype(subtype: string) {
  return CASH_IN_SUBTYPES.has(subtype);
}

/** 债券现金流备注：债券自己的动作文案，不借用理财口径，也不含份额。 */
export function buildBondCashFlowNote(input: {
  action: FundSubtype | string | null | undefined;
  productName?: string | null;
  userNote?: string | null;
}) {
  const action = input.action;
  const label =
    action === FundSubtype.dividend_cash ? "债券利息到账"
      : action === FundSubtype.redeem || action === FundSubtype.switch_out ? "债券赎回"
        : action === FundSubtype.write_off ? "债券核销"
          : "债券买入";
  const parts = [label];
  const productName = input.productName?.trim();
  if (productName) parts.push(productName);
  const summary = parts.join(" ");
  const userNote = input.userNote?.trim();
  return userNote ? `${summary}；${userNote}` : summary;
}

/** 子行归属的存单：显式给出优先；否则该债单只有一张存单时自动归属。 */
async function resolveSourceLotId(params: {
  householdId: string;
  accountId: string;
  bondProductId: string | null;
  productName: string;
  explicitLotId: string | null;
}): Promise<string | null> {
  const explicit = params.explicitLotId?.trim() ?? "";
  if (explicit) return explicit;
  const lots = await prisma.bondTransaction.findMany({
    where: {
      householdId: params.householdId,
      accountId: params.accountId,
      action: FundSubtype.buy,
      deletedAt: null,
      ...(params.bondProductId
        ? { bondProductId: params.bondProductId }
        : { bondProductId: null, productName: params.productName || null }),
    },
    select: { id: true },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
  });
  return lots.length === 1 ? lots[0].id : null;
}

/** 债单主数据：债券走 BondProduct，与理财产品表完全分开。 */
async function resolveBondProductInTx(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  params: {
    householdId: string;
    institutionId: string | null;
    currency: string;
    productId: string | null;
    productName: string;
    input: BondEntryInput;
  },
) {
  const { householdId, institutionId, currency } = params;
  const productId = params.productId?.trim() ?? "";
  if (productId) {
    const existing = await tx.bondProduct.findFirst({
      where: { id: productId, householdId, isActive: true },
    });
    // ⚠️ 绝不把表单条款回写主数据（2026-09-19 定版）。
    // 主数据条款只由「债单条款卡」（PUT /api/v1/bond-products/[id]）维护。
    // 曾经的「存单填了就同步回主数据」副作用会让老存单（条款快照为 null、只能回退
    // 主数据）的计划行日期随每一次买入漂移 —— 用户实测报过「下次执行日被改到 26 年 10 月」。
    // 存单自己的条款快照在下面由 input 写入，与主数据无关。
    if (existing) return existing;
  }
  const productName = params.productName.trim();
  if (!productName) return null;
  const existing = await tx.bondProduct.findFirst({
    where: { householdId, institutionId: institutionId ?? null, name: productName, isActive: true },
  });
  if (existing) return existing;
  return tx.bondProduct.create({
    data: {
      householdId,
      institutionId: institutionId ?? null,
      name: productName,
      currency,
      annualRate: params.input.annualRate ?? undefined,
      termDays: params.input.termDays ?? undefined,
      maturityDate: params.input.maturityDate ?? undefined,
      payoutFrequency: params.input.payoutFrequency ?? undefined,
      firstPayoutDate: params.input.firstPayoutDate ?? undefined,
      interestCalcBasis: params.input.interestCalcBasis ?? undefined,
    },
  });
}

/**
 * 落一笔债券流水（买入 / 利息到账 / 赎回 / 核销）。
 * 买入行同时就是「存单」，条款快照写在它身上；子行带 sourceBondTransactionId。
 */
export async function createBondEntry(input: BondEntryInput): Promise<{
  cashEntryId: string;
  bondTransactionId: string;
  bondProductId: string | null;
  isLot: boolean;
}> {
  if (!(input.amount > 0)) throw new Error("金额不正确");
  const isWriteOff = input.subtype === FundSubtype.write_off;
  const isCashIn = isBondCashInSubtype(input.subtype);
  if (!isWriteOff && !input.cashAccountId) {
    throw new Error(isCashIn ? "请选择到账账户" : "请选择资金来源账户");
  }

  const touchedAccountIds = new Set<string>();
  const result = await prisma.$transaction(async (tx) => {
    const cashAcc = input.cashAccountId
      ? await tx.account.findUnique({
          where: { id: input.cashAccountId },
          select: { id: true, name: true, currency: true },
        })
      : null;
    if (!cashAcc && !isWriteOff) throw new Error("请选择资金来源账户");

    const bondAcc = isCashIn || isWriteOff
      ? await tx.account.findUnique({
          where: { id: input.bondAccountId },
          select: { id: true, name: true, institutionId: true, currency: true },
        })
      : await resolveOrCreateWealthAccount(tx, {
          householdId: input.householdId,
          cashAccountId: cashAcc!.id,
          requestedAccountId: input.bondAccountId || null,
          accountProductType: "bond",
        });
    if (!bondAcc) throw new Error("请选择债券账户");
    if (!isCashIn && !isWriteOff) {
      const cashCurrency = normalizeCurrency(cashAcc!.currency);
      const bondCurrency = normalizeCurrency(bondAcc.currency);
      if (cashCurrency !== bondCurrency) {
        throw new Error(`债券资金账户与债券账户币种不一致。资金账户是 ${cashCurrency}，债券账户是 ${bondCurrency}；请先换汇或选择同币种账户。`);
      }
    }

    const bondProduct = await resolveBondProductInTx(tx, {
      householdId: input.householdId,
      institutionId: bondAcc.institutionId ?? null,
      currency: bondAcc.currency ?? cashAcc?.currency ?? "CNY",
      productId: input.productId,
      productName: input.productName,
      input,
    });
    if (!bondProduct) throw new Error("请选择或新增债券产品");

    const sourceLotId = isCashIn || isWriteOff
      ? await resolveSourceLotId({
          householdId: input.householdId,
          accountId: bondAcc.id,
          bondProductId: bondProduct.id,
          productName: bondProduct.name,
          explicitLotId: input.sourceLotId ?? null,
        })
      : null;
    if ((isCashIn || isWriteOff) && !sourceLotId) {
      throw new Error("请选择该笔业务所属的存单");
    }

    const investmentCategoryName = getInvestmentCategoryName({
      fundProductType: "bond",
      fundSubtype: input.subtype,
    });
    const investmentCategory = investmentCategoryName
      ? await resolveCategorySnapshot(tx, input.householdId, { categoryName: investmentCategoryName, type: "investment" })
      : null;
    // 核销无现金流动：单边记录，债券账户余额直接扣减核销额。
    const signedCashAmount = isWriteOff ? -input.amount : isCashIn ? Math.abs(input.arrivalAmount ?? input.amount) : -input.amount;
    const cashNote = buildBondCashFlowNote({
      action: input.subtype,
      productName: bondProduct.name,
      userNote: input.note,
    });
    const cashEntry = await tx.txRecord.create({
      data: {
        householdId: input.householdId,
        date: isCashIn ? (input.arrivalDate ?? input.date) : input.date,
        type: TransactionType.investment,
        accountId: isCashIn || isWriteOff ? bondAcc.id : cashAcc!.id,
        accountName: isCashIn || isWriteOff ? bondAcc.name : cashAcc!.name,
        toAccountId: isCashIn ? cashAcc!.id : isWriteOff ? null : bondAcc.id,
        toAccountName: isCashIn ? cashAcc!.name : isWriteOff ? null : bondAcc.name,
        amount: signedCashAmount,
        categoryId: investmentCategory?.id ?? null,
        categoryName: investmentCategory?.name ?? investmentCategoryName ?? null,
        currency: cashAcc?.currency ?? bondAcc.currency ?? "CNY",
        source: "manual",
        note: cashNote,
        fundProductType: "bond",
        fundSubtype: input.subtype,
        bondProductId: bondProduct.id,
        bondSubtype: input.subtype,
        bondName: bondProduct.name,
        bondAnnualRate: input.annualRate ?? null,
        bondInterest: input.interest ?? null,
        bondArrivalDate: input.arrivalDate ?? null,
        bondConfirmDate: isCashIn ? (input.arrivalDate ?? input.date) : null,
        bondFee: input.fee ?? null,
      },
    });

    const isLot = input.subtype === FundSubtype.buy;
    const bondTransaction = await tx.bondTransaction.create({
      data: {
        // 与理财/存款同一约定：业务行 id ＝ 对应 TxRecord id。
        // 通用同步路径（syncIndependentBusinessTransactionFromTxRecord）按 TxRecord id upsert，
        // 若这里另起 id，会在编辑/删除/修复时插出重复的债券业务行。
        id: cashEntry.id,
        householdId: input.householdId,
        accountId: bondAcc.id,
        cashAccountId: cashAcc?.id ?? null,
        cashEntryId: cashEntry.id,
        bondProductId: bondProduct.id,
        productName: bondProduct.name,
        sourceBondTransactionId: isLot ? null : sourceLotId,
        action: input.subtype,
        source: "manual",
        entryOrigin: "manual",
        tradeDate: input.date,
        confirmDate: isCashIn ? (input.arrivalDate ?? input.date) : input.date,
        arrivalDate: input.arrivalDate ?? null,
        // 存单条款快照：买入时落定，付息/赎回沿用该存单自己的条款。
        termDays: isLot ? input.termDays : null,
        maturityDate: isLot ? input.maturityDate : null,
        payoutFrequency: isLot ? input.payoutFrequency : null,
        firstPayoutDate: isLot ? input.firstPayoutDate : null,
        interestCalcBasis: isLot ? input.interestCalcBasis : null,
        grossAmount: input.amount,
        arrivalAmount: isCashIn ? Math.abs(input.arrivalAmount ?? input.amount) : null,
        interest: input.interest ?? null,
        fee: input.fee ?? null,
        annualRate: input.annualRate ?? null,
        realizedProfit: input.subtype === FundSubtype.dividend_cash
          ? (input.interest ?? input.amount)
          : isCashIn
            ? (input.interest ?? 0) - Math.max(0, input.fee ?? 0)
            : isWriteOff
              ? -input.amount
              : null,
        note: input.note || null,
      },
    });

    await attachEntryTags({ tx, entryId: cashEntry.id, householdId: input.householdId, tagIds: input.tagIds ?? [] });
    await upsertEntryBusinessCashFlowLink(tx, {
      householdId: input.householdId,
      cashEntryId: cashEntry.id,
      businessEntryId: null,
      bondTransactionId: bondTransaction.id,
      businessType: "bond",
      cashFlowDirection: signedCashAmount < 0 ? "outflow" : signedCashAmount > 0 ? "inflow" : "none",
      source: "manual",
      note: "Linked cash flow to bond transaction",
      metadata: { splitRecord: true, independentBusinessTransaction: true },
    });

    if (cashAcc) touchedAccountIds.add(cashAcc.id);
    touchedAccountIds.add(bondAcc.id);
    return {
      cashEntryId: cashEntry.id,
      bondTransactionId: bondTransaction.id,
      bondProductId: bondProduct.id,
      isLot,
    };
  });

  for (const id of touchedAccountIds) {
    await recalcWealthPositions(id).catch(() => {});
  }
  await applyEntryChangesToAccountBalances([{ entryId: result.cashEntryId }]).catch(() => {});
  await invalidateCreditCardCycleCacheForAccountIds(Array.from(touchedAccountIds)).catch(() => {});
  // 存单 = 计划行真源：买入/付息/赎回/核销后刷新该存单的到期 + 付息两条计划行。
  // 赎回/核销一律走 ensure：部分赎回后本金仍 > 0，计划行必须留在 active 且金额
  // 跟着剩余本金走；只有本金归零时 ensureBondPlansForLot 才会把两行标完成。
  const lotId = result.isLot
    ? result.bondTransactionId
    : (await prisma.bondTransaction.findUnique({
        where: { id: result.bondTransactionId },
        select: { sourceBondTransactionId: true },
      }))?.sourceBondTransactionId ?? null;
  if (lotId) {
    await ensureBondPlansForLot({ householdId: input.householdId, lotId }).catch(() => {});
  }
  revalidateAfterFundShellChange();
  return result;
}

/**
 * 编辑一笔债券流水。
 * 买入行（存单）可改条款快照；子行沿用所属存单，不跨存单改归属。
 */
export async function editBondEntry(input: BondEntryInput): Promise<{
  cashEntryId: string;
  bondTransactionId: string;
  bondProductId: string | null;
  isLot: boolean;
}> {
  if (!(input.amount > 0)) throw new Error("金额不正确");
  const isWriteOff = input.subtype === FundSubtype.write_off;
  const isCashIn = isBondCashInSubtype(input.subtype);
  const entryId = input.editEntryId?.trim() ?? "";
  const businessId = input.editBusinessTransactionId?.trim() ?? "";
  if (!entryId && !businessId) throw new Error("缺少 id");

  const touchedAccountIds = new Set<string>();
  let previousCashEntry: EntryBalanceChange["previous"] = null;
  const result = await prisma.$transaction(async (tx) => {
    const existing = businessId
      ? await tx.bondTransaction.findFirst({ where: { id: businessId, householdId: input.householdId } })
      : await tx.bondTransaction.findFirst({
          where: { householdId: input.householdId, OR: [{ id: entryId }, { cashEntryId: entryId }] },
        });
    if (!existing) throw new Error("债券记录不存在");

    const cashAcc = input.cashAccountId
      ? await tx.account.findUnique({
          where: { id: input.cashAccountId },
          select: { id: true, name: true, currency: true },
        })
      : null;
    if (!cashAcc && !isWriteOff) throw new Error("请选择资金来源账户");

    const bondAcc = await tx.account.findUnique({
      where: { id: input.bondAccountId || existing.accountId },
      select: { id: true, name: true, institutionId: true, currency: true },
    });
    if (!bondAcc) throw new Error("请选择债券账户");

    const bondProduct = await resolveBondProductInTx(tx, {
      householdId: input.householdId,
      institutionId: bondAcc.institutionId ?? null,
      currency: bondAcc.currency ?? cashAcc?.currency ?? "CNY",
      productId: input.productId ?? existing.bondProductId,
      productName: input.productName,
      input,
    });
    if (!bondProduct) throw new Error("请选择或新增债券产品");

    const isLot = existing.action === FundSubtype.buy;
    const sourceLotId = isLot ? null : existing.sourceBondTransactionId;
    if (!isLot && !sourceLotId) throw new Error("该笔业务缺少所属存单，请重新选择存单");

    const investmentCategoryName = getInvestmentCategoryName({
      fundProductType: "bond",
      fundSubtype: input.subtype,
    });
    const investmentCategory = investmentCategoryName
      ? await resolveCategorySnapshot(tx, input.householdId, { categoryName: investmentCategoryName, type: "investment" })
      : null;
    const signedCashAmount = isWriteOff ? -input.amount : isCashIn ? Math.abs(input.arrivalAmount ?? input.amount) : -input.amount;
    const cashNote = buildBondCashFlowNote({
      action: input.subtype,
      productName: bondProduct.name,
      userNote: input.note,
    });

    const cashEntryId = existing.cashEntryId;
    if (cashEntryId) {
      previousCashEntry = await tx.txRecord.findUnique({
        where: { id: cashEntryId },
        select: BALANCE_ENTRY_SELECT,
      });
      await tx.txRecord.update({
        where: { id: cashEntryId },
        data: {
          date: isCashIn ? (input.arrivalDate ?? input.date) : input.date,
          accountId: isCashIn || isWriteOff ? bondAcc.id : cashAcc!.id,
          accountName: isCashIn || isWriteOff ? bondAcc.name : cashAcc!.name,
          toAccountId: isCashIn ? cashAcc!.id : isWriteOff ? null : bondAcc.id,
          toAccountName: isCashIn ? cashAcc!.name : isWriteOff ? null : bondAcc.name,
          amount: signedCashAmount,
          categoryId: investmentCategory?.id ?? null,
          categoryName: investmentCategory?.name ?? investmentCategoryName ?? null,
          currency: cashAcc?.currency ?? bondAcc.currency ?? "CNY",
          note: cashNote,
          fundProductType: "bond",
          fundSubtype: input.subtype,
          bondProductId: bondProduct.id,
          bondSubtype: input.subtype,
          bondName: bondProduct.name,
          bondAnnualRate: input.annualRate ?? null,
          bondInterest: input.interest ?? null,
          bondArrivalDate: input.arrivalDate ?? null,
          bondConfirmDate: isCashIn ? (input.arrivalDate ?? input.date) : null,
          bondFee: input.fee ?? null,
        },
      });
    }

    const bondTransaction = await tx.bondTransaction.update({
      where: { id: existing.id },
      data: {
        accountId: bondAcc.id,
        cashAccountId: cashAcc?.id ?? null,
        bondProductId: bondProduct.id,
        productName: bondProduct.name,
        action: input.subtype,
        tradeDate: input.date,
        confirmDate: isCashIn ? (input.arrivalDate ?? input.date) : input.date,
        arrivalDate: input.arrivalDate ?? null,
        // 存单条款快照只在买入行上维护；子行沿用所属存单的条款。
        ...(isLot
          ? {
              termDays: input.termDays,
              maturityDate: input.maturityDate,
              payoutFrequency: input.payoutFrequency,
              firstPayoutDate: input.firstPayoutDate,
              interestCalcBasis: input.interestCalcBasis,
            }
          : {}),
        grossAmount: input.amount,
        arrivalAmount: isCashIn ? Math.abs(input.arrivalAmount ?? input.amount) : null,
        interest: input.interest ?? null,
        fee: input.fee ?? null,
        annualRate: input.annualRate ?? null,
        realizedProfit: input.subtype === FundSubtype.dividend_cash
          ? (input.interest ?? input.amount)
          : isCashIn
            ? (input.interest ?? 0) - Math.max(0, input.fee ?? 0)
            : isWriteOff
              ? -input.amount
              : null,
        note: input.note || null,
      },
    });

    if (cashEntryId) {
      await upsertEntryBusinessCashFlowLink(tx, {
        householdId: input.householdId,
        cashEntryId,
        businessEntryId: null,
        bondTransactionId: bondTransaction.id,
        businessType: "bond",
        cashFlowDirection: signedCashAmount < 0 ? "outflow" : signedCashAmount > 0 ? "inflow" : "none",
        source: "manual",
        note: "Linked cash flow to bond transaction",
        metadata: { splitRecord: true, independentBusinessTransaction: true },
      });
    }

    if (cashAcc) touchedAccountIds.add(cashAcc.id);
    touchedAccountIds.add(bondAcc.id);
    return {
      cashEntryId: cashEntryId ?? "",
      bondTransactionId: bondTransaction.id,
      bondProductId: bondProduct.id,
      isLot,
      lotId: isLot ? bondTransaction.id : sourceLotId,
    };
  });

  for (const id of touchedAccountIds) {
    await recalcWealthPositions(id).catch(() => {});
  }
  await applyEntryChangesToAccountBalances([
    { entryId: result.cashEntryId, previous: previousCashEntry },
  ]).catch(() => {});
  await invalidateCreditCardCycleCacheForAccountIds(Array.from(touchedAccountIds)).catch(() => {});
  if (result.lotId) {
    await ensureBondPlansForLot({ householdId: input.householdId, lotId: result.lotId }).catch(() => {});
  }
  revalidateAfterFundShellChange();
  return {
    cashEntryId: result.cashEntryId,
    bondTransactionId: result.bondTransactionId,
    bondProductId: result.bondProductId,
    isLot: result.isLot,
  };
}
