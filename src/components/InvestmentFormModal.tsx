"use client";

import { DatabaseZap, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { HoldingPicker } from "./HoldingPicker";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { formatFundUnitsValue, normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision-core";
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

const p = parseNumber;

// 编辑模式的入口数据。
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
  accountId?: string | null;
  toAccountId?: string | null;
  cashAccountId?: string | null;
  toAccountName?: string | null;
  fundArrivalDate?: string | null;
  fundArrivalAmount?: number | null;
  realizedProfit?: number | null;
};

// 新增模式的默认值。
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
  fundUnitsDecimals: fundUnitsDecimalsProp,
}: {
  mode: "create" | "edit";
  accountId: string;
  accountProductType?: string | null;
  entry?: InvestmentEntry;
  defaults?: InvestmentDefaults;
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
  fundUnitsDecimals?: number | null;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const fundUnitsDecimals = normalizeFundUnitsDecimals(fundUnitsDecimalsProp, 3);
  const formatUnits = (value: number) => formatFundUnitsValue(value, fundUnitsDecimals);

  const fixedProductType: ProductType =
    (["fund", "money", "wealth", "deposit"].includes(accountProductType ?? "")
      ? accountProductType as ProductType
      : (mode === "edit" && entry?.fundProductType && ["fund", "money", "wealth", "deposit"].includes(entry.fundProductType)
        ? entry.fundProductType as ProductType
        : "fund"));

  // 编辑旧记录时，把历史存储形态映射成当前表单展示类型。
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
  const initUnits = mode === "edit" && entry?.fundUnits != null ? formatUnits(Number(entry.fundUnits))
    : defaults?.fundUnits && defaults.fundUnits > 0 ? formatUnits(Number(defaults.fundUnits)) : "";
  const initFee = mode === "edit" && entry?.fundFee != null ? String(entry.fundFee) : "";
  // 买入类：现金账户 -> 基金账户；赎回类：基金账户 -> 现金账户。
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
  const initFeeRate = mode === "edit" ? "" : (defaults?.feeRate ?? "0");
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
  const suppressFeeAutoCalcRef = useRef(mode === "edit");

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
      title={`所有人：${cashOwnerFilterLabel}`}
      aria-label={`切换所有人，当前 ${cashOwnerFilterLabel}`}
      className="secondary-button !px-0 h-7 w-7 shrink-0 text-slate-500"
    >
      <Repeat className="h-3.5 w-3.5" />
    </button>
  ) : undefined;
  const investmentOwnerCycleButton = investmentAccountSSOptions?.some((option) => option.isHeader) ? (
    <button
      type="button"
      onClick={cycleInvestmentOwnerFilter}
      title={`所有人：${investmentOwnerFilterLabel}`}
      aria-label={`切换所有人，当前 ${investmentOwnerFilterLabel}`}
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

  function renderCashAccountSelect(placeholder = "请选择资金账户") {
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

  function renderInvestmentAccountSelect(placeholder = "请选择账户") {
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
    suppressFeeAutoCalcRef.current = true;
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
    if (mode === "create") {
      fetch(`/api/v1/fund/fee-rate?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(code)}&feeType=${isRedeemLike(subtype) ? "redeem" : "buy"}`)
        .then(r => r.json())
        .then(d => { if (d.ok && d.rate != null) setFeeRate(String(d.rate)); })
        .catch(() => {});
    }
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

  // AI 面板触发新增记账时，自动带入识别到的基金信息。
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

      // 从分类或交易对方中提取 6 位基金代码。
      const catCode = (detail.item.category ?? "").match(/\b(\d{6})\b/)?.[1];
      const cptyCode = (detail.item.counterparty ?? "").match(/\b(\d{6})\b/)?.[1];
      const fundCodeFromAi = catCode || cptyCode || "";

      const amt = detail.item.amount ?? 0;
      const aiDate = detail.item.date ?? today;
      const note = (detail.item.remark ?? detail.item.rawText ?? "").trim();
      const isRedeem = /赎回|卖出/.test(note + detail.item.rawText);
      const isDivCash = /现金红利/.test(note + detail.item.rawText);

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
      if (detail.fundUnits != null) setUnits(formatUnits(Number(detail.fundUnits)));
      if (detail.fundNav != null) setNav(String(detail.fundNav));
      if (detail.fundFee != null) setFee(String(detail.fundFee));
      if (detail.fundName) setFundName(detail.fundName);
      setFeeRate("");
      setFeeEdited(false);
      setFeeRateEdited(false);
      unitsEditedRef.current = false;
      amountEditedRef.current = false;
      navEditedRef.current = false;
      suppressFeeAutoCalcRef.current = true;
      setOpen(true);
    }

    window.addEventListener("mmh:investment:edit", onInvestmentEdit as EventListener);
    return () => window.removeEventListener("mmh:investment:edit", onInvestmentEdit as EventListener);
  }, [mode, today]);

  // Dispatch success event when create form is saved from AI panel
  function notifyAiSuccess(requestId: string) {
    window.dispatchEvent(new CustomEvent("mmh:create-transaction:success", { detail: { requestId } }));
  }

  // 赎回时只计算申请日前已确认或已到账的可用份额。
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
    // 赎回模式保留全部持仓选项，份额为 0 的历史数据也允许手动补录。
    return holdings.map(h => ({
      ...h,
      units: holdingsAsOfDate.has(h.fundCode) ? holdingsAsOfDate.get(h.fundCode)! : 0,
    }));
  }, [holdings, holdingsAsOfDate]);

  const subtypeGroups = PRODUCT_SUBTYPES[productType];
  const allSubtypes = subtypeGroups.flat();

  function selectSubtype(nextSubtype: FundSubtype) {
    if (isRedeemLike(nextSubtype) && !isRedeemLike(subtype)) {
      // 切到赎回时清空买入金额和费用，并优先带入当前持仓份额。
      setAmount("");
      setFee("");
      setFeeEdited(false);
      setFeeRate("0");
      setFeeRateEdited(false);
      amountEditedRef.current = false;
      const h = effectiveHoldings?.find(p => p.fundCode === fundCode);
      if (h && h.units > 0) setUnits(formatUnits(Number(h.units)));
      else if (defaults?.fundUnits && defaults.fundUnits > 0) setUnits(formatUnits(Number(defaults.fundUnits)));
      else setUnits("");
    }
    if (isBuyLike(nextSubtype) && !isBuyLike(subtype)) {
      // 切回买入时清空赎回金额、到账金额和相关自动计算状态。
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

  // 现金红利模式打开后聚焦到金额输入。
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

  // 新增模式打开后，按基金账户和基金代码补全资金账户、费率和确认天数。
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

  // 编辑模式打开后只刷新确认天数；手续费金额以当前记录为准，不重读费率库。
  useEffect(() => {
    if (mode !== "edit" || !open || !toAccountId || isDividend(subtype)) return;
    if (fundCodeKey) {
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
    const effectiveFee = p(fee) > 0 ? p(fee) : (!suppressFeeAutoCalcRef.current && computedFee ? p(computedFee) : 0);
    if (navN > 0 && amountN > 0 && isBuyLike(subtype)) {
      const principal = amountN - effectiveFee;
      return principal > 0 ? formatUnits(principal / navN) : "";
    }
    if (isRedeemLike(subtype) && defaults?.fundUnits && defaults.fundUnits > 0) {
      return formatUnits(Number(defaults.fundUnits));
    }
    if (navN > 0 && amountN > 0 && isRedeemLike(subtype)) {
      return formatUnits(amountN / navN);
    }
    return "";
  }, [nav, amount, fee, computedFee, subtype, defaults?.fundUnits]);

  function calculateBuyUnits(nextAmountRaw: string, nextFeeRaw: string) {
    suppressFeeAutoCalcRef.current = false;
    if (!isBuyLike(subtype) || unitsEditedRef.current) return;
    const navN = p(nav);
    const amountN = p(nextAmountRaw);
    const feeN = p(nextFeeRaw);
    if (navN <= 0 || amountN <= 0) return;
    const principal = amountN - feeN;
    const nextUnits = principal > 0 ? formatUnits(principal / navN) : "";
    if (nextUnits) setUnits(nextUnits);
  }

  function calculateUnitsAfterFeeChange(nextFeeRaw: string) {
    calculateBuyUnits(amount, nextFeeRaw);
  }

  function calculateUnitsAfterAmountChange(nextAmountRaw: string) {
    calculateBuyUnits(nextAmountRaw, fee);
  }

  function calculateFeeFromRate(nextRateRaw: string) {
    suppressFeeAutoCalcRef.current = false;
    setFeeEdited(false);
    const rate = p(nextRateRaw) / 100;
    const baseAmount = isRedeemLike(subtype) && redeemGrossAmount > 0 ? redeemGrossAmount : p(amount);
    const nextFee = baseAmount > 0 && rate > 0 ? (baseAmount * rate).toFixed(2) : "";
    const feeChanged = p(nextFee) !== p(fee);
    setFee(nextFee);

    if (feeChanged) {
      calculateUnitsAfterFeeChange(nextFee);
    }

    if (feeChanged && isRedeemLike(subtype) && !arrivalAmount) {
      const gross = redeemGrossAmount > 0 ? redeemGrossAmount : p(amount);
      if (gross > 0) setArrivalAmount(Math.max(0, gross - p(nextFee)).toFixed(2));
    }
  }

  // 申请日期变化时，联动确认日期和到账日期。
  useEffect(() => {
    if (mode === "edit" && !editAutoNavEnabledRef.current) return;
    if ((isBuyLike(subtype) || isRedeemLike(subtype)) && applyDate && confirmDays >= 0) {
      const nextConfirmDate = confirmDays > 0 ? addDays(applyDate, confirmDays) : applyDate;
      setConfirmDate(nextConfirmDate);
      // 到账天数已知且未手动改过到账日时，自动推导到账日期。
      if (arrivalDays > 0 && !arrivalDateEditedRef.current) {
        setArrivalDate(addDays(nextConfirmDate, arrivalDays));
      }
    }
  }, [applyDate, confirmDays, subtype, open, arrivalDays, mode]);

  // 手动修改到账日期时，反算并保存 arrivalDays。
  const arrivalDateEditedRef = useRef(false);
  function onArrivalDateChange(val: string) {
    setArrivalDate(val);
    arrivalDateEditedRef.current = true;
    // arrivalDate - confirmDate 得到到账天数。
    if (val && confirmDate) {
      const d1 = new Date(val + "T00:00:00Z");
      const d2 = new Date(confirmDate + "T00:00:00Z");
      const diff = Math.round((d1.getTime() - d2.getTime()) / 86400000);
      if (diff >= 0) {
        setArrivalDays(diff);
        // 只持久化常见短周期到账天数，避免偶发长间隔污染默认值。
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

  // 赎回模式下，日期变化后按当日可用持仓重算份额。
  useEffect(() => {
    if (!isRedeemLike(subtype) || unitsEditedRef.current || !fundCode || !effectiveHoldings) return;
    const h = effectiveHoldings.find(p => p.fundCode === fundCode);
    if (h && h.units > 0) setUnits(formatUnits(Number(h.units)));
  }, [applyDate, effectiveHoldings, fundCode, subtype]);

  useEffect(() => {
    const code = fundCode.trim();
    if (!confirmDate || !code || !showUnitsFor(subtype, productType)) return;
    if (mode === "edit" && !editAutoNavEnabledRef.current) return;
    // 防抖获取净值，避免日期和代码联动时连续请求。
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
    // 用户手动改过赎回金额后，不再用 gross 覆盖用户输入。
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
    // 重置日期、金额、份额、净值、手续费和备注。
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
    if (mode === "create") {
      fetch(`/api/v1/fund/fee-rate?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(code)}&feeType=${isRedeemLike(subtype) ? "redeem" : "buy"}`)
        .then(r => r.json())
        .then(d => { if (d.ok && d.rate != null) setFeeRate(String(d.rate)); })
        .catch(() => {});
    }
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
        const effectiveFee = feeN > 0 ? feeN : 0;
        if (isRedeemLike(subtype) && navN > 0 && amountN > 0 && !arrivalAmount) setArrivalAmount(Math.max(0, amountN - effectiveFee).toFixed(2));
      } else {
        window.alert(data.error ?? `净值获取失败 code=${fundCode},date=${fetchDate})`);
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "净值获取异常");
    } finally {
      setNavLoading(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>, keepOpen = false) {
    e.preventDefault();
    if (submitting) return;
    const finalAmount = p(amount);
    // 分红再投资不要求用户输入金额，金额可由份额和净值推导。
    if (isDividend(subtype) && subtype !== "dividend_cash") {
      // 只校验份额，不拦截空金额。
    } else if (!amount.trim() || finalAmount < 0) {
      window.alert("请输入正确的金额");
      return;
    }
    if (!isDividend(subtype) && confirmDate && confirmDate < applyDate) { window.alert("确认日期不能早于申请日期"); return; }

    const rawFinalUnits = p(units) > 0 ? p(units) : (mode === "create" && computedUnits ? p(computedUnits) : 0);
    const finalUnits = rawFinalUnits > 0 ? roundFundUnits(rawFinalUnits, fundUnitsDecimals) : 0;
    const finalFee = p(fee);
    const finalFeeRate = p(feeRate);

    // 分红再投资：金额 = 份额 * 净值。
    const effectiveAmount = subtype === "dividend_reinvest" && !(finalAmount > 0) && finalUnits > 0 && p(nav) > 0
      ? finalUnits * p(nav)
      : (subtype === "dividend_reinvest" && !(finalAmount > 0) ? 0 : finalAmount);

    // 只有手动修改过费率时，才把该确认日期的新费率写入费率库。
    if (mode === "create" && feeRateEdited && !isDividend(subtype) && (productType === "fund" || productType === "money") && fundCode.trim() && showFeeFor(subtype, productType)) {
      fetch("/api/v1/fund/fee-rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: toAccountId, fundCode: fundCode.trim(), rate: finalFeeRate, feeType: isRedeemLike(subtype) ? "redeem" : "buy", effectiveDate: confirmDate || applyDate }),
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
    // 现金红利使用到账日期作为记账日期。
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
        if (units.trim() || subtype === "dividend_reinvest") formData.set("fundUnits", finalUnits > 0 ? String(finalUnits) : "");
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
      if (feeRateEdited && !isDividend(subtype)) formData.set("feeRate", feeRate.trim() ? feeRate : "");
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
        formData.set("fundFee", finalFee > 0 ? String(finalFee) : "");
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
          // 保存并继续时按上次保存间隔推导下一笔申请日期。
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
                    setUnits(formatUnits((amountN - effectiveFee) / navN));
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
    } catch (err) { window.alert(err instanceof Error ? err.message : (mode === "edit" ? "保存失败" : "记账失败")); }
    finally { setSubmitting(false); }
  }

  async function onDelete() {
    if (deleting || mode !== "edit" || !entry) return;
    if (!window.confirm("确认删除这条基金记录吗？")) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/v1/entries/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryIds: [entry.id] }),
      });
      const data = await res.json();
      if (!data.ok) { window.alert(data.error ?? "删除失败"); return; }
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event("mmh:fund:refresh"));
      });
    } catch {
      window.alert("删除失败");
    } finally {
      setDeleting(false);
    }
  }

  const showCode = productType === "fund" || productType === "money";
  const showFee = showFeeFor(subtype, productType);

  const title = mode === "edit" ? "编辑基金记录" : "投资记账";
  useCloseOnNavigation(open, () => {
    setOpen(false);
    if (mode === "create") resetForCreate();
  });

  // 编辑模式显示图标按钮，新增模式显示“记账”按钮。
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
      <Plus className="w-4 h-4" />记账
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
                    className="secondary-button h-8 px-2">关闭</button>
              </div>

              <form className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" onSubmit={onSubmit}>
              <div className="space-y-1">
                <div className="form-label">交易类型</div>
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

              {isDividend(subtype) ? (
                <>
                  {subtype === "dividend_reinvest" && investmentAccounts && investmentAccounts.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">基金账户</div>
                      {renderInvestmentAccountSelect("选择基金账户")}
                    </div>
                  )}

                  {subtype === "dividend_reinvest" && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">到账日期</div>
                      <DateStepper value={arrivalDate} onChange={setArrivalDate} />
                    </div>
                  )}

                  {subtype === "dividend_cash" && (
                    <>
                      <div className="space-y-1">
                          <div className="text-xs font-medium text-slate-600">到账日期</div>
                        <DateStepper value={arrivalDate} onChange={setArrivalDate} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {investmentAccounts && investmentAccounts.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-slate-600">基金账户</div>
                            {renderInvestmentAccountSelect("选择基金账户")}
                          </div>
                        )}
                        {cashAccounts && cashAccounts.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-slate-600">到账资金账户</div>
                            {renderCashAccountSelect("不关联")}
                          </div>
                        )}
                      </div>
                    </>
                  )}

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

                  {subtype === "dividend_cash" && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">现金红利金额</div>
                      <input ref={dividendAmountRef} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
                        className="form-input" />
                    </div>
                  )}

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

                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">备注</div>
                    <input
                      value={memo}
                      onChange={(e) => setMemo(e.target.value)}
                      placeholder="可选"
                      className="form-input"
                    />
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
              ) : (
              <>
              <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">申请日期</div>
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
                    <div className="text-xs font-medium text-slate-600">确认日期</div>
                    <DateStepper value={confirmDate} onChange={changeConfirmDate} min={applyDate} />
                  </div>
                )}
              </div>

              {isRedeemLike(subtype) ? (
                <>
                  {investmentAccounts && investmentAccounts.length > 0 && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                          <div className="text-xs font-medium text-slate-600">基金账户</div>
                          {renderInvestmentAccountSelect("选择基金账户")}
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">赎回到账账户</div>
                        {renderCashAccountSelect("请选择资金账户")}
                      </div>
                    </div>
                  )}

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
                        if (!unitsEditedRef.current && h.units != null) setUnits(formatUnits(Number(h.units)));
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
                        <div className="text-xs font-medium text-slate-600">产品名称</div>
                      <input placeholder="例如：招行朝朝宝" value={fundName} onChange={(e) => setFundName(e.target.value)}
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
                        placeholder="1.2345"
                        style={{ caretColor: "var(--foreground)" }}
                        className="form-input caret-slate-800"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">赎回金额</div>
                    <input inputMode="decimal" value={amount} onChange={(e) => {
                        const nextAmount = e.target.value;
                        amountEditedRef.current = true;
                        setAmount(nextAmount);
                        calculateUnitsAfterAmountChange(nextAmount);
                      }}
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
                            calculateFeeFromRate(nextRate);
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
                            if (mode === "edit") return;
                            suppressFeeAutoCalcRef.current = false;
                            setFee(e.target.value);
                            setFeeEdited(true);
                            calculateUnitsAfterFeeChange(e.target.value);
                          }}
                          readOnly={mode === "edit"}
                          placeholder={computedFee || "0.00"}
                          style={{ caretColor: "var(--foreground)" }}
                          className={`form-input caret-slate-800 ${mode === "edit" ? "bg-slate-50 text-slate-500" : ""}`}
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
              {showAccountSelectorsFor(subtype) && cashAccounts && cashAccounts.length > 0 && investmentAccounts && investmentAccounts.length > 0 ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">资金来源账户</div>
                    {renderCashAccountSelect("请选择资金账户")}
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">基金账户</div>
                    {renderInvestmentAccountSelect("选择基金账户")}
                  </div>
                </div>
              ) : showAccountSelectorsFor(subtype) && cashAccounts && cashAccounts.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">资金来源账户</div>
                  {renderCashAccountSelect("请选择资金账户")}
                </div>
              ) : investmentAccounts && investmentAccounts.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">基金账户</div>
                  {renderInvestmentAccountSelect("选择基金账户")}
                </div>
              ) : null}

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
                  <div className="text-xs font-medium text-slate-600">产品名称</div>
                  <input placeholder="例如：招行朝朝宝" value={fundName} onChange={(e) => setFundName(e.target.value)}
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
                      calculateUnitsAfterAmountChange(v);
                    }}
                    label="金额"
                    placeholder={subtype === "dividend_reinvest" ? "由份额×净值自动计算" : undefined}
                    precision={2}
                  />
                </div>
              </div>

              {showFee && (
                <div className="grid grid-cols-2 gap-2 items-end">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">手续费率(%)</div>
                    <input inputMode="decimal" value={feeRate}
                      onChange={(e) => {
                        const nextRate = e.target.value;
                        setFeeRate(nextRate);
                        setFeeRateEdited(true);
                        calculateFeeFromRate(nextRate);
                      }}
                      placeholder="0.15"
                      className="form-input" />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">手续费金额</div>
                    <input inputMode="decimal" value={fee}
                      onChange={(e) => {
                        if (mode === "edit") return;
                        suppressFeeAutoCalcRef.current = false;
                        setFee(e.target.value);
                        setFeeEdited(true);
                        calculateUnitsAfterFeeChange(e.target.value);
                      }}
                      readOnly={mode === "edit"}
                      placeholder={computedFee || "0.00"}
                      className={`form-input ${mode === "edit" ? "bg-slate-50 text-slate-500" : ""}`} />
                  </div>
                </div>
              )}

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
