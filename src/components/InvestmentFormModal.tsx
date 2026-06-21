﻿﻿﻿﻿"use client";

import { ChevronDown, DatabaseZap, Pencil, Plus, Trash2 } from "lucide-react";
import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { HoldingPicker } from "./HoldingPicker";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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

// 本地简写别名
const p = parseNumber;

// 编辑模式的入口数据类型
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
  accountId?: string | null; // 数据库资金流向来源账户ID：赎回为基金账户，买入为资金账户
  toAccountId?: string | null; // 数据库资金流向去向账户ID：赎回为资金账户，买入为基金账户
  cashAccountId?: string | null;
  toAccountName?: string | null;
  fundArrivalDate?: string | null;
  fundArrivalAmount?: number | null;
  realizedProfit?: number | null;
};

// 新增模式的默认值类型
export type InvestmentDefaults = {
  fundCode?: string;
  fundName?: string;
  fundUnits?: number | null;
  confirmDays?: number | null;
  feeRate?: string | null;
};

export function InvestmentFormModal({
  mode,
  accountId: defaultAccountId,
  accountProductType,
  entry,
  defaults,
  cashAccounts,
  investmentAccounts,
  holdings,
  allEntries,
  createAction,
  editAction,
}: {
  mode: "create" | "edit";
  accountId: string; // 默认基金账户ID（新增模式）或当前账户ID（编辑模式）
  accountProductType?: string | null;
  entry?: InvestmentEntry; // 编辑模式必须提供
  defaults?: InvestmentDefaults; // 新增模式的默认值
  cashAccounts?: { id: string; label: string }[];
  investmentAccounts?: { id: string; label: string }[];
  holdings?: { fundCode: string; name: string; units: number }[];
  allEntries?: { date: string; fundConfirmDate?: string | null; fundArrivalDate?: string | null; fundCode: string; fundSubtype: string; fundUnits: number | null; source: string | null }[];
  createAction: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  editAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const fixedProductType: ProductType =
    (["fund", "money", "wealth", "deposit"].includes(accountProductType ?? "")
      ? accountProductType as ProductType
      : (mode === "edit" && entry?.fundProductType && ["fund", "money", "wealth", "deposit"].includes(entry.fundProductType)
        ? entry.fundProductType as ProductType
        : "fund"));

  // 编辑模式：从 entry 初始化
  // buy_failed：暂停申购显示为买入，资金退回显示为赎回（份额均为0）
  // buy + source=dividend：显示为 dividend_reinvest
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
  // 买入/dividend_cash：accountId=现金账户(来源), toAccountId=投资账户(去向)
  // 赎回/转换转出/buy_failed退回：accountId=投资账户(来源), toAccountId=现金账户(去向)
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
  const holdingDropdownRef = useRef<HTMLDivElement>(null);
  const [holdingSearch, setHoldingSearch] = useState(initFundCode && initFundName ? `${initFundCode} ${initFundName}` : "");
  const [showHoldingDropdown, setShowHoldingDropdown] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const dividendAmountRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef<string | null>(null);
  const pendingFundCodeFetchRef = useRef<string | null>(null);
  const redeemLastAppliedRef = useRef<number>(0);
  const prevSavedDateRef = useRef<string | null>(null);
  const editAutoNavEnabledRef = useRef(mode !== "edit");

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

  // Listen for AI panel "open create transaction" event — only in create mode
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

      // Extract fund code from category (基金·004011) or counterparty (基金004011)
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

  // 当前选中项的显示文本（用于判断搜索词是否只是默认选中值）
  const selectedHoldingText = useMemo(() =>
    fundCode && fundName ? `${fundCode} ${fundName}` : "",
    [fundCode, fundName]
  );

  // 当搜索词等于选中项文本时视为"未主动搜索"，下拉展开显示全部
  const isUserSearching = holdingSearch !== "" && holdingSearch !== selectedHoldingText;

  // 赎回模式：计算申请日期前已确认/到账的可赎回份额
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
    // 赎回模式：保留所有持仓基金在下拉列表，不因份额为 0 就剔除
    // 份额为 0 的仍可选，用户可手动输入份额（可能是历史数据补录）
    return holdings.map(h => ({
      ...h,
      units: holdingsAsOfDate.has(h.fundCode) ? holdingsAsOfDate.get(h.fundCode)! : 0,
    }));
  }, [holdings, holdingsAsOfDate]);

  const filteredHoldings = useMemo(() => {
    const base = effectiveHoldings ?? [];
    const filtered = isUserSearching
      ? base.filter(h => h.fundCode.includes(holdingSearch) || h.name.includes(holdingSearch))
      : base;
    return [...filtered].sort((a, b) => a.fundCode.localeCompare(b.fundCode));
  }, [effectiveHoldings, holdingSearch, isUserSearching]);

  const subtypeGroups = PRODUCT_SUBTYPES[productType];
  const allSubtypes = subtypeGroups.flat();

  // 下拉菜单：点击外部关闭，并恢复搜索词为选中项文本
  useEffect(() => {
    if (!showHoldingDropdown) return;
    function handleOutside(e: MouseEvent) {
      if (holdingDropdownRef.current && !holdingDropdownRef.current.contains(e.target as Node)) {
        setShowHoldingDropdown(false);
        if (isUserSearching) setHoldingSearch(selectedHoldingText);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [showHoldingDropdown, isUserSearching, selectedHoldingText]);

  function selectSubtype(nextSubtype: FundSubtype) {
    if (isRedeemLike(nextSubtype) && !isRedeemLike(subtype)) {
      // 切到赎回：重置买入的金额/份额/手续费，预填持仓份额
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
      // 切回买入：重置赎回的金额/份额/手续费/到账金额/费率
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

  // 现金红利模式：光标自动聚焦到金额输入框
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

  // 新增模式：打开时自动填充现金账户（费率/确认天数只用于买入/赎回）
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

  // 编辑模式：从库中获取 confirmDays 和 feeRate 的准确值（现金红利不需要）
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

  // ── Auto-calc units whenever nav/amount/fee change ──
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

  // 确认日期联动：申请日期变 → 确认日期变，到账日期联动（arrivalDays > 0 时）
  useEffect(() => {
    if (mode === "edit" && !editAutoNavEnabledRef.current) return;
    if ((isBuyLike(subtype) || isRedeemLike(subtype)) && applyDate && confirmDays >= 0) {
      const nextConfirmDate = confirmDays > 0 ? addDays(applyDate, confirmDays) : applyDate;
      setConfirmDate(nextConfirmDate);
      // arrivalDays > 0 且到账日期未被手工修改时自动推算
      if (arrivalDays > 0 && !arrivalDateEditedRef.current) {
        setArrivalDate(addDays(nextConfirmDate, arrivalDays));
      }
    }
  }, [applyDate, confirmDays, subtype, open, arrivalDays, mode]);

  // 到账日期手工变化时，自动计算 arrivalDays = diff(arrivalDate, confirmDate)，存库
  const arrivalDateEditedRef = useRef(false);
  function onArrivalDateChange(val: string) {
    setArrivalDate(val);
    arrivalDateEditedRef.current = true;
    // 从 arrivalDate 和 confirmDate 计算差值 → arrivalDays
    if (val && confirmDate) {
      const d1 = new Date(val + "T00:00:00Z");
      const d2 = new Date(confirmDate + "T00:00:00Z");
      const diff = Math.round((d1.getTime() - d2.getTime()) / 86400000);
      if (diff >= 0) {
        setArrivalDays(diff);
        // 存入确认天数库
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

  // 赎回模式：日期变化时重算持仓份额（未手动修改份额时）
  useEffect(() => {
    if (!isRedeemLike(subtype) || unitsEditedRef.current || !fundCode || !effectiveHoldings) return;
    const h = effectiveHoldings.find(p => p.fundCode === fundCode);
    if (h && h.units > 0) setUnits(Number(h.units).toFixed(3));
  }, [applyDate, effectiveHoldings, fundCode, subtype]);

  useEffect(() => {
    const code = fundCode.trim();
    if (!confirmDate || !code || !showUnitsFor(subtype, productType)) return;
    if (mode === "edit" && !editAutoNavEnabledRef.current) return;
    // Get nav after create defaults or explicit edit-field changes — debounce to avoid rapid API calls
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
    // 用户手动改过赎回金额时不再用 gross 覆盖，以用户值为准
    const effectiveAmount = amountEditedRef.current ? p(amount) : gross;
    if (effectiveAmount <= 0) return;
    const key = effectiveAmount + feeN;
    if (Math.abs(key - redeemLastAppliedRef.current) < 0.005) return;
    redeemLastAppliedRef.current = key;
    setArrivalAmount(Math.max(0, effectiveAmount - feeN).toFixed(2));
    if (!amountEditedRef.current && gross > 0) setAmount(gross.toFixed(2));
  }, [redeemGrossAmount, amount, fee, computedFee, subtype, mode]);

  function resetForCreate(keepSubtype = false) {
    // Read current fund from URL at click time (defaults prop may be stale from SSR)
    let urlFundCode = "";
    try {
      const q = new URLSearchParams(window.location.search);
      const view = q.get("view") ?? "";
      if (view === "investfund" || view === "investmoney") urlFundCode = q.get("fundCode") ?? "";
    } catch { /* SSR guard */ }

    if (!keepSubtype) {
      setSubtype("buy");
      setCashAccountId("");
      setToAccountId(defaultAccountId);
      setFundCode(urlFundCode ? urlFundCode : (defaults?.fundCode ?? ""));
      setFundName(urlFundCode ? (defaults?.fundName ?? urlFundCode) : (defaults?.fundName ?? ""));
      setFeeRate(defaults?.feeRate ?? "0");
      setFeeRateEdited(false);
    }
    // 共享重置：日期、金额、份额、净值、手续费、备注
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

  // 基金代码失焦时查询基金名称、费率、确认天数
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
        window.alert(data.error ?? `净值获取失败(code=${fundCode},date=${fetchDate})`);
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
    // 分红再投资：只需份额，金额由份额×净值推导或为0，其他红利类只需金额
    if (isDividend(subtype) && subtype !== "dividend_cash") {
      // 分红再投资不需要金额，不做拦截
    } else if (!amount.trim() || finalAmount < 0) {
      window.alert("请输入正确的金额");
      return;
    }
    if (!isDividend(subtype) && confirmDate && confirmDate < applyDate) { window.alert("确认日期不能早于申请日期"); return; }

    const finalUnits = p(units) > 0 ? p(units) : (computedUnits ? p(computedUnits) : 0);
    const finalFee = p(fee) > 0 ? p(fee) : (computedFee ? p(computedFee) : 0);
    const finalFeeRate = p(feeRate);

    // 分红再投资：金额 = 份额 × 净值
    const effectiveAmount = subtype === "dividend_reinvest" && !(finalAmount > 0) && finalUnits > 0 && p(nav) > 0
      ? finalUnits * p(nav)
      : (subtype === "dividend_reinvest" && !(finalAmount > 0) ? 0 : finalAmount);

    // 使用基金账户保存费率和确认天数（新增和编辑都需要）
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
    // dividend_cash 使用的日期字段是 arrivalDate（到账日期），不是 applyDate
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
          // 根据上次保存间隔推算下次申请日期
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

  // 触发按钮
  const triggerButton = mode === "edit" ? (
    entry ? (
      <div className="flex h-7 items-center gap-1">
        <button type="button" onClick={() => setOpen(true)}
          className="secondary-button h-7 w-7 px-0 text-slate-500 hover:text-blue-600">
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={onDelete} disabled={deleting}
          className="secondary-button h-7 w-7 px-0 text-slate-500 hover:text-red-600 disabled:opacity-50">
          <Trash2 className="w-3.5 h-3.5" />
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
      {triggerButton}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/28 p-4 backdrop-blur-[2px]">
          <div className="modal-surface w-full max-w-md">
            <div className="modal-header">
              <div className="text-sm font-semibold text-slate-800">
                {title}
                <span className="ml-2 text-xs font-normal text-slate-500">{PRODUCT_LABELS[productType]}</span>
              </div>
              <button type="button" onClick={() => { setOpen(false); if (mode === "create") resetForCreate(); }}
                className="secondary-button h-8 px-2">关闭</button>
            </div>

            <form className="p-4 space-y-3 overflow-y-auto max-h-[80vh]" onSubmit={onSubmit}>
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

              {/* ===== 红利类：极简布局 ===== */}
              {isDividend(subtype) ? (
                <>
                  {/* 分红再投资：基金账户 */}
                  {subtype === "dividend_reinvest" && investmentAccounts && investmentAccounts.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">基金账户</div>
                      <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}
                        className="form-input">
                        <option value="">选择基金账户</option>
                        {investmentAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                      </select>
                    </div>
                  )}

                  {/* 分红再投资：到账日期 */}
                  {subtype === "dividend_reinvest" && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">到账日期</div>
                      <DateStepper value={arrivalDate} onChange={setArrivalDate} />
                    </div>
                  )}

                  {/* 现金红利：到账日期 + 资金账户 */}
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
                            <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}
                              className="form-input">
                              <option value="">选择基金账户</option>
                              {investmentAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                            </select>
                          </div>
                        )}
                        {cashAccounts && cashAccounts.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-slate-600">到账资金账户</div>
                            <select value={cashAccountId} onChange={(e) => { cashAccountTouchedRef.current = true; cashAccountAutoRef.current = false; setCashAccountId(e.target.value); }}
                              className="form-input">
                              <option value="">不关聓</option>
                              {cashAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                            </select>
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {/* 红利类：持习基金可搜索选择 */}
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
                        <input value={fundCode} onChange={(e) => changeFundCode(e.target.value)} onBlur={handleFundCodeBlur} placeholder="6位代码"
                          className="form-input" />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">
                          基金名称{nameLoading && <span className="ml-1 text-slate-400 font-normal">获取中…</span>}
                        </div>
                        <input value={fundName} readOnly
                          className="form-input" />
                      </div>
                    </div>
                  ) : null}

                  {/* 现金红利：金额 */}
                  {subtype === "dividend_cash" && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">现金红利金额</div>
                      <input ref={dividendAmountRef} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
                        className="form-input" />
                    </div>
                  )}

                  {/* 分红再投资：份额 */}
                  {subtype === "dividend_reinvest" && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">分红再投资份额</div>
                      <CalcInput value={units}
                        onChange={(v) => { unitsEditedRef.current = true; setUnits(v); }}
                        placeholder="0.00" label="份额" />
                    </div>
                  )}

                  {/* 备注 */}
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">备注</div>
                    <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="可选"
                      className="form-input" />
                  </div>

                  {/* 保存按钮 */}
                  <div className="flex justify-end gap-2 pt-1">
                    {mode === "create" && (
                      <button type="button" disabled={submitting} onClick={(e) => { e.preventDefault(); onSubmit(e as any, true); }}
                        className="secondary-button h-9 px-4 text-blue-700 disabled:opacity-50">
                        {submitting ? "保存中…" : "保存并继续"}
                      </button>
                    )}
                    <button type="submit" disabled={submitting}
                      className="primary-button h-9 disabled:opacity-50">
                      {submitting ? "保存中…" : "保存"}
                    </button>
                  </div>
                </>
              ) : (
              <>
              {/* 申请日期、T+N、确认日期 */}
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

              {/* ===== 赎回模式专用布局 ===== */}
              {isRedeemLike(subtype) ? (
                <>
                  {/* 赎回：基金账户（左） + 赎回到账账户（右） */}
                  {investmentAccounts && investmentAccounts.length > 0 && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">基金账户</div>
                        <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}
                          className="form-input">
                          <option value="">选择基金账户</option>
                          {investmentAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">赎回到账账户</div>
                        <select value={cashAccountId} onChange={(e) => { cashAccountTouchedRef.current = true; cashAccountAutoRef.current = false; setCashAccountId(e.target.value); }}
                          className="form-input">
                          <option value="">不关联</option>
                          {cashAccounts?.map(a => <option key={a.id} value={a.id}>{a.label}</option>) ?? []}
                        </select>
                      </div>
                    </div>
                  )}

                  {/* 赎回：持仓基金可搜索选择 */}
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
                        <input value={fundCode} onChange={(e) => changeFundCode(e.target.value)} onBlur={handleFundCodeBlur} placeholder="6位代码"
                          className="form-input" />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">
                          基金名称{nameLoading && <span className="ml-1 text-slate-400 font-normal">获取中…</span>}
                        </div>
                        <input value={fundName} readOnly
                          className="form-input" />
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

                  {/* 赎回：份额 + 计算器 | 获取净值 + 净值 → 赎回金额 */}
                  <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">份额</div>
                      <CalcInput value={units}
                        onChange={(v) => { unitsEditedRef.current = true; amountEditedRef.current = false; setUnits(v); }}
                        placeholder="0.00"
                        label="份额" />
                    </div>
                    <button type="button" onClick={fetchNav} disabled={navLoading || !fundCode}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-amber-200 bg-amber-50 text-amber-700 transition-colors hover:border-amber-300 hover:bg-amber-100 disabled:opacity-50"
                      title="获取净值">
                      <DatabaseZap className={`h-4 w-4 ${navLoading ? "animate-pulse" : ""}`} />
                    </button>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">
                        净值{navLoading && <span className="ml-1 text-slate-400 font-normal">获取中…</span>}
                        {navActualDate && !navLoading && <span className="ml-1 text-amber-600 font-normal">({navActualDate}净值)</span>}
                      </div>
                      <input inputMode="decimal" value={nav} onChange={(e) => { setNav(e.target.value); navEditedRef.current = true; }} onBlur={autoCalcUnits}
                        placeholder="1.2345"
                        style={{ caretColor: "var(--foreground)" }}
                        className="form-input caret-slate-800" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">赎回金额</div>
                    <input inputMode="decimal" value={amount} onChange={(e) => { amountEditedRef.current = true; setAmount(e.target.value); }} onBlur={autoCalcUnits}
                      style={{ caretColor: "var(--foreground)" }}
                      className="form-input caret-slate-800" />
                  </div>

                  {/* 赎回：手续费率 + 手续费金额 */}
                  {showFee && (
                    <div className="grid grid-cols-2 gap-2 items-end">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">手续费率（%）</div>
                        <input inputMode="decimal" value={feeRate} onChange={(e) => {
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
                          className="form-input caret-slate-800" />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">手续费金额</div>
                        <input inputMode="decimal" value={fee} onChange={(e) => { setFee(e.target.value); setFeeEdited(true); }} onBlur={autoCalcUnits} placeholder={computedFee || "0.00"}
                          style={{ caretColor: "var(--foreground)" }}
                          className="form-input caret-slate-800" />
                      </div>
                    </div>
                  )}

                  {/* 赎回：到账日期 + 到账金额 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">到账日期</div>
                      <DateStepper value={arrivalDate} onChange={onArrivalDateChange} min={applyDate} />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">到账金额</div>
                      <CalcInput value={arrivalAmount} onChange={setArrivalAmount} placeholder="可手工填写" label="到账金额" />
                    </div>
                  </div>

                  {/* 赎回收益（编辑模式） */}
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
              {/* ===== 买入/其他模式布局 ===== */}

              {/* 资金来源账户和基金账户 */}
              {showAccountSelectorsFor(subtype) && cashAccounts && cashAccounts.length > 0 && investmentAccounts && investmentAccounts.length > 0 ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">资金来源账户</div>
                    <select value={cashAccountId} onChange={(e) => { cashAccountTouchedRef.current = true; cashAccountAutoRef.current = false; setCashAccountId(e.target.value); }}
                      className="form-input">
                      <option value="">不关联</option>
                      {cashAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">基金账户</div>
                    <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}
                      className="form-input">
                      <option value="">选择基金账户</option>
                      {investmentAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                    </select>
                  </div>
                </div>
              ) : showAccountSelectorsFor(subtype) && cashAccounts && cashAccounts.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">资金来源账户</div>
                  <select value={cashAccountId} onChange={(e) => { cashAccountTouchedRef.current = true; cashAccountAutoRef.current = false; setCashAccountId(e.target.value); }}
                    className="form-input">
                    <option value="">不关联</option>
                    {cashAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </div>
              ) : investmentAccounts && investmentAccounts.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">基金账户</div>
                  <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}
                    className="form-input">
                    <option value="">选择基金账户</option>
                    {investmentAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </div>
              ) : null}

              {/* 基金代码（手工输入）+ 名称 + 持仓快捷选择 */}
              {showCode ? (
                <>
                  <div className="grid grid-cols-[1fr_2fr_auto] gap-2 items-end">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">基金代码</div>
                      <input value={fundCode} onChange={(e) => changeFundCode(e.target.value)} onBlur={handleFundCodeBlur} placeholder="6位代码"
                        className="form-input" />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">
                        基金名称{nameLoading && <span className="ml-1 text-slate-400 font-normal">获取中…</span>}
                      </div>
                        <input value={fundName} readOnly
                          className="form-input" />
                    </div>
                    {effectiveHoldings && effectiveHoldings.length > 0 && (
                      <div className="flex items-end">
                        <button type="button" onClick={() => setShowHoldingDropdown(!showHoldingDropdown)}
                          className="secondary-button h-9 w-9 shrink-0 px-0 text-slate-500"
                          title="从持仓选择">
                          <ChevronDown className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </div>
                  {effectiveHoldings && effectiveHoldings.length > 0 && showHoldingDropdown && (
                    <div className="relative" ref={holdingDropdownRef}>
                      <div className="absolute z-50 w-full max-h-56 overflow-y-auto rounded-[12px] border border-slate-200/80 bg-white shadow-[0_18px_40px_rgba(15,23,42,0.12)]">
                        {filteredHoldings.map(h => (
                          <button key={h.fundCode} type="button" className="w-full border-b border-slate-100 px-3 py-2 text-left text-sm transition-colors hover:bg-blue-50/80 last:border-b-0"
                            onClick={() => {
                              changeFundCode(h.fundCode);
                              setFundName(h.name);
                              setShowHoldingDropdown(false);
                            }}>
                            <span className="font-medium">{h.fundCode}</span> <span className="text-slate-600">{h.name}</span>
                            <span className="text-slate-400 ml-1">（{Number(h.units).toFixed(3)}份）</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : null}

              {!showCode && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">产品名称</div>
                  <input placeholder="例如：招行朝朝宝" value={fundName} onChange={(e) => setFundName(e.target.value)}
                    className="form-input" />
                </div>
              )}

              {/* 净值 + 获取按钮 + 金额 */}
              <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">
                    净值{navLoading && <span className="ml-1 text-slate-400 font-normal">获取中…</span>}
                    {navActualDate && !navLoading && <span className="ml-1 text-amber-600 font-normal">({navActualDate}净值)</span>}
                  </div>
                  <input inputMode="decimal" value={nav} onChange={(e) => setNav(e.target.value)} onBlur={autoCalcUnits}
                    placeholder="1.2345"
                    className="form-input" />
                </div>
                <button type="button" onClick={fetchNav} disabled={navLoading || !fundCode}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-amber-200 bg-amber-50 text-amber-700 transition-colors hover:border-amber-300 hover:bg-amber-100 disabled:opacity-50"
                  title="获取净值">
                  <DatabaseZap className={`h-4 w-4 ${navLoading ? "animate-pulse" : ""}`} />
                </button>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{isBuyLike(subtype) ? "买入金额" : "金额"}{subtype === "dividend_reinvest" && <span className="ml-1 text-slate-400 font-normal">（留空则=份额×净值）</span>}</div>
                  <CalcInput value={amount} onChange={(v) => { amountEditedRef.current = true; setAmount(v); onAmountBlur(); }} label="金额" placeholder={subtype === "dividend_reinvest" ? "由份额×净值自动计算" : undefined} />
                </div>
              </div>

              {/* 买入模式：手续费率 | 手续费金额 */}
              {showFee && (
                <div className="grid grid-cols-2 gap-2 items-end">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">手续费率（%）</div>
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

              {/* 到账日期 + 份额 */}
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
                    label="份额" />
                </div>
              </div>
                </>
              )}

              {/* 备注 */}
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">备注</div>
                <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="可选"
                    className="form-input" />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                {mode === "create" && (
                  <button type="button" disabled={submitting} onClick={(e) => { e.preventDefault(); onSubmit(e as any, true); }}
                    className="secondary-button h-9 px-4 text-blue-700 disabled:opacity-50">
                    {submitting ? "保存中…" : "保存并继续"}
                  </button>
                )}
                <button type="submit" disabled={submitting}
                  className="primary-button h-9 disabled:opacity-50">
                  {submitting ? "保存中…" : "保存"}
                </button>
              </div>
              </>
              )}
            </form>
          </div>
        </div>
      )}
    </>
  );
}
