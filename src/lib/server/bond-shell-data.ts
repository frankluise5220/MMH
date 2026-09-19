import { FundSubtype } from "@prisma/client";

import { bondPayoutExpectation, clampBondFirstPayoutToStart, estimateBondInterestForDays } from "@/lib/bond";
import { toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { loadBondTransactionEntryLike } from "@/lib/server/business-transaction-entries";

/**
 * 债券视图（BondShell）的数据口径。
 *
 * 债券是「债单 + 票面利率 + 到期日 + 付息」模型，不是基金的份额/净值模型：
 *   - 债单主数据 = BondProduct（条款兜底）
 *   - 现金流真源 = bond_transactions（买入 / 付息 / 赎回 / 核销）
 *   - **持仓 = 存单**：每笔买入行就是一张存单（一个持仓），同一债单可以有多张
 *     存单；付息/赎回/核销用 sourceBondTransactionId 指回所属存单。条款（到期日/
 *     期限/付息方式/首次付息日）取存单自己的快照，缺失回退 BondProduct —— 付息
 *     因此按存单各自产生，而不是按产品聚合。
 *   - 存单持仓本金 = 该存单买入额 − 该存单赎回/核销额（无份额，金额即本金）
 *   - 预计利息 / 下次付息 = 与计划任务同一条推算（@/lib/bond），避免两处口径漂移
 */

/** 债券存单（持仓）投影 —— 视图与录入弹窗共用同一份口径。 */
export type BondLotProjection = {
  /** 存单 id = 买入行 bond_transactions.id。 */
  id: string;
  /** 存单所属债券账户。 */
  accountId: string;
  name: string;
  bondProductId: string | null;
  /** 同一债单内的存单序号（按起息日排序，从 1 开始）。 */
  certificateIndex: number;
  startDate: string | null;
  clearedDate: string | null;
  maturityDate: string | null;
  payoutFrequency: string | null;
  annualRate: number | null;
  principal: number;
  paidInterest: number;
  expectedInterest: number | null;
  nextPayoutDate: string | null;
  nextExpectedInterest: number | null;
  realizedProfit: number;
  status: "open" | "closed";
  /** 该存单在明细表里的分录 id（= cashEntryId ?? 存单 id），用于「点中存单收窄明细」。 */
  relatedEntryIds: string[];
};

export type BondShellLot = Omit<BondLotProjection, "accountId" | "bondProductId">;

export type BondShellData = {
  account: {
    id: string;
    name: string;
    institutionName: string;
    currency: string;
  };
  lots: BondShellLot[];
  entries: Awaited<ReturnType<typeof loadBondTransactionEntryLike>>;
  totalPrincipal: number;
  totalPaidInterest: number;
  totalExpectedInterest: number;
};

const CLEAR_ACTIONS = new Set<string>([
  FundSubtype.redeem,
  FundSubtype.switch_out,
  FundSubtype.write_off,
]);

const OPEN_PRINCIPAL_EPSILON = 0.005;

/** 投影只需要这些列；bondTransaction + BondProduct 的结构化子集。 */
export type BondLotRow = {
  id: string;
  accountId: string;
  cashEntryId: string | null;
  bondProductId: string | null;
  productName: string | null;
  sourceBondTransactionId: string | null;
  action: string;
  tradeDate: Date;
  confirmDate: Date | null;
  grossAmount: unknown;
  arrivalAmount: unknown;
  interest: unknown;
  realizedProfit: unknown;
  /** 存单自己的条款快照（买入时落定）；缺失回退 BondProduct。 */
  annualRate: unknown;
  termDays: number | null;
  maturityDate: Date | null;
  payoutFrequency: string | null;
  firstPayoutDate: Date | null;
  interestCalcBasis: string | null;
  BondProduct: {
    name: string;
    annualRate: unknown;
    termDays: number | null;
    maturityDate: Date | null;
    payoutFrequency: string | null;
    firstPayoutDate: Date | null;
    interestCalcBasis: string | null;
  } | null;
};

function ymd(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

function daysBetween(fromKey: string | null, toKey: string | null): number | null {
  if (!fromKey || !toKey) return null;
  const from = new Date(`${fromKey}T00:00:00.000Z`);
  const to = new Date(`${toKey}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

/**
 * 把 bond_transactions 行投影成「存单列表」。
 *
 * 两遍扫描：
 *   1. 买入行 = 存单（本金 = 买入额）；
 *   2. 子行按 sourceBondTransactionId 归入存单；历史数据没有关联时，该债单只有
 *      一张存单则自动归属，多张存单则只出现在明细里（不摊派，避免张冠李戴）。
 */
export function projectBondLots(rows: BondLotRow[]): BondLotProjection[] {
  type LotAcc = {
    id: string;
    accountId: string;
    name: string;
    bondProductId: string | null;
    product: BondLotRow["BondProduct"];
    /** 存单自己的条款快照；空值回退 product（老数据/迁移来的存单没有快照）。 */
    ownRate: number | null;
    ownTermDays: number | null;
    ownMaturityDate: Date | null;
    ownPayoutFrequency: string | null;
    ownFirstPayoutDate: Date | null;
    ownInterestCalcBasis: string | null;
    tradeDate: Date;
    startDate: string | null;
    clearedDate: string | null;
    principal: number;
    paidInterest: number;
    realizedProfit: number;
    lastPayoutAnchor: Date | null;
    relatedEntryIds: string[];
  };

  const entryIdOf = (row: BondLotRow) => row.cashEntryId ?? row.id;
  const productKeyOf = (row: BondLotRow) => row.bondProductId ?? `name:${row.productName ?? row.id}`;

  const lots: LotAcc[] = [];
  const lotById = new Map<string, LotAcc>();
  const lotsByProduct = new Map<string, LotAcc[]>();

  for (const row of rows) {
    if (row.action !== FundSubtype.buy) continue;
    const lot: LotAcc = {
      id: row.id,
      accountId: row.accountId,
      name: row.BondProduct?.name ?? row.productName ?? "",
      bondProductId: row.bondProductId ?? null,
      product: row.BondProduct ?? null,
      ownRate: row.annualRate == null ? null : Number(row.annualRate),
      ownTermDays: row.termDays ?? null,
      ownMaturityDate: row.maturityDate ?? null,
      ownPayoutFrequency: row.payoutFrequency ?? null,
      ownFirstPayoutDate: row.firstPayoutDate ?? null,
      ownInterestCalcBasis: row.interestCalcBasis ?? null,
      tradeDate: row.tradeDate,
      startDate: row.tradeDate.toISOString().slice(0, 10),
      clearedDate: null,
      principal: Math.abs(toNumber(row.grossAmount)),
      paidInterest: 0,
      realizedProfit: 0,
      lastPayoutAnchor: null,
      relatedEntryIds: [entryIdOf(row)],
    };
    lots.push(lot);
    lotById.set(lot.id, lot);
    const key = productKeyOf(row);
    const list = lotsByProduct.get(key) ?? [];
    list.push(lot);
    lotsByProduct.set(key, list);
  }

  for (const row of rows) {
    if (row.action === FundSubtype.buy) continue;
    const explicit = row.sourceBondTransactionId ? lotById.get(row.sourceBondTransactionId) : undefined;
    const candidates = lotsByProduct.get(productKeyOf(row)) ?? [];
    const lot = explicit ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!lot) continue;

    lot.relatedEntryIds.push(entryIdOf(row));
    const gross = Math.abs(toNumber(row.grossAmount));
    if (CLEAR_ACTIONS.has(row.action)) {
      lot.principal -= gross;
      lot.realizedProfit += toNumber(row.realizedProfit);
      const tradeDate = row.tradeDate.toISOString().slice(0, 10);
      if (!lot.clearedDate || tradeDate > lot.clearedDate) lot.clearedDate = tradeDate;
    } else if (row.action === FundSubtype.dividend_cash) {
      // 票息到账：优先取 interest，缺失时退回实际到账额（老数据可能只落了到账额）。
      const interest = toNumber(row.interest);
      lot.paidInterest += interest > 0 ? interest : Math.abs(toNumber(row.arrivalAmount)) || gross;
      lot.realizedProfit += toNumber(row.realizedProfit);
      const anchor = row.confirmDate ?? row.tradeDate;
      if (!lot.lastPayoutAnchor || anchor > lot.lastPayoutAnchor) lot.lastPayoutAnchor = anchor;
    }
  }

  // 存单序号：同一债单内按起息日排序。
  const indexByLotId = new Map<string, number>();
  for (const list of lotsByProduct.values()) {
    list
      .slice()
      .sort((a, b) => a.tradeDate.getTime() - b.tradeDate.getTime())
      .forEach((lot, index) => indexByLotId.set(lot.id, index + 1));
  }

  return lots.map((lot) => {
    const principal = Math.max(0, Number(lot.principal.toFixed(2)));
    const status: BondLotProjection["status"] = principal > OPEN_PRINCIPAL_EPSILON ? "open" : "closed";
    // 条款口径：**存单自己的快照优先，缺失才回退债单主数据** —— 与计划任务
    // loadBondLotPlanSource 完全一致。买入不再回写主数据后，视图必须读存单快照，
    // 否则新存单的「下次付息 / 预计利息」会跟着主数据跑。
    const annualRate = lot.ownRate ?? (lot.product?.annualRate == null ? null : Number(lot.product.annualRate));
    const termDays = lot.ownTermDays ?? lot.product?.termDays ?? null;
    const payoutFrequency = lot.ownPayoutFrequency ?? lot.product?.payoutFrequency ?? null;
    const interestCalcBasis = lot.ownInterestCalcBasis ?? lot.product?.interestCalcBasis ?? null;
    const explicitMaturity = lot.ownMaturityDate ?? lot.product?.maturityDate ?? null;
    const maturityDate = explicitMaturity ?? (termDays && termDays > 0 ? addDaysUtc(lot.tradeDate, termDays) : null);
    const startKey = lot.startDate;
    // 老存单回退主数据时，主数据首期付息日可能早于本存单起息日 → 夹到存单时间轴。
    const firstPayoutDate = clampBondFirstPayoutToStart({
      firstPayoutDate: lot.ownFirstPayoutDate ?? lot.product?.firstPayoutDate ?? null,
      startDate: lot.tradeDate,
      payoutFrequency,
    });

    const expectation = bondPayoutExpectation({
      term: {
        annualRate,
        termDays,
        maturityDate,
        payoutFrequency,
        firstPayoutDate,
        interestCalcBasis,
      },
      start: firstPayoutDate ?? lot.lastPayoutAnchor ?? lot.tradeDate,
      after: lot.lastPayoutAnchor,
      principal,
    });

    // 存续期预计利息总额：优先显式期限，否则用「起息日 → 到期日」自然天数。
    const effectiveTermDays = termDays ?? daysBetween(startKey, ymd(maturityDate));
    const totalExpectedInterest = principal > 0 && effectiveTermDays != null
      ? estimateBondInterestForDays({ principal, annualRate, days: effectiveTermDays })
      : 0;

    return {
      id: lot.id,
      accountId: lot.accountId,
      name: lot.name,
      bondProductId: lot.bondProductId,
      certificateIndex: indexByLotId.get(lot.id) ?? 1,
      startDate: startKey,
      clearedDate: lot.clearedDate,
      maturityDate: ymd(maturityDate),
      payoutFrequency,
      annualRate,
      principal,
      paidInterest: Number(lot.paidInterest.toFixed(2)),
      expectedInterest: totalExpectedInterest > 0 ? totalExpectedInterest : null,
      nextPayoutDate: status === "open" ? expectation.nextPayoutDate : null,
      nextExpectedInterest: status === "open" ? expectation.nextExpectedInterest : null,
      realizedProfit: Number(lot.realizedProfit.toFixed(2)),
      status,
      relatedEntryIds: lot.relatedEntryIds,
    } satisfies BondLotProjection;
  });
}

/**
 * 录入弹窗的存单下拉数据源：跨债券账户取存单（供付息/赎回/核销选择所属存单）。
 * 与视图同一份投影，避免两处口径漂移。
 */
export async function loadBondLotOptions(params: {
  householdId: string;
  accountIds: string[];
}): Promise<BondLotProjection[]> {
  const accountIds = Array.from(new Set(params.accountIds.filter(Boolean)));
  if (accountIds.length === 0) return [];

  const rows = await prisma.bondTransaction.findMany({
    where: { householdId: params.householdId, accountId: { in: accountIds }, deletedAt: null },
    include: {
      BondProduct: {
        select: {
          name: true,
          annualRate: true,
          termDays: true,
          maturityDate: true,
          payoutFrequency: true,
          firstPayoutDate: true,
          interestCalcBasis: true,
        },
      },
    },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
  });

  return projectBondLots(rows).sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    if (a.name !== b.name) return a.name.localeCompare(b.name, "zh-Hans-CN");
    return (a.startDate ?? "").localeCompare(b.startDate ?? "");
  });
}

export async function loadBondShellData(params: {
  householdId: string;
  accountId: string;
}): Promise<BondShellData | null> {
  const { householdId, accountId } = params;
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, isPlaceholder: { not: true } },
    include: { Institution: true },
  });
  if (!account) return null;

  const [rows, entries] = await Promise.all([
    prisma.bondTransaction.findMany({
      where: { householdId, accountId, deletedAt: null },
      include: {
        BondProduct: {
          select: {
            name: true,
            annualRate: true,
            termDays: true,
            maturityDate: true,
            payoutFrequency: true,
            firstPayoutDate: true,
            interestCalcBasis: true,
          },
        },
      },
      orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
    }),
    loadBondTransactionEntryLike({ householdId, accountIds: [accountId] }),
  ]);

  const projectedLots: BondShellLot[] = projectBondLots(rows)
    .map(({ accountId: _accountId, bondProductId: _bondProductId, ...lot }) => lot)
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "open" ? -1 : 1;
      if (a.name !== b.name) return a.name.localeCompare(b.name, "zh-Hans-CN");
      return (a.startDate ?? "").localeCompare(b.startDate ?? "");
    });

  const openLots = projectedLots.filter((lot) => lot.status === "open");

  return {
    account: {
      id: account.id,
      name: account.name,
      institutionName: account.Institution?.shortName || account.Institution?.name || "",
      currency: account.currency,
    },
    lots: projectedLots,
    entries,
    totalPrincipal: Number(openLots.reduce((sum, lot) => sum + lot.principal, 0).toFixed(2)),
    totalPaidInterest: Number(projectedLots.reduce((sum, lot) => sum + lot.paidInterest, 0).toFixed(2)),
    totalExpectedInterest: Number(openLots.reduce((sum, lot) => sum + (lot.expectedInterest ?? 0), 0).toFixed(2)),
  };
}

/** 债券明细里可回填到编辑弹窗的类型标签。 */
export function bondSubtypeLabelKey(action: string | null | undefined): string {
  if (action === FundSubtype.dividend_cash) return "bondShell.subtype.interest";
  if (action === FundSubtype.redeem) return "bondShell.subtype.redeem";
  if (action === FundSubtype.switch_out) return "bondShell.subtype.transferOut";
  if (action === FundSubtype.write_off) return "bondShell.subtype.writeOff";
  return "bondShell.subtype.buy";
}
