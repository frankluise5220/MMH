import { FundCashFlowKind, FundProductType, FundSubtype, Prisma } from "@prisma/client";

import { createFundTransactionWithCashFlows } from "@/lib/fund/transactions";

type Tx = Prisma.TransactionClient;

export type WalletLinkedFundResult = {
  fundAccountId: string;
  fundCode: string;
  fundTransactionId: string;
};

/**
 * 电子钱包 → 货币基金的支付联动（2026-11-18）。
 *
 * 钱包账户上的 linkedFundAccountId/linkedFundCode 只是配置，本身不动任何流水。
 * 只有在记账时显式勾选「从关联货基支付」（支出）/「转入后自动购买关联货基」（收入、转账），
 * 才在**同一个事务里**生成一笔货基业务行 + 一条资金腿：
 *   - 支出：货基赎回（份额 −X），资金腿进钱包 +X；原支出从钱包 −X ⇒ 钱包净额 0。
 *   - 转入：货基申购（份额 +X），资金腿从钱包 −X；原转入进钱包 +X ⇒ 钱包净额 0。
 * 货基净值恒为 1，份额增量在金额上等于 X。
 */
export async function applyWalletLinkedFund(
  tx: Tx,
  params: {
    householdId: string;
    /** 发生收支的钱包账户 id（支出时的付款账户 / 转入时的到账账户）。 */
    walletAccountId: string;
    direction: "redeem" | "buy";
    /** 正数金额（元）。 */
    amount: number;
    date: Date;
    note?: string | null;
    /** 原收支流水 id，写进备注便于对账。 */
    sourceEntryId?: string;
  },
): Promise<WalletLinkedFundResult | null> {
  const wallet = await tx.account.findFirst({
    where: { id: params.walletAccountId, householdId: params.householdId },
    select: { id: true, name: true, institutionId: true, groupId: true, linkedFundAccountId: true, linkedFundCode: true },
  });
  if (!wallet?.linkedFundAccountId) return null;

  const fundAccount = await tx.account.findFirst({
    where: {
      id: wallet.linkedFundAccountId,
      householdId: params.householdId,
      kind: "investment",
      investProductType: FundProductType.money,
    },
    select: { id: true, name: true, institutionId: true, groupId: true },
  });
  if (!fundAccount) throw new Error("关联的货币基金账户不存在，或该账户不是货币基金类型");
  // 与账户设置保存时的校验同口径：钱包与货基必须同机构（2026-11-18）。
  if (!wallet.institutionId || fundAccount.institutionId !== wallet.institutionId) {
    throw new Error("关联的货币基金账户与本钱包不属于同一机构");
  }
  // 也必须同一所有人：跨所有人联动等于从别人的货基里扣钱（2026-11-18）。
  if ((fundAccount.groupId ?? null) !== (wallet.groupId ?? null)) {
    throw new Error("关联的货币基金账户与本钱包不属于同一所有人");
  }

  let fundCode = wallet.linkedFundCode?.trim() || "";
  if (fundCode && !/^\d{6}$/.test(fundCode)) {
    throw new Error("关联的基金代码不合法");
  }
  if (!fundCode) {
    const holdings = await tx.fundHolding.findMany({
      where: { accountId: fundAccount.id, units: { gt: 0 } },
      select: { fundCode: true },
    });
    if (holdings.length !== 1) {
      throw new Error("该货基账户下有多只持仓，请在账户设置里指定基金代码");
    }
    fundCode = holdings[0]!.fundCode;
  }

  const holding = await tx.fundHolding.findUnique({
    where: { accountId_fundCode: { accountId: fundAccount.id, fundCode } },
    select: { units: true, fundName: true },
  });
  const units = Math.round(params.amount * 100) / 100;
  if (!(units > 0)) throw new Error("关联货基联动的金额必须大于 0");
  if (params.direction === "redeem" && Number(holding?.units ?? 0) + 1e-9 < units) {
    throw new Error("关联货基的可赎回份额不足");
  }

  const isRedeem = params.direction === "redeem";
  const action = isRedeem ? "从关联货基赎回" : "购买关联货基";
  const created = await createFundTransactionWithCashFlows(tx, {
    householdId: params.householdId,
    fundAccountId: fundAccount.id,
    cashAccountId: wallet.id,
    fundCode,
    fundName: holding?.fundName ?? null,
    fundProductType: FundProductType.money,
    fundSubtype: isRedeem ? FundSubtype.redeem : FundSubtype.buy,
    source: "manual",
    entryOrigin: "wallet_linked_fund",
    applyDate: params.date,
    grossAmount: units,
    units,
    nav: 1,
    note: `${params.note ? `${params.note}，` : ""}电子钱包${action}${params.sourceEntryId ? `（关联流水 ${params.sourceEntryId}）` : ""}`,
    cashFlows: [{
      kind: isRedeem ? FundCashFlowKind.redeem_in : FundCashFlowKind.buy_out,
      accountId: wallet.id,
      accountName: wallet.name,
      amount: isRedeem ? units : -units,
      date: params.date,
    }],
  });

  return { fundAccountId: fundAccount.id, fundCode, fundTransactionId: created.fundTransaction.id };
}
