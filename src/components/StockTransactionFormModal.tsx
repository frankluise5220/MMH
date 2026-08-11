"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";

type StockAction =
  | "buy"
  | "sell"
  | "dividend"
  | "bonus_share"
  | "split_share"
  | "merge_share"
  | "fee_adjustment"
  | "tax_adjustment";

type AccountOption = {
  id: string;
  name?: string;
  label: string;
  subLabel?: string;
  title?: string;
  hoverTitle?: string;
  kind?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  institutionId?: string | null;
  institutionType?: string | null;
  investProductType?: string | null;
  currency?: string | null;
};

type CreatedAccountPayload = {
  id: string;
  name: string;
  kind?: string | null;
  currency?: string | null;
  investProductType?: string | null;
  groupId?: string | null;
  institutionId?: string | null;
  AccountGroup?: { id?: string; name?: string | null } | null;
  Institution?: { id?: string; name?: string | null; shortName?: string | null; type?: string | null } | null;
};

type CreatedAccountResponse = {
  ok?: boolean;
  error?: string;
  account?: CreatedAccountPayload;
  brokerageCashAccount?: CreatedAccountPayload | null;
};

type InvestmentAccountsResponse = {
  ok?: boolean;
  accounts?: Array<{
    id: string;
    name: string;
    investProductType?: string | null;
    currency?: string | null;
    institutionName?: string | null;
    institutionId?: string | null;
    institutionType?: string | null;
    groupId?: string | null;
    groupName?: string | null;
  }>;
};

type StockCreateEventDetail = {
  requestId?: string;
  defaultStockAccountId?: string;
  defaultCashAccountId?: string;
  defaultDate?: string;
  defaultAmount?: number;
};

type FeeRule = {
  feeType: string;
  rate?: number | null;
  amount?: number | null;
  minAmount?: number | null;
};

const STOCK_ACTIONS: Array<{ key: StockAction; label: string; tone: string }> = [
  { key: "buy", label: "买入", tone: "bg-blue-600 text-white border-blue-600" },
  { key: "sell", label: "卖出", tone: "bg-orange-600 text-white border-orange-600" },
  { key: "dividend", label: "分红", tone: "bg-emerald-600 text-white border-emerald-600" },
  { key: "bonus_share", label: "送股", tone: "bg-slate-700 text-white border-slate-700" },
  { key: "split_share", label: "拆股", tone: "bg-slate-700 text-white border-slate-700" },
  { key: "merge_share", label: "并股", tone: "bg-slate-700 text-white border-slate-700" },
  { key: "fee_adjustment", label: "费用调整", tone: "bg-rose-600 text-white border-rose-600" },
  { key: "tax_adjustment", label: "税费调整", tone: "bg-rose-600 text-white border-rose-600" },
];

const ACTION_HELP: Record<StockAction, string> = {
  buy: "记录证券买入，影响股票持仓，并从所选证券资金账户扣款。",
  sell: "记录证券卖出，影响股票持仓、所选证券资金账户和已实现收益。",
  dividend: "记录现金股息，只影响所选证券资金账户和历史收益，不改变持仓股数。",
  bonus_share: "记录送股或红股，只增加持仓数量，不生成现金流水。",
  split_share: "记录拆股带来的新增股数，只调整持仓数量。",
  merge_share: "记录并股带来的减少股数，只调整持仓数量。",
  fee_adjustment: "记录券商费用、平台费等资金账户扣款，不改变持仓数量。",
  tax_adjustment: "记录税费资金账户扣款，不改变持仓数量。",
};

const MARKET_OPTIONS = [
  { value: "CN", label: "A 股" },
  { value: "HK", label: "港股" },
  { value: "US", label: "美股" },
  { value: "OTHER", label: "其他" },
] as const;

const FEE_TYPES = [
  { feeType: "commission", stateKey: "commission" },
  { feeType: "stamp_tax", stateKey: "stampTax" },
  { feeType: "transfer_fee", stateKey: "transferFee" },
  { feeType: "exchange_fee", stateKey: "exchangeFee" },
  { feeType: "regulatory_fee", stateKey: "regulatoryFee" },
  { feeType: "platform_fee", stateKey: "otherFee" },
  { feeType: "other", stateKey: "otherFee" },
] as const;

function todayDateInputValue() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseNumber(value: string) {
  const num = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function formatDraft(value: number, decimals = 2) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toFixed(decimals);
}

function normalizeStockCode(value: string) {
  return value.trim().toUpperCase();
}

