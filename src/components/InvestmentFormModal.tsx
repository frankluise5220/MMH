"use client";

import { DatabaseZap, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { HoldingPicker } from "./HoldingPicker";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./TransactionFormModal";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import {
  type FundSubtype,
  type ProductType,
  PRODUCT_LABELS,
  SUBTYPE_LABELS,
  DEPOSIT_LABELS,
  PRODUCT_SUBTYPES,
  parseNumber,
  addDays,
  isRedeemLike,
  isBuyLike,
  isDividend,
  showConfirmFor,
  showAccountSelectorsFor,
  showUnitsFor,
  showFeeFor,
} from "@/lib/investment-config";

function pnlCls(n: number | null | undefined): string {
  if (n == null) return "text-slate-600";
  const isRedUp = (() => {
    if (typeof document === "undefined") return true;
    const match = document.cookie.match(/colorScheme=([^;]+)/);
    return (match?.[1] ?? "red_up_green_down") === "red_up_green_down";
  })();
  if (n > 0) return isRedUp ? "text-red-600" : "text-emerald-700";
  if (n < 0) return isRedUp ? "text-emerald-700" : "text-red-600";
  return "text-slate-600";
}

// 鏈湴绠€鍐欏埆鍚?
const p = parseNumber;

// 缂栬緫妯″紡鐨勫叆鍙ｆ暟鎹被鍨?
export type InvestmentEntry = {
  id: string;
  transactionId: string;
  date: string;
  confirmDate?: string;
  amount: number;
  note: string | null;
  memo: string | null;
  fundCode: string | null;
  fundName: string | null;
  fundUnits: number | null;
  fundNav: number | null;
  fundFee: number | null;
  fundProductType: string | null;
  fundSubtype: string | null;
  source?: string | null;
  accountId?: string | null; // 鏁版嵁搴撹祫閲戞祦鍚戞潵婧愯处鎴稩D锛氳祹鍥炰负鍩洪噾璐︽埛锛屼拱鍏ヤ负璧勯噾璐︽埛
  toAccountId?: string | null; // 鏁版嵁搴撹祫閲戞祦鍚戝幓鍚戣处鎴稩D锛氳祹鍥炰负璧勯噾璐︽埛锛屼拱鍏ヤ负鍩洪噾璐︽埛
  cashAccountId?: string | null;
  toAccountName?: string | null;
  fundArrivalDate?: string | null;
  fundArrivalAmount?: number | null;
  realizedProfit?: number | null;
};

// 鏂板妯″紡鐨勯粯璁ゅ€肩被鍨?
export type InvestmentDefaults = {
  fundCode?: string;
  fundName?: string;
  fundUnits?: number | null;
  confirmDays?: number | null;
  feeRate?: string | null;
};

type OpenInvestmentCreateDetail = {
  requestId: string;
  defaultAccountId?: string;
  defaultCashAccountId?: string;
  defaultDate?: string;
  defaultAmount?: number;
};

