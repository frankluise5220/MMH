"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { EntityCreateForm } from "./EntityCreateForm";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";

type StockTransactionAction =
  | "buy"
  | "sell"
  | "dividend"
  | "bonus_share"
  | "split_share"
  | "merge_share";

type StockModalAction = "buy" | "sell" | "dividend" | "share_change";

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

type StockAccountCreatedExtra = {
  kind?: string;
  groupId?: string;
  groupName?: string;
  institutionId?: string;
  institutionName?: string;
  institutionShortName?: string;
  currency?: string;
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

type StockSecurityLookupResponse = {
  ok?: boolean;
  error?: string;
  data?: {
    security?: {
      id: string;
      market: string;
      stockCode: string;
      stockName?: string | null;
      currency?: string | null;
      exchange?: string | null;
    } | null;
  };
};

type StockCreateEventDetail = {
  requestId?: string;
  defaultStockAccountId?: string;
  defaultCashAccountId?: string;
  defaultDate?: string;
  defaultAmount?: number;
};

const STOCK_ACTIONS: Array<{ key: StockModalAction; label: string; tone: string }> = [
  { key: "buy", label: "买入", tone: "bg-blue-600 text-white border-blue-600" },
  { key: "sell", label: "卖出", tone: "bg-orange-600 text-white border-orange-600" },
  { key: "dividend", label: "分红", tone: "bg-emerald-600 text-white border-emerald-600" },
  { key: "share_change", label: "股本变动", tone: "bg-slate-700 text-white border-slate-700" },
];

const SHARE_CHANGE_ACTIONS: Array<{ key: Extract<StockTransactionAction, "bonus_share" | "split_share" | "merge_share">; label: string }> = [
  { key: "bonus_share", label: "送股" },
  { key: "split_share", label: "拆股" },
  { key: "merge_share", label: "并股" },
];

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

function normalizeStockCode(value: string) {
  return value.trim().toUpperCase();
}

function inferStockMarketFromCode(value: string) {
  const code = normalizeStockCode(value);
  if (/^\d{6}$/.test(code)) return "CN";
  if (/^\d{5}$/.test(code)) return "HK";
  if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(code)) return "US";
  return "CN";
}

