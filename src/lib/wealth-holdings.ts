/**
 * 理财「可赎回持仓」聚合。
 *
 * 一笔理财业务记录只有「本金金额 + 份额」，赎回页签要的是**按产品聚合后的剩余本金与
 * 剩余份额**，并且按交易日回放（`movements` / `unitMovements`），这样选日期时才能算出
 * 「该日期可交易份额」。
 *
 * 这份聚合是唯一的真源：服务端页面（RSC props）与 `/api/v1/wealth/holdings` 都调它。
 * 页面侧不能只在 RSC 里算——理财保存走的是 tag 失效、不重渲染当前路由（见
 * `revalidateAfterFundShellChange`），弹窗保存后必须自己从接口重取，否则新增买入
 * 在赎回页签里看不到，非得手动刷新浏览器。
 */
import { formatDateUtc, toNumber } from "@/lib/date-utils";

export type WealthHoldingMovement = { date: string; delta: number };

export type WealthHoldingOption = {
  id: string;
  /** 下拉展示名：产品简称优先。 */
  label: string;
  fundName: string;
  wealthProductId?: string | null;
  wealthAccountId: string;
  wealthAccountLabel?: string | null;
  remainingAmount: number;
  remainingUnits?: number | null;
  hasUnits?: boolean;
  annualRate?: number | null;
  termDays?: number | null;
  firstDate: string;
  movements: WealthHoldingMovement[];
  unitMovements: WealthHoldingMovement[];
};

export type WealthHoldingAccount = {
  id: string;
  name: string;
  /** 账户展示名（含机构等）；缺省时用 `name`。 */
  label?: string | null;
};

/** 业务记录（`loadWealthTransactionEntryLike` 的投影），字段按需读取。 */
export type WealthHoldingEntry = Record<string, any>;

function toYmdOrNull(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(date.getTime())) return null;
  return formatDateUtc(date);
}

export function buildWealthHoldingOptions(params: {
  entries: WealthHoldingEntry[];
  accounts: WealthHoldingAccount[];
  /** 产品名称缺失时的兜底文案（由调用方按语言传入）。 */
  unnamedFallback: string;
}): WealthHoldingOption[] {
  const { entries, accounts, unnamedFallback } = params;
  const accountIds = accounts.map((account) => account.id);
  if (accountIds.length === 0) return [];
  const accountIdSet = new Set(accountIds);
  const accountNameById = new Map(accounts.map((account) => [account.id, account.label || account.name]));

  const buckets = new Map<string, {
    id: string;
    label: string;
    fundName: string;
    wealthProductId: string | null;
    wealthAccountId: string;
    wealthAccountLabel: string;
    remainingAmount: number;
    remainingUnits: number;
    hasUnits: boolean;
    annualRate: number | null;
    termDays: number | null;
    firstDate: string;
    movements: WealthHoldingMovement[];
    unitMovements: WealthHoldingMovement[];
  }>();

  for (const entry of entries) {
    if ((entry.fundProductType !== "wealth" && entry.fundProductType !== "bond") || entry.deletedAt) continue;
    const amountValue = toNumber(entry.amount);
    const principalAmountValue = entry.wealthPrincipalAmount != null ? toNumber(entry.wealthPrincipalAmount) : amountValue;
    const isRedeemEntry =
      entry.fundSubtype === "redeem" ||
      entry.fundSubtype === "switch_out" ||
      (amountValue > 0 && accountIdSet.has(entry.accountId ?? "") && entry.fundSubtype !== "dividend_cash");
    const isDividendEntry = entry.fundSubtype === "dividend_cash";
    const wealthAccountId = (isRedeemEntry ? entry.accountId : entry.toAccountId) ?? "";
    if (!wealthAccountId || !accountIdSet.has(wealthAccountId)) continue;

    // 产品条款：理财读 WealthProduct，债券读自己的 BondProduct（两类独立主数据）。
    const productInfo = entry.WealthProduct ?? entry.BondProduct ?? null;
    const productName = productInfo?.name ?? entry.fundName ?? unnamedFallback;
    const productLabel = productInfo?.shortName?.trim() || productName;
    const productKey = entry.wealthProductId ? `product:${entry.wealthProductId}` : `name:${productName}`;
    const key = `${wealthAccountId}\u001f${productKey}`;
    const existing = buckets.get(key);
    const annualRate =
      entry.depositAnnualRate != null
        ? toNumber(entry.depositAnnualRate)
        : productInfo?.annualRate != null
          ? toNumber(productInfo.annualRate)
          : null;
    const principalDelta = isRedeemEntry
      ? -Math.abs(principalAmountValue)
      : isDividendEntry
        ? 0
        : Math.abs(principalAmountValue);
    const unitsValue = entry.fundUnits == null ? null : Math.abs(toNumber(entry.fundUnits));
    const unitsDelta = unitsValue == null || isDividendEntry ? 0 : isRedeemEntry ? -unitsValue : unitsValue;
    const movementDate = toYmdOrNull(entry.date) ?? "";

    if (existing) {
      existing.remainingAmount += principalDelta;
      if (unitsValue != null) {
        existing.hasUnits = true;
        existing.remainingUnits += unitsDelta;
      }
      if (principalDelta !== 0 && movementDate) {
        existing.movements.push({ date: movementDate, delta: Number(principalDelta.toFixed(2)) });
      }
      if (unitsValue != null && unitsDelta !== 0 && movementDate) {
        existing.unitMovements.push({ date: movementDate, delta: Number(unitsDelta.toFixed(6)) });
      }
      if (existing.annualRate == null && annualRate != null) existing.annualRate = annualRate;
      if (existing.termDays == null && productInfo?.termDays != null) existing.termDays = productInfo.termDays;
    } else {
      buckets.set(key, {
        id: key,
        label: productLabel,
        fundName: productName,
        wealthProductId: entry.wealthProductId ?? null,
        wealthAccountId,
        wealthAccountLabel: accountNameById.get(wealthAccountId) ?? entry.toAccountName ?? entry.accountName ?? "",
        remainingAmount: principalDelta,
        remainingUnits: unitsDelta,
        hasUnits: unitsValue != null,
        annualRate,
        termDays: productInfo?.termDays ?? null,
        firstDate: movementDate,
        movements: principalDelta !== 0 && movementDate ? [{ date: movementDate, delta: Number(principalDelta.toFixed(2)) }] : [],
        unitMovements: unitsValue != null && unitsDelta !== 0 && movementDate ? [{ date: movementDate, delta: Number(unitsDelta.toFixed(6)) }] : [],
      });
    }
  }

  return Array.from(buckets.values())
    .filter((holding) => holding.movements.some((movement) => movement.delta > 0))
    .map((holding) => ({
      id: holding.id,
      label: holding.label,
      fundName: holding.fundName,
      wealthProductId: holding.wealthProductId,
      wealthAccountId: holding.wealthAccountId,
      wealthAccountLabel: holding.wealthAccountLabel,
      remainingAmount: Number(holding.remainingAmount.toFixed(2)),
      remainingUnits: Number(holding.remainingUnits.toFixed(6)),
      hasUnits: holding.hasUnits,
      annualRate: holding.annualRate,
      termDays: holding.termDays,
      firstDate: holding.firstDate,
      movements: holding.movements,
      unitMovements: holding.unitMovements,
    }))
    .sort((a, b) => {
      if (a.wealthAccountLabel !== b.wealthAccountLabel) return a.wealthAccountLabel.localeCompare(b.wealthAccountLabel, "zh-Hans-CN");
      return a.label.localeCompare(b.label, "zh-Hans-CN");
    });
}