export function InvestmentFormModal({
  mode,
  accountId: defaultAccountId,
  accountProductType,
  entry,
  defaults,
  cashAccounts,
  investmentAccounts,
  cashAccountSSOptions,
  investmentAccountSSOptions,
  holdings,
  allEntries,
  createAction,
  editAction,
  openSignal,
  hideTrigger,
}: {
  mode: "create" | "edit";
  accountId: string; // 榛樿鍩洪噾璐︽埛ID锛堟柊澧炴ā寮忥級鎴栧綋鍓嶈处鎴稩D锛堢紪杈戞ā寮忥級
  accountProductType?: string | null;
  entry?: InvestmentEntry; // 缂栬緫妯″紡蹇呴』鎻愪緵
  defaults?: InvestmentDefaults; // 鏂板妯″紡鐨勯粯璁ゅ€?
  cashAccounts?: { id: string; label: string }[];
  investmentAccounts?: { id: string; label: string }[];
  cashAccountSSOptions?: SmartSelectOption[];
  investmentAccountSSOptions?: SmartSelectOption[];
  holdings?: { fundCode: string; name: string; units: number }[];
  allEntries?: { date: string; fundConfirmDate?: string | null; fundArrivalDate?: string | null; fundCode: string; fundSubtype: string; fundUnits: number | null; source: string | null }[];
  createAction: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  editAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  openSignal?: number;
  hideTrigger?: boolean;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const fixedProductType: ProductType =
    (["fund", "money", "wealth", "deposit"].includes(accountProductType ?? "")
      ? accountProductType as ProductType
      : (mode === "edit" && entry?.fundProductType && ["fund", "money", "wealth", "deposit"].includes(entry.fundProductType)
        ? entry.fundProductType as ProductType
        : "fund"));

  // 缂栬緫妯″紡锛氫粠 entry 鍒濆鍖?
  // buy_failed锛氭殏鍋滅敵璐樉绀轰负涔板叆锛岃祫閲戦€€鍥炴樉绀轰负璧庡洖锛堜唤棰濆潎涓?锛?
  // buy + source=dividend锛氭樉绀轰负 dividend_reinvest
  const initDisplaySubtype: FundSubtype = mode === "edit" && entry?.fundSubtype === "buy_failed"
    ? (entry?.source === "regular_invest_refund" ? "redeem" : "buy")
    : mode === "edit" && entry?.fundSubtype === "buy" && entry?.source === "dividend"
    ? "dividend_reinvest"
    : mode === "edit" && entry?.fundSubtype && SUBTYPE_LABELS[entry.fundSubtype as FundSubtype]
    ? entry.fundSubtype as FundSubtype
    : (mode === "edit" && entry && entry.amount < 0 ? "buy" : "redeem");
  const initSubtype: FundSubtype = initDisplaySubtype;
  const initAmount = mode === "edit" && entry ? Math.abs(entry.amount) : "";
  const initNav = mode === "edit" && entry?.fundNav != null ? String(entry.fundNav) : "";
  const initUnits = mode === "edit" && entry?.fundUnits != null ? Number(entry.fundUnits).toFixed(3)
    : defaults?.fundUnits && defaults.fundUnits > 0 ? Number(defaults.fundUnits).toFixed(3) : "";
  const initFee = mode === "edit" && entry?.fundFee != null ? String(entry.fundFee) : "";
  // 涔板叆/dividend_cash锛歛ccountId=鐜伴噾璐︽埛(鏉ユ簮), toAccountId=鎶曡祫璐︽埛(鍘诲悜)
  // 璧庡洖/杞崲杞嚭/buy_failed閫€鍥烇細accountId=鎶曡祫璐︽埛(鏉ユ簮), toAccountId=鐜伴噾璐︽埛(鍘诲悜)
  const isRedeemEntry = isRedeemLike(initSubtype);
  const initCashAccountId = mode === "edit"
    ? (isRedeemEntry ? (entry?.toAccountId ?? "") : (entry?.accountId ?? ""))
    : "";
  const initToAccountId = mode === "edit"
    ? (isRedeemEntry ? (entry?.accountId ?? defaultAccountId) : (entry?.toAccountId ?? defaultAccountId))
    : defaultAccountId;
  const initConfirmDays = mode === "edit" && entry
    ? (defaults?.confirmDays ?? 0)
    : (defaults?.confirmDays ?? 0);
  const initFeeRate = defaults?.feeRate ?? "0";
  const initFundCode = mode === "edit" ? (entry?.fundCode ?? "") : (defaults?.fundCode ?? "");
  const initFundName = mode === "edit" ? (entry?.fundName ?? entry?.fundCode ?? "") : (defaults?.fundName ?? "");
  const initArrivalDate = mode === "edit"
    ? (entry?.fundArrivalDate ?? (() => {
        const dt = mode === "edit" && entry ? entry.date : today;
        const days = typeof initConfirmDays === "number" ? initConfirmDays : Number(initConfirmDays) || 0;
        if ((initSubtype === "dividend_cash" || initSubtype === "dividend_reinvest") && dt && days >= 0) {
          const d = new Date(dt + "T00:00:00Z");
          d.setDate(d.getDate() + days);
          return d.toISOString().slice(0, 10);
        }
        return "";
      })())
    : (initSubtype === "dividend_cash" ? today : "");
  const initArrivalAmount = mode === "edit" && entry?.fundArrivalAmount != null ? String(entry.fundArrivalAmount) : "";
  const initMemo = mode === "edit" ? (entry?.memo ?? entry?.note ?? "") : "";
  const initDate = mode === "edit" && entry ? entry.date : today;
  const initConfirmDate = mode === "edit" && entry ? (entry.confirmDate ?? "") : "";

  const [open, setOpen] = useState(false);
  const [productType, setProductType] = useState<ProductType>(fixedProductType);
  const [subtype, setSubtype] = useState<FundSubtype>(initSubtype);
  const [applyDate, setApplyDate] = useState(initDate);
  const [confirmDate, setConfirmDate] = useState(initConfirmDate);
  const [cashAccountId, setCashAccountId] = useState(initCashAccountId);
  const [toAccountId, setToAccountId] = useState(initToAccountId);
  const cashAccountIdRef = useRef(initCashAccountId);
  const cashAccountTouchedRef = useRef(false);
  const cashAccountAutoRef = useRef(false);
  const [fundCode, setFundCode] = useState(initFundCode);
  const [fundName, setFundName] = useState(initFundName);
  const [nameLoading, setNameLoading] = useState(false);
  const [nav, setNav] = useState(initNav);
  const [navLoading, setNavLoading] = useState(false);
  const [navActualDate, setNavActualDate] = useState<string | null>(null);
  const [units, setUnits] = useState(initUnits);
  const [amount, setAmount] = useState(String(initAmount));
  const [feeRate, setFeeRate] = useState(initFeeRate);
  const [arrivalDate, setArrivalDate] = useState(initArrivalDate);
  const [arrivalAmount, setArrivalAmount] = useState(initArrivalAmount);
  const [feeRateEdited, setFeeRateEdited] = useState(false);
  const [fee, setFee] = useState(initFee);
  const [feeEdited, setFeeEdited] = useState(false);
  const [confirmDays, setConfirmDays] = useState(typeof initConfirmDays === "number" ? initConfirmDays : Number(initConfirmDays) || 0);
  const [confirmDaysEdited, setConfirmDaysEdited] = useState(false);
  const [redeemCostDays, setRedeemCostDays] = useState(1);
  const [arrivalDays, setArrivalDays] = useState(2);
  const [deleting, setDeleting] = useState(false);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const lastNavFetchedDate = useRef<string>("");
  const navDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  function setNavFromApi(navStr: string) {
    setNav(navStr);
    navEditedRef.current = true;
  }
  const [memo, setMemo] = useState(initMemo);
  const unitsEditedRef = useRef(false);
  const amountEditedRef = useRef(false);
  const navEditedRef = useRef(false);
  const [holdingSearch, setHoldingSearch] = useState(initFundCode && initFundName ? `${initFundCode} ${initFundName}` : "");
  const [submitting, setSubmitting] = useState(false);
  const dividendAmountRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef<string | null>(null);
  const pendingFundCodeFetchRef = useRef<string | null>(null);
  const redeemLastAppliedRef = useRef<number>(0);
  const prevSavedDateRef = useRef<string | null>(null);
  const editAutoNavEnabledRef = useRef(mode !== "edit");

  const flatCashAccountOptions = useMemo<SmartSelectOption[]>(
    () => (cashAccounts ?? []).map((account) => ({ id: account.id, label: account.label })),
    [cashAccounts],
  );
  const flatInvestmentAccountOptions = useMemo<SmartSelectOption[]>(
    () => (investmentAccounts ?? []).map((account) => ({ id: account.id, label: account.label })),
    [investmentAccounts],
  );
  const {
    ownerFilterLabel: cashOwnerFilterLabel,
    cycleOwnerFilter: cycleCashOwnerFilter,
    filteredOptions: cashAccountSSFiltered,
  } = useAccountSSFilter(cashAccountSSOptions);
  const {
    ownerFilterLabel: investmentOwnerFilterLabel,
    cycleOwnerFilter: cycleInvestmentOwnerFilter,
    filteredOptions: investmentAccountSSFiltered,
  } = useAccountSSFilter(investmentAccountSSOptions);
  const recentAccountIds = useRecentAccountIds();
  const visibleCashAccountOptions = sortOptionsByRecent(cashAccountSSFiltered ?? cashAccountSSOptions ?? flatCashAccountOptions, recentAccountIds);
  const visibleInvestmentAccountOptions = sortOptionsByRecent(investmentAccountSSFiltered ?? investmentAccountSSOptions ?? flatInvestmentAccountOptions, recentAccountIds);
  const cashOwnerCycleButton = cashAccountSSOptions?.some((option) => option.isHeader) ? (
    <button
      type="button"
      onClick={cycleCashOwnerFilter}
      title={`鎵€鏈変汉锛?{cashOwnerFilterLabel}`}
      aria-label={`鍒囨崲鎵€鏈変汉锛屽綋鍓?${cashOwnerFilterLabel}`}
      className="secondary-button !px-0 h-7 w-7 shrink-0 text-slate-500"
    >
      <Repeat className="h-3.5 w-3.5" />
    </button>
  ) : undefined;
  const investmentOwnerCycleButton = investmentAccountSSOptions?.some((option) => option.isHeader) ? (
    <button
      type="button"
      onClick={cycleInvestmentOwnerFilter}
      title={`鎵€鏈変汉锛?{investmentOwnerFilterLabel}`}
      aria-label={`鍒囨崲鎵€鏈変汉锛屽綋鍓?${investmentOwnerFilterLabel}`}
      className="secondary-button !px-0 h-7 w-7 shrink-0 text-slate-500"
    >
      <Repeat className="h-3.5 w-3.5" />
    </button>
  ) : undefined;

  function selectCashAccount(id: string) {
    cashAccountTouchedRef.current = true;
    cashAccountAutoRef.current = false;
    setCashAccountId(id);
  }

  function renderCashAccountSelect(placeholder = "璇烽€夋嫨璧勯噾璐︽埛") {
    return (
      <SmartSelect
        mode="single"
        value={cashAccountId}
        onChange={selectCashAccount}
        options={visibleCashAccountOptions}
        placeholder={placeholder}
        behavior={{
          hierarchy: "auto",
          search: "auto",
          clearable: true,
          headerExtra: cashOwnerCycleButton,
        }}
      />
    );
  }

  function renderInvestmentAccountSelect(placeholder = "璇烽€夋嫨璐︽埛") {
    return (
      <SmartSelect
        mode="single"
        value={toAccountId}
        onChange={setToAccountId}
        options={visibleInvestmentAccountOptions}
        placeholder={placeholder}
        behavior={{
          hierarchy: "auto",
          search: "auto",
          clearable: true,
          headerExtra: investmentOwnerCycleButton,
        }}
      />
    );
  }

  function enableEditAutoNav() {
    if (mode === "edit") editAutoNavEnabledRef.current = true;
  }

  function changeApplyDate(val: string) {
    enableEditAutoNav();
    setApplyDate(val);
  }

  function changeConfirmDate(val: string) {
    enableEditAutoNav();
    setConfirmDate(val);
  }

  function changeFundCode(val: string) {
    enableEditAutoNav();
    setFundCode(val);
  }

  // Reset edit form state from entry props every time modal opens
  useEffect(() => {
    if (!open || mode !== "edit" || !entry) return;
    setSubtype(initSubtype);
    setApplyDate(initDate);
    setConfirmDate(initConfirmDate);
    setCashAccountId(initCashAccountId);
    setToAccountId(initToAccountId);
    setFundCode(initFundCode);
    setFundName(initFundName);
    setNav(initNav);
    setUnits(initUnits);
    setAmount(String(initAmount));
    setFeeRate(initFeeRate);
    setFee(initFee);
    setFeeEdited(false);
    setFeeRateEdited(false);
    setConfirmDays(typeof initConfirmDays === "number" ? initConfirmDays : Number(initConfirmDays) || 0);
    setConfirmDaysEdited(false);
    setMemo(initMemo);
    setArrivalDate(initArrivalDate);
    setArrivalAmount(initArrivalAmount);
    unitsEditedRef.current = false;
    amountEditedRef.current = false;
    navEditedRef.current = false;
    arrivalDateEditedRef.current = false;
    lastNavFetchedDate.current = "";
    editAutoNavEnabledRef.current = false;
    cashAccountTouchedRef.current = false;
    cashAccountAutoRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry]);

  // Fetch fund name/rate/confirmDays when AI sets a fund code
  useEffect(() => {
    if (!pendingFundCodeFetchRef.current || !open) return;
    const code = pendingFundCodeFetchRef.current;
    pendingFundCodeFetchRef.current = null;

    setNameLoading(true);
    fetch(`/api/v1/fund/name?code=${encodeURIComponent(code)}`)
      .then(r => r.json())
      .then(d => { if (d.ok && d.name) setFundName(d.name); })
      .catch(() => {})
      .finally(() => setNameLoading(false));

    fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(code)}`)
      .then(r => r.json())
      .then(d => { if (d.ok && d.days != null) { setConfirmDays(d.days); if (d.redeemCostDays != null) setRedeemCostDays(d.redeemCostDays); if (d.arrivalDays != null) setArrivalDays(d.arrivalDays); } })
      .catch(() => {});
    fetch(`/api/v1/fund/fee-rate?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(code)}&feeType=${isRedeemLike(subtype) ? "redeem" : "buy"}`)
      .then(r => r.json())
      .then(d => { if (d.ok && d.rate != null) setFeeRate(String(d.rate)); })
      .catch(() => {});
  }, [open, toAccountId, subtype]);

  // Always re-verify fund name from authoritative source when modal opens with a fundCode
  useEffect(() => {
    if (!open || !fundCode || fundCode.length !== 6) return;
    setNameLoading(true);
    fetch(`/api/v1/fund/name?code=${encodeURIComponent(fundCode)}`)
      .then(r => r.json())
      .then(d => { if (d.ok && d.name) setFundName(d.name); })
      .catch(() => {})
      .finally(() => setNameLoading(false));
  }, [open, fundCode]);

  // Listen for AI panel "open create transaction" event 鈥?only in create mode
  useEffect(() => {
    if (mode !== "create") return;

    function onOpenFromAi(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId: string;
        item?: {
          type?: string;
          date?: string;
          amount?: number;
          account?: string;
          fromAccount?: string;
          toAccount?: string;
          category?: string;
          counterparty?: string;
          remark?: string;
          rawText?: string;
        };
      }>).detail;
      if (!detail?.requestId || !detail.item) return;
      // Only handle investment types
      if (detail.item.type !== "investment") return;

      requestIdRef.current = detail.requestId;

      // Extract fund code from category (鍩洪噾路004011) or counterparty (鍩洪噾004011)
      const catCode = (detail.item.category ?? "").match(/\b(\d{6})\b/)?.[1];
      const cptyCode = (detail.item.counterparty ?? "").match(/\b(\d{6})\b/)?.[1];
      const fundCodeFromAi = catCode || cptyCode || "";

      const amt = detail.item.amount ?? 0;
      const aiDate = detail.item.date ?? today;
      const note = (detail.item.remark ?? detail.item.rawText ?? "").trim();
      const isRedeem = /璧庡洖|鍗栧嚭/.test(note + detail.item.rawText);
      const isDivCash = /鐜伴噾绾㈠埄/.test(note + detail.item.rawText);

      // Reset form first, then populate
      resetForCreate();
      if (isDivCash) {
        setSubtype("dividend_cash");
        setArrivalDate(aiDate);
      } else if (isRedeem) {
        setSubtype("redeem");
        setApplyDate(aiDate);
      } else {
        setSubtype("buy");
        setApplyDate(aiDate);
      }

      if (fundCodeFromAi) {
        setFundCode(fundCodeFromAi);
        pendingFundCodeFetchRef.current = fundCodeFromAi;
      }
      if (amt > 0) setAmount(String(amt));
      if (note) setMemo(note);

      setOpen(true);
    }

    window.addEventListener("mmh:create-transaction:open", onOpenFromAi as EventListener);
    return () => window.removeEventListener("mmh:create-transaction:open", onOpenFromAi as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, defaultAccountId, today, defaults]);

  useEffect(() => {
    if (mode !== "create") return;

    function onOpenFromCreate(ev: Event) {
      const detail = (ev as CustomEvent<OpenInvestmentCreateDetail>).detail;
      if (!detail?.requestId) return;

      requestIdRef.current = detail.requestId;
      resetForCreate(false, { preferDefaults: true });
      if (detail.defaultDate) setApplyDate(detail.defaultDate);
      if (typeof detail.defaultAmount === "number" && detail.defaultAmount > 0) {
        setAmount(String(detail.defaultAmount));
      }
      if (detail.defaultAccountId) setToAccountId(detail.defaultAccountId);
      if (detail.defaultCashAccountId) setCashAccountId(detail.defaultCashAccountId);
      setOpen(true);
    }

    window.addEventListener("mmh:investment:create", onOpenFromCreate as EventListener);
    return () => window.removeEventListener("mmh:investment:create", onOpenFromCreate as EventListener);
  }, [mode, today, defaults]);

  // Listen for edit events (dispatched by EntryRowActions for fund/money investment records)
  useEffect(() => {
    if (mode !== "edit") return;

    function onInvestmentEdit(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId: string;
        entryId: string;
        type: string;
        date: string;
        confirmDate?: string | null;
        amount: number;
        note: string;
        accountId?: string;
        toAccountId?: string;
        fundCode?: string;
        fundName?: string;
        fundSubtype?: string;
        fundUnits?: number;
        fundNav?: number;
        fundFee?: number;
        fundProductType?: string;
        cashAccountId?: string;
        fundArrivalDate?: string | null;
        fundArrivalAmount?: number | null;
      }>).detail;
      if (!detail?.requestId || !detail.entryId) return;
      if (detail.type !== "investment") return;

      requestIdRef.current = detail.requestId;
      setEditEntryId(detail.entryId);
      if (detail.fundProductType && ["fund", "money", "wealth", "deposit"].includes(detail.fundProductType)) {
        setProductType(detail.fundProductType as ProductType);
      }

      // Fill form from payload
      editAutoNavEnabledRef.current = false;
      setApplyDate(detail.date || today);
      setConfirmDate(detail.confirmDate ?? "");
      setArrivalDate(detail.fundArrivalDate ?? "");
      setArrivalAmount(detail.fundArrivalAmount != null ? String(detail.fundArrivalAmount) : "");
      const numericAmount = Number(detail.amount);
      setAmount(Number.isFinite(numericAmount) && numericAmount !== 0 ? String(Math.abs(numericAmount)) : "");
      setMemo(detail.note ?? "");
      const isRedeemEntry = detail.fundSubtype === "redeem" || detail.fundSubtype === "switch_out";
      const nextFundAccountId = isRedeemEntry ? detail.accountId : detail.toAccountId;
      const nextCashAccountId = detail.cashAccountId ?? (isRedeemEntry ? detail.toAccountId : detail.accountId);
      setCashAccountId(nextCashAccountId ?? "");
      setToAccountId(nextFundAccountId ?? "");
      cashAccountTouchedRef.current = true;
      cashAccountAutoRef.current = false;
      setFundCode(detail.fundCode ?? "");
      setFundName(detail.fundName ?? "");
      setHoldingSearch(detail.fundCode ? `${detail.fundCode} ${detail.fundName ?? ""}` : "");
      if (detail.fundSubtype) {
        const st = detail.fundSubtype === "buy_failed" ? "buy" : detail.fundSubtype as FundSubtype;
        if (SUBTYPE_LABELS[st as FundSubtype]) setSubtype(st as FundSubtype);
      }
      if (detail.fundUnits != null) setUnits(Number(detail.fundUnits).toFixed(3));
      if (detail.fundNav != null) setNav(String(detail.fundNav));
      if (detail.fundFee != null) setFee(String(detail.fundFee));
      if (detail.fundName) setFundName(detail.fundName);
      setOpen(true);
    }

    window.addEventListener("mmh:investment:edit", onInvestmentEdit as EventListener);
    return () => window.removeEventListener("mmh:investment:edit", onInvestmentEdit as EventListener);
  }, [mode, today]);

  // Dispatch success event when create form is saved from AI panel
  function notifyAiSuccess(requestId: string) {
    window.dispatchEvent(new CustomEvent("mmh:create-transaction:success", { detail: { requestId } }));
  }

  // 璧庡洖妯″紡锛氳绠楃敵璇锋棩鏈熷墠宸茬‘璁?鍒拌处鐨勫彲璧庡洖浠介
  const holdingsAsOfDate = useMemo(() => {
    if (!allEntries || !isRedeemLike(subtype) || !applyDate) return null;
    const map = new Map<string, number>();
    for (const e of allEntries) {
      if (!e.fundCode) continue;
      const sub = e.fundSubtype;
      const availableDate = sub === "buy" || sub === "dividend_reinvest"
        ? (e.fundArrivalDate ?? e.fundConfirmDate ?? e.date)
        : e.date;
      if (availableDate > applyDate) continue;
      let delta = 0;
      if (sub === "buy" || sub === "dividend_reinvest") {
        delta = e.fundUnits ?? 0;
      } else if (sub === "redeem") {
        delta = -(e.fundUnits ?? 0);
      } else if (sub === "buy_failed" && e.source === "regular_invest_refund") {
        delta = -(e.fundUnits ?? 0);
      }
      map.set(e.fundCode, (map.get(e.fundCode) ?? 0) + delta);
    }
    return map;
  }, [allEntries, subtype, applyDate]);

  const effectiveHoldings = useMemo(() => {
    if (!holdings) return undefined;
    if (!holdingsAsOfDate) return holdings;
    // 璧庡洖妯″紡锛氫繚鐣欐墍鏈夋寔浠撳熀閲戝湪涓嬫媺鍒楄〃锛屼笉鍥犱唤棰濅负 0 灏卞墧闄?
    // 浠介涓?0 鐨勪粛鍙€夛紝鐢ㄦ埛鍙墜鍔ㄨ緭鍏ヤ唤棰濓紙鍙兘鏄巻鍙叉暟鎹ˉ褰曪級
    return holdings.map(h => ({
      ...h,
      units: holdingsAsOfDate.has(h.fundCode) ? holdingsAsOfDate.get(h.fundCode)! : 0,
    }));
  }, [holdings, holdingsAsOfDate]);

  const subtypeGroups = PRODUCT_SUBTYPES[productType];
  const allSubtypes = subtypeGroups.flat();

  function selectSubtype(nextSubtype: FundSubtype) {
    if (isRedeemLike(nextSubtype) && !isRedeemLike(subtype)) {
      // 鍒囧埌璧庡洖锛氶噸缃拱鍏ョ殑閲戦/浠介/鎵嬬画璐癸紝棰勫～鎸佷粨浠介
      setAmount("");
      setFee("");
      setFeeEdited(false);
      setFeeRate("0");
      setFeeRateEdited(false);
      amountEditedRef.current = false;
      const h = effectiveHoldings?.find(p => p.fundCode === fundCode);
      if (h && h.units > 0) setUnits(Number(h.units).toFixed(3));
      else if (defaults?.fundUnits && defaults.fundUnits > 0) setUnits(Number(defaults.fundUnits).toFixed(3));
      else setUnits("");
    }
    if (isBuyLike(nextSubtype) && !isBuyLike(subtype)) {
      // 鍒囧洖涔板叆锛氶噸缃祹鍥炵殑閲戦/浠介/鎵嬬画璐?鍒拌处閲戦/璐圭巼
      setUnits("");
      unitsEditedRef.current = false;
      amountEditedRef.current = false;
      navEditedRef.current = false;
      setAmount("");
      setFee("");
      setFeeEdited(false);
      setFeeRate("0");
      setFeeRateEdited(false);
      setArrivalAmount("");
    }
    if (isDividend(nextSubtype)) {
      if (!arrivalDate) setArrivalDate(today);
      if (!cashAccountId && cashAccounts && cashAccounts.length > 0) {
        setCashAccountId(cashAccounts[0].id);
      }
      if (defaults?.fundCode && !fundCode) {
        setFundCode(defaults.fundCode);
        setFundName(defaults.fundName ?? defaults.fundCode);
        setHoldingSearch(`${defaults.fundCode} ${defaults.fundName ?? defaults.fundCode}`);
      }
    }
    setSubtype(nextSubtype);
  }

  useEffect(() => {
    if (!allSubtypes.includes(subtype)) {
      setSubtype(allSubtypes[0]);
    }
  }, [productType]);

  // 鐜伴噾绾㈠埄妯″紡锛氬厜鏍囪嚜鍔ㄨ仛鐒﹀埌閲戦杈撳叆妗?
  useEffect(() => {
    if (isDividend(subtype) && open) {
      setTimeout(() => dividendAmountRef.current?.focus(), 100);
    }
  }, [subtype, open]);

  useEffect(() => {
    cashAccountIdRef.current = cashAccountId;
  }, [cashAccountId]);

  const fundCodeKey = useMemo(() => {
    const raw = fundCode.trim();
    return /^\d{6}$/.test(raw) ? raw : "";
  }, [fundCode]);

  // 鏂板妯″紡锛氭墦寮€鏃惰嚜鍔ㄥ～鍏呯幇閲戣处鎴凤紙璐圭巼/纭澶╂暟鍙敤浜庝拱鍏?璧庡洖锛?
  useEffect(() => {
    if (mode !== "create" || !open || !toAccountId) return;
    const controller = new AbortController();
    fetch(`/api/v1/fund/last-cash-account?accountId=${encodeURIComponent(toAccountId)}${fundCodeKey ? `&fundCode=${encodeURIComponent(fundCodeKey)}` : ""}`, { signal: controller.signal })
      .then(r => r.json())
      .then(d => {
        if (cashAccountTouchedRef.current) return;
        const fallback = cashAccounts && cashAccounts.length > 0 ? cashAccounts[0].id : "";
        const desired = d?.ok && d.cashAccountId ? String(d.cashAccountId) : fallback;
        if (desired && (cashAccountAutoRef.current || !cashAccountIdRef.current)) {
          cashAccountAutoRef.current = true;
          setCashAccountId(desired);
        }
      })
      .catch(() => {
        if (cashAccountTouchedRef.current) return;
        const fallback = cashAccounts && cashAccounts.length > 0 ? cashAccounts[0].id : "";
        if (fallback && (cashAccountAutoRef.current || !cashAccountIdRef.current)) {
          cashAccountAutoRef.current = true;
          setCashAccountId(fallback);
        }
      });
    if (isDividend(subtype)) return;
    if (fundCodeKey) {
      const feeType = isRedeemLike(subtype) ? "redeem" : "buy";
      fetch(`/api/v1/fund/fee-rate?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(fundCodeKey)}&feeType=${feeType}`)
        .then(r => r.json())
        .then(d => { if (!feeRateEdited) setFeeRate(d.ok && d.rate != null ? String(d.rate) : "0"); })
        .catch(() => { if (!feeRateEdited && !feeRate) setFeeRate("0"); });
      fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(fundCodeKey)}`)
        .then(r => r.json())
        .then(d => { if (d.ok && d.days != null) { setConfirmDays(d.days); if (d.arrivalDays != null) setArrivalDays(d.arrivalDays); } })
        .catch((e) => { console.error("Auto-fill error:", e); });
    } else {
      fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(toAccountId)}`)
        .then(r => r.json())
        .then(d => { if (d.ok && d.days != null) { setConfirmDays(d.days); if (d.arrivalDays != null) setArrivalDays(d.arrivalDays); } })
        .catch(() => {});
    }
    return () => controller.abort();
  }, [mode, open, toAccountId, fundCodeKey, cashAccounts, subtype]);

  // 缂栬緫妯″紡锛氫粠搴撲腑鑾峰彇 confirmDays 鍜?feeRate 鐨勫噯纭€硷紙鐜伴噾绾㈠埄涓嶉渶瑕侊級
  useEffect(() => {
    if (mode !== "edit" || !open || !toAccountId || isDividend(subtype)) return;
    if (fundCodeKey) {
      const feeType = isRedeemLike(subtype) ? "redeem" : "buy";
      fetch(`/api/v1/fund/fee-rate?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(fundCodeKey)}&feeType=${feeType}`)
        .then(r => r.json())
        .then(d => { if (!feeRateEdited && d.ok && d.rate != null) setFeeRate(String(d.rate)); })
        .catch(() => {});
      fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(fundCodeKey)}`)
        .then(r => r.json())
        .then(d => { if (!confirmDaysEdited && d.ok && d.days != null) { setConfirmDays(d.days); if (d.arrivalDays != null) setArrivalDays(d.arrivalDays); } })
        .catch(() => {});
    } else {
      fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(toAccountId)}`)
        .then(r => r.json())
        .then(d => { if (!confirmDaysEdited && d.ok && d.days != null) { setConfirmDays(d.days); if (d.arrivalDays != null) setArrivalDays(d.arrivalDays); } })
        .catch(() => {});
    }
  }, [mode, open, toAccountId, fundCodeKey, subtype]);

  const redeemGrossAmount = useMemo(() => {
    const navN = p(nav);
    const unitsN = p(units);
    return isRedeemLike(subtype) && navN > 0 && unitsN > 0 ? navN * unitsN : 0;
  }, [nav, units, subtype]);

  const computedFee = useMemo(() => {
    const amountN = p(amount);
    const rateN = p(feeRate);
    const baseAmount = isRedeemLike(subtype) && redeemGrossAmount > 0 ? redeemGrossAmount : amountN;
    if (baseAmount > 0 && rateN > 0 && showFeeFor(subtype, productType)) return (baseAmount * rateN / 100).toFixed(2);
    return "";
  }, [amount, feeRate, subtype, productType, redeemGrossAmount]);

  const computedUnits = useMemo(() => {
    const navN = p(nav);
    const amountN = p(amount);
    const effectiveFee = p(fee) > 0 ? p(fee) : (computedFee ? p(computedFee) : 0);
    if (navN > 0 && amountN > 0 && isBuyLike(subtype)) {
      const principal = amountN - effectiveFee;
      return principal > 0 ? (principal / navN).toFixed(3) : "";
    }
    if (isRedeemLike(subtype) && defaults?.fundUnits && defaults.fundUnits > 0) {
      return Number(defaults.fundUnits).toFixed(3);
    }
    if (navN > 0 && amountN > 0 && isRedeemLike(subtype)) {
      return (amountN / navN).toFixed(3);
    }
    return "";
  }, [nav, amount, fee, computedFee, subtype, defaults?.fundUnits]);

  function autoCalcUnits() {
    if (!isBuyLike(subtype)) return;
    if (unitsEditedRef.current) return;
    const navN = p(nav);
    const amountN = p(amount);
    const feeN = p(fee) > 0 ? p(fee) : (computedFee ? p(computedFee) : 0);
    if (navN <= 0 || amountN <= 0) return;
    const principal = amountN - feeN;
    const next = principal > 0 ? (principal / navN).toFixed(3) : "";
    if (next && next !== units) setUnits(next);
  }

  // 鈹€鈹€ Auto-calc units whenever nav/amount/fee change 鈹€鈹€
  useEffect(() => {
    autoCalcUnits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav, fee, computedFee]);

  function onAmountBlur() {
    // Auto-calc fee from rate when amount changes
    if (!feeEdited && showFeeFor(subtype, productType)) {
      const rate = p(feeRate) / 100;
      const base = isRedeemLike(subtype) && redeemGrossAmount > 0 ? redeemGrossAmount : p(amount);
      if (base > 0 && rate > 0) setFee((base * rate).toFixed(2));
    }
    autoCalcUnits();
  }



  useEffect(() => {
    if (!showFeeFor(subtype, productType) || feeEdited) return;
    setFee(computedFee || "");
  }, [computedFee, subtype, productType, feeEdited]);

  // 纭鏃ユ湡鑱斿姩锛氱敵璇锋棩鏈熷彉 鈫?纭鏃ユ湡鍙橈紝鍒拌处鏃ユ湡鑱斿姩锛坅rrivalDays > 0 鏃讹級
  useEffect(() => {
    if (mode === "edit" && !editAutoNavEnabledRef.current) return;
    if ((isBuyLike(subtype) || isRedeemLike(subtype)) && applyDate && confirmDays >= 0) {
      const nextConfirmDate = confirmDays > 0 ? addDays(applyDate, confirmDays) : applyDate;
      setConfirmDate(nextConfirmDate);
      // arrivalDays > 0 涓斿埌璐︽棩鏈熸湭琚墜宸ヤ慨鏀规椂鑷姩鎺ㄧ畻
      if (arrivalDays > 0 && !arrivalDateEditedRef.current) {
        setArrivalDate(addDays(nextConfirmDate, arrivalDays));
      }
    }
  }, [applyDate, confirmDays, subtype, open, arrivalDays, mode]);

  // 鍒拌处鏃ユ湡鎵嬪伐鍙樺寲鏃讹紝鑷姩璁＄畻 arrivalDays = diff(arrivalDate, confirmDate)锛屽瓨搴?
  const arrivalDateEditedRef = useRef(false);
  function onArrivalDateChange(val: string) {
    setArrivalDate(val);
    arrivalDateEditedRef.current = true;
    // 浠?arrivalDate 鍜?confirmDate 璁＄畻宸€?鈫?arrivalDays
    if (val && confirmDate) {
      const d1 = new Date(val + "T00:00:00Z");
      const d2 = new Date(confirmDate + "T00:00:00Z");
      const diff = Math.round((d1.getTime() - d2.getTime()) / 86400000);
      if (diff >= 0) {
        setArrivalDays(diff);
        // 瀛樺叆纭澶╂暟搴?
        if (toAccountId && fundCode.trim() && diff <= 3) {
          fetch("/api/v1/fund/confirm-days", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: toAccountId, fundCode: fundCode.trim(), arrivalDays: diff }),
          }).catch(() => {});
        }
      }
    }
  }

  // 璧庡洖妯″紡锛氭棩鏈熷彉鍖栨椂閲嶇畻鎸佷粨浠介锛堟湭鎵嬪姩淇敼浠介鏃讹級
  useEffect(() => {
    if (!isRedeemLike(subtype) || unitsEditedRef.current || !fundCode || !effectiveHoldings) return;
    const h = effectiveHoldings.find(p => p.fundCode === fundCode);
    if (h && h.units > 0) setUnits(Number(h.units).toFixed(3));
  }, [applyDate, effectiveHoldings, fundCode, subtype]);

  useEffect(() => {
    const code = fundCode.trim();
    if (!confirmDate || !code || !showUnitsFor(subtype, productType)) return;
    if (mode === "edit" && !editAutoNavEnabledRef.current) return;
    // Get nav after create defaults or explicit edit-field changes 鈥?debounce to avoid rapid API calls
    if (navDebounce.current) clearTimeout(navDebounce.current);
    navDebounce.current = setTimeout(() => {
      if (lastNavFetchedDate.current === confirmDate) return;
      lastNavFetchedDate.current = confirmDate;
      setNavLoading(true);
      fetch(`/api/v1/fund/nav?code=${encodeURIComponent(code)}&date=${encodeURIComponent(confirmDate)}`)
        .then(r => r.json())
        .then(d => {
          if (d.ok && d.nav) {
            setNavFromApi(String(d.nav));
            setNavActualDate(d.date && d.date !== confirmDate ? d.date : null);
          }
        })
        .catch(() => {})
        .finally(() => setNavLoading(false));
    }, 500);
    return () => { if (navDebounce.current) clearTimeout(navDebounce.current); };
  }, [confirmDate, fundCode, subtype, productType, mode, entry?.fundNav]);

  useEffect(() => {
    if (!isRedeemLike(subtype) || mode !== "create") return;
    const gross = redeemGrossAmount;
    const feeN = p(fee) > 0 ? p(fee) : (computedFee ? p(computedFee) : 0);
    // 鐢ㄦ埛鎵嬪姩鏀硅繃璧庡洖閲戦鏃朵笉鍐嶇敤 gross 瑕嗙洊锛屼互鐢ㄦ埛鍊间负鍑?
    const effectiveAmount = amountEditedRef.current ? p(amount) : gross;
    if (effectiveAmount <= 0) return;
    const key = effectiveAmount + feeN;
    if (Math.abs(key - redeemLastAppliedRef.current) < 0.005) return;
    redeemLastAppliedRef.current = key;
    setArrivalAmount(Math.max(0, effectiveAmount - feeN).toFixed(2));
    if (!amountEditedRef.current && gross > 0) setAmount(gross.toFixed(2));
  }, [redeemGrossAmount, amount, fee, computedFee, subtype, mode]);

  function resetForCreate(keepSubtype = false, options?: { preferDefaults?: boolean }) {
    // Read current fund from URL at click time (defaults prop may be stale from SSR)
    let urlFundCode = "";
    if (!options?.preferDefaults) {
      try {
        const q = new URLSearchParams(window.location.search);
        const view = q.get("view") ?? "";
        if (view === "investfund" || view === "investmoney") urlFundCode = q.get("fundCode") ?? "";
      } catch { /* SSR guard */ }
    }

    if (!keepSubtype) {
      setSubtype("buy");
      setCashAccountId("");
      setToAccountId(defaultAccountId);
      const nextFundCode = urlFundCode ? urlFundCode : (defaults?.fundCode ?? "");
      const nextFundName = urlFundCode ? (defaults?.fundName ?? urlFundCode) : (defaults?.fundName ?? "");
      setFundCode(nextFundCode);
      setFundName(nextFundName);
      setHoldingSearch(nextFundCode ? `${nextFundCode} ${nextFundName || nextFundCode}` : "");
      setFeeRate(defaults?.feeRate ?? "0");
      setFeeRateEdited(false);
    }
    // 鍏变韩閲嶇疆锛氭棩鏈熴€侀噾棰濄€佷唤棰濄€佸噣鍊笺€佹墜缁垂銆佸娉?
    setApplyDate(today);
    setConfirmDate(confirmDays > 0 ? addDays(today, confirmDays) : today);
    cashAccountTouchedRef.current = false;
    cashAccountAutoRef.current = false;
    prevSavedDateRef.current = null;
    setArrivalDate("");
    setArrivalAmount("");
    setArrivalDays(2);
    arrivalDateEditedRef.current = false;
    setNav("");
    setNavActualDate(null);
    setNavLoading(false);
    setUnits("");
    setAmount("");
    setFee("");
    setFeeEdited(false);
    setMemo("");
    unitsEditedRef.current = false;
    amountEditedRef.current = false;
    navEditedRef.current = false;
  }

  useEffect(() => {
    if (mode !== "create" || !openSignal) return;
    resetForCreate(false, { preferDefaults: true });
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);

  async function handleFundCodeBlur() {
    if (!open) return;
    const code = fundCode.trim();
    if (!code || code.length !== 6) return;

    setNameLoading(true);
    try {
      const res = await fetch(`/api/v1/fund/name?code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (data.ok && data.name) setFundName(data.name);
    } catch {} finally {
      setNameLoading(false);
    }

    fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(code)}`)
      .then(r => r.json())
      .then(d => { if (d.ok && d.days != null) { setConfirmDays(d.days); if (d.redeemCostDays != null) setRedeemCostDays(d.redeemCostDays); if (d.arrivalDays != null) setArrivalDays(d.arrivalDays); } })
      .catch(() => {});
    fetch(`/api/v1/fund/fee-rate?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(code)}&feeType=${isRedeemLike(subtype) ? "redeem" : "buy"}`)
      .then(r => r.json())
      .then(d => { if (d.ok && d.rate != null) setFeeRate(String(d.rate)); })
      .catch(() => {});
  }

  async function fetchNav() {
    if (!fundCode) return;
    const fetchDate = confirmDate || applyDate;
    setNavLoading(true);
    try {
      const res = await fetch(`/api/v1/fund/nav?code=${encodeURIComponent(fundCode)}&date=${encodeURIComponent(fetchDate)}`);
      const data = await res.json();
      if (data.ok && data.nav) {
        setNavFromApi(String(data.nav));
        setNavActualDate(data.date && data.date !== fetchDate ? data.date : null);
        const navN = data.nav;
        const amountN = p(amount);
        const feeN = p(fee);
        const effectiveFee = feeEdited ? feeN : (feeN > 0 ? feeN : (amountN * (p(feeRate) / 100)));
        if (isBuyLike(subtype) && navN > 0 && amountN > 0) {
          const principal = amountN - effectiveFee;
          if (principal > 0) setUnits((principal / navN).toFixed(3));
        }
        if (isRedeemLike(subtype) && navN > 0 && amountN > 0 && !arrivalAmount) setArrivalAmount(Math.max(0, amountN - effectiveFee).toFixed(2));
      } else {
        window.alert(data.error ?? `鍑€鍊艰幏鍙栧け璐?code=${fundCode},date=${fetchDate})`);
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "鍑€鍊艰幏鍙栧紓甯?");
    } finally {
      setNavLoading(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>, keepOpen = false) {
    e.preventDefault();
    if (submitting) return;
    const finalAmount = p(amount);
    // 鍒嗙孩鍐嶆姇璧勶細鍙渶浠介锛岄噾棰濈敱浠介脳鍑€鍊兼帹瀵兼垨涓?锛屽叾浠栫孩鍒╃被鍙渶閲戦
    if (isDividend(subtype) && subtype !== "dividend_cash") {
      // 鍒嗙孩鍐嶆姇璧勪笉闇€瑕侀噾棰濓紝涓嶅仛鎷︽埅
    } else if (!amount.trim() || finalAmount < 0) {
      window.alert("璇疯緭鍏ユ纭殑閲戦");
      return;
    }
    if (!isDividend(subtype) && confirmDate && confirmDate < applyDate) { window.alert("纭鏃ユ湡涓嶈兘鏃╀簬鐢宠鏃ユ湡"); return; }

    const finalUnits = p(units) > 0 ? p(units) : (computedUnits ? p(computedUnits) : 0);
    const finalFee = p(fee) > 0 ? p(fee) : (computedFee ? p(computedFee) : 0);
    const finalFeeRate = p(feeRate);

    // 鍒嗙孩鍐嶆姇璧勶細閲戦 = 浠介 脳 鍑€鍊?
    const effectiveAmount = subtype === "dividend_reinvest" && !(finalAmount > 0) && finalUnits > 0 && p(nav) > 0
      ? finalUnits * p(nav)
      : (subtype === "dividend_reinvest" && !(finalAmount > 0) ? 0 : finalAmount);

    // 浣跨敤鍩洪噾璐︽埛淇濆瓨璐圭巼鍜岀‘璁ゅぉ鏁帮紙鏂板鍜岀紪杈戦兘闇€瑕侊級
    if (!isDividend(subtype) && (productType === "fund" || productType === "money") && fundCode.trim() && finalFeeRate > 0 && showFeeFor(subtype, productType)) {
      fetch("/api/v1/fund/fee-rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: toAccountId, fundCode: fundCode.trim(), rate: finalFeeRate, feeType: isRedeemLike(subtype) ? "redeem" : "buy" }),
      }).catch(() => {});
    }
    if (isBuyLike(subtype) && confirmDays >= 0) {
      fetch("/api/v1/fund/confirm-days", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: toAccountId, fundCode: fundCode.trim() || undefined, days: confirmDays, arrivalDays: mode === "create" && arrivalDays > 3 ? undefined : arrivalDays }),
      }).catch(() => {});
    }
    if (fundCode.trim() && isRedeemLike(subtype)) {
      fetch("/api/v1/fund/confirm-days", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: toAccountId, fundCode: fundCode.trim(), redeemCostDays, arrivalDays: mode === "create" && arrivalDays > 3 ? undefined : arrivalDays }),
      }).catch(() => {});
    }

    const formData = new FormData();
    // dividend_cash 浣跨敤鐨勬棩鏈熷瓧娈垫槸 arrivalDate锛堝埌璐︽棩鏈燂級锛屼笉鏄?applyDate
    const effectiveDate = isDividend(subtype) ? (arrivalDate || applyDate) : applyDate;

    if (mode === "edit" && (entry || editEntryId)) {
      formData.set("intent", "editInvestment");
      formData.set("entryId", entry?.id || editEntryId || "");
      formData.set("transactionId", entry?.transactionId || "");
      formData.set("subtype", subtype);
      formData.set("date", effectiveDate);
      formData.set("amount", String(effectiveAmount));
      formData.set("memo", memo.trim());
      formData.set("fundCode", fundCode.trim());
      formData.set("fundName", fundName.trim());
      formData.set("fundProductType", productType);
      if (!isDividend(subtype) || subtype === "dividend_reinvest") {
        if (units.trim() || subtype === "dividend_reinvest") formData.set("fundUnits", units.trim() ? String(p(units)) : "");
      }
      if (!isDividend(subtype)) {
        formData.set("fundNav", nav.trim() ? String(p(nav)) : "");
        formData.set("fundFee", fee.trim() ? String(p(fee)) : "");
        formData.set("fundConfirmDate", confirmDate || "");
      }
      formData.set("accountId", toAccountId);
      formData.set("toAccountId", toAccountId);
      formData.set("cashAccountId", cashAccountId || "");
      if (isDividend(subtype)) {
        formData.set("fundArrivalDate", arrivalDate || effectiveDate);
      } else {
        formData.set("fundArrivalDate", arrivalDate || "");
        formData.set("fundArrivalAmount", isRedeemLike(subtype) && arrivalAmount.trim() ? String(p(arrivalAmount)) : "");
      }
      formData.set("feeRate", isDividend(subtype) ? "" : (feeRate.trim() ? feeRate : ""));
      formData.set("confirmDays", isDividend(subtype) ? "0" : String(confirmDays));
    } else {
      formData.set("type", "investment");
      formData.set("subtype", subtype);
      formData.set("accountId", toAccountId);
      if (cashAccountId) formData.set("cashAccountId", cashAccountId);
      formData.set("date", effectiveDate);
      formData.set("amount", String(effectiveAmount));
      formData.set("note", memo.trim() || fundName.trim() || fundCode.trim());
      formData.set("fundProductType", productType);
      if (fundCode.trim()) formData.set("fundCode", fundCode.trim());
      if (!isDividend(subtype) || subtype === "dividend_reinvest") {
        if (finalUnits > 0) formData.set("fundUnits", String(finalUnits));
      }
      if (!isDividend(subtype)) {
        if (p(nav) > 0) formData.set("fundNav", String(p(nav)));
        if (finalFee > 0) formData.set("fundFee", String(finalFee));
        if (confirmDate) formData.set("fundConfirmDate", confirmDate);
      }
      if (isDividend(subtype)) {
        if (arrivalDate) formData.set("fundArrivalDate", arrivalDate);
      } else if (isRedeemLike(subtype)) {
        if (arrivalDate) formData.set("fundArrivalDate", arrivalDate);
        if (p(arrivalAmount) > 0) formData.set("fundArrivalAmount", String(p(arrivalAmount)));
      }
      formData.set("redeemCostDays", String(redeemCostDays));
      formData.set('arrivalDays', String(arrivalDays));
    }
    try {
      const res = mode === "edit" && editAction ? await editAction(formData) : await createAction(formData);
      if (!res.ok) { window.alert(res.error); return; }
      if (mode === "create" && requestIdRef.current) {
        notifyAiSuccess(requestIdRef.current);
        requestIdRef.current = null;
      }
      if (keepOpen) {
        if (mode === "create") {
          // 鏍规嵁涓婃淇濆瓨闂撮殧鎺ㄧ畻涓嬫鐢宠鏃ユ湡
          const currentDate = applyDate;
          const prev = prevSavedDateRef.current;
          const intervalRaw = prev
            ? Math.round((new Date(currentDate + "T00:00:00Z").getTime() - new Date(prev + "T00:00:00Z").getTime()) / 86400000)
            : 1;
          const interval = intervalRaw >= 7 ? intervalRaw : 1;
          prevSavedDateRef.current = currentDate;
          const [y, m, d] = currentDate.split("-").map(Number);
          const next = new Date(Date.UTC(y, m - 1, d + interval));
          while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
          const nextDate = next.toISOString().slice(0, 10);
          setApplyDate(nextDate);
          setConfirmDate(confirmDays > 0 ? addDays(nextDate, confirmDays) : nextDate);
          setNav("");
          setNavLoading(false);
          setFee("");
          setFeeEdited(false);
          setMemo("");
          amountEditedRef.current = false;
          navEditedRef.current = false;
          setConfirmDaysEdited(true);
          arrivalDateEditedRef.current = false;
          // Preserve amount and fund, clear nav/units (user re-fetches or enters nav for new date)
          if (amount.trim() && fundCode.trim()) {
            // Check if nav is available in cache for the new date via API
            fetch(`/api/v1/fund/nav?code=${encodeURIComponent(fundCode.trim())}&date=${encodeURIComponent(nextDate)}`)
              .then(r => r.json())
              .then(d => {
                if (d.ok && d.nav) {
                  setNavFromApi(String(d.nav));
                  setNavActualDate(d.date && d.date !== nextDate ? d.date : null);
                  const navN = d.nav;
                  const amountN = p(amount);
                  if (navN > 0 && amountN > 0) {
                    const feeN = p(fee);
                    const effectiveFee = feeEdited ? feeN : (feeN > 0 ? feeN : (amountN * (p(feeRate) / 100)));
                    setUnits(((amountN - effectiveFee) / navN).toFixed(3));
                  }
                }
              })
              .catch(() => {});
          }
        }
        requestAnimationFrame(() => {
          window.dispatchEvent(new Event("mmh:fund:refresh"));
        });
      } else {
        setOpen(false);
        if (mode === "create") resetForCreate();
        requestAnimationFrame(() => {
          window.dispatchEvent(new Event("mmh:fund:refresh"));
        });
      }
    } catch (err) { window.alert(err instanceof Error ? err.message : (mode === "edit" ? "淇濆瓨澶辫触" : "璁拌处澶辫触")); }
    finally { setSubmitting(false); }
  }

  async function onDelete() {
    if (deleting || mode !== "edit" || !entry) return;
    if (!window.confirm("纭鍒犻櫎杩欐潯鍩洪噾璁板綍鍚楋紵")) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/v1/entries/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryIds: [entry.id] }),
      });
      const data = await res.json();
      if (!data.ok) { window.alert(data.error ?? "鍒犻櫎澶辫触"); return; }
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event("mmh:fund:refresh"));
      });
    } catch {
      window.alert("鍒犻櫎澶辫触");
    } finally {
      setDeleting(false);
    }
  }

  const showCode = productType === "fund" || productType === "money";
  const showFee = showFeeFor(subtype, productType);

  const title = mode === "edit" ? "缂栬緫鍩洪噾璁板綍" : "鎶曡祫璁拌处";
  useCloseOnNavigation(open, () => {
    setOpen(false);
    if (mode === "create") resetForCreate();
  });

  // 瑙﹀彂鎸夐挳
  const triggerButton = mode === "edit" ? (
    entry ? (
      <div className="flex h-7 shrink-0 items-center gap-1">
        <button type="button" onClick={() => setOpen(true)}
          className="secondary-button h-7 w-7 shrink-0 px-0 text-slate-500 hover:text-blue-600">
          <Pencil className="h-3.5 w-3.5 shrink-0" />
        </button>
        <button type="button" onClick={onDelete} disabled={deleting}
          className="secondary-button h-7 w-7 shrink-0 px-0 text-slate-500 hover:text-red-600 disabled:opacity-50">
          <Trash2 className="h-3.5 w-3.5 shrink-0" />
        </button>
      </div>
    ) : null
  ) : (
    <button type="button" onClick={() => { resetForCreate(); setOpen(true); }}
      className="primary-button h-8 gap-1 px-3 shadow-sm">
      <Plus className="w-4 h-4" />璁拌处
    </button>
  );

  return (
    <>
      {!hideTrigger ? triggerButton : null}

      {open && typeof document !== "undefined" ? createPortal(
        <div className="app-modal-backdrop z-[1000]">
          <div className="app-modal-panel max-w-md">
              <div className="modal-header shrink-0">
                <div className="text-sm font-semibold text-slate-800">
                  {title}
                  <span className="ml-2 text-xs font-normal text-slate-500">{PRODUCT_LABELS[productType]}</span>
                </div>
                <button type="button" onClick={() => { setOpen(false); if (mode === "create") resetForCreate(); }}
                  className="secondary-button h-8 px-2">鍏抽棴</button>
              </div>

              <form className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" onSubmit={onSubmit}>
              <div className="space-y-1">
                <div className="form-label">浜ゆ槗绫诲瀷</div>
                <div className="space-y-1.5">
                  {PRODUCT_SUBTYPES[productType].map((group, gi) => (
                    <div key={gi} className="flex gap-1.5">
                      {group.map((s) => (
                        <button key={s} type="button" onClick={() => selectSubtype(s)}
                          className={`segment-button h-8 flex-1 text-xs ${subtype === s ? "segment-button-active font-medium" : ""}`}>
                          {productType === "deposit" ? (DEPOSIT_LABELS[s as FundSubtype] ?? SUBTYPE_LABELS[s as FundSubtype]) : SUBTYPE_LABELS[s as FundSubtype]}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              {/* ===== 绾㈠埄绫伙細鏋佺畝甯冨眬 ===== */}
              {isDividend(subtype) ? (
                <>
                  {/* 鍒嗙孩鍐嶆姇璧勶細鍩洪噾璐︽埛 */}
                  {subtype === "dividend_reinvest" && investmentAccounts && investmentAccounts.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">鍩洪噾璐︽埛</div>
                      {renderInvestmentAccountSelect("閫夋嫨鍩洪噾璐︽埛")}
                    </div>
                  )}

                  {/* 鍒嗙孩鍐嶆姇璧勶細鍒拌处鏃ユ湡 */}
                  {subtype === "dividend_reinvest" && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">鍒拌处鏃ユ湡</div>
                      <DateStepper value={arrivalDate} onChange={setArrivalDate} />
                    </div>
                  )}

                  {/* 鐜伴噾绾㈠埄锛氬埌璐︽棩鏈?+ 璧勯噾璐︽埛 */}
                  {subtype === "dividend_cash" && (
                    <>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">鍒拌处鏃ユ湡</div>
                        <DateStepper value={arrivalDate} onChange={setArrivalDate} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {investmentAccounts && investmentAccounts.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-slate-600">鍩洪噾璐︽埛</div>
                            {renderInvestmentAccountSelect("閫夋嫨鍩洪噾璐︽埛")}
                          </div>
                        )}
                        {cashAccounts && cashAccounts.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-slate-600">鍒拌处璧勯噾璐︽埛</div>
                            {renderCashAccountSelect("涓嶅叧鑱?")}
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {/* 绾㈠埄绫伙細鎸佷範鍩洪噾鍙悳绱㈤€夋嫨 */}
                  {showCode && effectiveHoldings && effectiveHoldings.length > 0 ? (
                    <HoldingPicker
                      holdings={effectiveHoldings}
                      fundCode={fundCode}
                      fundName={fundName}
                      searchText={holdingSearch}
                      onSearchChange={setHoldingSearch}
                      onSelect={(h) => { changeFundCode(h.fundCode); setFundName(h.name); }}
                      onBlur={handleFundCodeBlur}
                    />
                  ) : showCode ? (
                    <div className="grid grid-cols-[1fr_2fr] gap-2 items-end">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">鍩洪噾浠ｇ爜</div>
                        <input
                          value={fundCode}
                          onChange={(e) => changeFundCode(e.target.value)}
                          onBlur={handleFundCodeBlur}
                          placeholder="6浣嶄唬鐮?"
                          className="form-input"
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">
                          基金名称
                          {nameLoading ? (
                            <span className="ml-1 font-normal text-slate-400">获取中...</span>
                          ) : null}
                        </div>
                        <input value={fundName} readOnly className="form-input" />
                      </div>
                    </div>
                  ) : null}

                  {/* 鐜伴噾绾㈠埄锛氶噾棰?*/}
                  {subtype === "dividend_cash" && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">鐜伴噾绾㈠埄閲戦</div>
                      <input ref={dividendAmountRef} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
                        className="form-input" />
                    </div>
                  )}

                  {/* 鍒嗙孩鍐嶆姇璧勶細浠介 */}
                  {subtype === "dividend_reinvest" && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">分红再投资份额</div>
                      <CalcInput
                        value={units}
                        onChange={(v) => {
                          unitsEditedRef.current = true;
                          setUnits(v);
                        }}
                        placeholder="0.00"
                        label="份额"
                        precision={3}
                      />
                    </div>
                  )}

                  {/* 澶囨敞 */}
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">备注</div>
                    <input
                      value={memo}
                      onChange={(e) => setMemo(e.target.value)}
                      placeholder="可选"
                      className="form-input"
                    />
                  </div>

                  {/* 淇濆瓨鎸夐挳 */}
                  <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex justify-end gap-2 border-t border-slate-100 bg-white/95 px-4 py-3 backdrop-blur">
                    {mode === "create" && (
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={(e) => {
                          e.preventDefault();
                          onSubmit(e as any, true);
                        }}
                        className="secondary-button h-9 px-4 text-blue-700 disabled:opacity-50"
                      >
                        {submitting ? "保存中..." : "保存并继续"}
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={submitting}
                      className="primary-button h-9 disabled:opacity-50"
                    >
                      {submitting ? "保存中..." : "保存"}
                    </button>
                  </div>
                </>
              ) : (
              <>
              {/* 鐢宠鏃ユ湡銆乀+N銆佺‘璁ゆ棩鏈?*/}
              <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">鐢宠鏃ユ湡</div>
                  <DateStepper value={applyDate} onChange={changeApplyDate}
                    onBlur={() => {
                      if (confirmDays >= 0 && applyDate) {
                        enableEditAutoNav();
                        setConfirmDate(confirmDays > 0 ? addDays(applyDate, confirmDays) : applyDate);
                      }
                    }} />
                </div>
                {showConfirmFor(subtype) && (
                  <div className="flex items-center gap-1 text-xs text-slate-600 shrink-0 pb-1">
                    <span>T+</span>
                    <input inputMode="numeric" value={confirmDays}
                      onChange={(e) => {
                        enableEditAutoNav();
                        const days = Number(e.target.value) || 0;
                        setConfirmDays(days);
                        setConfirmDaysEdited(true);
                        if (applyDate) setConfirmDate(addDays(applyDate, days));
                      }}
                      placeholder="0"
                      className="h-7 w-8 rounded-[8px] border border-slate-300/70 bg-white text-center text-xs outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
                  </div>
                )}
                {showConfirmFor(subtype) && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">纭鏃ユ湡</div>
                    <DateStepper value={confirmDate} onChange={changeConfirmDate} min={applyDate} />
                  </div>
                )}
              </div>

              {/* ===== 璧庡洖妯″紡涓撶敤甯冨眬 ===== */}
              {isRedeemLike(subtype) ? (
                <>
                  {/* 璧庡洖锛氬熀閲戣处鎴凤紙宸︼級 + 璧庡洖鍒拌处璐︽埛锛堝彸锛?*/}
                  {investmentAccounts && investmentAccounts.length > 0 && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">鍩洪噾璐︽埛</div>
                        {renderInvestmentAccountSelect("閫夋嫨鍩洪噾璐︽埛")}
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">璧庡洖鍒拌处璐︽埛</div>
                        {renderCashAccountSelect("请选择资金账户")}
                      </div>
                    </div>
                  )}

                  {/* 璧庡洖锛氭寔浠撳熀閲戝彲鎼滅储閫夋嫨 */}
                  {showCode && effectiveHoldings && effectiveHoldings.length > 0 ? (
                    <HoldingPicker
                      holdings={effectiveHoldings}
                      fundCode={fundCode}
                      fundName={fundName}
                      searchText={holdingSearch}
                      onSearchChange={setHoldingSearch}
                      onSelect={(h) => {
                        changeFundCode(h.fundCode);
                        setFundName(h.name);
                        if (!unitsEditedRef.current && h.units != null) setUnits(Number(h.units).toFixed(3));
                      }}
                      onBlur={handleFundCodeBlur}
                    />
                  ) : showCode ? (
                    <div className="grid grid-cols-[1fr_2fr] gap-2 items-end">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">基金代码</div>
                        <input
                          value={fundCode}
                          onChange={(e) => changeFundCode(e.target.value)}
                          onBlur={handleFundCodeBlur}
                          placeholder="6位代码"
                          className="form-input"
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">
                          基金名称
                          {nameLoading ? (
                            <span className="ml-1 font-normal text-slate-400">获取中...</span>
                          ) : null}
                        </div>
                        <input value={fundName} readOnly className="form-input" />
                      </div>
                    </div>
                  ) : null}
                  {!showCode && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">浜у搧鍚嶇О</div>
                      <input placeholder="渚嬪锛氭嫑琛屾湞鏈濆疂" value={fundName} onChange={(e) => setFundName(e.target.value)}
                        className="form-input" />
                    </div>
                  )}

                  <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">份额</div>
                      <CalcInput
                        value={units}
                        onChange={(v) => {
                          unitsEditedRef.current = true;
                          amountEditedRef.current = false;
                          setUnits(v);
                        }}
                        placeholder="0.00"
                        label="份额"
                        precision={3}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={fetchNav}
                      disabled={navLoading || !fundCode}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-amber-200 bg-amber-50 text-amber-700 transition-colors hover:border-amber-300 hover:bg-amber-100 disabled:opacity-50"
                      title="获取净值"
                    >
                      <DatabaseZap className={`h-4 w-4 ${navLoading ? "animate-pulse" : ""}`} />
                    </button>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">
                        净值
                        {navLoading ? (
                          <span className="ml-1 font-normal text-slate-400">获取中...</span>
                        ) : null}
                        {navActualDate && !navLoading ? (
                          <span className="ml-1 font-normal text-amber-600">({navActualDate}净值)</span>
                        ) : null}
                      </div>
                      <input
                        inputMode="decimal"
                        value={nav}
                        onChange={(e) => {
                          setNav(e.target.value);
                          navEditedRef.current = true;
                        }}
                        onBlur={autoCalcUnits}
                        placeholder="1.2345"
                        style={{ caretColor: "var(--foreground)" }}
                        className="form-input caret-slate-800"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">璧庡洖閲戦</div>
                    <input inputMode="decimal" value={amount} onChange={(e) => { amountEditedRef.current = true; setAmount(e.target.value); }} onBlur={autoCalcUnits}
                      style={{ caretColor: "var(--foreground)" }}
                      className="form-input caret-slate-800" />
                  </div>

                  {showFee && (
                    <div className="grid grid-cols-2 items-end gap-2">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">手续费率(%)</div>
                        <input
                          inputMode="decimal"
                          value={feeRate}
                          onChange={(e) => {
                            const nextRate = e.target.value;
                            setFeeRate(nextRate);
                            setFeeRateEdited(true);
                            if (!feeEdited) {
                              const rate = p(nextRate) / 100;
                              const baseAmount = redeemGrossAmount > 0 ? redeemGrossAmount : p(amount);
                              setFee(baseAmount > 0 && rate > 0 ? (baseAmount * rate).toFixed(2) : "");
                            }
                          }}
                          onBlur={() => {
                            if (!feeEdited) autoCalcUnits();
                          }}
                          placeholder="0.15"
                          style={{ caretColor: "var(--foreground)" }}
                          className="form-input caret-slate-800"
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">手续费金额</div>
                        <input
                          inputMode="decimal"
                          value={fee}
                          onChange={(e) => {
                            setFee(e.target.value);
                            setFeeEdited(true);
                          }}
                          onBlur={autoCalcUnits}
                          placeholder={computedFee || "0.00"}
                          style={{ caretColor: "var(--foreground)" }}
                          className="form-input caret-slate-800"
                        />
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">到账日期</div>
                      <DateStepper value={arrivalDate} onChange={onArrivalDateChange} min={applyDate} />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">到账金额</div>
                      <CalcInput value={arrivalAmount} onChange={setArrivalAmount} placeholder="可手动填写" label="到账金额" precision={2} />
                    </div>
                  </div>

                  {mode === "edit" && entry && (
                    <div className="space-y-1 rounded-md border border-emerald-100 bg-emerald-50/40 p-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-slate-600">赎回收益</span>
                        <span className={`tabular-nums font-semibold ${pnlCls(entry.realizedProfit)}`}>
                          {entry.realizedProfit != null ? entry.realizedProfit.toFixed(2) : "保存后计算"}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-400">按到账金额减去被赎回份额对应成本计算，保存后由持仓重算写回。</div>
                    </div>
                  )}
                </>
              ) : (
                <>
              {/* ===== 涔板叆/鍏朵粬妯″紡甯冨眬 ===== */}

              {/* 璧勯噾鏉ユ簮璐︽埛鍜屽熀閲戣处鎴?*/}
              {showAccountSelectorsFor(subtype) && cashAccounts && cashAccounts.length > 0 && investmentAccounts && investmentAccounts.length > 0 ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">璧勯噾鏉ユ簮璐︽埛</div>
                    {renderCashAccountSelect("请选择资金账户")}
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">鍩洪噾璐︽埛</div>
                    {renderInvestmentAccountSelect("閫夋嫨鍩洪噾璐︽埛")}
                  </div>
                </div>
              ) : showAccountSelectorsFor(subtype) && cashAccounts && cashAccounts.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">璧勯噾鏉ユ簮璐︽埛</div>
                  {renderCashAccountSelect("请选择资金账户")}
                </div>
              ) : investmentAccounts && investmentAccounts.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">鍩洪噾璐︽埛</div>
                  {renderInvestmentAccountSelect("閫夋嫨鍩洪噾璐︽埛")}
                </div>
              ) : null}

              {/* 鍩洪噾浠ｇ爜锛堟墜宸ヨ緭鍏ワ級+ 鍚嶇О */}
              {showCode ? (
                <div className="grid grid-cols-[1fr_2fr] items-end gap-2">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">基金代码</div>
                    <input
                      value={fundCode}
                      onChange={(e) => changeFundCode(e.target.value)}
                      onBlur={handleFundCodeBlur}
                      placeholder="6位代码"
                      className="form-input"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">
                      基金名称
                      {nameLoading ? (
                        <span className="ml-1 font-normal text-slate-400">获取中...</span>
                      ) : null}
                    </div>
                    <input value={fundName} readOnly className="form-input" />
                  </div>
                </div>
              ) : null}

              {!showCode && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">浜у搧鍚嶇О</div>
                  <input placeholder="渚嬪锛氭嫑琛屾湞鏈濆疂" value={fundName} onChange={(e) => setFundName(e.target.value)}
                    className="form-input" />
                </div>
              )}

              <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">
                    净值
                    {navLoading ? (
                      <span className="ml-1 font-normal text-slate-400">获取中...</span>
                    ) : null}
                    {navActualDate && !navLoading ? (
                      <span className="ml-1 font-normal text-amber-600">({navActualDate}净值)</span>
                    ) : null}
                  </div>
                  <input
                    inputMode="decimal"
                    value={nav}
                    onChange={(e) => setNav(e.target.value)}
                    onBlur={autoCalcUnits}
                    placeholder="1.2345"
                    className="form-input"
                  />
                </div>
                <button
                  type="button"
                  onClick={fetchNav}
                  disabled={navLoading || !fundCode}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-amber-200 bg-amber-50 text-amber-700 transition-colors hover:border-amber-300 hover:bg-amber-100 disabled:opacity-50"
                  title="获取净值"
                >
                  <DatabaseZap className={`h-4 w-4 ${navLoading ? "animate-pulse" : ""}`} />
                </button>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">
                    {isBuyLike(subtype) ? "买入金额" : "金额"}
                    {subtype === "dividend_reinvest" ? (
                      <span className="ml-1 font-normal text-slate-400">（留空则=份额×净值）</span>
                    ) : null}
                  </div>
                  <CalcInput
                    value={amount}
                    onChange={(v) => {
                      amountEditedRef.current = true;
                      setAmount(v);
                      onAmountBlur();
                    }}
                    label="金额"
                    placeholder={subtype === "dividend_reinvest" ? "由份额×净值自动计算" : undefined}
                    precision={2}
                  />
                </div>
              </div>

              {/* 涔板叆妯″紡锛氭墜缁垂鐜?| 鎵嬬画璐归噾棰?*/}
              {showFee && (
                <div className="grid grid-cols-2 gap-2 items-end">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">手续费率(%)</div>
                    <input inputMode="decimal" value={feeRate}
                      onChange={(e) => {
                        const nextRate = e.target.value;
                        setFeeRate(nextRate);
                        setFeeRateEdited(true);
                        if (!feeEdited) {
                          const rate = p(nextRate) / 100;
                          const baseAmount = p(amount);
                          setFee(baseAmount > 0 && rate > 0 ? (baseAmount * rate).toFixed(2) : "");
                        }
                      }}
                      onBlur={() => {
                        if (!feeEdited) autoCalcUnits();
                      }}
                      placeholder="0.15"
                      className="form-input" />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">手续费金额</div>
                    <input inputMode="decimal" value={fee}
                      onChange={(e) => { setFee(e.target.value); setFeeEdited(true); }}
                      onBlur={autoCalcUnits}
                      placeholder={computedFee || "0.00"}
                      className="form-input" />
                  </div>
                </div>
              )}

              {/* 鍒拌处鏃ユ湡 + 浠介 */}
              <div className="grid grid-cols-2 gap-2 items-end">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">到账日期</div>
                  <DateStepper value={arrivalDate} onChange={onArrivalDateChange} min={applyDate} />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">份额</div>
                  <CalcInput value={units}
                    onChange={(v) => { unitsEditedRef.current = true; setUnits(v); }}
                    placeholder={computedUnits || "0.00"}
                    label="份额" precision={3} />
                </div>
              </div>
                </>
              )}

              {/* 澶囨敞 */}
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">备注</div>
                <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="可选" className="form-input" />
              </div>

              <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex justify-end gap-2 border-t border-slate-100 bg-white/95 px-4 py-3 backdrop-blur">
                {mode === "create" && (
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={(e) => {
                      e.preventDefault();
                      onSubmit(e as any, true);
                    }}
                    className="secondary-button h-9 px-4 text-blue-700 disabled:opacity-50"
                  >
                    {submitting ? "保存中..." : "保存并继续"}
                  </button>
                )}
                <button
                  type="submit"
                  disabled={submitting}
                  className="primary-button h-9 disabled:opacity-50"
                >
                  {submitting ? "保存中..." : "保存"}
                </button>
              </div>
              </>
              )}
              </form>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}