function sameBrokerageFundingAccount(stockAccount: AccountOption | null, cashAccount: AccountOption) {
  if (!stockAccount?.institutionId || cashAccount.institutionId !== stockAccount.institutionId) return false;
  if (stockAccount.groupId && cashAccount.groupId && cashAccount.groupId !== stockAccount.groupId) return false;
  if (stockAccount.currency && cashAccount.currency && cashAccount.currency !== stockAccount.currency) return false;
  return true;
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
  const groupName = account.AccountGroup?.name?.trim() || "";
  const labelParts = account.name.includes(institutionName)
    ? [groupName, account.name]
    : [groupName, institutionName, account.name];
  const label = labelParts.filter(Boolean).join("·") || account.name;
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

function inferBrokerageNameFromStockAccount(account: AccountOption | null) {
  if (!account) return "";
  const accountName = account.name?.trim() || "";
  const groupName = account.groupName?.trim() || "";
  for (const label of [account.label, account.title, account.hoverTitle]) {
    const parts = (label ?? "").split("·").map((part) => part.trim()).filter(Boolean);
    const candidate = parts.find((part) => part !== accountName && part !== groupName && part !== "股票账户");
    if (candidate) return candidate;
  }
  return "";
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

  const sameInstitutionCash = params.cashAccounts.find((account) => sameBrokerageFundingAccount(stockAccount, account)) ?? null;
  if (sameInstitutionCash?.id) return sameInstitutionCash.id;

  const fallback = params.fallbackCashAccountId?.trim();
  if (fallback && cashIds.has(fallback)) return fallback;
  return "";
}

function quantityLabelForAction(action: StockTransactionAction) {
  if (action === "bonus_share") return "送股数量";
  if (action === "split_share") return "新增股数";
  if (action === "merge_share") return "减少股数";
  return "数量";
}

function amountLabelForAction(action: StockModalAction) {
  if (action === "dividend") return "分红金额";
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
  const [nestedAccountOpen, setNestedAccountOpen] = useState(false);
  const [nestedCashAccountOpen, setNestedCashAccountOpen] = useState(false);
  const autoCreateAttemptedRef = useRef(false);
  const cashAccountTouchedRef = useRef(false);

  const [action, setAction] = useState<StockModalAction>("buy");
  const [shareChangeAction, setShareChangeAction] = useState<Extract<StockTransactionAction, "bonus_share" | "split_share" | "merge_share">>("bonus_share");
  const [market, setMarket] = useState("CN");
  const [stockCode, setStockCode] = useState("");
  const [stockName, setStockName] = useState("");
  const [tradeDate, setTradeDate] = useState(today);
  const [settleDate, setSettleDate] = useState("");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [grossAmount, setGrossAmount] = useState("");
  const [netAmount, setNetAmount] = useState("");
  const [stockLookupLoading, setStockLookupLoading] = useState(false);
  const [brokerTradeId, setBrokerTradeId] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

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
  const { ownerFilterLabel, cycleOwnerFilter, filteredOptions } = useAccountSSFilter(stockAccountOptions);
  const selectedAccount = localStockAccounts.find((account) => account.id === stockAccountId) ?? null;
  const eligibleCashAccounts = useMemo(
    () => localCashAccounts.filter((account) => sameBrokerageFundingAccount(selectedAccount, account)),
    [localCashAccounts, selectedAccount],
  );
  const eligibleCashAccountOptions = useMemo<SmartSelectOption[]>(() => {
    const fallback = eligibleCashAccounts.map(cashAccountToSmartOption);
    const eligibleIds = new Set(eligibleCashAccounts.map((account) => account.id));
    const scoped = (localCashSSOptions ?? []).filter((option) => option.isHeader || eligibleIds.has(option.id));
    return mergeOptions(scoped.length > 0 ? scoped : fallback, fallback);
  }, [eligibleCashAccounts, localCashSSOptions]);
  const selectedCashAccount = eligibleCashAccounts.find((account) => account.id === cashAccountId)
    ?? eligibleCashAccounts[0]
    ?? null;
  const transactionAction: StockTransactionAction = action === "share_change" ? shareChangeAction : action;
  const isBuySell = action === "buy" || action === "sell";
  const isDividendAction = action === "dividend";
  const isShareAction = action === "share_change";
  const isCashAmountAction = action === "buy" || action === "sell" || action === "dividend";
  const showQuantityField = isBuySell || isShareAction;
  const showPriceField = isBuySell;
  const showAmountField = isCashAmountAction;
  const showSettleDate = isBuySell || isDividendAction;
  const showNetAmount = isDividendAction;
  const grossFromQuantity = parseNumber(quantity) * parseNumber(price);
  const effectiveGrossAmount = isBuySell ? grossFromQuantity : parseNumber(grossAmount);
  const previewCashAmount = action === "sell" || action === "dividend"
    ? Math.max(0, parseNumber(netAmount) || effectiveGrossAmount)
    : action === "buy"
      ? effectiveGrossAmount
      : 0;
  const accountCreateFieldData = useMemo(() => {
    const accounts = mergeAccounts(localStockAccounts, localCashAccounts);
    const groups = new Map<string, { id: string; name: string }>();
    const institutions = new Map<string, { id: string; name: string; type?: string }>();
    for (const account of accounts) {
      if (account.groupId) groups.set(account.groupId, { id: account.groupId, name: account.groupName || "所有人" });
      if (account.institutionId) {
        const label = account.label.split("·")[0] || account.institutionId;
        institutions.set(account.institutionId, {
          id: account.institutionId,
          name: label,
          type: account.institutionType ?? "brokerage",
        });
      }
    }
    return {
      groupId: Array.from(groups.values()),
      institutionId: Array.from(institutions.values()),
    };
  }, [localCashAccounts, localStockAccounts]);
  const existingStockAccountNames = useMemo(
    () => localStockAccounts.map((account) => account.name || account.label),
    [localStockAccounts],
  );
  const existingCashAccountNames = useMemo(
    () => localCashAccounts.map((account) => account.name || account.label),
    [localCashAccounts],
  );
  const cashAccountCreateExtraFields = useMemo(() => ({
    kind: "ewallet",
    ...(selectedAccount?.groupId ? { groupId: selectedAccount.groupId } : {}),
    ...(selectedAccount?.institutionId ? { institutionId: selectedAccount.institutionId } : {}),
    ...(selectedAccount?.currency ? { currency: selectedAccount.currency } : {}),
  }), [selectedAccount]);
  const cashAccountCreateReadOnlyFields = useMemo(() => [
    ...(selectedAccount?.groupId ? ["groupId"] : []),
    ...(selectedAccount?.institutionId ? ["institutionId"] : []),
    ...(selectedAccount?.currency ? ["currency"] : []),
  ], [selectedAccount]);

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
    setNetAmount("");
    setStockLookupLoading(false);
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
      if (!seedCashAccount?.institutionId) return;
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

  function handleStockAccountCreated(id: string, name: string, extra?: StockAccountCreatedExtra) {
    const institutionName = extra?.institutionShortName?.trim() || extra?.institutionName?.trim() || "";
    const option: AccountOption = {
      id,
      name,
      label: [institutionName, name].filter(Boolean).join("·") || name,
      subLabel: [extra?.groupName ?? "", "股票账户"].filter(Boolean).join(" · "),
      kind: "investment",
      investProductType: "stock",
      groupId: extra?.groupId ?? null,
      groupName: extra?.groupName ?? null,
      institutionId: extra?.institutionId ?? null,
      institutionType: "brokerage",
      currency: extra?.currency ?? "CNY",
    };
    const brokerageCashOption = extra?.brokerageCashAccount ? createdCashAccountToOption(extra.brokerageCashAccount) : null;
    setLocalStockAccounts((prev) => mergeAccounts([option], prev));
    setLocalStockSSOptions((prev) => mergeOptions(prev, [accountToSmartOption(option)]));
    if (brokerageCashOption) {
      setLocalCashAccounts((prev) => mergeAccounts([brokerageCashOption], prev));
      setLocalCashSSOptions((prev) => mergeOptions(prev, [cashAccountToSmartOption(brokerageCashOption)]));
    }
    cashAccountTouchedRef.current = false;
    setStockAccountId(id);
    setCashAccountId(brokerageCashOption?.id ?? "");
    setNestedAccountOpen(false);
    requestAnimationFrame(() => {
      dispatchFinanceDataChanged({
        reason: "stock-account:create",
        accountIds: [id, brokerageCashOption?.id ?? ""].filter((item): item is string => Boolean(item)),
      });
    });
  }

  function openNestedCashAccountCreate() {
    if (!selectedAccount?.id) {
      window.alert("请先选择股票账户");
      return;
    }
    if (!selectedAccount.institutionId) {
      window.alert("请先选择带证券机构的股票账户");
      return;
    }
    setNestedCashAccountOpen(true);
  }

  function handleCashAccountCreated(id: string, name: string, extra?: StockAccountCreatedExtra) {
    const institutionName = extra?.institutionShortName?.trim()
      || extra?.institutionName?.trim()
      || inferBrokerageNameFromStockAccount(selectedAccount);
    const groupName = extra?.groupName ?? selectedAccount?.groupName ?? "";
    const labelParts = name.includes(institutionName)
      ? [groupName, name]
      : [groupName, institutionName, name];
    const option: AccountOption = {
      id,
      name,
      label: labelParts.filter(Boolean).join("·") || name,
      subLabel: [groupName, "证券资金账户"].filter(Boolean).join(" · "),
      kind: extra?.kind ?? "ewallet",
      groupId: extra?.groupId ?? selectedAccount?.groupId ?? null,
      groupName: groupName || null,
      institutionId: extra?.institutionId ?? selectedAccount?.institutionId ?? null,
      institutionType: "brokerage",
      investProductType: null,
      currency: extra?.currency ?? selectedAccount?.currency ?? "CNY",
    };
    setLocalCashAccounts((prev) => mergeAccounts([option], prev));
    setLocalCashSSOptions((prev) => mergeOptions(prev, [cashAccountToSmartOption(option)]));
    cashAccountTouchedRef.current = true;
    setCashAccountId(id);
    setNestedCashAccountOpen(false);
    requestAnimationFrame(() => {
      dispatchFinanceDataChanged({
        reason: "stock-funding-account:create",
        accountIds: [id, stockAccountId].filter((item): item is string => Boolean(item)),
      });
    });
  }

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

  useEffect(() => {
    if (!open) return;
    const code = normalizeStockCode(stockCode);
    if (!code) {
      setStockName("");
      setStockLookupLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setStockLookupLoading(true);
      try {
        const lookupMarket = inferStockMarketFromCode(code);
        const params = new URLSearchParams({ market: lookupMarket, code, lookup: "1" });
        const res = await fetch(`/api/v1/stocks/securities?${params.toString()}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const data = await res.json().catch(() => null) as StockSecurityLookupResponse | null;
        if (!res.ok || !data?.ok) throw new Error(data?.error ?? "股票名称查询失败");
        const security = data.data?.security ?? null;
        const nextName = security?.stockName?.trim() ?? "";
        if (nextName && nextName !== code) {
          setStockName(nextName);
          if (security?.market) setMarket(security.market);
        } else {
          setStockName("");
        }
      } catch (error) {
        if ((error as Error)?.name !== "AbortError") setStockName("");
      } finally {
        if (!controller.signal.aborted) setStockLookupLoading(false);
      }
    }, 600);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, stockCode]);

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
    if (isBuySell && (!parseNumber(quantity) || !parseNumber(price) || effectiveGrossAmount <= 0)) {
      window.alert("买卖股票需要填写数量和成交价格");
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
    setSubmitting(true);
    try {
      const payload = {
        stockAccountId,
        cashAccountId: selectedCashAccount?.id || undefined,
        market,
        stockCode: normalizedCode,
        stockName: stockName.trim() || normalizedCode,
        action: transactionAction,
        tradeDate,
        settleDate: showSettleDate ? settleDate || undefined : undefined,
        quantity: showQuantityField ? quantity || undefined : undefined,
        price: showPriceField ? price || undefined : undefined,
        grossAmount: showAmountField ? effectiveGrossAmount || undefined : undefined,
        netAmount: showNetAmount ? netAmount || undefined : undefined,
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
          accountIds: Array.from(new Set([stockAccountId, selectedCashAccount?.id].filter((id): id is string => Boolean(id)))),
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
    <>
      <div className="app-modal-backdrop z-[1000]">
        <div className="app-modal-panel max-w-[min(38rem,calc(100vw-1rem))]">
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <div className="modal-header">
              <div className="text-sm font-semibold text-slate-800">股票交易</div>
              <button type="button" onClick={close} className="secondary-button h-8 px-2" title="关闭">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 sm:px-5 sm:py-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <div className="form-label">股票账户</div>
                  <SmartSelect
                    mode="single"
                    value={stockAccountId}
                    onChange={(id) => {
                      cashAccountTouchedRef.current = false;
                      setStockAccountId(id);
                    }}
                    options={sortOptionsByRecent(filteredOptions ?? stockAccountOptions, recentAccountIds)}
                    placeholder={autoCreatingAccount ? "正在自动建立股票账户" : "选择股票账户"}
                    onCreateClick={() => setNestedAccountOpen(true)}
                    createLabel="新增股票账户"
                    onCycleOwnerFilter={cycleOwnerFilter}
                    ownerFilterLabel={ownerFilterLabel}
                    behavior={{ search: true, density: "compact", minDropdownWidth: 280 }}
                  />
                  {autoCreateError ? <div className="text-[11px] text-rose-600">{autoCreateError}</div> : null}
                </div>
                <div className="space-y-1">
                  <div className="form-label">资金账户</div>
                  <SmartSelect
                    mode="single"
                    value={selectedCashAccount?.id ?? cashAccountId}
                    onChange={(value) => {
                      cashAccountTouchedRef.current = true;
                      setCashAccountId(value);
                    }}
                    options={sortOptionsByRecent(eligibleCashAccountOptions, recentAccountIds)}
                    placeholder={eligibleCashAccountOptions.length > 0 ? "选择资金账户" : "新增资金账户"}
                    onCreateClick={openNestedCashAccountCreate}
                    createLabel="新增资金账户"
                    behavior={{ search: true, density: "compact", minDropdownWidth: 260 }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <div className="form-label">股票代码</div>
                  <input
                    value={stockCode}
                    onChange={(event) => {
                      const nextCode = event.target.value.toUpperCase();
                      setStockCode(nextCode);
                      setMarket(inferStockMarketFromCode(nextCode));
                    }}
                    className="form-input"
                    placeholder="600519 / 00700 / AAPL"
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <div className="form-label">股票名称</div>
                  <div className="flex h-9 items-center rounded-[10px] border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700">
                    {stockLookupLoading ? "查询中..." : stockName || ""}
                  </div>
                </div>
              </div>

              <div className={`grid gap-3 ${showSettleDate ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
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

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {isShareAction ? (
                  <div className="space-y-1">
                    <div className="form-label">变动类型</div>
                    <select
                      value={shareChangeAction}
                      onChange={(event) => setShareChangeAction(event.target.value as typeof shareChangeAction)}
                      className="form-input"
                    >
                      {SHARE_CHANGE_ACTIONS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                    </select>
                  </div>
                ) : null}
                {showQuantityField ? (
                  <div className="space-y-1">
                    <div className="form-label">{quantityLabelForAction(transactionAction)}</div>
                    <CalcInput value={quantity} onChange={setQuantity} placeholder="股数" label={quantityLabelForAction(transactionAction)} precision={4} />
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
                    {isBuySell ? (
                      <input
                        value={grossFromQuantity > 0 ? grossFromQuantity.toFixed(2) : ""}
                        readOnly
                        className="form-input bg-slate-50 text-right tabular-nums text-slate-700"
                        placeholder="自动计算"
                      />
                    ) : (
                      <CalcInput
                        value={grossAmount}
                        onChange={setGrossAmount}
                        placeholder="金额"
                        label={amountLabelForAction(action)}
                        precision={2}
                      />
                    )}
                  </div>
                ) : null}
                {showNetAmount ? (
                  <div className="space-y-1">
                    <div className="form-label">净到账</div>
                    <CalcInput value={netAmount} onChange={setNetAmount} placeholder={previewCashAmount > 0 ? previewCashAmount.toFixed(2) : "可选"} label="净金额" precision={2} />
                  </div>
                ) : null}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

            <div className="modal-footer flex shrink-0 justify-end">
              <button type="submit" disabled={submitting || autoCreatingAccount} className="primary-button h-9 px-4 text-sm disabled:opacity-50">
                {submitting ? "保存中..." : "保存"}
              </button>
            </div>
          </form>
        </div>
      </div>
      <EntityCreateForm
        mode="compact"
        entityType="account"
        open={nestedAccountOpen}
        onClose={() => setNestedAccountOpen(false)}
        onCreated={(id, name, extra) => handleStockAccountCreated(id, name, extra as StockAccountCreatedExtra)}
        title="新增股票账户"
        nameLabel="股票账户名称"
        namePlaceholder="例如：中信建投股票账户"
        defaultType="investment"
        extraFields={{ kind: "investment", investProductType: "stock" }}
        hiddenFields={["kind", "investProductType", "fundUnitsDecimals", "tradingCalendar"]}
        nestedFieldData={accountCreateFieldData}
        existingNames={existingStockAccountNames}
      />
      <EntityCreateForm
        mode="compact"
        entityType="account"
        open={nestedCashAccountOpen}
        onClose={() => setNestedCashAccountOpen(false)}
        onCreated={(id, name, extra) => handleCashAccountCreated(id, name, extra as StockAccountCreatedExtra)}
        title="新增资金账户"
        nameLabel="资金账户名称"
        namePlaceholder="例如：资金账户21003344"
        defaultType="ewallet"
        extraFields={cashAccountCreateExtraFields}
        hiddenFields={["kind"]}
        readOnlyFields={cashAccountCreateReadOnlyFields}
        nestedFieldData={accountCreateFieldData}
        existingNames={existingCashAccountNames}
      />
    </>,
    document.body,
  );
}