function mergeAccounts(primary: AccountOption[], secondary: AccountOption[]) {
  const result: AccountOption[] = [];
  const seen = new Set<string>();
  for (const item of [...primary, ...secondary]) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function mergeOptions(primary: SmartSelectOption[] | undefined, secondary: SmartSelectOption[] | undefined) {
  const result: SmartSelectOption[] = [];
  const seen = new Set<string>();
  for (const item of [...(primary ?? []), ...(secondary ?? [])]) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function createdAccountToOption(account: NonNullable<CreatedAccountResponse["account"]>): AccountOption {
  const institutionName = account.Institution?.shortName?.trim() || account.Institution?.name?.trim() || "";
  const label = [institutionName, account.name].filter(Boolean).join("·") || account.name;
  return {
    id: account.id,
    name: account.name,
    label,
    subLabel: [
      account.AccountGroup?.name ?? "",
      "股票账户",
    ].filter(Boolean).join(" · "),
    kind: account.kind ?? "investment",
    groupId: account.groupId ?? account.AccountGroup?.id ?? null,
    groupName: account.AccountGroup?.name ?? null,
    institutionId: account.institutionId ?? account.Institution?.id ?? null,
    institutionType: account.Institution?.type ?? null,
    investProductType: "stock",
    currency: account.currency ?? "CNY",
  };
}

function createdCashAccountToOption(account: CreatedAccountPayload): AccountOption {
  const institutionName = account.Institution?.shortName?.trim() || account.Institution?.name?.trim() || "";
  const label = [institutionName, account.name].filter(Boolean).join("·") || account.name;
  return {
    id: account.id,
    name: account.name,
    label,
    subLabel: [
      account.AccountGroup?.name ?? "",
      "证券资金账户",
    ].filter(Boolean).join(" · "),
    kind: account.kind ?? "ewallet",
    groupId: account.groupId ?? account.AccountGroup?.id ?? null,
    groupName: account.AccountGroup?.name ?? null,
    institutionId: account.institutionId ?? account.Institution?.id ?? null,
    institutionType: account.Institution?.type ?? null,
    investProductType: account.investProductType ?? null,
    currency: account.currency ?? "CNY",
  };
}

function investmentAccountToOption(account: NonNullable<InvestmentAccountsResponse["accounts"]>[number]): AccountOption {
  const label = [account.institutionName?.trim() ?? "", account.name].filter(Boolean).join("·") || account.name;
  return {
    id: account.id,
    name: account.name,
    label,
    subLabel: "股票账户",
    kind: "investment",
    investProductType: "stock",
    groupId: account.groupId ?? null,
    groupName: account.groupName ?? null,
    institutionId: account.institutionId ?? null,
    institutionType: account.institutionType ?? null,
    currency: account.currency ?? "CNY",
  };
}

function accountToSmartOption(account: AccountOption): SmartSelectOption {
  return {
    id: account.id,
    label: account.label,
    subLabel: account.subLabel,
    title: account.title ?? account.hoverTitle,
    parentId: account.groupId ? `group:${account.groupId}` : undefined,
    kind: account.kind ?? null,
    investProductType: "stock",
    institutionId: account.institutionId ?? null,
    currency: account.currency ?? null,
  };
}

function cashAccountToSmartOption(account: AccountOption): SmartSelectOption {
  return {
    id: account.id,
    label: account.label,
    subLabel: account.subLabel,
    title: account.title ?? account.hoverTitle,
    parentId: account.groupId ? `group:${account.groupId}` : undefined,
    kind: account.kind ?? null,
    investProductType: account.investProductType ?? null,
    institutionId: account.institutionId ?? null,
    currency: account.currency ?? null,
  };
}

function resolveDefaultCashAccountId(params: {
  explicitCashAccountId?: string;
  stockAccountId?: string;
  stockAccounts: AccountOption[];
  cashAccounts: AccountOption[];
  fallbackCashAccountId?: string;
}) {
  const cashIds = new Set(params.cashAccounts.map((account) => account.id));
  const stockAccount = params.stockAccounts.find((account) => account.id === params.stockAccountId) ?? null;
  const explicit = params.explicitCashAccountId?.trim();
  if (explicit && (cashIds.has(explicit) || explicit === params.stockAccountId)) return explicit;

  const sameInstitutionCash = stockAccount?.institutionId
    ? params.cashAccounts.find((account) => account.institutionId === stockAccount.institutionId && (!stockAccount.currency || !account.currency || account.currency === stockAccount.currency))
      ?? params.cashAccounts.find((account) => account.institutionId === stockAccount.institutionId)
    : null;
  if (sameInstitutionCash?.id) return sameInstitutionCash.id;

  const fallback = params.fallbackCashAccountId?.trim();
  if (fallback && cashIds.has(fallback)) return fallback;
  return params.cashAccounts[0]?.id ?? params.stockAccountId ?? "";
}

function calculateFee(rule: FeeRule | null, grossAmount: number) {
  if (!rule || grossAmount <= 0) return 0;
  const base = rule.amount != null
    ? Number(rule.amount)
    : rule.rate != null
      ? grossAmount * Number(rule.rate)
      : 0;
  const withMin = rule.minAmount != null ? Math.max(base, Number(rule.minAmount)) : base;
  return Number.isFinite(withMin) ? Math.max(0, withMin) : 0;
}

function actionDirection(action: StockAction) {
  return action === "sell" ? "sell" : "buy";
}

function isShareOnlyAction(action: StockAction) {
  return action === "bonus_share" || action === "split_share" || action === "merge_share";
}

function quantityLabelForAction(action: StockAction) {
  if (action === "bonus_share") return "送股数量";
  if (action === "split_share") return "新增股数";
  if (action === "merge_share") return "减少股数";
  return "数量";
}

function amountLabelForAction(action: StockAction) {
  if (action === "dividend") return "分红金额";
  if (action === "fee_adjustment") return "费用金额";
  if (action === "tax_adjustment") return "税费金额";
  return "成交金额";
}

export function StockTransactionFormModal({
  defaultStockAccountId,
  defaultCashAccountId,
  stockAccounts = [],
  stockAccountSSOptions,
  cashAccounts = [],
  cashAccountSSOptions,
}: {
  defaultStockAccountId?: string;
  defaultCashAccountId?: string;
  stockAccounts?: AccountOption[];
  stockAccountSSOptions?: SmartSelectOption[];
  cashAccounts?: AccountOption[];
  cashAccountSSOptions?: SmartSelectOption[];
}) {
  const today = useMemo(() => todayDateInputValue(), []);
  const recentAccountIds = useRecentAccountIds();

  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [stockAccountId, setStockAccountId] = useState(defaultStockAccountId ?? "");
  const [cashAccountId, setCashAccountId] = useState(defaultCashAccountId ?? "");
  const [localStockAccounts, setLocalStockAccounts] = useState<AccountOption[]>(stockAccounts);
  const [localStockSSOptions, setLocalStockSSOptions] = useState<SmartSelectOption[] | undefined>(stockAccountSSOptions);
  const [localCashAccounts, setLocalCashAccounts] = useState<AccountOption[]>(cashAccounts);
  const [localCashSSOptions, setLocalCashSSOptions] = useState<SmartSelectOption[] | undefined>(cashAccountSSOptions);
  const [autoCreatingAccount, setAutoCreatingAccount] = useState(false);
  const [autoCreateError, setAutoCreateError] = useState("");
  const autoCreateAttemptedRef = useRef(false);
  const cashAccountTouchedRef = useRef(false);

  const [action, setAction] = useState<StockAction>("buy");
  const [market, setMarket] = useState("CN");
  const [stockCode, setStockCode] = useState("");
  const [stockName, setStockName] = useState("");
  const [tradeDate, setTradeDate] = useState(today);
  const [settleDate, setSettleDate] = useState("");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [grossAmount, setGrossAmount] = useState("");
  const [commission, setCommission] = useState("");
  const [stampTax, setStampTax] = useState("");
  const [transferFee, setTransferFee] = useState("");
  const [exchangeFee, setExchangeFee] = useState("");
  const [regulatoryFee, setRegulatoryFee] = useState("");
  const [otherFee, setOtherFee] = useState("");
  const [netAmount, setNetAmount] = useState("");
  const [brokerTradeId, setBrokerTradeId] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feeLoading, setFeeLoading] = useState(false);

  useEffect(() => {
    setLocalStockAccounts((prev) => mergeAccounts(stockAccounts, prev));
  }, [stockAccounts]);

  useEffect(() => {
    setLocalStockSSOptions((prev) => mergeOptions(stockAccountSSOptions, prev));
  }, [stockAccountSSOptions]);

  useEffect(() => {
    setLocalCashAccounts((prev) => mergeAccounts(cashAccounts, prev));
  }, [cashAccounts]);

  useEffect(() => {
    setLocalCashSSOptions((prev) => mergeOptions(cashAccountSSOptions, prev));
  }, [cashAccountSSOptions]);

  const stockAccountOptions = useMemo<SmartSelectOption[]>(
    () => {
      const fallback = localStockAccounts.map(accountToSmartOption);
      const scoped = (localStockSSOptions ?? []).filter((option) => option.isHeader || option.investProductType === "stock" || localStockAccounts.some((account) => account.id === option.id));
      return mergeOptions(scoped.length > 0 ? scoped : fallback, fallback);
    },
    [localStockAccounts, localStockSSOptions],
  );
  const cashAccountOptions = useMemo<SmartSelectOption[]>(
    () => {
      const fallback = localCashAccounts.map(cashAccountToSmartOption);
      const scoped = (localCashSSOptions ?? []).filter((option) => option.isHeader || localCashAccounts.some((account) => account.id === option.id));
      return mergeOptions(scoped.length > 0 ? scoped : fallback, fallback);
    },
    [localCashAccounts, localCashSSOptions],
  );
  const { ownerFilterLabel, cycleOwnerFilter, filteredOptions } = useAccountSSFilter(stockAccountOptions);
  const {
    ownerFilterLabel: cashOwnerFilterLabel,
    cycleOwnerFilter: cycleCashOwnerFilter,
    filteredOptions: filteredCashOptions,
  } = useAccountSSFilter(cashAccountOptions);
  const selectedAccount = localStockAccounts.find((account) => account.id === stockAccountId) ?? null;
  const selectedCashAccount = localCashAccounts.find((account) => account.id === cashAccountId)
    ?? (cashAccountId === stockAccountId ? selectedAccount : null);
  const selectedAction = STOCK_ACTIONS.find((item) => item.key === action) ?? STOCK_ACTIONS[0];
  const isBuySell = action === "buy" || action === "sell";
  const isDividendAction = action === "dividend";
  const isAdjustmentAction = action === "fee_adjustment" || action === "tax_adjustment";
  const isShareAction = isShareOnlyAction(action);
  const isCashAmountAction = action === "buy" || action === "sell" || action === "dividend" || action === "fee_adjustment" || action === "tax_adjustment";
  const showQuantityField = isBuySell || isShareAction;
  const showPriceField = isBuySell;
  const showAmountField = isCashAmountAction;
  const showSettleDate = isBuySell || isDividendAction;
  const showNetAmount = isBuySell || isDividendAction;
  const showDetailedFeePanel = isBuySell;
  const showDividendDeductionPanel = isDividendAction;
  const grossFromQuantity = parseNumber(quantity) * parseNumber(price);
  const effectiveGrossAmount = parseNumber(grossAmount) || grossFromQuantity;
  const detailedFeeTotal =
    parseNumber(commission) +
    parseNumber(stampTax) +
    parseNumber(transferFee) +
    parseNumber(exchangeFee) +
    parseNumber(regulatoryFee) +
    parseNumber(otherFee);
  const totalFee = showDetailedFeePanel ? detailedFeeTotal : showDividendDeductionPanel ? parseNumber(otherFee) : 0;
  const previewCashAmount = action === "sell" || action === "dividend"
    ? Math.max(0, effectiveGrossAmount - totalFee)
    : action === "buy" || action === "fee_adjustment" || action === "tax_adjustment"
      ? effectiveGrossAmount + totalFee
      : 0;
  const footerHint = previewCashAmount > 0
    ? `${selectedAction.label}预计${action === "sell" || action === "dividend" ? "流入" : "扣款"} ${previewCashAmount.toFixed(2)}`
    : isShareAction
      ? "保存后只写入 StockTransaction 并重算 StockHolding，不生成现金流水。"
      : "保存后会写入 StockTransaction、现金流水和 LinkId。";

  const resetDraft = useCallback((detail?: StockCreateEventDetail) => {
    const nextStockAccountId =
      detail?.defaultStockAccountId ||
      defaultStockAccountId ||
      localStockAccounts[0]?.id ||
      "";
    const nextCashAccountId = resolveDefaultCashAccountId({
      explicitCashAccountId: detail?.defaultCashAccountId,
      stockAccountId: nextStockAccountId,
      stockAccounts: localStockAccounts,
      cashAccounts: localCashAccounts,
      fallbackCashAccountId: defaultCashAccountId,
    });
    setRequestId(detail?.requestId ?? null);
    setAction("buy");
    setMarket("CN");
    setStockCode("");
    setStockName("");
    setTradeDate(detail?.defaultDate ?? todayDateInputValue());
    setSettleDate("");
    setQuantity("");
    setPrice("");
    setGrossAmount(detail?.defaultAmount ? String(detail.defaultAmount) : "");
    setCommission("");
    setStampTax("");
    setTransferFee("");
    setExchangeFee("");
    setRegulatoryFee("");
    setOtherFee("");
    setNetAmount("");
    setBrokerTradeId("");
    setNote("");
    setAutoCreateError("");
    autoCreateAttemptedRef.current = false;
    cashAccountTouchedRef.current = false;
    setStockAccountId(nextStockAccountId);
    setCashAccountId(nextCashAccountId);
  }, [defaultCashAccountId, defaultStockAccountId, localCashAccounts, localStockAccounts]);

  const close = useCallback(() => {
    if (submitting) return;
    setOpen(false);
  }, [submitting]);

  useCloseOnNavigation(open, () => setOpen(false));

  useEffect(() => {
    function onOpen(event: Event) {
      const detail = (event as CustomEvent<StockCreateEventDetail>).detail ?? {};
      resetDraft(detail);
      setOpen(true);
    }
    window.addEventListener("mmh:stock:create", onOpen);
    return () => window.removeEventListener("mmh:stock:create", onOpen);
  }, [resetDraft]);

  const ensureDefaultStockAccount = useCallback(async () => {
    if (autoCreatingAccount || autoCreateAttemptedRef.current || localStockAccounts.length > 0) return;
    autoCreateAttemptedRef.current = true;
    setAutoCreatingAccount(true);
    setAutoCreateError("");
    try {
      const existingRes = await fetch("/api/v1/accounts/investment");
      const existingData = await existingRes.json().catch(() => null) as InvestmentAccountsResponse | null;
      const existingStockAccounts = existingData?.ok
        ? (existingData.accounts ?? []).filter((account) => account.investProductType === "stock")
        : [];
      if (existingStockAccounts.length > 0) {
        const options = existingStockAccounts.map(investmentAccountToOption);
        const nextStockAccountId = options[0]?.id ?? "";
        setLocalStockAccounts((prev) => mergeAccounts(options, prev));
        setLocalStockSSOptions((prev) => mergeOptions(prev, options.map(accountToSmartOption)));
        setStockAccountId(nextStockAccountId);
        setCashAccountId(resolveDefaultCashAccountId({
          explicitCashAccountId: defaultCashAccountId,
          stockAccountId: nextStockAccountId,
          stockAccounts: options,
          cashAccounts: localCashAccounts,
          fallbackCashAccountId: defaultCashAccountId,
        }));
        return;
      }

      const seedCashAccount = localCashAccounts.find((account) => account.id === cashAccountId)
        ?? localCashAccounts.find((account) => account.id === defaultCashAccountId)
        ?? null;
      const res = await fetch("/api/v1/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "股票账户",
          kind: "investment",
          investProductType: "stock",
          groupId: seedCashAccount?.groupId ?? undefined,
          institutionId: seedCashAccount?.institutionId ?? undefined,
          currency: seedCashAccount?.currency ?? "CNY",
        }),
      });
      const data = await res.json().catch(() => null) as CreatedAccountResponse | null;
      if (!res.ok || !data?.ok || !data.account?.id) {
        throw new Error(data?.error ?? "自动创建股票账户失败");
      }
      const option = createdAccountToOption(data.account);
      const brokerageCashOption = data.brokerageCashAccount ? createdCashAccountToOption(data.brokerageCashAccount) : null;
      setLocalStockAccounts((prev) => mergeAccounts([option], prev));
      setLocalStockSSOptions((prev) => mergeOptions(prev, [accountToSmartOption(option)]));
      if (brokerageCashOption) {
        setLocalCashAccounts((prev) => mergeAccounts([brokerageCashOption], prev));
        setLocalCashSSOptions((prev) => mergeOptions(prev, [cashAccountToSmartOption(brokerageCashOption)]));
      }
      setStockAccountId(option.id);
      setCashAccountId((prev) => brokerageCashOption?.id || prev || resolveDefaultCashAccountId({
        stockAccountId: option.id,
        stockAccounts: [option],
        cashAccounts: brokerageCashOption ? mergeAccounts([brokerageCashOption], localCashAccounts) : localCashAccounts,
        fallbackCashAccountId: defaultCashAccountId,
      }));
      requestAnimationFrame(() => {
        dispatchFinanceDataChanged({
          reason: "stock-account-auto-create",
          accountIds: [option.id, brokerageCashOption?.id ?? ""].filter((id): id is string => Boolean(id)),
        });
      });
    } catch (error) {
      setAutoCreateError(error instanceof Error ? error.message : "自动创建股票账户失败");
    } finally {
      setAutoCreatingAccount(false);
    }
  }, [autoCreatingAccount, cashAccountId, defaultCashAccountId, localCashAccounts, localStockAccounts.length]);

  useEffect(() => {
    if (!open) return;
    if (localStockAccounts.length > 0) return;
    void ensureDefaultStockAccount();
  }, [ensureDefaultStockAccount, localStockAccounts.length, open]);

  useEffect(() => {
    if (!stockAccountId && localStockAccounts.length > 0) {
      setStockAccountId(defaultStockAccountId || localStockAccounts[0]?.id || "");
    }
  }, [defaultStockAccountId, localStockAccounts, stockAccountId]);

  useEffect(() => {
    if (!open || cashAccountTouchedRef.current) return;
    const nextCashAccountId = resolveDefaultCashAccountId({
      stockAccountId,
      stockAccounts: localStockAccounts,
      cashAccounts: localCashAccounts,
      fallbackCashAccountId: defaultCashAccountId,
    });
    setCashAccountId((prev) => (prev === nextCashAccountId ? prev : nextCashAccountId));
  }, [defaultCashAccountId, localCashAccounts, localStockAccounts, open, stockAccountId]);

  async function applyFeeRules() {
    if (!stockAccountId) {
      window.alert("请先选择股票账户");
      return;
    }
    if (!isBuySell) {
      window.alert("账户费率暂只自动套用买入/卖出");
      return;
    }
    if (effectiveGrossAmount <= 0) {
      window.alert("请先填写成交金额，或填写数量和价格");
      return;
    }
    setFeeLoading(true);
    try {
      const paramsBase = new URLSearchParams({
        accountId: stockAccountId,
        direction: actionDirection(action),
        tradeDate,
        market,
        stockCode: normalizeStockCode(stockCode),
      });
      const results = await Promise.all(
        FEE_TYPES.map(async (item) => {
          const params = new URLSearchParams(paramsBase);
          params.set("feeType", item.feeType);
          const res = await fetch(`/api/v1/stocks/fee-rules?${params.toString()}`);
          const data = await res.json().catch(() => null) as { ok?: boolean; data?: { rule?: FeeRule | null }; error?: string } | null;
          if (!res.ok || !data?.ok) throw new Error(data?.error ?? "读取费率失败");
          return { stateKey: item.stateKey, fee: calculateFee(data.data?.rule ?? null, effectiveGrossAmount), hasRule: Boolean(data.data?.rule) };
        }),
      );
      let applied = 0;
      let nextOtherFee = parseNumber(otherFee);
      for (const item of results) {
        if (!item.hasRule) continue;
        applied += 1;
        const value = formatDraft(item.fee);
        if (item.stateKey === "commission") setCommission(value);
        if (item.stateKey === "stampTax") setStampTax(value);
        if (item.stateKey === "transferFee") setTransferFee(value);
        if (item.stateKey === "exchangeFee") setExchangeFee(value);
        if (item.stateKey === "regulatoryFee") setRegulatoryFee(value);
        if (item.stateKey === "otherFee") nextOtherFee += item.fee;
      }
      if (nextOtherFee > parseNumber(otherFee)) setOtherFee(formatDraft(nextOtherFee));
      if (applied === 0) window.alert("当前股票账户还没有可套用的手续费规则");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "读取费率失败");
    } finally {
      setFeeLoading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (!stockAccountId) {
      window.alert("请先选择股票账户");
      return;
    }
    const normalizedCode = normalizeStockCode(stockCode);
    if (!normalizedCode) {
      window.alert("请填写股票代码");
      return;
    }
    if (isBuySell && (!parseNumber(quantity) || effectiveGrossAmount <= 0)) {
      window.alert("买卖股票需要填写数量和成交金额");
      return;
    }
    if (isShareAction && !parseNumber(quantity)) {
      window.alert("送转、拆股或并股需要填写股数");
      return;
    }
    if (isCashAmountAction && effectiveGrossAmount <= 0) {
      window.alert("请填写交易金额");
      return;
    }
    if (isCashAmountAction && !cashAccountId) {
      window.alert("请选择证券资金账户");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        stockAccountId,
        cashAccountId: cashAccountId || stockAccountId,
        market,
        stockCode: normalizedCode,
        stockName: stockName.trim() || normalizedCode,
        action,
        tradeDate,
        settleDate: showSettleDate ? settleDate || undefined : undefined,
        quantity: showQuantityField ? quantity || undefined : undefined,
        price: showPriceField ? price || undefined : undefined,
        grossAmount: showAmountField ? effectiveGrossAmount || undefined : undefined,
        netAmount: showNetAmount ? netAmount || undefined : undefined,
        commission: showDetailedFeePanel ? commission || undefined : undefined,
        stampTax: showDetailedFeePanel ? stampTax || undefined : undefined,
        transferFee: showDetailedFeePanel ? transferFee || undefined : undefined,
        exchangeFee: showDetailedFeePanel ? exchangeFee || undefined : undefined,
        regulatoryFee: showDetailedFeePanel ? regulatoryFee || undefined : undefined,
        otherFee: showDetailedFeePanel || showDividendDeductionPanel ? otherFee || undefined : undefined,
        brokerTradeId: brokerTradeId.trim() || undefined,
        note: note.trim() || undefined,
        source: "manual",
      };
      const res = await fetch("/api/v1/stocks/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; data?: { transaction?: { id?: string; cashEntryId?: string | null } | null } } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? "股票交易保存失败");
      }
      if (requestId) {
        window.dispatchEvent(new CustomEvent("mmh:stock:create:success", { detail: { requestId } }));
      }
      requestAnimationFrame(() => {
        dispatchFinanceDataChanged({
          reason: "stock-transaction-save",
          accountIds: Array.from(new Set([stockAccountId, cashAccountId].filter((id): id is string => Boolean(id)))),
          entryIds: [data.data?.transaction?.cashEntryId ?? "", data.data?.transaction?.id ?? ""].filter(Boolean),
        });
      });
      setOpen(false);
      resetDraft();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "股票交易保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="app-modal-backdrop z-[1000]">
      <div className="app-modal-panel max-w-[min(46rem,calc(100vw-1rem))]">
        <form onSubmit={submit} className="flex max-h-[90vh] flex-col">
          <div className="modal-header">
            <div>
              <div className="text-sm font-semibold text-slate-800">股票交易</div>
              <div className="mt-0.5 text-xs text-slate-500">
                {selectedAccount ? `${selectedAccount.label} · 资金走证券资金账户` : autoCreatingAccount ? "正在自动建立股票账户" : "选择或自动建立股票账户"}
              </div>
            </div>
            <button type="button" onClick={close} className="secondary-button h-8 px-2" title="关闭">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-4 gap-2">
              {STOCK_ACTIONS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setAction(item.key)}
                  className={`h-8 rounded-[10px] border px-2 text-xs ${action === item.key ? item.tone : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="rounded-[10px] border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
              {ACTION_HELP[action]}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="form-label">股票账户</div>
                <SmartSelect
                  mode="single"
                  value={stockAccountId}
                  onChange={setStockAccountId}
                  options={sortOptionsByRecent(filteredOptions ?? stockAccountOptions, recentAccountIds)}
                  placeholder={autoCreatingAccount ? "正在自动建立股票账户" : "选择股票账户"}
                  onCycleOwnerFilter={cycleOwnerFilter}
                  ownerFilterLabel={ownerFilterLabel}
                  behavior={{ search: true, density: "compact", minDropdownWidth: 280 }}
                />
                {autoCreateError ? <div className="text-[11px] text-rose-600">{autoCreateError}</div> : null}
              </div>
              <div className="space-y-1">
                <div className="form-label">证券资金账户</div>
                {cashAccountOptions.length > 0 ? (
                  <SmartSelect
                    mode="single"
                    value={cashAccountId}
                    onChange={(value) => {
                      cashAccountTouchedRef.current = true;
                      setCashAccountId(value);
                    }}
                    options={sortOptionsByRecent(filteredCashOptions ?? cashAccountOptions, recentAccountIds)}
                    placeholder="选择券商可用资金账户"
                    onCycleOwnerFilter={cycleCashOwnerFilter}
                    ownerFilterLabel={cashOwnerFilterLabel}
                    behavior={{ search: true, density: "compact", minDropdownWidth: 280 }}
                  />
                ) : (
                  <div className="flex h-9 items-center rounded-[10px] border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700">
                    {selectedCashAccount?.label || "暂用股票账户现金"}
                  </div>
                )}
                <div className="text-[11px] text-slate-400">
                  银证转账进这里；同一券商下的股票和基金可以共用。
                </div>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-3">
              <div className="space-y-1">
                <div className="form-label">市场</div>
                <select value={market} onChange={(event) => setMarket(event.target.value)} className="form-input">
                  {MARKET_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">股票代码</div>
                <input value={stockCode} onChange={(event) => setStockCode(event.target.value.toUpperCase())} className="form-input" placeholder="例如：600519" />
              </div>
              <div className="col-span-2 space-y-1">
                <div className="form-label">股票名称</div>
                <input value={stockName} onChange={(event) => setStockName(event.target.value)} className="form-input" placeholder="可选，留空时使用代码" />
              </div>
            </div>

            <div className={`grid gap-3 ${showSettleDate ? "grid-cols-2" : "grid-cols-1"}`}>
              <div className="space-y-1">
                <div className="form-label">交易日期</div>
                <DateStepper value={tradeDate} onChange={setTradeDate} />
              </div>
              {showSettleDate ? (
                <div className="space-y-1">
                  <div className="form-label">交割日期</div>
                  <DateStepper value={settleDate || tradeDate} onChange={(value) => setSettleDate(value === tradeDate ? "" : value)} />
                </div>
              ) : null}
            </div>

            <div className="grid grid-cols-4 gap-3">
              {showQuantityField ? (
                <div className="space-y-1">
                  <div className="form-label">{quantityLabelForAction(action)}</div>
                  <CalcInput value={quantity} onChange={setQuantity} placeholder="股数" label={quantityLabelForAction(action)} precision={4} />
                </div>
              ) : null}
              {showPriceField ? (
                <div className="space-y-1">
                  <div className="form-label">成交价格</div>
                  <CalcInput value={price} onChange={setPrice} placeholder="成交价" label="成交价格" precision={4} />
                </div>
              ) : null}
              {showAmountField ? (
                <div className="space-y-1">
                  <div className="form-label">{amountLabelForAction(action)}</div>
                  <CalcInput
                    value={grossAmount}
                    onChange={setGrossAmount}
                    placeholder={grossFromQuantity > 0 ? grossFromQuantity.toFixed(2) : "金额"}
                    label={amountLabelForAction(action)}
                    precision={2}
                  />
                </div>
              ) : null}
              {showNetAmount ? (
                <div className="space-y-1">
                  <div className="form-label">{action === "sell" || action === "dividend" ? "净到账" : "净扣款"}</div>
                  <CalcInput value={netAmount} onChange={setNetAmount} placeholder={previewCashAmount > 0 ? previewCashAmount.toFixed(2) : "可选"} label="净金额" precision={2} />
                </div>
              ) : null}
              {isShareAction ? (
                <div className="col-span-3 flex items-center rounded-[10px] border border-slate-200 bg-slate-50 px-3 text-xs leading-5 text-slate-500">
                  {action === "merge_share" ? "并股会按填写数量减少持仓股数，不影响证券资金账户。" : "送股/拆股会按填写数量增加持仓股数，不影响证券资金账户。"}
                </div>
              ) : null}
              {isAdjustmentAction ? (
                <div className="col-span-3 flex items-center rounded-[10px] border border-slate-200 bg-slate-50 px-3 text-xs leading-5 text-slate-500">
                  {action === "tax_adjustment" ? "税费调整会从证券资金账户扣款，不改变持仓股数。" : "费用调整会从证券资金账户扣款，不改变持仓股数。"}
                </div>
              ) : null}
            </div>

            {showDetailedFeePanel ? (
            <div className="rounded-[12px] border border-slate-200 bg-slate-50/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-medium text-slate-700">手续费</div>
                  <div className="text-[11px] text-slate-400">可手填，也可套用当前股票账户的费率规则。</div>
                </div>
                <button type="button" onClick={applyFeeRules} disabled={feeLoading || submitting} className="secondary-button h-8 px-3 text-xs disabled:opacity-50">
                  {feeLoading ? "读取中…" : "套用账户费率"}
                </button>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <div className="form-label">佣金</div>
                  <CalcInput value={commission} onChange={setCommission} placeholder="0.00" label="佣金" />
                </div>
                <div className="space-y-1">
                  <div className="form-label">印花税</div>
                  <CalcInput value={stampTax} onChange={setStampTax} placeholder="0.00" label="印花税" />
                </div>
                <div className="space-y-1">
                  <div className="form-label">过户费</div>
                  <CalcInput value={transferFee} onChange={setTransferFee} placeholder="0.00" label="过户费" />
                </div>
                <div className="space-y-1">
                  <div className="form-label">交易所费用</div>
                  <CalcInput value={exchangeFee} onChange={setExchangeFee} placeholder="0.00" label="交易所费用" />
                </div>
                <div className="space-y-1">
                  <div className="form-label">监管费</div>
                  <CalcInput value={regulatoryFee} onChange={setRegulatoryFee} placeholder="0.00" label="监管费" />
                </div>
                <div className="space-y-1">
                  <div className="form-label">其他费用</div>
                  <CalcInput value={otherFee} onChange={setOtherFee} placeholder="0.00" label="其他费用" />
                </div>
              </div>
            </div>
            ) : null}

            {showDividendDeductionPanel ? (
              <div className="rounded-[12px] border border-slate-200 bg-slate-50/70 p-3">
                <div className="mb-2">
                  <div className="text-xs font-medium text-slate-700">分红扣税/费用</div>
                  <div className="text-[11px] text-slate-400">现金股息不改变持仓股数；如有预扣税或费用，填在这里。</div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="form-label">扣税/费用</div>
                    <CalcInput value={otherFee} onChange={setOtherFee} placeholder="0.00" label="扣税/费用" />
                  </div>
                  <div className="flex items-center rounded-[10px] border border-slate-200 bg-white px-3 text-xs text-slate-500">
                    预计净到账 {previewCashAmount > 0 ? previewCashAmount.toFixed(2) : "0.00"}
                  </div>
                </div>
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="form-label">券商成交号</div>
                <input value={brokerTradeId} onChange={(event) => setBrokerTradeId(event.target.value)} className="form-input" placeholder="可选" />
              </div>
              <div className="space-y-1">
                <div className="form-label">备注</div>
                <input value={note} onChange={(event) => setNote(event.target.value)} className="form-input" placeholder="可选" />
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <div className="text-xs text-slate-500">
              {footerHint}
            </div>
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={close} disabled={submitting} className="secondary-button h-9 px-4 text-sm disabled:opacity-50">取消</button>
              <button type="submit" disabled={submitting || autoCreatingAccount} className="primary-button h-9 px-4 text-sm disabled:opacity-50">
                {submitting ? "保存中…" : "保存股票交易"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
