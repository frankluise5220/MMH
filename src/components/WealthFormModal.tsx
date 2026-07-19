"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { parseNumber } from "@/lib/investment-config";
import { DateStepper } from "./DateStepper";
import { CalcInput } from "./CalcInput";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { NestedAddModal } from "./EntityCreateForm";
import { kindLabel } from "@/lib/account-kinds";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { isWealthAccountAllowedForCashAccount } from "@/lib/wealth-account-rules";

type Entry = {
  id?: string;
  transactionId?: string;
  cashEntryId?: string | null;
  businessTransactionId?: string | null;
  date: string;
  amount: number;
  note?: string | null;
  fundName?: string | null;
  wealthProductId?: string | null;
  fundProductType?: string | null;
  fundSubtype?: string | null;
  fundUnits?: number | null;
  fundNav?: number | null;
  depositInterest?: number | null;
  fundArrivalAmount?: number | null;
  accountId?: string | null;
  toAccountId?: string | null;
  toAccountName?: string | null;
  fundArrivalDate?: string | null;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;
type AccountOption = {
  id: string;
  label: string;
  icon?: string;
  subLabel?: string;
  kind?: string;
  groupId?: string | null;
  investProductType?: string | null;
  institutionId?: string | null;
  institutionType?: string | null;
  currency?: string | null;
};
type WealthProductOption = {
  id: string;
  name: string;
  shortName?: string | null;
  institutionId?: string | null;
  institutionName?: string | null;
  currency?: string | null;
  annualRate?: number | null;
  termDays?: number | null;
  note?: string | null;
};
type WealthHoldingOption = {
  id: string;
  label: string;
  subLabel?: string;
  fundName: string;
  wealthProductId?: string | null;
  wealthAccountId: string;
  wealthAccountLabel?: string | null;
  remainingAmount: number;
  remainingUnits?: number | null;
  hasUnits?: boolean;
  annualRate?: number | null;
  termDays?: number | null;
  movements?: Array<{ date: string; delta: number }>;
  unitMovements?: Array<{ date: string; delta: number }>;
};
type EditingWealthRedeemSource = {
  id: string;
  label: string;
  fundName: string;
  wealthProductId?: string | null;
  wealthAccountId: string;
  wealthAccountLabel?: string | null;
  restoredPrincipalAmount: number;
  restoredRemainingAmount: number;
  restoredUnits: number | null;
  restoredRemainingUnits: number | null;
  hasUnits?: boolean;
  annualRate?: number | null;
  termDays?: number | null;
  movements?: Array<{ date: string; delta: number }>;
  unitMovements?: Array<{ date: string; delta: number }>;
};
type WealthSubtype = "buy" | "redeem" | "dividend_cash";
const TERM_PRESETS = [
  { label: "3个月", days: 90 },
  { label: "半年", days: 180 },
  { label: "1年", days: 365 },
  { label: "2年", days: 730 },
  { label: "3年", days: 1095 },
  { label: "5年", days: 1825 },
] as const;

function inferWealthRedeemPrincipalAmount(input: {
  amount?: number | null;
  fundArrivalAmount?: number | null;
  depositInterest?: number | null;
  fundSubtype?: string | null;
}) {
  const rawAmount = Math.abs(input.amount ?? 0);
  const isRedeem = input.fundSubtype === "redeem" || input.fundSubtype === "switch_out";
  if (!isRedeem) return rawAmount;

  const arrivalAmount = input.fundArrivalAmount == null ? null : Math.abs(input.fundArrivalAmount);
  const interest = input.depositInterest ?? 0;
  if (arrivalAmount != null && Math.abs(rawAmount - arrivalAmount) < 0.005) {
    return Math.max(0, arrivalAmount - interest);
  }
  return rawAmount;
}

function mergeWealthProducts(primary: WealthProductOption[], fallback: WealthProductOption[]) {
  const seen = new Set<string>();
  const merged: WealthProductOption[] = [];
  for (const product of [...primary, ...fallback]) {
    if (seen.has(product.id)) continue;
    seen.add(product.id);
    merged.push(product);
  }
  return merged;
}

function wealthHoldingAmountAt(holding: WealthHoldingOption, date: string) {
  const movements = holding.movements ?? [];
  if (movements.length === 0) return holding.remainingAmount;
  return Number(
    movements
      .filter((movement) => !date || movement.date <= date)
      .reduce((sum, movement) => sum + movement.delta, 0)
      .toFixed(2),
  );
}

function wealthHoldingUnitsAt(holding: WealthHoldingOption, date: string) {
  const movements = holding.unitMovements ?? [];
  if (movements.length === 0) return holding.remainingUnits ?? 0;
  return Number(
    movements
      .filter((movement) => !date || movement.date <= date)
      .reduce((sum, movement) => sum + movement.delta, 0)
      .toFixed(6),
  );
}

function isWealthRedeemArrivalAccount(account: AccountOption, wealthInstitutionId?: string | null) {
  if (account.kind === "bank_debit") return true;
  return account.kind === "ewallet" && !!wealthInstitutionId && account.institutionId === wealthInstitutionId;
}

function isWealthDividendArrivalAccount(account: AccountOption, wealthInstitutionId?: string | null) {
  return account.kind === "bank_debit" && (!wealthInstitutionId || account.institutionId === wealthInstitutionId);
}

function parseSignedNumber(value: string) {
  const n = parseFloat(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function WealthFormModal({
  mode = "create",
  accountId: defaultAccountId,
  entry,
  listenForEditEvents,
  openSignal,
  cashAccounts = [],
  investmentAccounts = [],
  cashAccountSSOptions,
  investmentAccountSSOptions,
  wealthHoldingOptions = [],
  nestedFieldData,
  createAction,
  editAction,
}: {
  mode?: "create" | "edit";
  accountId: string;
  entry?: Entry;
  listenForEditEvents?: boolean;
  openSignal?: number;
  cashAccounts?: AccountOption[];
  investmentAccounts?: AccountOption[];
  /** Hierarchical SmartSelect options for cash account dropdown (grouped by AccountGroup) */
  cashAccountSSOptions?: SmartSelectOption[];
  /** Hierarchical SmartSelect options for investment account dropdown (grouped by AccountGroup) */
  investmentAccountSSOptions?: SmartSelectOption[];
  wealthHoldingOptions?: WealthHoldingOption[];
  /** Groups & institutions data for NestedAddModal compact account creation */
  nestedFieldData?: NestedFieldData;
  createAction: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  editAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const initIsDividend = mode === "edit" && entry?.fundSubtype === "dividend_cash";
  const initIsRedeem = mode === "edit" && entry
    ? entry.fundSubtype
      ? entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out"
      : entry.amount > 0
    : false;
  const initAmount = mode === "edit" && entry ? String(inferWealthRedeemPrincipalAmount(entry)) : "";
  const initDate = mode === "edit" && entry?.date ? entry.date.slice(0, 10) : today;
  const initArrivalDate = mode === "edit" && entry?.fundArrivalDate ? entry.fundArrivalDate.slice(0, 10) : initDate;
  const initName = mode === "edit" && entry?.fundName ? entry.fundName : "";
  const initMemo = mode === "edit" && entry?.note ? entry.note : "";
  const initUnits = mode === "edit" && entry?.fundUnits != null ? String(Math.abs(entry.fundUnits)) : "";
  const initNav = mode === "edit" && entry?.fundNav != null ? String(Math.abs(entry.fundNav)) : "";

  // 编辑模式确定资金/投资账户
  const initOutgoingFromWealth = initIsRedeem || initIsDividend;
  const initCashAccountId = mode === "edit" && entry
    ? (initOutgoingFromWealth ? (entry.toAccountId ?? "") : (entry.accountId ?? ""))
    : "";
  const initToAccountId = mode === "edit" && entry
    ? (initOutgoingFromWealth ? (entry.accountId ?? defaultAccountId) : (entry.toAccountId ?? defaultAccountId))
    : defaultAccountId;

  const [open, setOpen] = useState(false);
  const [subtype, setSubtype] = useState<WealthSubtype>(initIsDividend ? "dividend_cash" : initIsRedeem ? "redeem" : "buy");
  const [date, setDate] = useState(initDate);
  const [holdingFilterDate, setHoldingFilterDate] = useState(initDate);
  const [arrivalDate, setArrivalDate] = useState(initArrivalDate);
  const arrivalDateTouchedRef = useRef(mode === "edit");
  const [amount, setAmount] = useState(initAmount);
  const [units, setUnits] = useState(initUnits);
  const [nav, setNav] = useState(initNav);
  const [wealthProductId, setWealthProductId] = useState(mode === "edit" && entry?.wealthProductId ? entry.wealthProductId : "");
  const [fundName, setFundName] = useState(initName);
  const [annualRate, setAnnualRate] = useState("");
  const [termDays, setTermDays] = useState("");
  const [interestAmount, setInterestAmount] = useState(mode === "edit" && initIsRedeem && entry?.depositInterest != null ? String(entry.depositInterest) : "");
  const [arrivalAmount, setArrivalAmount] = useState(mode === "edit" && entry && entry.amount > 0 ? String(Math.abs(entry.amount)) : "");
  const [interestEdited, setInterestEdited] = useState(false);
  const [arrivalEdited, setArrivalEdited] = useState(false);
  const [cashAccountId, setCashAccountId] = useState(initCashAccountId);
  const [toAccountId, setToAccountId] = useState(initToAccountId);
  const [selectedHoldingId, setSelectedHoldingId] = useState("");
  const [editingRedeemSource, setEditingRedeemSource] = useState<EditingWealthRedeemSource | null>(null);
  const [memo, setMemo] = useState(initMemo);
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const [editBusinessTransactionId, setEditBusinessTransactionId] = useState<string | null>(null);
  const unitsEditedRef = useRef(mode === "edit");
  const autoFilledUnitsForRef = useRef<string | null>(null);
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [productSaving, setProductSaving] = useState(false);
  const [productDraft, setProductDraft] = useState({
    name: "",
    shortName: "",
    annualRate: "",
    termDays: "",
    note: "",
  });
  const [productError, setProductError] = useState("");

  // Mutable account lists for NestedAddModal onCreated updates
  const [cashAccountList, setCashAccountList] = useState(cashAccounts);
  const [investmentAccountList, setInvestmentAccountList] = useState(investmentAccounts);
  // Mutable SS options — onCreated appends new account to these too
  const [localCashSSOpts, setLocalCashSSOpts] = useState(cashAccountSSOptions);
  const [localInvestSSOpts, setLocalInvestSSOpts] = useState(investmentAccountSSOptions);
  const [nestedEntityType, setNestedEntityType] = useState<"cash-account" | "wealth-account" | null>(null);
  const [wealthProducts, setWealthProducts] = useState<WealthProductOption[]>([]);

  const { ownerFilterLabel: cfLabel, cycleOwnerFilter: cfCycle, filteredOptions: cashFiltered } = useAccountSSFilter(localCashSSOpts);
  const isRedeem = subtype === "redeem";
  const isDividend = subtype === "dividend_cash";
  const isHoldingAction = isRedeem || isDividend;
  const selectedCashAccount = useMemo(
    () => cashAccountList.find((account) => account.id === cashAccountId) ?? null,
    [cashAccountId, cashAccountList],
  );
  const wealthAccountList = useMemo(
    () => investmentAccountList.filter((account) => account.investProductType === "wealth"),
    [investmentAccountList],
  );
  const wealthAccountIds = useMemo(() => new Set(wealthAccountList.map((account) => account.id)), [wealthAccountList]);
  const selectableWealthAccountList = useMemo(() => {
    if (isHoldingAction) return wealthAccountList;
    if (!selectedCashAccount?.groupId) return [];
    return wealthAccountList.filter((account) => isWealthAccountAllowedForCashAccount({
      cashGroupId: selectedCashAccount.groupId ?? "",
      cashInstitutionId: selectedCashAccount.institutionId,
      wealthGroupId: account.groupId ?? "",
      wealthInstitutionId: account.institutionId,
      wealthInstitutionType: account.institutionType,
    }));
  }, [isHoldingAction, selectedCashAccount, wealthAccountList]);
  const selectableWealthAccountIds = useMemo(
    () => new Set(selectableWealthAccountList.map((account) => account.id)),
    [selectableWealthAccountList],
  );
  const localWealthSSOpts = useMemo(
    () => (localInvestSSOpts ?? []).filter((option) => option.isHeader || selectableWealthAccountIds.has(option.id)),
    [localInvestSSOpts, selectableWealthAccountIds],
  );
  const { ownerFilterLabel: wealthOwnerLabel, cycleOwnerFilter: cycleWealthOwner, filteredOptions: wealthFiltered } = useAccountSSFilter(localWealthSSOpts);
  const cashAccountOptions = useMemo<SmartSelectOption[]>(
    () => cashAccountList.map((account) => ({ ...account, kind: account.kind ?? null })),
    [cashAccountList],
  );
  const wealthAccountOptions = useMemo<SmartSelectOption[]>(
    () => selectableWealthAccountList.map((account) => ({ ...account, kind: account.kind ?? null })),
    [selectableWealthAccountList],
  );
  const cashSelectOptions = cashFiltered ?? cashAccountOptions;
  const wealthSelectOptions = wealthFiltered ?? wealthAccountOptions;
  const selectedWealthAccount = useMemo(
    () => wealthAccountList.find((account) => account.id === toAccountId) ?? null,
    [toAccountId, wealthAccountList],
  );
  const productInstitutionId = selectedWealthAccount?.institutionId ?? selectedCashAccount?.institutionId ?? null;
  const selectedWealthInstitutionId = selectedWealthAccount?.institutionId ?? null;
  const redeemCashOptions = useMemo(
    () =>
      cashAccountList.filter(
        (account) => isRedeem
          ? isWealthRedeemArrivalAccount(account, selectedWealthInstitutionId)
          : isWealthDividendArrivalAccount(account, selectedWealthInstitutionId),
      ),
    [cashAccountList, isRedeem, selectedWealthInstitutionId],
  );
  const effectiveHoldingOptions = useMemo(() => {
    if (!editingRedeemSource || !isRedeem) return wealthHoldingOptions;
    const restored: WealthHoldingOption = {
      id: editingRedeemSource.id,
      label: editingRedeemSource.label,
      subLabel: [
        editingRedeemSource.wealthAccountLabel,
        `编辑前本金 ${editingRedeemSource.restoredRemainingAmount.toFixed(2)}`,
        editingRedeemSource.annualRate != null ? `年化 ${editingRedeemSource.annualRate}%` : "",
        editingRedeemSource.termDays ? `${editingRedeemSource.termDays}天` : "",
      ].filter(Boolean).join(" · "),
      fundName: editingRedeemSource.fundName,
      wealthProductId: editingRedeemSource.wealthProductId ?? null,
      wealthAccountId: editingRedeemSource.wealthAccountId,
      wealthAccountLabel: editingRedeemSource.wealthAccountLabel ?? null,
      remainingAmount: editingRedeemSource.restoredRemainingAmount,
      remainingUnits: editingRedeemSource.restoredRemainingUnits,
      hasUnits: editingRedeemSource.hasUnits,
      annualRate: editingRedeemSource.annualRate ?? null,
      termDays: editingRedeemSource.termDays ?? null,
      movements: [
        ...(editingRedeemSource.movements ?? []),
        { date: holdingFilterDate, delta: editingRedeemSource.restoredPrincipalAmount },
      ],
      unitMovements: [
        ...(editingRedeemSource.unitMovements ?? []),
        ...(editingRedeemSource.restoredUnits != null ? [{ date: holdingFilterDate, delta: editingRedeemSource.restoredUnits }] : []),
      ],
    };
    if (wealthHoldingOptions.some((holding) => holding.id === editingRedeemSource.id)) {
      return wealthHoldingOptions.map((holding) =>
        holding.id === editingRedeemSource.id
          ? { ...holding, ...restored }
          : holding,
      );
    }
    return [restored, ...wealthHoldingOptions];
  }, [editingRedeemSource, holdingFilterDate, isRedeem, wealthHoldingOptions]);
  const filteredHoldingOptions = useMemo(
    () =>
      effectiveHoldingOptions.filter((holding) => {
        if (toAccountId && holding.wealthAccountId !== toAccountId) return false;
        if (!isHoldingAction) return true;
        if (holding.hasUnits) return wealthHoldingUnitsAt(holding, holdingFilterDate) > 0.000001;
        return wealthHoldingAmountAt(holding, holdingFilterDate) > 0.0001;
      }),
    [effectiveHoldingOptions, holdingFilterDate, isHoldingAction, toAccountId],
  );
  const holdingSelectOptions: SmartSelectOption[] = useMemo(
    () => filteredHoldingOptions.map((holding) => ({
      id: holding.id,
      label: holding.label,
      subLabel: [
        holding.wealthAccountLabel,
        holding.hasUnits
          ? `当日份额 ${wealthHoldingUnitsAt(holding, holdingFilterDate).toFixed(6)}`
          : `当日本金 ${wealthHoldingAmountAt(holding, holdingFilterDate).toFixed(2)}`,
        holding.annualRate != null ? `年化 ${holding.annualRate}%` : "",
        holding.termDays ? `${holding.termDays}天` : "",
      ].filter(Boolean).join(" · "),
    })),
    [filteredHoldingOptions, holdingFilterDate],
  );
  const selectedHolding = useMemo(
    () => effectiveHoldingOptions.find((holding) => holding.id === selectedHoldingId) ?? null,
    [effectiveHoldingOptions, selectedHoldingId],
  );
  const selectedHoldingAmountAtDate = useMemo(
    () => selectedHolding ? wealthHoldingAmountAt(selectedHolding, holdingFilterDate) : 0,
    [holdingFilterDate, selectedHolding],
  );
  const selectedHoldingUnitsAtDate = useMemo(
    () => selectedHolding ? wealthHoldingUnitsAt(selectedHolding, holdingFilterDate) : 0,
    [holdingFilterDate, selectedHolding],
  );
  const selectedBuyProductRequiresUnits = useMemo(() => {
    if (isHoldingAction || !toAccountId) return false;
    const productName = wealthProducts.find((product) => product.id === wealthProductId)?.name ?? fundName.trim();
    return wealthHoldingOptions.some((holding) => {
      if (!holding.hasUnits || holding.wealthAccountId !== toAccountId) return false;
      if (wealthProductId && holding.wealthProductId === wealthProductId) return true;
      return !!productName && holding.fundName === productName;
    });
  }, [fundName, isHoldingAction, toAccountId, wealthHoldingOptions, wealthProductId, wealthProducts]);
  const wealthProductOptions: SmartSelectOption[] = useMemo(
    () => wealthProducts.map((product) => ({
      id: product.id,
      label: product.shortName?.trim() || product.name,
      subLabel: [product.shortName?.trim() ? product.name : "", product.institutionName || ""].filter(Boolean).join(" · "),
    })),
    [wealthProducts],
  );
  const resolveWealthAccountForCashAccount = useCallback((cashId: string, explicitWealthId?: string | null) => {
    const cashAccount = cashAccountList.find((account) => account.id === cashId);
    if (!cashAccount?.groupId) return "";
    const allowedAccounts = wealthAccountList.filter((account) => isWealthAccountAllowedForCashAccount({
      cashGroupId: cashAccount.groupId ?? "",
      cashInstitutionId: cashAccount.institutionId,
      wealthGroupId: account.groupId ?? "",
      wealthInstitutionId: account.institutionId,
      wealthInstitutionType: account.institutionType,
    }));
    if (explicitWealthId && allowedAccounts.some((account) => account.id === explicitWealthId)) return explicitWealthId;
    const sameInstitution = allowedAccounts.find((account) => account.institutionId === cashAccount.institutionId);
    if (sameInstitution) return sameInstitution.id;
    if (allowedAccounts.some((account) => account.id === defaultAccountId)) return defaultAccountId;
    return "";
  }, [cashAccountList, defaultAccountId, wealthAccountList]);

  useEffect(() => { setCashAccountList(cashAccounts); }, [cashAccounts]);
  useEffect(() => { setInvestmentAccountList(investmentAccounts); }, [investmentAccounts]);
  useEffect(() => { setLocalCashSSOpts(cashAccountSSOptions); }, [cashAccountSSOptions]);
  useEffect(() => { setLocalInvestSSOpts(investmentAccountSSOptions); }, [investmentAccountSSOptions]);
  const recentAccountIds = useRecentAccountIds();
  const shouldListenForEditEvents = listenForEditEvents ?? (mode === "edit" && !entry);

  useEffect(() => {
    if (mode !== "edit" || !entry || !openSignal) return;
    const nextSubtype: WealthSubtype =
      entry.fundSubtype === "dividend_cash" ? "dividend_cash" : initIsRedeem ? "redeem" : "buy";
    setEditEntryId(entry.cashEntryId ?? entry.id ?? entry.transactionId ?? null);
    setEditBusinessTransactionId(entry.businessTransactionId ?? null);
    setSubtype(nextSubtype);
    setDate(entry.date?.slice(0, 10) || today);
    setHoldingFilterDate(entry.date?.slice(0, 10) || today);
    setArrivalDate(entry.fundArrivalDate?.slice(0, 10) || entry.date?.slice(0, 10) || today);
    arrivalDateTouchedRef.current = true;
    setAmount(String(inferWealthRedeemPrincipalAmount(entry)));
    setUnits(entry.fundUnits != null ? String(Math.abs(entry.fundUnits)) : "");
    setNav(entry.fundNav != null ? String(Math.abs(entry.fundNav)) : "");
    unitsEditedRef.current = nextSubtype === "redeem";
    setWealthProductId(entry.wealthProductId ?? "");
    setFundName(entry.fundName ?? "");
    setInterestAmount(nextSubtype === "redeem" && entry.depositInterest != null ? String(entry.depositInterest) : "");
    setArrivalAmount(nextSubtype === "redeem" ? String(Math.abs(entry.fundArrivalAmount ?? entry.amount ?? 0)) : "");
    setInterestEdited(false);
    setArrivalEdited(false);
    setMemo(entry.note ?? "");
    const outgoingFromWealth = nextSubtype === "redeem" || nextSubtype === "dividend_cash";
    setCashAccountId(outgoingFromWealth ? (entry.toAccountId ?? "") : (entry.accountId ?? ""));
    const nextWealthAccountId = outgoingFromWealth ? (entry.accountId ?? defaultAccountId) : (entry.toAccountId ?? defaultAccountId);
    setToAccountId(nextWealthAccountId);
    const matchedHolding = wealthHoldingOptions.find((holding) => {
      if (holding.wealthAccountId !== nextWealthAccountId) return false;
      if (entry.wealthProductId && holding.wealthProductId === entry.wealthProductId) return true;
      return !!entry.fundName && holding.fundName === entry.fundName;
    });
    setSelectedHoldingId(matchedHolding?.id ?? "");
    if (nextSubtype === "redeem") {
      const restoredPrincipalAmount = inferWealthRedeemPrincipalAmount(entry);
      const restoredUnits = entry.fundUnits != null ? Math.abs(entry.fundUnits) : null;
      const restoredHoldingId =
        matchedHolding?.id ??
        `${nextWealthAccountId}\u001f${entry.wealthProductId ? `product:${entry.wealthProductId}` : `name:${entry.fundName ?? "未命名理财"}`}`;
      setEditingRedeemSource({
        id: restoredHoldingId,
        label: matchedHolding?.label ?? entry.fundName ?? "未命名理财",
        fundName: entry.fundName ?? matchedHolding?.fundName ?? "未命名理财",
        wealthProductId: entry.wealthProductId ?? matchedHolding?.wealthProductId ?? null,
        wealthAccountId: nextWealthAccountId,
        wealthAccountLabel:
          matchedHolding?.wealthAccountLabel ??
          wealthAccountList.find((account) => account.id === nextWealthAccountId)?.label ??
          "理财账户",
        restoredPrincipalAmount: Number(restoredPrincipalAmount.toFixed(2)),
        restoredRemainingAmount: Number(((matchedHolding ? wealthHoldingAmountAt(matchedHolding, entry.date || today) : 0) + restoredPrincipalAmount).toFixed(2)),
        restoredUnits,
        restoredRemainingUnits: restoredUnits == null
          ? matchedHolding?.remainingUnits ?? null
          : Number(((matchedHolding ? wealthHoldingUnitsAt(matchedHolding, entry.date || today) : 0) + restoredUnits).toFixed(6)),
        hasUnits: matchedHolding?.hasUnits || restoredUnits != null,
        annualRate: matchedHolding?.annualRate ?? null,
        termDays: matchedHolding?.termDays ?? null,
        movements: matchedHolding?.movements ?? [],
        unitMovements: matchedHolding?.unitMovements ?? [],
      });
      setSelectedHoldingId(restoredHoldingId);
    } else {
      setEditingRedeemSource(null);
    }
    setOpen(true);
  }, [defaultAccountId, entry, initIsRedeem, mode, openSignal, today, wealthAccountList, wealthHoldingOptions]);

  useEffect(() => {
    if (!isHoldingAction) {
      setHoldingFilterDate(date);
      return;
    }
    const timer = window.setTimeout(() => {
      setHoldingFilterDate(date);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [date, isHoldingAction]);

  function reset() {
    setSubtype("buy");
    setDate(today);
    setHoldingFilterDate(today);
    setArrivalDate(today);
    arrivalDateTouchedRef.current = false;
    setAmount("");
    setUnits("");
    setNav("");
    unitsEditedRef.current = false;
    autoFilledUnitsForRef.current = null;
    setWealthProductId("");
    setFundName("");
    setAnnualRate("");
    setTermDays("");
    setInterestAmount("");
    setArrivalAmount("");
    setInterestEdited(false);
    setArrivalEdited(false);
    setCashAccountId("");
    setToAccountId("");
    setSelectedHoldingId("");
    setEditingRedeemSource(null);
    setMemo("");
    setRequestId(null);
    setEditEntryId(null);
    setEditBusinessTransactionId(null);
  }

  // Listen for edit event
  useEffect(() => {
    if (!shouldListenForEditEvents) return;

    function onEdit(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId: string; entryId: string;
        cashEntryId?: string | null; businessTransactionId?: string | null;
        type: string; date: string; amount: number; note: string;
        accountId?: string; toAccountId?: string;
        fundName?: string; wealthProductId?: string | null; fundSubtype?: string; fundArrivalDate?: string | null;
        fundUnits?: number | null; fundNav?: number | null; depositInterest?: number | null; fundArrivalAmount?: number | null;
      }>).detail;
      if (!detail?.requestId || !detail.entryId) return;
      setRequestId(detail.requestId);
      setEditEntryId(detail.cashEntryId ?? detail.entryId);
      setEditBusinessTransactionId(detail.businessTransactionId ?? null);
      const nextSubtype: WealthSubtype =
        detail.fundSubtype === "dividend_cash" ? "dividend_cash" : detail.fundSubtype === "redeem" ? "redeem" : "buy";
      setDate(detail.date || today);
      setHoldingFilterDate(detail.date || today);
      setArrivalDate(detail.fundArrivalDate?.slice(0, 10) || detail.date || today);
      arrivalDateTouchedRef.current = true;
      const detailPrincipalAmount = inferWealthRedeemPrincipalAmount(detail);
      setAmount(detailPrincipalAmount ? String(detailPrincipalAmount) : "");
      setUnits(detail.fundUnits != null ? String(Math.abs(detail.fundUnits)) : "");
      setNav(detail.fundNav != null ? String(Math.abs(detail.fundNav)) : "");
      unitsEditedRef.current = nextSubtype === "redeem";
      setWealthProductId(detail.wealthProductId ?? "");
      setFundName(detail.fundName ?? "");
      setInterestAmount(nextSubtype === "redeem" && detail.depositInterest != null ? String(detail.depositInterest) : "");
      setArrivalAmount(
        nextSubtype === "redeem"
          ? String(Math.abs(detail.fundArrivalAmount ?? detail.amount ?? 0))
          : "",
      );
      setInterestEdited(false);
      setArrivalEdited(false);
      setMemo(detail.note ?? "");
      const outgoingFromWealth = nextSubtype === "redeem" || nextSubtype === "dividend_cash";
      setSubtype(nextSubtype);
      setCashAccountId(outgoingFromWealth ? (detail.toAccountId ?? "") : (detail.accountId ?? ""));
      const nextWealthAccountId = outgoingFromWealth ? (detail.accountId ?? defaultAccountId) : (detail.toAccountId ?? defaultAccountId);
      setToAccountId(wealthAccountIds.has(nextWealthAccountId) ? nextWealthAccountId : (wealthAccountList[0]?.id ?? ""));
      const matchedHolding = wealthHoldingOptions.find((holding) => {
        if (holding.wealthAccountId !== nextWealthAccountId) return false;
        if (detail.wealthProductId && holding.wealthProductId === detail.wealthProductId) return true;
        return !!detail.fundName && holding.fundName === detail.fundName;
      });
      setSelectedHoldingId(matchedHolding?.id ?? "");
      if (nextSubtype === "redeem") {
        const restoredPrincipalAmount = inferWealthRedeemPrincipalAmount(detail);
        const restoredUnits = detail.fundUnits != null ? Math.abs(detail.fundUnits) : null;
        const restoredHoldingId =
          matchedHolding?.id ??
          `${nextWealthAccountId}\u001f${detail.wealthProductId ? `product:${detail.wealthProductId}` : `name:${detail.fundName ?? "未命名理财"}`}`;
        setEditingRedeemSource({
          id: restoredHoldingId,
          label: matchedHolding?.label ?? detail.fundName ?? "未命名理财",
          fundName: detail.fundName ?? matchedHolding?.fundName ?? "未命名理财",
          wealthProductId: detail.wealthProductId ?? matchedHolding?.wealthProductId ?? null,
          wealthAccountId: nextWealthAccountId,
          wealthAccountLabel:
            matchedHolding?.wealthAccountLabel ??
            wealthAccountList.find((account) => account.id === nextWealthAccountId)?.label ??
            "理财账户",
          restoredPrincipalAmount: Number(restoredPrincipalAmount.toFixed(2)),
          restoredRemainingAmount: Number(((matchedHolding ? wealthHoldingAmountAt(matchedHolding, detail.date || today) : 0) + restoredPrincipalAmount).toFixed(2)),
          restoredUnits,
          restoredRemainingUnits: restoredUnits == null
            ? matchedHolding?.remainingUnits ?? null
            : Number(((matchedHolding ? wealthHoldingUnitsAt(matchedHolding, detail.date || today) : 0) + restoredUnits).toFixed(6)),
          hasUnits: matchedHolding?.hasUnits || restoredUnits != null,
          annualRate: matchedHolding?.annualRate ?? null,
          termDays: matchedHolding?.termDays ?? null,
          movements: matchedHolding?.movements ?? [],
          unitMovements: matchedHolding?.unitMovements ?? [],
        });
        setSelectedHoldingId(restoredHoldingId);
      } else {
        setEditingRedeemSource(null);
      }
      setOpen(true);
    }
    window.addEventListener("mmh:wealth:edit", onEdit as EventListener);
    return () => window.removeEventListener("mmh:wealth:edit", onEdit as EventListener);
  }, [defaultAccountId, mode, shouldListenForEditEvents, today, wealthAccountIds, wealthAccountList, wealthHoldingOptions]);

  // Listen for create event
  useEffect(() => {
    if (mode !== "create") return;

    function onCreate(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId: string;
        defaultCashAccountId?: string;
        defaultWealthAccountId?: string;
        defaultDate?: string;
        defaultAmount?: number;
      }>).detail;
      const nextDate = detail?.defaultDate || today;
      const nextCashAccountId = detail?.defaultCashAccountId ?? "";
      reset();
      setRequestId(detail?.requestId ?? null);
      setCashAccountId(nextCashAccountId);
      setDate(nextDate);
      setHoldingFilterDate(nextDate);
      setArrivalDate(nextDate);
      arrivalDateTouchedRef.current = false;
      if (typeof detail?.defaultAmount === "number" && detail.defaultAmount > 0) setAmount(String(detail.defaultAmount));
      setToAccountId(resolveWealthAccountForCashAccount(nextCashAccountId, detail?.defaultWealthAccountId));
      setOpen(true);
    }
    window.addEventListener("mmh:wealth:create", onCreate as EventListener);
    return () => window.removeEventListener("mmh:wealth:create", onCreate as EventListener);
  }, [mode, resolveWealthAccountForCashAccount, today]);

  function changeTradeDate(nextDate: string) {
    setDate(nextDate);
    if (mode === "create" && isHoldingAction && !arrivalDateTouchedRef.current) {
      setArrivalDate(nextDate);
    }
  }

  function changeArrivalDate(nextDate: string) {
    arrivalDateTouchedRef.current = true;
    setArrivalDate(nextDate);
  }

  function resetAfterKeepAdding() {
    setAmount("");
    setUnits("");
    setNav("");
    unitsEditedRef.current = false;
    autoFilledUnitsForRef.current = null;
    setInterestAmount("");
    setArrivalAmount("");
    setInterestEdited(false);
    setArrivalEdited(false);
    setMemo("");
    if (isHoldingAction) {
      setSelectedHoldingId("");
    }
  }

  useEffect(() => {
    if (!open || mode !== "create" || !cashAccountId || subtype !== "buy") return;
    const nextWealthAccountId = resolveWealthAccountForCashAccount(cashAccountId, toAccountId);
    if (nextWealthAccountId !== toAccountId) setToAccountId(nextWealthAccountId);
  }, [cashAccountId, mode, open, resolveWealthAccountForCashAccount, subtype, toAccountId]);

  const amountNumber = parseNumber(amount);
  const unitsNumber = parseNumber(units);
  const navNumber = parseNumber(nav);
  const interestNumber = parseSignedNumber(interestAmount);
  const redeemPrincipalNumber = isRedeem && unitsNumber > 0 && navNumber > 0
    ? Number((unitsNumber * navNumber).toFixed(2))
    : amountNumber;
  const arrivalPreview = useMemo(() => {
    if (!isRedeem || redeemPrincipalNumber <= 0) return amountNumber;
    return Number(Math.max(0, redeemPrincipalNumber + interestNumber).toFixed(2));
  }, [amountNumber, interestNumber, isRedeem, redeemPrincipalNumber]);

  useEffect(() => {
    if (!isHoldingAction) {
      setSelectedHoldingId("");
      autoFilledUnitsForRef.current = null;
      return;
    }
    if (!selectedHoldingId && filteredHoldingOptions.length > 0 && !editEntryId) {
      setSelectedHoldingId(filteredHoldingOptions[0].id);
      return;
    }
    if (selectedHoldingId && !filteredHoldingOptions.some((holding) => holding.id === selectedHoldingId)) {
      autoFilledUnitsForRef.current = null;
      setSelectedHoldingId("");
    }
  }, [editEntryId, filteredHoldingOptions, isHoldingAction, selectedHoldingId]);

  useEffect(() => {
    if (!isHoldingAction || !selectedHolding) return;
    setWealthProductId(selectedHolding.wealthProductId ?? "");
    setFundName(selectedHolding.fundName);
    if (isRedeem && !editEntryId) {
      setAmount(selectedHoldingAmountAtDate > 0 ? selectedHoldingAmountAtDate.toFixed(2) : "");
      const autoFillKey = `${selectedHoldingId}:${holdingFilterDate}`;
      if (!unitsEditedRef.current && autoFilledUnitsForRef.current !== autoFillKey) {
        setUnits(selectedHolding.hasUnits && selectedHoldingUnitsAtDate > 0 ? selectedHoldingUnitsAtDate.toFixed(6) : "");
        autoFilledUnitsForRef.current = autoFillKey;
      }
    }
    setAnnualRate(
      selectedHolding.annualRate != null && Number.isFinite(selectedHolding.annualRate)
        ? String(selectedHolding.annualRate)
        : "",
    );
    setTermDays(
      selectedHolding.termDays != null && Number.isFinite(selectedHolding.termDays) && selectedHolding.termDays > 0
        ? String(selectedHolding.termDays)
        : "",
    );
    if (selectedHolding.wealthAccountId && selectedHolding.wealthAccountId !== toAccountId) {
      setToAccountId(selectedHolding.wealthAccountId);
    }
    if (!editEntryId) {
      setInterestEdited(false);
      setArrivalEdited(false);
    }
  }, [editEntryId, holdingFilterDate, isHoldingAction, isRedeem, selectedHolding, selectedHoldingAmountAtDate, selectedHoldingId, selectedHoldingUnitsAtDate, toAccountId]);

  useEffect(() => {
    if (!isRedeem || arrivalEdited) return;
    setArrivalAmount(arrivalPreview > 0 ? arrivalPreview.toFixed(2) : "");
  }, [arrivalEdited, arrivalPreview, isRedeem]);

  useEffect(() => {
    if (!isRedeem || !arrivalEdited || interestEdited) return;
    const arrivalValue = parseNumber(arrivalAmount);
    if (arrivalValue <= 0 || redeemPrincipalNumber <= 0) return;
    const nextInterest = Number((arrivalValue - redeemPrincipalNumber).toFixed(2));
    setInterestAmount(nextInterest !== 0 ? nextInterest.toFixed(2) : "");
  }, [arrivalAmount, arrivalEdited, interestEdited, isRedeem, redeemPrincipalNumber]);

  useEffect(() => {
    if (!isHoldingAction) return;
    if (cashAccountId && redeemCashOptions.some((account) => account.id === cashAccountId)) return;
    setCashAccountId(redeemCashOptions[0]?.id ?? "");
  }, [cashAccountId, isHoldingAction, redeemCashOptions]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const institutionId = productInstitutionId ?? "";
    const url = institutionId
      ? `/api/v1/wealth-products?institutionId=${encodeURIComponent(institutionId)}`
      : "/api/v1/wealth-products";
    void fetch(url, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data?.ok) return;
        const products = (data.products ?? []) as WealthProductOption[];
        if (wealthProductId && institutionId && !products.some((product) => product.id === wealthProductId)) {
          setWealthProductId("");
          setFundName("");
        }
        setWealthProducts((prev) => {
          const selectedLocalProducts = prev.filter((product) =>
            (!institutionId || product.institutionId === institutionId) && (
              product.id === wealthProductId ||
              (!!fundName && (product.name === fundName || product.shortName === fundName))
            ),
          );
          return mergeWealthProducts(products, selectedLocalProducts);
        });
        if (!wealthProductId && fundName) {
          const matched = products.find((product) => product.name === fundName || product.shortName === fundName);
          if (matched) setWealthProductId(matched.id);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fundName, open, productInstitutionId, wealthProductId]);

  function openWealthProductModal() {
    setProductDraft({
      name: fundName.trim(),
      shortName: "",
      annualRate,
      termDays,
      note: "",
    });
    setProductError(selectedCashAccount ? "" : "请先选择资金来源账户");
    setProductModalOpen(true);
  }

  function openWealthAccountModal() {
    if (!selectedCashAccount) {
      window.alert("请先选择资金来源账户");
      return;
    }
    if (!selectedCashAccount.groupId || !selectedCashAccount.institutionId) {
      window.alert("资金来源账户缺少所有人或机构，无法直接新增同机构理财账户");
      return;
    }
    setNestedEntityType("wealth-account");
  }

  function productAccountHint() {
    if (selectedWealthAccount) return `将归属到已选理财账户：${selectedWealthAccount.label}`;
    if (selectedCashAccount) return `未选择理财账户，保存产品时会自动复用或新增 ${selectedCashAccount.label} 同所有人、同机构的理财账户，并自动选中。`;
    return "请先选择资金来源账户，才能新增理财产品。";
  }

  async function saveWealthProduct() {
    const name = productDraft.name.trim();
    setProductError("");
    if (!selectedCashAccount) {
      setProductError("请先选择资金来源账户");
      return;
    }
    if (!name) {
      setProductError("请输入产品名称");
      return;
    }
    setProductSaving(true);
    try {
      const res = await fetch("/api/v1/wealth-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          shortName: productDraft.shortName.trim() || undefined,
          cashAccountId: selectedCashAccount.id,
          wealthAccountId: selectedWealthAccount?.id ?? undefined,
          currency: selectedWealthAccount?.currency ?? selectedCashAccount.currency ?? "CNY",
          annualRate: productDraft.annualRate || undefined,
          termDays: productDraft.termDays || undefined,
          note: productDraft.note.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok || !data.product || !data.wealthAccount) {
        throw new Error(data?.error ?? "创建理财产品失败");
      }
      const product = data.product as WealthProductOption;
      const account = data.wealthAccount as {
        id: string;
        name: string;
        kind: string;
        investProductType?: string | null;
        groupId?: string | null;
        groupName?: string | null;
        institutionId?: string | null;
        institutionName?: string | null;
        institutionShortName?: string | null;
        institutionType?: string | null;
        currency?: string | null;
      };
      const institutionLabel = account.institutionShortName?.trim() || account.institutionName?.trim() || "";
      const accountLabel = [institutionLabel, account.name].filter(Boolean).join("·");
      const accountOption: AccountOption = {
        id: account.id,
        label: accountLabel || account.name,
        subLabel: [account.groupName, "理财账户"].filter(Boolean).join(" · "),
        kind: account.kind,
        groupId: account.groupId ?? null,
        investProductType: account.investProductType ?? "wealth",
        institutionId: account.institutionId ?? null,
        institutionType: account.institutionType ?? null,
        currency: account.currency ?? "CNY",
      };
      setInvestmentAccountList((prev) => [
        ...prev.filter((item) => item.id !== account.id),
        accountOption,
      ]);
      setLocalInvestSSOpts((prev) => prev
        ? [
            ...prev.filter((item) => item.id !== account.id),
            { ...accountOption, kind: accountOption.kind ?? null },
          ]
        : prev);
      setToAccountId(account.id);
      setWealthProducts((prev) => prev.some((item) => item.id === product.id) ? prev : [...prev, product]);
      setWealthProductId(product.id);
      setFundName(product.name);
      if (product.annualRate != null) setAnnualRate(String(product.annualRate));
      if (product.termDays != null) setTermDays(String(product.termDays));
      setProductModalOpen(false);
    } catch (err) {
      setProductError(err instanceof Error ? err.message : "创建理财产品失败");
    } finally {
      setProductSaving(false);
    }
  }

  async function saveWealthTransaction(keepAdding: boolean) {
    if (submitting) return;
    const amt = isRedeem ? redeemPrincipalNumber : parseNumber(amount);
    if (amt <= 0) { window.alert("请输入金额"); return; }
    const selectedProduct = wealthProducts.find((product) => product.id === wealthProductId);
    const resolvedFundName = selectedHolding?.fundName || selectedProduct?.name || fundName.trim();
    if (!resolvedFundName) { window.alert("请选择或新增产品名称"); return; }
    if (!cashAccountId) { window.alert(isHoldingAction ? "请选择到账账户" : "请选择资金来源账户"); return; }
    if (toAccountId && !wealthAccountIds.has(toAccountId)) { window.alert("请选择理财账户"); return; }
    if (!isHoldingAction && toAccountId && !selectableWealthAccountIds.has(toAccountId)) {
      window.alert("理财账户只能选择资金来源同机构或第三方支付机构的账户");
      return;
    }
    if (isHoldingAction && !toAccountId) { window.alert("请选择理财账户"); return; }
    if (isHoldingAction && !selectedHoldingId) { window.alert("请选择持仓理财产品"); return; }
    if (isHoldingAction && !cashAccountId) { window.alert("请选择到账账户"); return; }
    const unitsValue = parseNumber(units);
    if (!isHoldingAction && selectedBuyProductRequiresUnits && unitsValue <= 0) {
      window.alert("该理财产品已有份额记录，继续买入时必须填写份额");
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("type", "investment");
      fd.set("subtype", subtype);
      fd.set("productType", "wealth");
      fd.set("date", date);
      fd.set("amount", String(amt));
      fd.set("fundName", resolvedFundName);
      const resolvedWealthProductId = selectedHolding?.wealthProductId || wealthProductId;
      if (resolvedWealthProductId) fd.set("wealthProductId", resolvedWealthProductId);
      fd.set("note", memo);
      fd.set("memo", memo);
      if (toAccountId) {
        fd.set("accountId", toAccountId);
        fd.set("toAccountId", toAccountId);
      }
      fd.set("cashAccountId", cashAccountId);
      if (isHoldingAction) fd.set("fundArrivalDate", arrivalDate || date);
      if (unitsValue > 0) fd.set("fundUnits", String(unitsValue));
      const navValue = parseNumber(nav);
      if (isRedeem && navValue > 0) fd.set("fundNav", String(navValue));
      const rateValue = parseNumber(annualRate);
      if (rateValue > 0) fd.set("depositAnnualRate", String(rateValue));
      if (isRedeem) {
        const arrivalValue = parseNumber(arrivalAmount);
        if (arrivalValue <= 0) throw new Error("到账金额不正确");
        fd.set("fundArrivalAmount", String(arrivalValue));
        if (interestAmount.trim()) fd.set("depositInterest", String(interestNumber));
      }
      const cashEntryIdForEdit = entry?.cashEntryId ?? entry?.id ?? editEntryId;
      const businessTransactionIdForEdit = entry?.businessTransactionId ?? editBusinessTransactionId;
      if (mode === "edit" && cashEntryIdForEdit) {
        fd.set("entryId", cashEntryIdForEdit);
        if (businessTransactionIdForEdit) fd.set("businessTransactionId", businessTransactionIdForEdit);
        fd.set("fundProductType", "wealth");
        const res = editAction ? await editAction(fd) : { ok: false as const, error: "缺少 editAction" };
        if (!res.ok) throw new Error(res.error ?? "保存失败");
        window.dispatchEvent(new CustomEvent("mmh:wealth:edit:success", { detail: { requestId } }));
      } else {
        fd.set("fundProductType", "wealth");
        const res = await createAction(fd);
        if (!res.ok) throw new Error(res.error ?? "记账失败");
      }
      if (keepAdding && mode === "create") {
        resetAfterKeepAdding();
      } else {
        setOpen(false);
        if (mode === "create") reset();
      }
      requestAnimationFrame(() => {
        dispatchFinanceDataChanged({ reason: "wealth-save" });
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await saveWealthTransaction(false);
  }
  useCloseOnNavigation(open, () => {
    setOpen(false);
    if (mode === "create") reset();
  });
  if (!open) return null;

  return createPortal(
    <>
      <div className="app-modal-backdrop z-[1000]">
        <div className="app-modal-panel max-w-md">
          <div className="modal-header">
            <div className="text-sm font-semibold text-slate-800">
              {mode === "edit" ? "编辑理财记录" : "新增理财记录"}
              <span className="ml-2 text-xs font-normal text-slate-500">银行理财</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                if (mode === "create") reset();
              }}
              className="secondary-button h-8 px-2"
            >
              关闭
            </button>
          </div>

          <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-4">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSubtype("buy");
                    setSelectedHoldingId("");
                    setUnits("");
                    setNav("");
                    unitsEditedRef.current = false;
                    autoFilledUnitsForRef.current = null;
                    setInterestAmount("");
                    setArrivalAmount("");
                    setInterestEdited(false);
                    setArrivalEdited(false);
                  }}
                  className={`segment-button h-8 flex-1 text-xs ${subtype === "buy" ? "segment-button-active font-medium" : ""}`}
                >
                  买入
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSubtype("redeem");
                    setAmount("");
                    setUnits("");
                    setNav("");
                    unitsEditedRef.current = false;
                    autoFilledUnitsForRef.current = null;
                    if (!arrivalDateTouchedRef.current) setArrivalDate(date);
                    setInterestEdited(false);
                    setArrivalEdited(false);
                  }}
                  className={`segment-button h-8 flex-1 text-xs ${subtype === "redeem" ? "segment-button-active font-medium" : ""}`}
                >
                  赎回
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSubtype("dividend_cash");
                    setAmount("");
                    setUnits("");
                    setNav("");
                    unitsEditedRef.current = false;
                    autoFilledUnitsForRef.current = null;
                    setInterestAmount("");
                    setArrivalAmount("");
                    if (!arrivalDateTouchedRef.current) setArrivalDate(date);
                    setInterestEdited(false);
                    setArrivalEdited(false);
                  }}
                  className={`segment-button h-8 flex-1 text-xs ${subtype === "dividend_cash" ? "segment-button-active font-medium" : ""}`}
                >
                  分红
                </button>
              </div>

              {isHoldingAction ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">日期</div>
                      <DateStepper value={date} onChange={changeTradeDate} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">理财账户</div>
                      <SmartSelect
                        mode="single"
                        value={toAccountId}
                        onChange={setToAccountId}
                        options={sortOptionsByRecent(wealthSelectOptions, recentAccountIds)}
                        placeholder="选择理财账户"
                        onCycleOwnerFilter={cycleWealthOwner}
                        ownerFilterLabel={wealthOwnerLabel}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{isDividend ? "分红理财产品" : "持仓理财产品"}</div>
                    <SmartSelect
                      mode="single"
                      value={selectedHoldingId}
                      onChange={(id) => {
                        unitsEditedRef.current = false;
                        autoFilledUnitsForRef.current = null;
                        setSelectedHoldingId(id);
                      }}
                      options={holdingSelectOptions}
                      placeholder={holdingSelectOptions.length > 0 ? (isDividend ? "选择分红的持仓产品" : "选择可赎回的理财产品") : "暂无可用持仓"}
                      searchable
                    />
                    <div className="text-[11px] text-slate-400">
                      {selectedHolding
                        ? [
                            `当日本金 ${selectedHoldingAmountAtDate.toFixed(2)}`,
                            selectedHolding.hasUnits ? `当日份额 ${selectedHoldingUnitsAtDate.toFixed(6)}` : "",
                            selectedHolding.wealthAccountLabel ?? "",
                          ].filter(Boolean).join(" · ")
                        : "先选择理财账户，再选择该账户下的持仓产品"}
                    </div>
                  </div>
                  {isRedeem ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <div className="form-label">赎回本金</div>
                        <CalcInput
                          value={amount}
                          onChange={setAmount}
                          placeholder="0.00"
                          label="赎回本金"
                          precision={2}
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">赎回份额</div>
                        <CalcInput
                          value={units}
                          onChange={(value) => {
                            unitsEditedRef.current = true;
                            setUnits(value);
                          }}
                          placeholder="可选"
                          label="赎回份额"
                          precision={6}
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">净值</div>
                        <CalcInput
                          value={nav}
                          onChange={setNav}
                          placeholder="可选"
                          label="净值"
                          precision={6}
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">年化收益率（%）</div>
                        <CalcInput
                          value={annualRate}
                          onChange={setAnnualRate}
                          placeholder="如：3.5"
                          label="年化收益率"
                          precision={4}
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">利息</div>
                        <CalcInput
                          value={interestAmount}
                          onChange={(value) => {
                            setInterestEdited(true);
                            setInterestAmount(value);
                          }}
                          placeholder="0.00"
                          label="利息"
                          precision={2}
                        />
                      </div>
                    </div>
                  ) : null}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <div className="form-label">到账账户</div>
                      <SmartSelect
                        mode="single"
                        value={cashAccountId}
                        onChange={setCashAccountId}
                        options={sortOptionsByRecent(redeemCashOptions, recentAccountIds)}
                        placeholder={
                          redeemCashOptions.length > 0
                            ? isRedeem ? "选择借记卡或同机构电子钱包" : "选择同机构借记卡"
                            : isRedeem ? "暂无借记卡或同机构电子钱包" : "该机构暂无借记卡"
                        }
                        onCreateClick={() => setNestedEntityType("cash-account")}
                        createLabel="新增账户"
                        onCycleOwnerFilter={cfCycle}
                        ownerFilterLabel={cfLabel}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">到账日期</div>
                      <DateStepper value={arrivalDate} onChange={changeArrivalDate} />
                    </div>
                    <div className="space-y-1 sm:col-span-2">
                      <div className="form-label">{isDividend ? "分红金额" : "到账金额"}</div>
                      <CalcInput
                        value={isDividend ? amount : arrivalAmount}
                        onChange={(value) => {
                          if (isDividend) {
                            setAmount(value);
                          } else {
                            setArrivalEdited(true);
                            setArrivalAmount(value);
                          }
                        }}
                        placeholder="0.00"
                        label={isDividend ? "分红金额" : "到账金额"}
                        precision={2}
                      />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">日期</div>
                      <DateStepper value={date} onChange={changeTradeDate} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">买入金额</div>
                      <CalcInput
                        value={amount}
                        onChange={setAmount}
                        placeholder="0.00"
                        label="买入"
                        precision={2}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">份额{selectedBuyProductRequiresUnits ? "（必填）" : ""}</div>
                      <CalcInput
                        value={units}
                        onChange={(value) => {
                          unitsEditedRef.current = true;
                          setUnits(value);
                        }}
                        placeholder={selectedBuyProductRequiresUnits ? "必填" : "可选"}
                        label="份额"
                        precision={6}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">均价</div>
                      <div className="form-input flex items-center justify-end text-xs tabular-nums text-slate-500">
                        {parseNumber(units) > 0 && parseNumber(amount) > 0
                          ? (parseNumber(amount) / parseNumber(units)).toFixed(4)
                          : "-"}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">资金来源账户</div>
                      <SmartSelect
                        mode="single"
                        value={cashAccountId}
                        onChange={setCashAccountId}
                        options={sortOptionsByRecent(cashSelectOptions, recentAccountIds)}
                        placeholder="选择账户"
                        onCreateClick={() => setNestedEntityType("cash-account")}
                        createLabel="新增账户"
                        onCycleOwnerFilter={cfCycle}
                        ownerFilterLabel={cfLabel}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">理财账户</div>
                      <SmartSelect
                        mode="single"
                        value={toAccountId}
                        onChange={setToAccountId}
                        options={sortOptionsByRecent(wealthSelectOptions, recentAccountIds)}
                        placeholder={wealthSelectOptions.length > 0 ? "选择同机构或第三方支付账户" : "新增产品后自动建立"}
                        onCreateClick={openWealthAccountModal}
                        createLabel="新增理财账户"
                        onCycleOwnerFilter={cycleWealthOwner}
                        ownerFilterLabel={wealthOwnerLabel}
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="form-label">产品名称</div>
                    <SmartSelect
                      mode="single"
                      value={wealthProductId}
                      onChange={(id) => {
                        setWealthProductId(id);
                        const product = wealthProducts.find((item) => item.id === id);
                        setFundName(product?.name ?? "");
                        if (product?.annualRate != null) setAnnualRate(String(product.annualRate));
                        if (product?.termDays != null) setTermDays(String(product.termDays));
                      }}
                      options={wealthProductOptions}
                      placeholder={wealthProductOptions.length > 0 ? "选择理财产品" : "暂无产品，点击 + 新增"}
                      searchable
                      onCreateClick={openWealthProductModal}
                      createLabel="新增理财产品"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">年化收益率（%）</div>
                      <input
                        inputMode="decimal"
                        value={annualRate}
                        onChange={(e) => setAnnualRate(e.target.value)}
                        placeholder="如：3.5"
                        className="form-input"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">期限天数</div>
                      <select
                        value={termDays}
                        onChange={(e) => setTermDays(e.target.value)}
                        className="form-input"
                      >
                        <option value="">请选择常见期限</option>
                        {TERM_PRESETS.map((preset) => (
                          <option key={preset.days} value={String(preset.days)}>
                            {preset.label}
                          </option>
                        ))}
                        {termDays && !TERM_PRESETS.some((preset) => String(preset.days) === termDays) ? (
                          <option value={termDays}>{termDays}天</option>
                        ) : null}
                      </select>
                    </div>
                  </div>
                </>
              )}

              <div className="space-y-1">
                <div className="form-label">备注</div>
                <input
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="可选"
                  className="form-input"
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                {mode === "create" ? (
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => { void saveWealthTransaction(true); }}
                    className="secondary-button h-9 px-4 text-sm disabled:opacity-50"
                  >
                    {submitting ? "保存中…" : "保存并再记一笔"}
                  </button>
                ) : null}
                <button
                  type="submit"
                  disabled={submitting}
                  className={`h-9 rounded-[10px] px-4 text-sm text-white disabled:opacity-50 ${isRedeem ? "bg-orange-600 hover:bg-orange-700" : isDividend ? "bg-emerald-600 hover:bg-emerald-700" : "primary-button"}`}
                >
                  {submitting ? "保存中…" : mode === "edit" ? "保存修改" : isRedeem ? "记账（赎回）" : isDividend ? "记账（分红）" : "记账（买入）"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
      {nestedEntityType ? (
        <NestedAddModal
          mode="compact"
          entityType="account"
          open={true}
          onClose={() => setNestedEntityType(null)}
          onCreated={(id, name, extra) => {
            const kind = extra?.kind || "bank_debit";
            const institutionLabel = extra?.institutionShortName?.trim() || extra?.institutionName?.trim() || "";
            const label = [institutionLabel, name].filter(Boolean).join("·") || name;
            const option = {
              id,
              label,
              subLabel: [
                extra?.groupName,
                nestedEntityType === "wealth-account" ? "理财账户" : kindLabel(kind),
              ].filter(Boolean).join(" · "),
              parentId: extra?.groupId ? `group:${extra.groupId}` : undefined,
              kind,
              groupId: extra?.groupId ?? null,
              institutionId: extra?.institutionId ?? null,
              institutionType: nestedFieldData?.institutionId?.find((item) => item.id === extra?.institutionId)?.type ?? null,
              currency: extra?.currency ?? "CNY",
              investProductType: nestedEntityType === "wealth-account" ? "wealth" : null,
            };
            if (nestedEntityType === "wealth-account") {
              setInvestmentAccountList((prev) => [
                ...prev.filter((item) => item.id !== id),
                option,
              ]);
              setLocalInvestSSOpts((prev) => (prev ? [...prev.filter((item) => item.id !== id), option] : [option]));
              setToAccountId(id);
            } else {
              setCashAccountList((prev) => [...prev.filter((item) => item.id !== id), option]);
              setLocalCashSSOpts((prev) => (prev ? [...prev.filter((item) => item.id !== id), option] : [option]));
              setCashAccountId(id);
            }
            setNestedEntityType(null);
          }}
          title={nestedEntityType === "wealth-account" ? "新增理财账户" : undefined}
          nameLabel={nestedEntityType === "wealth-account" ? "理财账户名称" : undefined}
          namePlaceholder={nestedEntityType === "wealth-account" ? "例如：理财" : undefined}
          defaultType={nestedEntityType === "wealth-account" ? "investment" : "bank_debit"}
          extraFields={
            nestedEntityType === "wealth-account" && selectedCashAccount
              ? {
                  kind: "investment",
                  investProductType: "wealth",
                  ...(selectedCashAccount.groupId ? { groupId: selectedCashAccount.groupId } : {}),
                  ...(selectedCashAccount.institutionId ? { institutionId: selectedCashAccount.institutionId } : {}),
                  currency: selectedCashAccount.currency ?? "CNY",
                }
              : undefined
          }
          hiddenFields={nestedEntityType === "wealth-account" ? ["kind", "investProductType", "groupId", "institutionId", "currency"] : undefined}
          nestedFieldData={nestedFieldData}
        />
      ) : null}
      {productModalOpen ? (
        <div className="app-modal-backdrop z-[1010]">
          <div className="app-modal-panel max-w-[min(30rem,calc(100vw-1rem))]">
            <div className="modal-header">
              <div>
                <div className="text-sm font-semibold text-slate-800">新增理财产品</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {selectedWealthAccount?.label || selectedCashAccount?.label || "请选择资金来源账户"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setProductModalOpen(false)}
                className="secondary-button h-8 px-2"
              >
                关闭
              </button>
            </div>
            <div className="space-y-3 p-3 sm:p-4">
              <div className="space-y-1">
                <div className="form-label">产品名称</div>
                <input
                  value={productDraft.name}
                  onChange={(e) => setProductDraft((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="例如：招行朝朝宝"
                  className="form-input"
                  autoFocus
                />
              </div>
              <div className="rounded-[10px] border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-700">
                {productAccountHint()}
              </div>
              {productError ? (
                <div className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {productError}
                </div>
              ) : null}
              <div className="space-y-1">
                <div className="form-label">简称</div>
                <input
                  value={productDraft.shortName}
                  onChange={(e) => setProductDraft((prev) => ({ ...prev, shortName: e.target.value }))}
                  placeholder="可选，用于下拉显示"
                  className="form-input"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="form-label">年化收益率（%）</div>
                  <input
                    inputMode="decimal"
                    value={productDraft.annualRate}
                    onChange={(e) => setProductDraft((prev) => ({ ...prev, annualRate: e.target.value }))}
                    placeholder="如：3.5"
                    className="form-input"
                  />
                </div>
                <div className="space-y-1">
                  <div className="form-label">期限天数</div>
                  <input
                    inputMode="numeric"
                    value={productDraft.termDays}
                    onChange={(e) => setProductDraft((prev) => ({ ...prev, termDays: e.target.value }))}
                    placeholder="可选"
                    className="form-input"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <div className="form-label">备注</div>
                <input
                  value={productDraft.note}
                  onChange={(e) => setProductDraft((prev) => ({ ...prev, note: e.target.value }))}
                  placeholder="可选"
                  className="form-input"
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setProductModalOpen(false)}
                  className="secondary-button h-9 px-4 text-sm"
                  disabled={productSaving}
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => { void saveWealthProduct(); }}
                  disabled={productSaving}
                  className="primary-button h-9 px-4 text-sm disabled:opacity-50"
                >
                  {productSaving ? "保存中…" : "保存并选中"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>,
    document.body,
  );
}
