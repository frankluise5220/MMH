"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { parseNumber } from "@/lib/investment-config";
import { DateStepper } from "./DateStepper";
import { CalcInput } from "./CalcInput";
import { ClearableNoteField } from "./ClearableNoteField";
import { ModalLayerProvider, getNextModalLayerZIndex, useModalLayerZIndex } from "./ModalLayer";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { NestedAddModal } from "./EntityCreateForm";
import { kindLabel } from "@/lib/account-kinds";
import { recordRecentAccount, sortByAccountUsage, useAccountUsage } from "@/lib/client/recentAccounts";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";
import { APP_PREFS_EVENT, getSidebarHideInitialDataPreference } from "@/lib/client/appPreferences";
import { Repeat } from "lucide-react";
import { depositTermMaturityUtc } from "@/lib/deposit-term";
import { depositInterestDaysUtc } from "@/lib/deposit-maturity";
import {
  DEFAULT_DEPOSIT_TERM_DAYS,
  splitTermDays,
  TERM_UNIT_DAYS,
  type DepositTermUnit,
} from "@/lib/deposit-term";
import {
  clampDepositInterestPayoutInterval,
  encodeDepositInterestPayout,
  maxDepositInterestPayoutInterval,
  parseDepositInterestPayout,
  type DepositInterestPayoutUnit,
} from "@/lib/deposit-interest-payout";

