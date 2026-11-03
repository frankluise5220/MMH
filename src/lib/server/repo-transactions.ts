import { FundSubtype } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { parseDateInputToUtc, toNumber } from "@/lib/date-utils";
import {
  estimateRepoInterest,
  estimateRepoMaturityDateKey,
  repoFeeRatePercent,
  repoOccupiedDays,
  repoProductByCode,
  repoProductLabel,
} from "@/lib/repo";
import { createBondEntry } from "@/lib/server/bond-transactions";

/**
 * 国债逆回购的落账入口。
 *
 * 逆回购在账务上就是一张「到期一次还本付息的存单」，因此整条链路复用债券：
 *   - 借出（lendRepo）= bond_transactions 的 buy 行（本金出账到券商账户）；
 *   - 到期回款（redeemRepo）= redeem 子行（本息回到券商资金账户，利息记已实现收益）。
 * 只多两件事：品种来自常量表（不进债券产品库）、不生成债券付息计划行。
 */

export type RepoLendInput = {
  householdId: string;
  /** 债券账户（券商账户）。 */
  accountId: string;
  /** 资金腿：券商资金账户。 */
  cashAccountId: string;
  /** 成交日 ymd。 */
  date: string;
  /** 品种代码，如 204001。 */
  code: string;
  /** 借出本金（元）。 */
  amount: number;
  /** 成交年化（%）；留空则到期按实际到账倒推。 */
  annualRate: number | null;
  /** 期限（天），默认取品种期限。 */
  termDays?: number | null;
  /** 到期日 ymd，默认按「T+期限、遇周末顺延」推算。 */
  maturityDate?: string | null;
  /** 手续费，默认按品种费率算。 */
  fee?: number | null;
  note?: string;
  tagIds?: string[];
};

export type RepoRedeemInput = {
  householdId: string;
  /** 借出时的存单 id（bond_transactions.id）。 */
  lotId: string;
  /** 回款日 ymd；到期自动回款用到期日，手动回款默认当天。 */
  arrivalDate: string;
  /** 到账账户，默认沿用借出时的券商资金账户。 */
  cashAccountId?: string | null;
  /** 实际到账本息；留空按「本金 + 预计利息」计算。 */
  arrivalAmount?: number | null;
  /** 实际利息；留空按占款天数重算。 */
  interest?: number | null;
  note?: string;
};

function repoPrincipal(value: unknown): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : 0;
}

/**
 * 品种解析：先查交易所静态清单，再查本账簿的自定义品种（RepoProductCustom）。
 * 自定义品种的费率留空时按交易所期限档兜底（repoFeeRatePercent）。
 */
async function resolveRepoProduct(householdId: string, code: string) {
  const standard = repoProductByCode(code);
  if (standard) return standard;
  const custom = await prisma.repoProductCustom.findUnique({
    where: { householdId_code: { householdId, code } },
  });
  if (!custom) return null;
  const termDays = custom.termDays;
  return {
    code: custom.code,
    name: custom.name,
    market: custom.market === "sz" ? ("sz" as const) : ("sh" as const),
    termDays,
    minAmount: 1000,
    stepAmount: 1000,
    feeRatePercent:
      custom.feeRatePercent == null ? repoFeeRatePercent(termDays) : Number(custom.feeRatePercent),
  };
}