type Entry = {
  id?: string;
  transactionId?: string;
  date: string;
  amount: number;
  note?: string | null;
  fundName?: string | null;
  fundProductType?: string | null;
  fundSubtype?: string | null;
  accountId?: string | null;
  toAccountId?: string | null;
  toAccountName?: string | null;
  fundNav?: number | null;
  depositAnnualRate?: number | null;
  depositInterest?: number | null;
  depositSourceEntryId?: string | null;
  depositMaturityAction?: string | null;
  depositInterestPayoutFrequency?: string | null;
  depositInterestCalcBasis?: string | null;
  fundArrivalDate?: string | null;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;
type AccountOption = {
  id: string;
  name?: string;
  kind?: string;
  currency?: string | null;
  institutionId?: string | null;
  label: string;
  icon?: string;
  subLabel?: string;
  investProductType?: string | null;
};
type RedeemLotOption = {
  id: string;
  label: string;
  subLabel?: string;
  fundName: string;
  startDate?: string | null;
  maturityDate?: string | null;
  remainingAmount: number;
  annualRate?: number | null;
  depositAccountId?: string;
  depositAccountLabel?: string;
  status?: "open" | "closed";
};
type EditingRedeemSource = {
  id: string;
  fundName: string;
  startDate?: string | null;
  maturityDate?: string | null;
  depositAccountId?: string;
  depositAccountLabel?: string;
  restoredRemainingAmount: number;
  annualRate?: number | null;
};

function compareRedeemLots(a: RedeemLotOption, b: RedeemLotOption) {
  const dateA = a.startDate ?? "9999-12-31";
  const dateB = b.startDate ?? "9999-12-31";
  if (dateA !== dateB) return dateA.localeCompare(dateB);
  const maturityA = a.maturityDate ?? "9999-12-31";
  const maturityB = b.maturityDate ?? "9999-12-31";
  if (maturityA !== maturityB) return maturityA.localeCompare(maturityB);
  return a.label.localeCompare(b.label, "zh-Hans-CN");
}

function appendFlatOption(list: AccountOption[], option: AccountOption) {
  if (list.some((item) => item.id === option.id)) return list;
  return [...list, option];
}

function appendSmartSelectOption(
  base: SmartSelectOption[] | undefined,
  option: SmartSelectOption,
  groupId?: string,
  groupName?: string,
) {
  const next = [...(base ?? [])];
  const headerId = groupId ? `group:${groupId}` : "";
  if (headerId && groupName?.trim() && !next.some((item) => item.id === headerId)) {
    next.push({ id: headerId, label: groupName.trim(), isHeader: true });
  }
  if (!next.some((item) => item.id === option.id)) {
    next.push({ ...option, parentId: headerId || undefined });
  }
  return next;
}

export function DepositFormModal({
  mode = "create",
  accountId: defaultAccountId,
  entry,
  openSignal,
  cashAccounts = [],
  investmentAccounts = [],
  cashAccountSSOptions,
  investmentAccountSSOptions,
  redeemLotOptions = [],
  allRedeemLotOptions,
  nestedFieldData,
  createAction,
  editAction,
}: {
  mode?: "create" | "edit";
  accountId: string;
  entry?: Entry;
  openSignal?: number;
  cashAccounts?: AccountOption[];
  investmentAccounts?: AccountOption[];
  cashAccountSSOptions?: SmartSelectOption[];
  investmentAccountSSOptions?: SmartSelectOption[];
  redeemLotOptions?: RedeemLotOption[];
  allRedeemLotOptions?: RedeemLotOption[];
  nestedFieldData?: NestedFieldData;
  createAction: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  editAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const { t } = useI18n();
  const parentModalZIndex = useModalLayerZIndex();
  const modalZIndex = getNextModalLayerZIndex(parentModalZIndex);

  const initIsRedeem = mode === "edit" && entry ? entry.amount > 0 : false;
  const initAmount = mode === "edit" && entry ? String(Math.abs(entry.amount)) : "";
  const initDate = mode === "edit" && entry?.date ? entry.date.slice(0, 10) : today;
  const initName = mode === "edit" && entry?.fundName ? entry.fundName : "";
  const initMemo = mode === "edit" && entry?.note ? entry.note : "";
  const initTermDays =
    mode === "edit" && entry?.date && entry?.fundArrivalDate
      ? String(
          Math.max(
            0,
            Math.round(
              (new Date(`${entry.fundArrivalDate.slice(0, 10)}T00:00:00.000Z`).getTime() -
                new Date(`${entry.date.slice(0, 10)}T00:00:00.000Z`).getTime()) / 86400000,
            ),
          ),
        )
      : mode === "edit"
        ? ""
        : DEFAULT_DEPOSIT_TERM_DAYS;

  const initCashAccountId =
    mode === "edit" && entry ? (initIsRedeem ? (entry.toAccountId ?? "") : (entry.accountId ?? "")) : "";
  const initDepositAccountId =
    mode === "edit" && entry
      ? (initIsRedeem ? (entry.accountId ?? defaultAccountId) : (entry.toAccountId ?? defaultAccountId))
      : defaultAccountId;

  const [open, setOpen] = useState(false);
  const [subtype, setSubtype] = useState<"buy" | "redeem">(initIsRedeem ? "redeem" : "buy");
  const [date, setDate] = useState(initDate);
  const [arrivalDate, setArrivalDate] = useState(initIsRedeem && entry?.fundArrivalDate ? entry.fundArrivalDate.slice(0, 10) : initDate);
  const arrivalDateTouchedRef = useRef(mode === "edit");
  const [amount, setAmount] = useState(initAmount);
  const [fundName, setFundName] = useState(initName);
  const [annualRate, setAnnualRate] = useState("");
  const [exchangeRate, setExchangeRate] = useState("");
  const [cashAmount, setCashAmount] = useState("");
  const [termUnit, setTermUnit] = useState<DepositTermUnit>(
    mode === "edit"
      ? (initTermDays ? splitTermDays(Number(initTermDays), entry?.date ?? null).unit : "year")
      : splitTermDays(DEFAULT_DEPOSIT_TERM_DAYS).unit,
  );
  const [termCount, setTermCount] = useState<string>(
    mode === "edit"
      ? (initTermDays ? String(splitTermDays(Number(initTermDays), entry?.date ?? null).count) : "")
      : String(splitTermDays(DEFAULT_DEPOSIT_TERM_DAYS).count),
  );
  const [interestAmount, setInterestAmount] = useState("");
  const [arrivalAmount, setArrivalAmount] = useState(mode === "edit" && entry && entry.amount > 0 ? String(Math.abs(entry.amount)) : "");
  const [interestEdited, setInterestEdited] = useState(false);
  const [arrivalEdited, setArrivalEdited] = useState(false);
  const [cashAccountId, setCashAccountId] = useState(initCashAccountId);
  const [depositAccountId, setDepositAccountId] = useState(initDepositAccountId);
  const [selectedRedeemLotId, setSelectedRedeemLotId] = useState("");
  const [memo, setMemo] = useState(initMemo);
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const [editingRedeemSource, setEditingRedeemSource] = useState<EditingRedeemSource | null>(null);
  const [lockedSubtype, setLockedSubtype] = useState<"buy" | "redeem" | null>(
    mode === "edit" && entry ? (initIsRedeem ? "redeem" : "buy") : null,
  );
  const [maturityAction, setMaturityAction] = useState<"redeem" | "renew_principal" | "renew_principal_interest">(
    mode === "edit" && entry?.depositMaturityAction === "renew_principal"
      ? "renew_principal"
      : mode === "edit" && entry?.depositMaturityAction === "renew_principal_interest"
        ? "renew_principal_interest"
        : "redeem",
  );
  const initPayout = parseDepositInterestPayout(
    mode === "edit" ? entry?.depositInterestPayoutFrequency : null,
  );
  const [interestPayoutUnit, setInterestPayoutUnit] = useState<"maturity" | DepositInterestPayoutUnit>(
    initPayout.kind === "periodic" ? initPayout.unit : "maturity",
  );
  const [interestPayoutInterval, setInterestPayoutInterval] = useState<string>(
    initPayout.kind === "periodic" ? String(initPayout.interval) : "1",
  );
  const [interestCalcBasis, setInterestCalcBasis] = useState<"daily" | "monthly">(
    mode === "edit" && entry?.depositInterestCalcBasis === "daily" ? "daily" : "monthly",
  );
  // 新手期（系统设置里「使用向导」未被隐藏）= 显示说明性提示文案；老用户界面保持干净。
  const [showGuideHints, setShowGuideHints] = useState(false);
  useEffect(() => {
    const sync = () => setShowGuideHints(!getSidebarHideInitialDataPreference());
    sync();
    window.addEventListener(APP_PREFS_EVENT, sync);
    return () => window.removeEventListener(APP_PREFS_EVENT, sync);
  }, []);

  const [cashAccountList, setCashAccountList] = useState(cashAccounts);
  const [depositAccountList, setDepositAccountList] = useState(() =>
    investmentAccounts.filter((option) => isDepositLikeOption(option)),
  );
  const [localCashSSOpts, setLocalCashSSOpts] = useState(cashAccountSSOptions);
  const [localDepositSSOpts, setLocalDepositSSOpts] = useState(investmentAccountSSOptions);
  const [nestedEntityType, setNestedEntityType] = useState<"cash-account" | "deposit-account" | null>(null);
  // Local copy of nested option data so newly created institutions/groups persist
  // across account-dialog instances within this modal.
  const [localNestedFieldData, setLocalNestedFieldData] = useState<NestedFieldData | undefined>(nestedFieldData);

  // Keep local nested option data in sync when the server-provided prop changes.
  useEffect(() => {
    if (nestedFieldData) setLocalNestedFieldData(nestedFieldData);
  }, [nestedFieldData]);

  const {
    ownerFilterLabel: cashOwnerFilterLabel,
    cycleOwnerFilter: cycleCashOwnerFilter,
    filteredOptions: cashFiltered,
  } = useAccountSSFilter(localCashSSOpts);
  const {
    ownerFilterLabel: depositOwnerFilterLabel,
    cycleOwnerFilter: cycleDepositOwnerFilter,
  } = useAccountSSFilter(localDepositSSOpts);

  useEffect(() => {
    setCashAccountList(cashAccounts);
  }, [cashAccounts]);
  useEffect(() => {
    setDepositAccountList(investmentAccounts.filter((option) => isDepositLikeOption(option)));
  }, [investmentAccounts]);
  useEffect(() => {
    setLocalCashSSOpts(cashAccountSSOptions);
  }, [cashAccountSSOptions]);
  useEffect(() => {
    setLocalDepositSSOpts(investmentAccountSSOptions);
  }, [investmentAccountSSOptions]);

  useEffect(() => {
    if (mode === "edit" && entry && openSignal) setOpen(true);
  }, [entry, mode, openSignal]);

  const redeemDepositOptions = useMemo(
    () => depositAccountList.filter((option) => isDepositLikeOption(option)),
    [depositAccountList],
  );
  const isRedeem = subtype === "redeem";
  const effectiveRedeemLotOptions = useMemo(() => {
    if (!editingRedeemSource || !isRedeem) return redeemLotOptions;
    const restored = {
      id: editingRedeemSource.id,
      label: editingRedeemSource.fundName,
      subLabel: [
        editingRedeemSource.depositAccountLabel,
        editingRedeemSource.maturityDate ? t("depositForm.lotSubLabel.maturity", { date: editingRedeemSource.maturityDate }) : "",
        t("depositForm.lotSubLabel.available", { amount: editingRedeemSource.restoredRemainingAmount.toFixed(2) }),
      ]
        .filter(Boolean)
        .join(" · "),
      fundName: editingRedeemSource.fundName,
      startDate: editingRedeemSource.startDate,
      maturityDate: editingRedeemSource.maturityDate,
      remainingAmount: editingRedeemSource.restoredRemainingAmount,
      annualRate: editingRedeemSource.annualRate ?? null,
      depositAccountId: editingRedeemSource.depositAccountId,
      depositAccountLabel: editingRedeemSource.depositAccountLabel,
    } satisfies RedeemLotOption;
    if (redeemLotOptions.some((lot) => lot.id === editingRedeemSource.id)) {
      return redeemLotOptions.map((lot) =>
        lot.id === editingRedeemSource.id
          ? { ...lot, ...restored }
          : lot,
      );
    }
    return [restored, ...redeemLotOptions];
  }, [editingRedeemSource, isRedeem, redeemLotOptions]);
  const filteredRedeemLotOptions = useMemo(
    () =>
      effectiveRedeemLotOptions.filter((lot) =>
        depositAccountId ? lot.depositAccountId === depositAccountId : true,
      ),
    [depositAccountId, effectiveRedeemLotOptions],
  );
  const sortedRedeemLotOptions = useMemo(
    () =>
      [...filteredRedeemLotOptions].sort(compareRedeemLots),
    [filteredRedeemLotOptions],
  );
  const redeemLotSelectOptions = useMemo<SmartSelectOption[]>(
    () =>
      sortedRedeemLotOptions.map((lot) => ({
        id: lot.id,
        label: lot.label,
        subLabel: lot.subLabel,
      })),
    [sortedRedeemLotOptions],
  );
  const selectedRedeemLot = useMemo(
    () => effectiveRedeemLotOptions.find((lot) => lot.id === selectedRedeemLotId) ?? null,
    [effectiveRedeemLotOptions, selectedRedeemLotId],
  );
  const currentContextAccount = useMemo(() => {
    const all = [...cashAccountList, ...depositAccountList];
    return all.find((option) => option.id === defaultAccountId) ?? null;
  }, [cashAccountList, defaultAccountId, depositAccountList]);
  const contextInstitutionId = currentContextAccount?.institutionId ?? null;
  const sameInstitutionDepositAccounts = useMemo(
    () =>
      contextInstitutionId
        ? depositAccountList.filter((option) => isDepositLikeOption(option) && option.institutionId === contextInstitutionId)
        : [],
    [contextInstitutionId, depositAccountList],
  );
  const sameInstitutionCashAccounts = useMemo(
    () =>
      contextInstitutionId
        ? cashAccountList.filter((option) => option.institutionId === contextInstitutionId)
        : [],
    [cashAccountList, contextInstitutionId],
  );
  const defaultDepositAccountForContext = useMemo(() => {
    if (isRedeem && selectedRedeemLot?.depositAccountId) return selectedRedeemLot.depositAccountId;
    if (isRedeem && currentContextAccount && isDepositLikeOption(currentContextAccount)) return currentContextAccount.id;
    return sameInstitutionDepositAccounts[0]?.id ?? (currentContextAccount && isDepositLikeOption(currentContextAccount) ? currentContextAccount.id : defaultAccountId);
  }, [currentContextAccount, defaultAccountId, isRedeem, sameInstitutionDepositAccounts, selectedRedeemLot]);
  const defaultCashAccountForContext = useMemo(() => {
    const bankDebit = sameInstitutionCashAccounts.find((option) => option.kind === "bank_debit");
    return bankDebit?.id ?? sameInstitutionCashAccounts[0]?.id ?? cashAccountList[0]?.id ?? "";
  }, [cashAccountList, sameInstitutionCashAccounts]);
  const selectedCashAccount = useMemo(
    () => cashAccountList.find((option) => option.id === cashAccountId) ?? null,
    [cashAccountId, cashAccountList],
  );
  const selectedDepositAccount = useMemo(
    () => depositAccountList.find((option) => option.id === depositAccountId) ?? null,
    [depositAccountId, depositAccountList],
  );
  const cashCurrency = (selectedCashAccount?.currency || "CNY").toUpperCase();
  const depositCurrency = (selectedDepositAccount?.currency || "CNY").toUpperCase();
  const showCurrencyConversion = !isRedeem && !!cashAccountId && !!depositAccountId && cashCurrency !== depositCurrency;
  const redeemInstitutionId = useMemo(
    () => depositAccountList.find((option) => option.id === depositAccountId)?.institutionId ?? null,
    [depositAccountId, depositAccountList],
  );
  const redeemCashOptions = useMemo(
    () =>
      cashAccountList.filter(
        (option) =>
          option.kind === "bank_debit" &&
          (!redeemInstitutionId || option.institutionId === redeemInstitutionId),
      ),
    [cashAccountList, redeemInstitutionId],
  );
  const redeemCashDefaultId = useMemo(
    () => redeemCashOptions[0]?.id ?? "",
    [redeemCashOptions],
  );
  const resolveDefaultRedeemDepositAccount = useCallback((explicitId?: string | null) => {
    if (explicitId && depositAccountList.some((option) => option.id === explicitId)) return explicitId;
    if (currentContextAccount && isDepositLikeOption(currentContextAccount)) return currentContextAccount.id;
    if (sameInstitutionDepositAccounts[0]?.id) return sameInstitutionDepositAccounts[0].id;
    const firstOpenLot = [...redeemLotOptions].sort(compareRedeemLots)[0];
    if (firstOpenLot?.depositAccountId) return firstOpenLot.depositAccountId;
    return depositAccountList[0]?.id ?? "";
  }, [currentContextAccount, depositAccountList, redeemLotOptions, sameInstitutionDepositAccounts]);

  const resolveDefaultRedeemLot = useCallback((depositId: string) => {
    return [...redeemLotOptions]
      .filter((lot) => (depositId ? lot.depositAccountId === depositId : true))
      .sort(compareRedeemLots)[0]?.id ?? "";
  }, [redeemLotOptions]);

  const resolveDefaultRedeemCashAccount = useCallback((depositId: string, explicitId?: string | null) => {
    const depositAccount = depositAccountList.find((option) => option.id === depositId);
    const institutionId = depositAccount?.institutionId ?? contextInstitutionId;
    const sameInstitutionDebitCards = cashAccountList.filter(
      (option) => option.kind === "bank_debit" && (!institutionId || option.institutionId === institutionId),
    );
    if (explicitId && sameInstitutionDebitCards.some((option) => option.id === explicitId)) return explicitId;
    if (
      currentContextAccount?.kind === "bank_debit" &&
      sameInstitutionDebitCards.some((option) => option.id === currentContextAccount.id)
    ) {
      return currentContextAccount.id;
    }
    return sameInstitutionDebitCards[0]?.id ?? "";
  }, [cashAccountList, contextInstitutionId, currentContextAccount, depositAccountList]);

  const resolveDefaultBuyDepositAccount = useCallback((explicitId?: string | null) => {
    if (explicitId && depositAccountList.some((option) => option.id === explicitId)) return explicitId;
    if (currentContextAccount && isDepositLikeOption(currentContextAccount)) return currentContextAccount.id;
    if (sameInstitutionDepositAccounts[0]?.id) return sameInstitutionDepositAccounts[0].id;
    return "";
  }, [currentContextAccount, depositAccountList, sameInstitutionDepositAccounts]);

  const resolveDefaultBuyCashAccount = useCallback((explicitId?: string | null) => {
    if (explicitId && cashAccountList.some((option) => option.id === explicitId)) return explicitId;
    if (currentContextAccount && !isDepositLikeOption(currentContextAccount)) return currentContextAccount.id;
    return defaultCashAccountForContext;
  }, [cashAccountList, currentContextAccount, defaultCashAccountForContext]);

  const applyBuyDefaults = useCallback((detail?: {
    defaultCashAccountId?: string;
    defaultDepositAccountId?: string;
  }) => {
    setSubtype("buy");
    setDepositAccountId(resolveDefaultBuyDepositAccount(detail?.defaultDepositAccountId));
    setCashAccountId(resolveDefaultBuyCashAccount(detail?.defaultCashAccountId));
    setSelectedRedeemLotId("");
    setTermUnit(splitTermDays(DEFAULT_DEPOSIT_TERM_DAYS).unit);
    setTermCount(String(splitTermDays(DEFAULT_DEPOSIT_TERM_DAYS).count));
    setInterestAmount("");
    setArrivalAmount("");
    setInterestEdited(false);
    setArrivalEdited(false);
  }, [resolveDefaultBuyCashAccount, resolveDefaultBuyDepositAccount]);

  const applyRedeemDefaults = useCallback((detail?: {
    defaultCashAccountId?: string;
    defaultDepositAccountId?: string;
    defaultRedeemLotId?: string;
  }) => {
    const nextDepositAccountId = resolveDefaultRedeemDepositAccount(detail?.defaultDepositAccountId);
    // explicit lot id wins (the lot-row "redeem" button goes this way); otherwise pick one by deposit account.
    const explicitLotId = detail?.defaultRedeemLotId;
    const requestedLot = explicitLotId ? redeemLotOptions.find((lot) => lot.id === explicitLotId) : undefined;
    const nextRedeemLotId = requestedLot
      ? requestedLot.id
      : resolveDefaultRedeemLot(nextDepositAccountId);
    // When a lot is explicitly given, trust its own deposit account to avoid a mismatch.
    const effectiveDepositAccountId = requestedLot?.depositAccountId || nextDepositAccountId;
    setSubtype("redeem");
    setArrivalDate(date || today);
    arrivalDateTouchedRef.current = false;
    setDepositAccountId(effectiveDepositAccountId);
    setCashAccountId(resolveDefaultRedeemCashAccount(effectiveDepositAccountId, detail?.defaultCashAccountId));
    setSelectedRedeemLotId(nextRedeemLotId);
    setInterestEdited(false);
    setArrivalEdited(false);
  }, [date, redeemLotOptions, resolveDefaultRedeemCashAccount, resolveDefaultRedeemDepositAccount, resolveDefaultRedeemLot, today]);

  const amountNumber = parseNumber(amount);
  const annualRateNumber = parseNumber(annualRate);
  // Term lives as unit + count; everything downstream still speaks in days
  // (maturity date roll, redeem interest preview, submitted fundArrivalDate).
  const termDays = useMemo(() => {
    const count = Math.trunc(parseNumber(termCount));
    if (!Number.isFinite(count) || count <= 0) return "";
    return String(count * TERM_UNIT_DAYS[termUnit]);
  }, [termCount, termUnit]);
  const termDaysNumber = useMemo(() => {
    const n = Number(termDays);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [termDays]);
  const isPeriodicInterestPayout = interestPayoutUnit !== "maturity";
  const maxInterestPayoutInterval = useMemo(() => {
    if (!isPeriodicInterestPayout) return 1;
    return Math.max(1, maxDepositInterestPayoutInterval(termDaysNumber || DEFAULT_DEPOSIT_TERM_DAYS, interestPayoutUnit));
  }, [interestPayoutUnit, isPeriodicInterestPayout, termDaysNumber]);
  const encodedInterestPayout = useMemo(() => {
    if (!isPeriodicInterestPayout) return "maturity";
    const interval = clampDepositInterestPayoutInterval(
      termDaysNumber || DEFAULT_DEPOSIT_TERM_DAYS,
      interestPayoutUnit,
      Math.trunc(parseNumber(interestPayoutInterval)) || 1,
    );
    return encodeDepositInterestPayout({ kind: "periodic", unit: interestPayoutUnit, interval });
  }, [interestPayoutInterval, interestPayoutUnit, isPeriodicInterestPayout, termDaysNumber]);

  // Keep interval within the deposit term whenever term or unit changes.
  useEffect(() => {
    if (!isPeriodicInterestPayout) return;
    const current = Math.trunc(parseNumber(interestPayoutInterval)) || 1;
    const clamped = clampDepositInterestPayoutInterval(
      termDaysNumber || DEFAULT_DEPOSIT_TERM_DAYS,
      interestPayoutUnit,
      current,
    );
    if (clamped !== current) setInterestPayoutInterval(String(clamped));
  }, [interestPayoutInterval, interestPayoutUnit, isPeriodicInterestPayout, termDaysNumber]);
  const hasStoredAnnualRate = !!(
    selectedRedeemLot &&
    selectedRedeemLot.annualRate != null &&
    Number.isFinite(selectedRedeemLot.annualRate) &&
    selectedRedeemLot.annualRate > 0
  );
  // Redeem interest preview must match what auto-redeem actually pays:
  // 存入日计息 day count over the lot's real span (365 non-leap year, 366
  // across Feb 29; legacy same-day spans keep the raw difference), not the
  // 365-per-year normalized picker value.
  const redeemInterestDays = useMemo(() => {
    if (!selectedRedeemLot?.startDate || !selectedRedeemLot?.maturityDate) return null;
    const start = new Date(`${selectedRedeemLot.startDate.slice(0, 10)}T00:00:00.000Z`);
    const end = new Date(`${selectedRedeemLot.maturityDate.slice(0, 10)}T00:00:00.000Z`);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
    return depositInterestDaysUtc(start, end);
  }, [selectedRedeemLot]);
  const interestPreview = useMemo(() => {
    if (amountNumber <= 0 || annualRateNumber <= 0) return 0;
    const days = redeemInterestDays ?? termDaysNumber;
    if (days <= 0) return 0;
    return Number(((amountNumber * (annualRateNumber / 100) * days) / 365).toFixed(2));
  }, [amountNumber, annualRateNumber, redeemInterestDays, termDaysNumber]);
  const arrivalPreview = useMemo(() => {
    if (!isRedeem) return amountNumber;
    const effectiveInterest = parseNumber(interestAmount) > 0 ? parseNumber(interestAmount) : interestPreview;
    return Number((amountNumber + effectiveInterest).toFixed(2));
  }, [amountNumber, interestAmount, interestPreview, isRedeem]);

  function reset() {
    setSubtype("buy");
    setDate(today);
    setArrivalDate(today);
    arrivalDateTouchedRef.current = false;
    setAmount("");
    setFundName("");
    setAnnualRate("");
    setExchangeRate("");
    setCashAmount("");
    setTermUnit(splitTermDays(DEFAULT_DEPOSIT_TERM_DAYS).unit);
    setTermCount(String(splitTermDays(DEFAULT_DEPOSIT_TERM_DAYS).count));
    setInterestAmount("");
    setArrivalAmount("");
    setInterestEdited(false);
    setArrivalEdited(false);
    setCashAccountId("");
    setDepositAccountId("");
    setSelectedRedeemLotId("");
    setMemo("");
    setRequestId(null);
    setEditEntryId(null);
    setEditingRedeemSource(null);
    setLockedSubtype(null);
    setMaturityAction("redeem");
    setInterestPayoutUnit("maturity");
    setInterestPayoutInterval("1");
    // 新建默认「月均计息」：取息周期为月时按 本金×年利率÷12×期数 固定金额。
    setInterestCalcBasis("monthly");
  }

  function applyRedeemComputedAmounts(forceInterest = false) {
    if (!isRedeem) return;
    const computedInterestValue = interestPreview > 0 ? interestPreview : 0;
    const computedInterestText = computedInterestValue > 0 ? computedInterestValue.toFixed(2) : "";
    const effectiveInterestValue =
      forceInterest || !interestEdited
        ? computedInterestValue
        : Math.max(0, parseNumber(interestAmount));
    const computedArrivalValue =
      isRedeem && amountNumber > 0 ? Number((amountNumber + effectiveInterestValue).toFixed(2)) : 0;
    const computedArrivalText = computedArrivalValue > 0 ? computedArrivalValue.toFixed(2) : "";

    if (forceInterest || !interestEdited) {
      setInterestAmount(computedInterestText);
      setInterestEdited(false);
    }
    if (forceInterest || !arrivalEdited || !interestEdited) {
      setArrivalAmount(computedArrivalText);
      setArrivalEdited(false);
    }
  }

  useEffect(() => {
    if (mode !== "edit") return;

    function onEdit(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId: string;
        entryId: string;
        type: string;
        date: string;
        amount: number;
        note: string;
        accountId?: string;
        cashAccountId?: string;
        toAccountId?: string;
        fundName?: string;
        fundNav?: number | null;
        depositAnnualRate?: number | null;
        depositInterest?: number | null;
        depositSourceEntryId?: string | null;
        depositMaturityAction?: string | null;
        depositInterestPayoutFrequency?: string | null;
        depositInterestCalcBasis?: string | null;
        fundSubtype?: string;
        fundArrivalDate?: string | null;
      }>).detail;
      if (!detail?.requestId || !detail.entryId) return;
      setRequestId(detail.requestId);
      setEditEntryId(detail.entryId);
      const isRedeem = detail.fundSubtype === "redeem";
      setSubtype(isRedeem ? "redeem" : "buy");
      setLockedSubtype(isRedeem ? "redeem" : "buy");
      setDate(detail.date || today);
      setArrivalDate(isRedeem ? (detail.fundArrivalDate?.slice(0, 10) || detail.date || today) : detail.date || today);
      arrivalDateTouchedRef.current = true;
      const detailInterestAmount =
        detail.depositInterest != null && Number.isFinite(detail.depositInterest)
          ? Number(detail.depositInterest)
          : 0;
      const redeemPrincipalAmount =
        isRedeem && detail.amount
          ? Math.max(0, Math.abs(detail.amount) - detailInterestAmount)
          : Math.abs(detail.amount ?? 0);
      setAmount(redeemPrincipalAmount > 0 ? String(redeemPrincipalAmount) : "");
      setFundName(detail.fundName ?? "");
      const detailAnnualRate = detail.depositAnnualRate ?? detail.fundNav ?? null;
      setAnnualRate(detailAnnualRate != null ? String(detailAnnualRate) : "");
      setMemo(detail.note ?? "");
      setArrivalAmount(detail.amount ? String(Math.abs(detail.amount)) : "");
      setInterestAmount(
        detail.depositInterest != null && Number.isFinite(detail.depositInterest)
          ? String(detail.depositInterest)
          : "",
      );
      setInterestEdited(
        detail.depositInterest != null && Number.isFinite(detail.depositInterest),
      );
      setArrivalEdited(mode === "edit");
      if (detail.date && detail.fundArrivalDate) {
        const diffDays = Math.max(
          0,
          Math.round(
            (new Date(`${detail.fundArrivalDate.slice(0, 10)}T00:00:00.000Z`).getTime() -
              new Date(`${detail.date.slice(0, 10)}T00:00:00.000Z`).getTime()) / 86400000,
          ),
        );
        const termSplit = splitTermDays(diffDays, detail.date);
        setTermUnit(termSplit.unit);
        setTermCount(diffDays > 0 ? String(termSplit.count) : "");
      } else {
        setTermCount("");
      }
      setCashAccountId(
        detail.cashAccountId ?? (isRedeem ? (detail.toAccountId ?? "") : (detail.accountId ?? "")),
      );
      setDepositAccountId(
        isRedeem
          ? (detail.accountId ?? defaultAccountId)
          : (detail.toAccountId ?? defaultAccountId),
      );
      if (isRedeem) {
        const restoredPrincipalAmount = redeemPrincipalAmount;
        const lotSearchPool = allRedeemLotOptions ?? redeemLotOptions;
        const matchedLot = lotSearchPool.find((lot) => {
          if (detail.depositSourceEntryId && lot.id === detail.depositSourceEntryId) return true;
          if (lot.fundName !== (detail.fundName ?? "")) return false;
          return true;
        });
        const restoredLotId = detail.depositSourceEntryId ?? matchedLot?.id ?? "";
        setEditingRedeemSource(
          restoredLotId
            ? {
                id: restoredLotId,
                fundName: detail.fundName ?? matchedLot?.fundName ?? t("depositForm.unnamedDeposit"),
                startDate: matchedLot?.startDate ?? null,
                maturityDate: matchedLot?.maturityDate ?? null,
                depositAccountId: detail.accountId ?? matchedLot?.depositAccountId ?? defaultAccountId,
                depositAccountLabel:
                  matchedLot?.depositAccountLabel ??
                  depositAccountList.find((account) => account.id === (detail.accountId ?? defaultAccountId))?.label ??
                  t("investment.product.deposit"),
                restoredRemainingAmount: Number(
                  ((matchedLot?.remainingAmount ?? 0) + restoredPrincipalAmount).toFixed(2),
                ),
                annualRate: detailAnnualRate ?? matchedLot?.annualRate ?? null,
              }
            : null,
        );
        setSelectedRedeemLotId(restoredLotId);
      } else {
        setEditingRedeemSource(null);
        setSelectedRedeemLotId("");
      }
      setMaturityAction(
        detail.depositMaturityAction === "renew_principal"
          ? "renew_principal"
          : detail.depositMaturityAction === "renew_principal_interest"
            ? "renew_principal_interest"
            : "redeem",
      );
      {
        const payout = parseDepositInterestPayout(detail.depositInterestPayoutFrequency);
        if (payout.kind === "periodic") {
          setInterestPayoutUnit(payout.unit);
          setInterestPayoutInterval(String(payout.interval));
        } else {
          setInterestPayoutUnit("maturity");
          setInterestPayoutInterval("1");
        }
        setInterestCalcBasis(detail.depositInterestCalcBasis === "daily" ? "daily" : "monthly");
      }
      setOpen(true);
    }
    window.addEventListener("mmh:deposit:edit", onEdit as EventListener);
    return () => window.removeEventListener("mmh:deposit:edit", onEdit as EventListener);
  }, [allRedeemLotOptions, defaultAccountId, depositAccountList, mode, redeemLotOptions, today]);

  useEffect(() => {
    if (mode !== "create") return;

    function onCreate(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId: string;
        defaultCashAccountId?: string;
        defaultDepositAccountId?: string;
        defaultSubtype?: "buy" | "redeem";
        defaultRedeemLotId?: string;
        defaultDate?: string;
        defaultAmount?: number;
      }>).detail;
      const nextSubtype = detail?.defaultSubtype === "redeem" ? "redeem" : "buy";
      setRequestId(detail?.requestId ?? null);
      reset();
      setSubtype(nextSubtype);
      setCashAccountId(detail?.defaultCashAccountId ?? "");
      setDate(detail?.defaultDate || today);
      setArrivalDate(detail?.defaultDate || today);
      arrivalDateTouchedRef.current = false;
      if (typeof detail?.defaultAmount === "number" && detail.defaultAmount > 0) setAmount(String(detail.defaultAmount));
      setLockedSubtype(null);
      if (nextSubtype === "redeem") {
        applyRedeemDefaults(detail);
      } else {
        applyBuyDefaults(detail);
      }
      setInterestAmount("");
      setArrivalAmount("");
      setInterestEdited(false);
      setArrivalEdited(false);
      setEditingRedeemSource(null);
      setOpen(true);
    }
    window.addEventListener("mmh:deposit:create", onCreate as EventListener);
    return () => window.removeEventListener("mmh:deposit:create", onCreate as EventListener);
  }, [applyBuyDefaults, applyRedeemDefaults, mode, today]);

  function changeDate(nextDate: string) {
    setDate(nextDate);
    if (mode === "create" && isRedeem && !arrivalDateTouchedRef.current) {
      setArrivalDate(nextDate);
    }
  }

  function changeArrivalDate(nextDate: string) {
    arrivalDateTouchedRef.current = true;
    setArrivalDate(nextDate);
  }

  useEffect(() => {
    if (!isRedeem) {
      setSelectedRedeemLotId("");
      return;
    }
    if (!selectedRedeemLotId && sortedRedeemLotOptions.length > 0 && !editEntryId) {
      setSelectedRedeemLotId(sortedRedeemLotOptions[0].id);
      return;
    }
    if (selectedRedeemLotId && !filteredRedeemLotOptions.some((lot) => lot.id === selectedRedeemLotId)) {
      setSelectedRedeemLotId("");
    }
  }, [editEntryId, filteredRedeemLotOptions, isRedeem, selectedRedeemLotId, sortedRedeemLotOptions]);

  useEffect(() => {
    if (!isRedeem || !selectedRedeemLot) return;
    setFundName(selectedRedeemLot.fundName);
    setInterestEdited(false);
    setArrivalEdited(false);
    setAnnualRate(
      selectedRedeemLot.annualRate != null && Number.isFinite(selectedRedeemLot.annualRate)
        ? String(selectedRedeemLot.annualRate)
        : "",
    );
    if (selectedRedeemLot.depositAccountId) {
      setDepositAccountId(selectedRedeemLot.depositAccountId);
    }
    setAmount(selectedRedeemLot.remainingAmount > 0 ? selectedRedeemLot.remainingAmount.toFixed(2) : "");
    if (selectedRedeemLot.depositAccountId) {
      const nextCashAccountId =
        cashAccountList.find((option) => {
          const depositAccount = depositAccountList.find((account) => account.id === selectedRedeemLot.depositAccountId);
          return (
            option.kind === "bank_debit" &&
            !!depositAccount?.institutionId &&
            option.institutionId === depositAccount.institutionId
          );
        })?.id ??
        cashAccountList.find((option) => option.kind === "bank_debit")?.id ??
        cashAccountList[0]?.id ??
        "";
      if (nextCashAccountId) setCashAccountId(nextCashAccountId);
    }
    if (selectedRedeemLot.startDate && selectedRedeemLot.maturityDate) {
      const start = new Date(`${selectedRedeemLot.startDate}T00:00:00.000Z`);
      const end = new Date(`${selectedRedeemLot.maturityDate}T00:00:00.000Z`);
      const diffDays = Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
      const termSplit = splitTermDays(diffDays, selectedRedeemLot.startDate);
      setTermUnit(termSplit.unit);
      setTermCount(diffDays > 0 ? String(termSplit.count) : "");
    } else {
      setTermCount("");
    }
  }, [cashAccountList, depositAccountList, isRedeem, mode, selectedRedeemLot]);

  useEffect(() => {
    if (!isRedeem || editEntryId) return;
    if (!depositAccountId || !depositAccountList.some((option) => option.id === depositAccountId)) {
      if (defaultDepositAccountForContext) setDepositAccountId(defaultDepositAccountForContext);
    }
  }, [defaultDepositAccountForContext, depositAccountId, depositAccountList, editEntryId, isRedeem]);

  useEffect(() => {
    if (isRedeem || editEntryId) return;
    if (depositAccountId) return;
    const nextDepositAccountId = resolveDefaultBuyDepositAccount();
    if (nextDepositAccountId) setDepositAccountId(nextDepositAccountId);
  }, [depositAccountId, editEntryId, isRedeem, resolveDefaultBuyDepositAccount]);

  useEffect(() => {
    if (!isRedeem || editEntryId) return;
    if (!cashAccountId || !cashAccountList.some((option) => option.id === cashAccountId)) {
      if (redeemCashDefaultId) setCashAccountId(redeemCashDefaultId);
      else if (defaultCashAccountForContext) setCashAccountId(defaultCashAccountForContext);
    }
  }, [cashAccountId, cashAccountList, defaultCashAccountForContext, editEntryId, isRedeem, redeemCashDefaultId]);

  useEffect(() => {
    if (!isRedeem) return;
    if (cashAccountId && !redeemCashOptions.some((option) => option.id === cashAccountId)) {
      setCashAccountId(redeemCashDefaultId);
    }
  }, [cashAccountId, isRedeem, redeemCashDefaultId, redeemCashOptions]);

  useEffect(() => {
    if (!isRedeem) return;
    if (selectedRedeemLot) {
      const nextAmount = selectedRedeemLot.remainingAmount > 0 ? selectedRedeemLot.remainingAmount.toFixed(2) : "";
      if (amount !== nextAmount) {
        setAmount(nextAmount);
      }
    }
  }, [amount, isRedeem, selectedRedeemLot]);

  useEffect(() => {
    if (!showCurrencyConversion) {
      setCashAmount("");
      return;
    }
    const depositAmount = parseNumber(amount);
    const rate = parseNumber(exchangeRate);
    if (depositAmount > 0 && rate > 0) {
      setCashAmount((depositAmount * rate).toFixed(2));
    }
  }, [amount, exchangeRate, showCurrencyConversion]);

  useEffect(() => {
    if (!isRedeem) return;
    if (interestEdited) return;
    setInterestAmount(interestPreview > 0 ? interestPreview.toFixed(2) : "");
  }, [interestEdited, interestPreview, isRedeem]);

  useEffect(() => {
    if (!isRedeem) return;
    if (arrivalEdited) return;
    setArrivalAmount(arrivalPreview > 0 ? arrivalPreview.toFixed(2) : "");
  }, [arrivalEdited, arrivalPreview, isRedeem]);

  function resetAfterKeepAdding() {
    setAmount("");
    setFundName("");
    setCashAmount("");
    setInterestAmount("");
    setArrivalAmount("");
    setInterestEdited(false);
    setArrivalEdited(false);
    setMemo("");
    if (isRedeem) {
      setSelectedRedeemLotId("");
    }
  }

  async function saveDepositTransaction(keepAdding: boolean) {
    if (submitting) return;
    const amt = parseNumber(amount);
    if (amt <= 0) {
      window.alert(t("wealthForm.alert.enterAmount"));
      return;
    }
    if (!fundName.trim()) {
      window.alert(t("wealthForm.alert.enterProductName"));
      return;
    }
    if (isRedeem && !selectedRedeemLotId) {
      window.alert(t("depositForm.alert.selectRedeemLot"));
      return;
    }
    if (!isRedeem && !cashAccountId) {
      window.alert(t("txForm.alert.selectCashSourceAccount"));
      return;
    }
    if (isRedeem && selectedRedeemLot) {
      const fullRedeemAmount = Number(selectedRedeemLot.remainingAmount.toFixed(2));
      if (Math.abs(amt - fullRedeemAmount) > 0.0001) {
        setAmount(fullRedeemAmount > 0 ? fullRedeemAmount.toFixed(2) : "");
      }
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("type", "investment");
      fd.set("subtype", lockedSubtype ?? subtype);
      fd.set("productType", "deposit");
      fd.set("date", date);
      const redeemAmount = isRedeem && selectedRedeemLot
        ? Number(selectedRedeemLot.remainingAmount.toFixed(2))
        : amt;
      const cashAmt = showCurrencyConversion ? parseNumber(cashAmount) : amt;
      if (showCurrencyConversion && cashAmt <= 0) {
        throw new Error(t("depositForm.alert.enterConvertedCashAmount"));
      }
      fd.set("amount", String(isRedeem ? redeemAmount : cashAmt));
      fd.set("fundName", fundName.trim());
      fd.set("note", memo);
      if (depositAccountId) fd.set("accountId", depositAccountId);
      fd.set("cashAccountId", cashAccountId);
      fd.set("fundProductType", "deposit");
      fd.set("source", "deposit");
      fd.set("depositPrincipalAmount", String(isRedeem ? redeemAmount : amt));
      if (showCurrencyConversion) {
        fd.set("currency", depositCurrency);
        const rateValue = parseNumber(exchangeRate);
        if (rateValue > 0) fd.set("exchangeRate", String(rateValue));
      }
      const rateValue = parseNumber(annualRate);
      if (rateValue > 0) {
        fd.set("depositAnnualRate", String(rateValue));
      }
      if (isRedeem) {
        const arrivalValue = parseNumber(arrivalAmount);
        if (arrivalValue <= 0) {
          throw new Error(t("wealthForm.alert.arrivalAmountInvalid"));
        }
        const interestValue = parseNumber(interestAmount);
        if (interestValue > 0) {
          fd.set("depositInterest", String(interestValue));
        }
        fd.set("fundArrivalAmount", String(arrivalValue));
        if (selectedRedeemLotId) {
          fd.set("depositSourceEntryId", selectedRedeemLotId);
        }
      }
      if (isRedeem) {
        fd.set("fundArrivalDate", arrivalDate || date);
      } else {
        fd.set("depositMaturityAction", maturityAction);
        fd.set("depositInterestPayoutFrequency", encodedInterestPayout);
        fd.set("depositInterestCalcBasis", isPeriodicInterestPayout ? interestCalcBasis : "daily");
        const termCountNumber = Math.trunc(parseNumber(termCount));
        if (Number.isFinite(termCountNumber) && termCountNumber > 0) {
          // 月/年周期按日历月/对年对日滚动（−1 天口径），不能用 30/365 天块近似。
          const maturityDate = new Date(`${date}T00:00:00.000Z`);
          const normalizedMaturityDate = depositTermMaturityUtc(maturityDate, termUnit, termCountNumber);
          fd.set("fundArrivalDate", normalizedMaturityDate.toISOString().slice(0, 10));
        } else {
          fd.set("fundArrivalDate", "");
        }
      }

      if (mode === "edit" && (entry?.id || editEntryId)) {
        fd.set("entryId", entry?.id || editEntryId || "");
        const res = editAction ? await editAction(fd) : { ok: false as const, error: t("wealthForm.alert.missingEditAction") };
        if (!res.ok) throw new Error(res.error ?? t("wealthForm.alert.saveFailed"));
        window.dispatchEvent(new CustomEvent("mmh:deposit:edit:success", { detail: { requestId } }));
      } else {
        const res = await createAction(fd);
        if (!res.ok) throw new Error(res.error ?? t("txForm.alert.saveFailed"));
      }

      if (keepAdding && mode === "create") {
        resetAfterKeepAdding();
      } else {
        setOpen(false);
        if (mode === "create") reset();
      }
      requestAnimationFrame(() => {
        dispatchFinanceDataChanged({ reason: "deposit-save" });
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t("wealthForm.alert.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await saveDepositTransaction(false);
  }

  const accountUsage = useAccountUsage();
  const cashFallbackSSOptions: SmartSelectOption[] = (localCashSSOpts ?? cashAccountList.map((option) => ({
    id: option.id,
    label: option.label,
    subLabel: option.subLabel,
    kind: option.kind,
    investProductType: option.investProductType,
    institutionId: option.institutionId,
    currency: option.currency,
  })));
  const visibleCashOptions = sortByAccountUsage(cashFiltered ?? cashFallbackSSOptions, accountUsage);

  useCloseOnNavigation(open, () => {
    setOpen(false);
    if (mode === "create") reset();
  });
  // Called when a nested institution/group is created inside an account dialog.
  // Keep the shared nested option data fresh so subsequent account dialogs can
  // select the newly created entity.
  function handleNestedOptionCreated(id: string, name: string, extra?: { kind?: string; type?: string }) {
    setLocalNestedFieldData((prev) => {
      const base = prev ?? nestedFieldData ?? {};
      if (extra?.type !== undefined) {
        const existing = base.institutionId ?? [];
        if (existing.some((item) => item.id === id)) return base;
        return { ...base, institutionId: [...existing, { id, name, type: extra.type }] };
      }
      const existing = base.groupId ?? [];
      if (existing.some((item) => item.id === id)) return base;
      return { ...base, groupId: [...existing, { id, name }] };
    });
  }

  if (!open) return null;
  const cashOwnerCycleButton = localCashSSOpts?.some((option) => option.isHeader) ? (
    <button
      type="button"
      onClick={cycleCashOwnerFilter}
      title={t("investForm.ownerFilter.title", { label: cashOwnerFilterLabel })}
      aria-label={t("investForm.ownerFilter.ariaLabel", { label: cashOwnerFilterLabel })}
      className="secondary-button !px-0 h-7 w-7 shrink-0 text-slate-500"
    >
      <Repeat className="h-3.5 w-3.5" />
    </button>
  ) : undefined;
  const depositOwnerCycleButton = localDepositSSOpts?.some((option) => option.isHeader) ? (
    <button
      type="button"
      onClick={cycleDepositOwnerFilter}
      title={t("investForm.ownerFilter.title", { label: depositOwnerFilterLabel })}
      aria-label={t("investForm.ownerFilter.ariaLabel", { label: depositOwnerFilterLabel })}
      className="secondary-button !px-0 h-7 w-7 shrink-0 text-slate-500"
    >
      <Repeat className="h-3.5 w-3.5" />
    </button>
  ) : undefined;

  return (
    <ModalLayerProvider value={modalZIndex}>
      {createPortal(
        <div className="app-modal-backdrop" style={{ zIndex: modalZIndex }}>
          <div className="app-modal-panel max-w-xl">
            <div className="modal-header">
              <div className="text-sm font-semibold text-slate-800">
                {mode === "edit" ? t("depositForm.title.edit") : t("depositForm.title.create")}
                <span className="ml-2 text-xs font-normal text-slate-500">{t("investment.product.deposit")}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (mode === "create") reset();
                }}
                className="secondary-button h-8 px-2"
              >
                {t("investForm.close")}
              </button>
            </div>

            <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-4">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (lockedSubtype) return;
                    applyBuyDefaults();
                  }}
                  disabled={!!lockedSubtype}
                  className={`segment-button h-8 flex-1 text-xs ${subtype === "buy" ? "segment-button-active font-medium" : ""} ${lockedSubtype ? "cursor-not-allowed opacity-60" : ""}`}
                >
                  {t("deposit.subtype.buy")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (lockedSubtype) return;
                    applyRedeemDefaults();
                  }}
                  disabled={!!lockedSubtype}
                  className={`segment-button h-8 flex-1 text-xs ${subtype === "redeem" ? "segment-button-active font-medium" : ""} ${lockedSubtype ? "cursor-not-allowed opacity-60" : ""}`}
                >
                  {t("deposit.subtype.redeem")}
                </button>
              </div>
              {lockedSubtype && showGuideHints ? (
                <div className="text-[11px] text-slate-400">
                  {t("depositForm.lockedSubtypeHint")}
                </div>
              ) : null}

              <div className={isRedeem ? "space-y-3" : "grid grid-cols-2 gap-3"}>
                <div className="space-y-1">
                  <div className="form-label">{t("detail.column.date")}</div>
                  <DateStepper value={date} onChange={changeDate} />
                </div>
                {isRedeem ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("depositForm.redeemAccount")}</div>
                      <SmartSelect
                        mode="single"
                        value={depositAccountId}
                        onChange={setDepositAccountId}
                        options={redeemDepositOptions}
                        placeholder={t("depositForm.selectDepositAccount")}
                        behavior={{ hierarchy: false, search: "auto", clearable: false, headerExtra: depositOwnerCycleButton }}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("wealthForm.arrivalAccount")}</div>
                      <SmartSelect
                        mode="single"
                        value={cashAccountId}
                        onChange={(id) => { setCashAccountId(id); recordRecentAccount(id); }}
                        options={redeemCashOptions}
                        placeholder={redeemCashOptions.length > 0 ? t("depositForm.selectArrivalDebit") : t("wealthForm.noDebitInInstitution")}
                        behavior={{ hierarchy: false, search: "auto", clearable: false }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="form-label">{t("depositForm.depositAccount")}</div>
                    <SmartSelect
                      mode="single"
                      value={depositAccountId}
                      onChange={setDepositAccountId}
                      options={redeemDepositOptions}
                      placeholder={t("depositForm.selectDepositAccountCreate")}
                      behavior={{
                        hierarchy: false,
                        search: "auto",
                        clearable: true,
                        headerExtra: depositOwnerCycleButton,
                        create: {
                          type: "button",
                          onClick: () => setNestedEntityType("deposit-account"),
                          label: t("settings.accounts.add"),
                        },
                      }}
                    />
                  </div>
                )}
              </div>

              {isRedeem ? (
                <>
                  <div className="space-y-1">
                    <div className="form-label">{t("depositForm.redeemLot")}</div>
                    <SmartSelect
                      mode="single"
                      value={selectedRedeemLotId}
                      onChange={setSelectedRedeemLotId}
                      options={redeemLotSelectOptions}
                      placeholder={redeemLotSelectOptions.length > 0 ? t("depositForm.selectRedeemLot") : t("depositForm.noRedeemLot")}
                      behavior={{ hierarchy: false, search: "auto", clearable: false }}
                    />
                    <div className="text-[11px] text-slate-400">
                      {selectedRedeemLot
                        ? `${t("depositForm.redeemWholeLotHint", { amount: selectedRedeemLot.remainingAmount.toFixed(2) })}${selectedRedeemLot.maturityDate ? t("depositForm.redeemMaturitySuffix", { date: selectedRedeemLot.maturityDate }) : ""}`
                        : t("depositForm.selectRedeemLotWithBalance")}
                    </div>
                  </div>
                </>
              ) : (
                <div className="space-y-1">
                  <div className="form-label">{t("wealthForm.productName")}</div>
                  <input
                    value={fundName}
                    onChange={(e) => setFundName(e.target.value)}
                    placeholder={t("depositForm.productNamePlaceholder")}
                    className="form-input"
                  />
                </div>
              )}

              {isRedeem ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("depositForm.annualRatePercent")}</div>
                      <CalcInput
                        value={annualRate}
                        onChange={setAnnualRate}
                        onBlur={() => applyRedeemComputedAmounts(true)}
                        placeholder={t("depositForm.rateExample")}
                        label={t("depositShell.colAnnualRate")}
                        precision={4}
                      />
                      {!hasStoredAnnualRate ? (
                        <div className="text-[11px] text-slate-400">
                          {t("depositForm.rateMissingHint")}
                        </div>
                      ) : null}
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.interest")}</div>
                      <CalcInput
                        value={interestAmount}
                        onChange={(value) => {
                          setInterestEdited(true);
                          setInterestAmount(value);
                        }}
                        placeholder="0.00"
                        label={t("txForm.interest")}
                        precision={2}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("wealthForm.arrivalDate")}</div>
                      <DateStepper value={arrivalDate} onChange={changeArrivalDate} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("wealthForm.arrivalAmount")}</div>
                      <CalcInput
                        value={arrivalAmount}
                        onChange={(value) => {
                          setArrivalEdited(true);
                          setArrivalAmount(value);
                        }}
                        placeholder="0.00"
                        label={t("wealthForm.arrivalAmount")}
                        precision={2}
                      />
                    </div>
                    <div className="col-span-2 text-[11px] text-slate-400">
                      {t("depositForm.arrivalPreview", {
                        principal: amountNumber > 0 ? amountNumber.toFixed(2) : "0.00",
                        interest: parseNumber(interestAmount).toFixed(2),
                        arrival: (parseNumber(arrivalAmount) || 0).toFixed(2),
                      })}
                    </div>
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <div className="form-label">{t("depositForm.annualRatePercent")}</div>
                    <CalcInput
                      value={annualRate}
                      onChange={setAnnualRate}
                      placeholder={t("depositForm.rateExample")}
                      label={t("depositShell.colAnnualRate")}
                      precision={4}
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("depositForm.termLabel")}</div>
                    <select
                      value={termUnit}
                      onChange={(e) => {
                        const nextUnit = e.target.value as DepositTermUnit;
                        setTermUnit(nextUnit);
                        // Switching units keeps a usable count: fall back to 1
                        // when the field is empty or beyond the unit's range.
                        const current = Math.trunc(parseNumber(termCount));
                        const maxCount = nextUnit === "day" ? 36500 : nextUnit === "week" ? 520 : nextUnit === "month" ? 120 : 30;
                        if (!Number.isFinite(current) || current <= 0 || current > maxCount) {
                          setTermCount("1");
                        }
                      }}
                      className="form-input w-full"
                    >
                      <option value="day">{t("depositForm.termUnit.day")}</option>
                      <option value="week">{t("depositForm.termUnit.week")}</option>
                      <option value="month">{t("depositForm.termUnit.month")}</option>
                      <option value="year">{t("depositForm.termUnit.year")}</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("depositForm.termCountLabel")}</div>
                    <input
                      type="number"
                      min={1}
                      value={termCount}
                      onChange={(e) => setTermCount(e.target.value)}
                      placeholder={t("depositForm.termCountPlaceholder")}
                      className="form-input w-full"
                    />
                  </div>
                </div>
              )}

              {!isRedeem ? (
                // 到期行为 + 取息相关控件统一铺满整宽、共用同一列宽（两列等宽），
                // 每一行都填满、不留空白格：
                //   到期一次付 → [到期行为][取息周期]
                //   按周/按年 → [到期行为][取息周期] / [取息间隔（跨两列）]
                //   按月     → [到期行为][取息周期] / [取息间隔][计息方式]
                <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <div className="form-label">{t("deposit.maturityAction.label")}</div>
                    <select
                      value={maturityAction}
                      onChange={(e) => {
                        const next = e.target.value as typeof maturityAction;
                        setMaturityAction(next);
                        // Periodic payout leaves no interest to roll in at maturity.
                        if (next === "renew_principal_interest" && isPeriodicInterestPayout) {
                          setInterestPayoutUnit("maturity");
                          setInterestPayoutInterval("1");
                        }
                      }}
                      className="form-input w-full"
                    >
                      <option value="redeem">{t("deposit.maturityAction.redeem")}</option>
                      <option value="renew_principal">{t("deposit.maturityAction.renewPrincipal")}</option>
                      <option value="renew_principal_interest" disabled={isPeriodicInterestPayout}>{t("deposit.maturityAction.renewPrincipalInterest")}</option>
                    </select>
                    <div className="text-[11px] text-slate-400">{showGuideHints ? t("deposit.maturityAction.hint") : ""}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("deposit.payoutFrequency.label")}</div>
                    <select
                      value={interestPayoutUnit}
                      onChange={(e) => {
                        const next = e.target.value as typeof interestPayoutUnit;
                        setInterestPayoutUnit(next);
                        if (next === "maturity") {
                          setInterestPayoutInterval("1");
                        } else {
                          const current = Math.trunc(parseNumber(interestPayoutInterval)) || 1;
                          const clamped = clampDepositInterestPayoutInterval(
                            termDaysNumber || DEFAULT_DEPOSIT_TERM_DAYS,
                            next,
                            current,
                          );
                          setInterestPayoutInterval(String(clamped));
                          if (maturityAction === "renew_principal_interest") {
                            setMaturityAction("renew_principal");
                          }
                        }
                      }}
                      className="form-input w-full"
                    >
                      <option value="maturity">{t("deposit.payoutFrequency.maturity")}</option>
                      <option value="week">{t("deposit.payoutFrequency.weekly")}</option>
                      <option value="month">{t("deposit.payoutFrequency.monthly")}</option>
                      <option value="year">{t("deposit.payoutFrequency.yearly")}</option>
                    </select>
                  </div>
                  {isPeriodicInterestPayout ? (
                    <div
                      className={`space-y-1 ${
                        // 按周/按年取息没有「计息方式」，间隔独占这一行、跨满两列；
                        // 按月取息时间隔与计息方式各占一列，凑满同一行。
                        interestPayoutUnit === "month" ? "" : "sm:col-span-2"
                      }`}
                    >
                      <div className="form-label">{t("deposit.payoutFrequency.intervalLabel")}</div>
                      <input
                        type="number"
                        min={1}
                        max={maxInterestPayoutInterval}
                        value={interestPayoutInterval}
                        onChange={(e) => setInterestPayoutInterval(e.target.value)}
                        onBlur={() => {
                          const current = Math.trunc(parseNumber(interestPayoutInterval)) || 1;
                          const clamped = clampDepositInterestPayoutInterval(
                            termDaysNumber || DEFAULT_DEPOSIT_TERM_DAYS,
                            interestPayoutUnit as DepositInterestPayoutUnit,
                            current,
                          );
                          setInterestPayoutInterval(String(clamped));
                        }}
                        placeholder="1"
                        className="form-input w-full"
                        title={t("deposit.payoutFrequency.intervalTitle", { max: String(maxInterestPayoutInterval) })}
                        aria-label={t("deposit.payoutFrequency.intervalLabel")}
                      />
                      {/* 按周/按年取息时，取息说明跟在间隔下方（这一行只有它，说明放这里最贴近）。 */}
                      {interestPayoutUnit === "month" ? null : (
                        <div className="text-[11px] text-slate-400">
                          {!showGuideHints
                            ? ""
                            : t("deposit.payoutFrequency.periodicHint", {
                                interval: String(Math.trunc(parseNumber(interestPayoutInterval)) || 1),
                                unit: t(
                                  interestPayoutUnit === "week"
                                    ? "depositForm.termUnit.week"
                                    : "depositForm.termUnit.year",
                                ),
                                max: String(maxInterestPayoutInterval),
                              })}
                        </div>
                      )}
                    </div>
                  ) : null}
                  {/* 计息方式仅按月取息时出现：月均/日均的分母差异只在月频率下体现。 */}
                  {isPeriodicInterestPayout && interestPayoutUnit === "month" ? (
                    <div className="space-y-1">
                      <div className="form-label">{t("deposit.calcBasis.label")}</div>
                      <select
                        value={interestCalcBasis}
                        onChange={(e) => setInterestCalcBasis(e.target.value === "monthly" ? "monthly" : "daily")}
                        className="form-input w-full"
                        aria-label={t("deposit.calcBasis.label")}
                        title={t("deposit.calcBasis.label")}
                      >
                        <option value="daily">{t("deposit.calcBasis.daily")}</option>
                        <option value="monthly">{t("deposit.calcBasis.monthly")}</option>
                      </select>
                      <div className="text-[11px] text-slate-400">
                        {!showGuideHints
                          ? ""
                          : interestCalcBasis === "monthly"
                            ? t("deposit.calcBasis.monthlyHint")
                            : t("deposit.payoutFrequency.periodicHint", {
                                interval: String(Math.trunc(parseNumber(interestPayoutInterval)) || 1),
                                unit: t("depositForm.termUnit.month"),
                                max: String(maxInterestPayoutInterval),
                              })}
                      </div>
                    </div>
                  ) : null}
                  {/* 到期一次付：取息说明跟在取息周期下方（此时没有间隔/计息方式）。 */}
                  {!isPeriodicInterestPayout ? (
                    <div className="text-[11px] text-slate-400 sm:col-span-2">
                      {showGuideHints ? t("deposit.payoutFrequency.hint") : ""}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {!isRedeem ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="form-label">{t("wealthForm.sourceAccount")}</div>
                    <SmartSelect
                      mode="single"
                      value={cashAccountId}
                      onChange={(id) => { setCashAccountId(id); recordRecentAccount(id); }}
                      options={visibleCashOptions}
                      placeholder={t("depositForm.selectCashAccount")}
                      behavior={{
                        hierarchy: "auto",
                        search: "auto",
                        clearable: false,
                        headerExtra: cashOwnerCycleButton,
                        create: {
                          type: "button",
                          onClick: () => setNestedEntityType("cash-account"),
                          label: t("settings.accounts.add"),
                        },
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{depositCurrency ? t("depositForm.depositAmountWithCurrency", { currency: depositCurrency }) : t("depositForm.depositAmount")}</div>
                    <CalcInput
                      value={amount}
                      onChange={setAmount}
                      placeholder="0.00"
                      label={t("depositForm.depositAmount")}
                      precision={2}
                    />
                  </div>
                </div>
              ) : null}

              {showCurrencyConversion ? (
                <div className="grid grid-cols-2 gap-3 rounded-[10px] border border-amber-200 bg-amber-50/70 p-3">
                  <div className="space-y-1">
                    <div className="form-label">{t("depositForm.exchangeRateLabel", { deposit: depositCurrency, cash: cashCurrency })}</div>
                    <CalcInput
                      value={exchangeRate}
                      onChange={setExchangeRate}
                      placeholder={t("depositForm.exchangeRateExample")}
                      label={t("txForm.fxRate")}
                      precision={6}
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("depositForm.cashAmountLabel", { currency: cashCurrency })}</div>
                    <CalcInput
                      value={cashAmount}
                      onChange={setCashAmount}
                      placeholder="0.00"
                      label={t("depositForm.cashAmount")}
                      precision={2}
                    />
                  </div>
                  <div className="col-span-2 text-[11px] text-slate-500">
                    {t("depositForm.conversionHint", {
                      amount: amountNumber > 0 ? amountNumber.toFixed(2) : "0.00",
                      currency: depositCurrency,
                    })}
                  </div>
                </div>
              ) : null}

              <div className="space-y-1">
                <div className="form-label">{t("detail.column.remark")}</div>
                <ClearableNoteField
                  value={memo}
                  onValueChange={setMemo}
                  placeholder={t("firstUseGuide.optional")}
                  className="form-input"
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                {mode === "create" ? (
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => { void saveDepositTransaction(true); }}
                    className="secondary-button h-9 px-4 text-sm disabled:opacity-50"
                  >
                    {submitting ? t("txForm.saving") : t("txForm.saveAndRepeat")}
                  </button>
                ) : null}
                <button
                  type="submit"
                  disabled={submitting}
                  className={`h-9 rounded-[10px] px-4 text-sm text-white disabled:opacity-50 ${
                    isRedeem ? "bg-orange-600 hover:bg-orange-700" : "primary-button"
                  }`}
                >
                  {submitting ? t("txForm.saving") : mode === "edit" ? t("txForm.saveChanges") : isRedeem ? t("depositForm.recordRedeem") : t("depositForm.recordBuy")}
                </button>
              </div>
              </div>
            </form>
          </div>
        </div>,
        document.body,
      )}

      {nestedEntityType
        ? createPortal(
            <NestedAddModal
              mode="compact"
              entityType="account"
              open
              onClose={() => setNestedEntityType(null)}
              onCreated={(id, name, extra) => {
                const createdKind = extra?.kind || (nestedEntityType === "cash-account" ? "bank_debit" : "deposit");
                const optionLabel = name;
                const optionSubLabel = kindLabel(createdKind);
                const groupId = extra?.groupId;
                const groupName = extra?.groupName;
                const extraWithCurrency = extra as typeof extra & { currency?: unknown };
                const currency = extraWithCurrency?.currency ? String(extraWithCurrency.currency) : "CNY";

                if (nestedEntityType === "cash-account") {
                  const flat = { id, label: optionLabel, subLabel: optionSubLabel, currency };
                  setCashAccountList((prev) => appendFlatOption(prev, flat));
                  setLocalCashSSOpts((prev) =>
                    appendSmartSelectOption(prev, { id, label: optionLabel, subLabel: optionSubLabel }, groupId, groupName),
                  );
                  setCashAccountId(id);
                } else {
                  const flat = { id, label: optionLabel, subLabel: optionSubLabel, currency };
                  setDepositAccountList((prev) => appendFlatOption(prev, flat));
                  setLocalDepositSSOpts((prev) =>
                    appendSmartSelectOption(prev, { id, label: optionLabel, subLabel: optionSubLabel }, groupId, groupName),
                  );
                  setDepositAccountId(id);
                }
                setNestedEntityType(null);
              }}
              extraFields={
                nestedEntityType === "cash-account"
                  ? undefined
                  : { kind: "deposit" }
              }
              hiddenFields={nestedEntityType === "cash-account" ? [] : ["kind"]}
              allowedAccountKinds={nestedEntityType === "cash-account" ? ["bank_debit", "ewallet"] : undefined}
              nestedFieldData={localNestedFieldData ?? nestedFieldData}
              onNestedCreated={handleNestedOptionCreated}
            />,
            document.body,
          )
        : null}
    </ModalLayerProvider>
  );
}

function isDepositLikeOption(option: AccountOption | null) {
  if (!option) return false;
  return option.kind === "deposit" || option.investProductType === "deposit";
}