/** 借出：本金从券商资金账户出到「逆回购存单」。 */
export async function lendRepo(input: RepoLendInput): Promise<{
  bondTransactionId: string;
  cashEntryId: string;
  maturityDate: string;
  occupiedDays: number;
  interest: number;
  fee: number;
}> {
  const principal = repoPrincipal(input.amount);
  if (!(principal > 0)) throw new Error("借出金额不正确");
  const tradeDate = parseDateInputToUtc(input.date);
  if (!tradeDate) throw new Error("成交日期不正确");
  const product = await resolveRepoProduct(input.householdId, input.code);
  if (!product) throw new Error("请选择逆回购品种");

  const termDays = Math.round(Number(input.termDays ?? product.termDays)) || product.termDays;
  const maturityKey =
    String(input.maturityDate ?? "").trim() || estimateRepoMaturityDateKey(input.date, termDays);
  const maturityDate = parseDateInputToUtc(maturityKey);
  if (!maturityDate) throw new Error("到期日不正确");
  const occupiedDays = repoOccupiedDays(input.date, maturityKey);
  if (!(occupiedDays > 0)) throw new Error("到期日必须晚于成交日");

  const annualRate = input.annualRate != null && input.annualRate > 0 ? input.annualRate : null;
  const interest = estimateRepoInterest({ principal, annualRate, occupiedDays });
  // 手续费默认用品种费率（自定义品种可以有自己的费率，不按交易所期限档）。
  const defaultFee =
    principal > 0 ? Math.max(0.01, Number(((principal * product.feeRatePercent) / 100).toFixed(2))) : 0;
  const fee = input.fee != null && input.fee >= 0 ? Number(input.fee.toFixed(2)) : defaultFee;

  const result = await createBondEntry({
    householdId: input.householdId,
    date: tradeDate,
    subtype: FundSubtype.buy,
    amount: principal,
    bondAccountId: input.accountId,
    cashAccountId: input.cashAccountId,
    productId: null,
    // 品种名即商品名：`GC001 · 1天`（同品种多笔存单靠到期日区分）。
    productName: repoProductLabel(product),
    annualRate,
    termDays,
    maturityDate,
    // 逆回购是到期一次还本付息，不产生付息计划行。
    payoutFrequency: "maturity",
    firstPayoutDate: null,
    interestCalcBasis: null,
    interest: interest > 0 ? interest : null,
    fee: fee > 0 ? fee : null,
    arrivalDate: maturityDate,
    arrivalAmount: null,
    note: input.note?.trim() ?? "",
    tagIds: input.tagIds,
    instrumentKind: "repo",
  });

  return {
    bondTransactionId: result.bondTransactionId,
    cashEntryId: result.cashEntryId,
    maturityDate: maturityKey,
    occupiedDays,
    interest,
    fee,
  };
}

/**
 * 到期回款：本息回到券商资金账户，利息记该存单的已实现收益。
 * 幂等：同一张存单已有回款行时直接报错，不会重复入账。
 */
export async function redeemRepo(input: RepoRedeemInput): Promise<{
  bondTransactionId: string;
  cashEntryId: string;
  principal: number;
  interest: number;
  arrivalAmount: number;
}> {
  const lot = await prisma.bondTransaction.findFirst({
    where: {
      id: input.lotId,
      householdId: input.householdId,
      instrumentKind: "repo",
      action: FundSubtype.buy,
      deletedAt: null,
    },
  });
  if (!lot) throw new Error("逆回购存单不存在");

  const redeemed = await prisma.bondTransaction.findFirst({
    where: {
      householdId: input.householdId,
      sourceBondTransactionId: lot.id,
      action: FundSubtype.redeem,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (redeemed) throw new Error("该笔逆回购已回款");

  const arrivalKey = String(input.arrivalDate ?? "").trim();
  const arrivalDate = parseDateInputToUtc(arrivalKey);
  if (!arrivalDate) throw new Error("回款日期不正确");

  const principal = repoPrincipal(lot.grossAmount);
  if (!(principal > 0)) throw new Error("存单本金不正确");

  const tradeKey = lot.tradeDate.toISOString().slice(0, 10);
  // 利息按**实际占款天数**（成交日 → 回款日）重算：周五做 1 天期实际占 3 天。
  const occupiedDays = repoOccupiedDays(tradeKey, arrivalKey) || (lot.termDays ?? 1);
  const interest =
    input.interest != null && Number.isFinite(input.interest)
      ? Number(Number(input.interest).toFixed(2))
      : estimateRepoInterest({ principal, annualRate: toNumber(lot.annualRate), occupiedDays });
  const arrivalAmount =
    input.arrivalAmount != null && Number.isFinite(input.arrivalAmount) && input.arrivalAmount > 0
      ? Number(Number(input.arrivalAmount).toFixed(2))
      : Number((principal + interest).toFixed(2));

  const result = await createBondEntry({
    householdId: input.householdId,
    date: arrivalDate,
    subtype: FundSubtype.redeem,
    amount: principal,
    bondAccountId: lot.accountId,
    cashAccountId: String(input.cashAccountId ?? lot.cashAccountId ?? "").trim(),
    productId: null,
    productName: lot.productName ?? "",
    sourceLotId: lot.id,
    annualRate: lot.annualRate == null ? null : toNumber(lot.annualRate),
    termDays: lot.termDays ?? null,
    maturityDate: null,
    payoutFrequency: null,
    firstPayoutDate: null,
    interestCalcBasis: null,
    interest: interest > 0 ? interest : null,
    // 手续费在借出时已收，回款不再重复收。
    fee: null,
    arrivalDate,
    arrivalAmount,
    note: input.note?.trim() ?? "",
    instrumentKind: "repo",
  });

  return {
    bondTransactionId: result.bondTransactionId,
    cashEntryId: result.cashEntryId,
    principal,
    interest,
    arrivalAmount,
  };
}
