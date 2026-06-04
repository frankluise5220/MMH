"use client";

import { ChevronDown, DatabaseZap, Pencil, Plus, Trash2 } from "lucide-react";
import { CalcInput } from "./CalcInput";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
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
  showNavFor,
  showConfirmFor,
  showAccountSelectorsFor,
  showUnitsFor,
  showFeeFor,
  amountLabel,
  subtypeDisplay,
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
  accountId?: string | null; // 资金来源账户ID
  toAccountId?: string | null; // 基金账户ID
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
  createAction: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  editAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const router = useRouter();
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const fixedProductType: ProductType =
    (["fund", "money", "wealth", "deposit"].includes(accountProductType ?? "")
      ? accountProductType as ProductType
      : (mode === "edit" && entry?.fundProductType && ["fund", "money", "wealth", "deposit"].includes(entry.fundProductType)
        ? entry.fundProductType as ProductType
        : "fund"));

  // 编辑模式：从 entry 初始化
  // buy_failed：暂停申购显示为买入，资金退回显示为赎回（份额均为0）
  const initDisplaySubtype: FundSubtype = mode === "edit" && entry?.fundSubtype === "buy_failed"
    ? (entry?.source === "regular_invest_refund" ? "redeem" : "buy")
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
  const initArrivalDate = mode === "edit" ? (entry?.fundArrivalDate ?? "") : (initSubtype === "dividend_cash" ? today : "");
  const initArrivalAmount = mode === "edit" && entry?.fundArrivalAmount != null ? String(entry.fundArrivalAmount) : "";
  const initMemo = mode === "edit" ? (entry?.memo ?? entry?.note ?? "") : "";
  const initDate = mode === "edit" && entry ? entry.date : today;
  const initConfirmDate = mode === "edit" && entry ? (entry.confirmDate ?? "") : "";

  const [open, setOpen] = useState(false);
  const [productType] = useState<ProductType>(fixedProductType);
  const [subtype, setSubtype] = useState<FundSubtype>(initSubtype);
  const [switchDir, setSwitchDir] = useState<"in" | "out">("in");
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
  const [deleting, setDeleting] = useState(false);
  const [memo, setMemo] = useState(initMemo);
  const unitsEditedRef = useRef(false);
  const holdingDropdownRef = useRef<HTMLDivElement>(null);
  const [holdingSearch, setHoldingSearch] = useState(initFundCode && initFundName ? `${initFundCode} ${initFundName}` : "");
  const [showHoldingDropdown, setShowHoldingDropdown] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const dividendAmountRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef<string | null>(null);
  const pendingFundCodeFetchRef = useRef<string | null>(null);
  const redeemLastAppliedRef = useRef<number>(0);

  // Reset edit form state from entry props every time modal opens
  useEffect(() => {
    if (!open || mode !== "edit" || !entry) return;
    setSubtype(initSubtype);
    setSwitchDir("in");
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
      .then(d => { if (d.ok && d.days != null) setConfirmDays(d.days); })
      .catch(() => {});
    fetch(`/api/v1/fund/fee-rate?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(code)}&feeType=${isRedeemLike(subtype) ? "redeem" : "buy"}`)
      .then(r => r.json())
      .then(d => { if (d.ok && d.rate != null) setFeeRate(String(d.rate)); })
      .catch(() => {});
  }, [open, toAccountId, subtype]);

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

    window.addEventListener("wiseme:create-transaction:open", onOpenFromAi as EventListener);
    return () => window.removeEventListener("wiseme:create-transaction:open", onOpenFromAi as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, defaultAccountId, today, defaults]);

  // Dispatch success event when create form is saved from AI panel
  function notifyAiSuccess(requestId: string) {
    window.dispatchEvent(new CustomEvent("wiseme:create-transaction:success", { detail: { requestId } }));
  }

  // 当前选中项的显示文本（用于判断搜索词是否只是默认选中值）
  const selectedHoldingText = useMemo(() =>
    fundCode && fundName ? `${fundCode} ${fundName}` : "",
    [fundCode, fundName]
  );

  // 当搜索词等于选中项文本时视为"未主动搜索"，下拉展开显示全部
  const isUserSearching = holdingSearch !== "" && holdingSearch !== selectedHoldingText;

  const filteredHoldings = useMemo(() => {
    if (!isUserSearching) return holdings ?? [];
    return holdings?.filter(h =>
      h.fundCode.includes(holdingSearch) || h.name.includes(holdingSearch)
    ) ?? [];
  }, [holdings, holdingSearch, isUserSearching]);

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
    if (isRedeemLike(nextSubtype) && !isRedeemLike(subtype) && defaults?.fundUnits && defaults.fundUnits > 0) {
      setUnits(Number(defaults.fundUnits).toFixed(3));
    }
    if (isDividend(nextSubtype)) {
      if (!arrivalDate) setArrivalDate(today);
      // 现金红利：默认基金账户已有(toAccountId)，默认资金账户取第一个
      if (!cashAccountId && cashAccounts && cashAccounts.length > 0) {
        setCashAccountId(cashAccounts[0].id);
      }
      // 默认基金代码/名称从 defaults 填入
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
        .then(d => { if (d.ok && d.days != null) setConfirmDays(d.days); })
        .catch((e) => { console.error("Auto-fill error:", e); });
    } else {
      fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(toAccountId)}`)
        .then(r => r.json())
        .then(d => { if (d.ok && d.days != null) setConfirmDays(d.days); })
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
        .then(d => { if (!confirmDaysEdited && d.ok && d.days != null) setConfirmDays(d.days); })
        .catch(() => {});
    } else {
      fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(toAccountId)}`)
        .then(r => r.json())
        .then(d => { if (!confirmDaysEdited && d.ok && d.days != null) setConfirmDays(d.days); })
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
    if (!isBuyLike(subtype) && !isRedeemLike(subtype)) return;
    const navN = p(nav);
    const amountN = p(amount);
    const feeN = p(fee) > 0 ? p(fee) : (computedFee ? p(computedFee) : 0);
    if (navN <= 0 || amountN <= 0) return;
    if (isBuyLike(subtype)) {
      const principal = amountN - feeN;
      const next = principal > 0 ? (principal / navN).toFixed(3) : "";
      if (next && next !== units) setUnits(next);
    } else if (isRedeemLike(subtype)) {
      const next = (amountN / navN).toFixed(3);
      if (next !== units) setUnits(next);
    }
  }

  // ── Auto-calc units whenever nav/amount/fee change (not only on blur) ──
  useEffect(() => {
    autoCalcUnits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav, fee, computedFee]);

  function onAmountBlur() {
    // Auto-calc fee from rate when amount changes
    if (!feeEdited && showFeeFor(subtype, productType)) {
      const rate = p(feeRate) / 100;
      const amt = p(amount);
      if (amt > 0 && rate > 0) setFee((amt * rate).toFixed(2));
    }
    autoCalcUnits();
  }



  useEffect(() => {
    if (showFeeFor(subtype, productType) && !feeEdited && computedFee) setFee(computedFee);
  }, [computedFee, subtype, productType, feeEdited]);

  useEffect(() => {
    if ((isBuyLike(subtype) || isRedeemLike(subtype)) && applyDate && confirmDays >= 0) {
      const nextConfirmDate = confirmDays > 0 ? addDays(applyDate, confirmDays) : applyDate;
      setConfirmDate(nextConfirmDate);
      if (isRedeemLike(subtype)) setArrivalDate(addDays(nextConfirmDate, 1));
    }
  }, [applyDate, confirmDays, subtype]);

  useEffect(() => {
    const code = fundCode.trim();
    if (!confirmDate || !code || !showUnitsFor(subtype, productType)) return;
    if (mode === "edit" && entry?.fundNav != null) return;
    setNavLoading(true);
    fetch(`/api/v1/fund/nav?code=${encodeURIComponent(code)}&date=${encodeURIComponent(confirmDate)}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.nav) {
          setNav(String(d.nav));
          setNavActualDate(d.date && d.date !== confirmDate ? d.date : null);
        }
      })
      .catch(() => {})
      .finally(() => setNavLoading(false));
  }, [confirmDate, fundCode, subtype, productType, mode, entry?.fundNav]);

  useEffect(() => {
    if (!isRedeemLike(subtype) || mode !== "create") return;
    const gross = redeemGrossAmount;
    // Guard against feedback loop: only apply if gross actually changed
    if (Math.abs(gross - redeemLastAppliedRef.current) < 0.005) return;
    const feeN = p(fee) > 0 ? p(fee) : (computedFee ? p(computedFee) : 0);
    if (gross > 0) {
      const nextArrivalAmount = Math.max(0, gross - feeN).toFixed(2);
      redeemLastAppliedRef.current = parseFloat(nextArrivalAmount) + feeN;
      setArrivalAmount(nextArrivalAmount);
      setAmount(gross.toFixed(2));
    }
  }, [redeemGrossAmount, fee, computedFee, subtype, mode]);

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
    setSwitchDir("in");
    setApplyDate(today);
    setConfirmDate("");
    cashAccountTouchedRef.current = false;
    cashAccountAutoRef.current = false;
    setArrivalDate("");
    setArrivalAmount("");
    setNav("");
    setNavActualDate(null);
    setNavLoading(false);
    setUnits("");
    setAmount("");
    setFee("");
    setFeeEdited(false);
    setMemo("");
    unitsEditedRef.current = false;
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
      .then(d => { if (d.ok && d.days != null) setConfirmDays(d.days); })
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
        setNav(String(data.nav));
        setNavActualDate(data.date && data.date !== fetchDate ? data.date : null);
        const navN = data.nav;
        const amountN = p(amount);
        const feeN = p(fee);
        const effectiveFee = feeN > 0 ? feeN : amountN * 0.0015;
        if (isBuyLike(subtype) && navN > 0 && amountN > 0) {
          const principal = amountN - effectiveFee;
          if (principal > 0) setUnits((principal / navN).toFixed(3));
        } else if (isRedeemLike(subtype) && navN > 0 && amountN > 0) {
          setUnits((amountN / navN).toFixed(3));
        }
        if (isRedeemLike(subtype) && navN > 0 && amountN > 0 && !arrivalAmount) setArrivalAmount(Math.max(0, amountN - effectiveFee).toFixed(2));
      }
    } finally {
      setNavLoading(false);
    }
  }

  async function fetchName() {
    const code = fundCode.trim();
    if (!code) return;
    setNameLoading(true);
    try {
      const res = await fetch(`/api/v1/fund/nav?code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (data.ok) {
        if (data.name) setFundName(data.name);
        if (data.nav && !confirmDate) setNav(String(data.nav));
      }
      if (confirmDate) {
        const dateRes = await fetch(`/api/v1/fund/nav?code=${encodeURIComponent(code)}&date=${encodeURIComponent(confirmDate)}`);
        const dateData = await dateRes.json();
        if (dateData.ok && dateData.nav) {
          setNav(String(dateData.nav));
        } else if (!data.ok && !data.nav) {
          window.alert(dateData.error ?? data.error ?? "获取失败");
          return;
        }
      }
      if (!confirmDate && !data.ok) {
        window.alert(data.error ?? "获取失败");
      }
    } catch { window.alert("获取失败"); }
    finally { setNameLoading(false); }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>, keepOpen = false) {
    e.preventDefault();
    if (submitting) return;
    const finalAmount = p(amount);
    if (!amount.trim() || !finalAmount) { window.alert("请输入正确的金额"); return; }
    if (!isDividend(subtype) && confirmDate && confirmDate < applyDate) { window.alert("确认日期不能早于申请日期"); return; }

    const finalUnits = p(units) > 0 ? p(units) : (computedUnits ? p(computedUnits) : 0);
    const finalFee = p(fee) > 0 ? p(fee) : (computedFee ? p(computedFee) : 0);
    const finalFeeRate = p(feeRate);

    // 使用基金账户保存费率和确认天数（新增和编辑都需要）
    if (!isDividend(subtype) && (productType === "fund" || productType === "money") && fundCode.trim() && finalFeeRate > 0 && showFeeFor(subtype, productType)) {
      fetch("/api/v1/fund/fee-rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: toAccountId, fundCode: fundCode.trim(), rate: finalFeeRate, feeType: isRedeemLike(subtype) ? "redeem" : "buy" }),
      }).catch(() => {});
    }
    if (isBuyLike(subtype) && confirmDays > 0) {
      fetch("/api/v1/fund/confirm-days", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: toAccountId, fundCode: fundCode.trim() || undefined, days: confirmDays }),
      }).catch(() => {});
    }

    const formData = new FormData();
    // dividend_cash 使用的日期字段是 arrivalDate（到账日期），不是 applyDate
    const effectiveDate = isDividend(subtype) ? (arrivalDate || applyDate) : applyDate;

    if (mode === "edit" && entry) {
      formData.set("intent", "editInvestment");
      formData.set("entryId", entry.id);
      formData.set("transactionId", entry.transactionId);
      formData.set("subtype", entry?.fundSubtype ?? subtype);
      formData.set("date", effectiveDate);
      formData.set("amount", String(finalAmount));
      formData.set("memo", memo.trim());
      formData.set("fundCode", fundCode.trim());
      formData.set("fundName", fundName.trim());
      formData.set("fundProductType", productType);
      if (!isDividend(subtype)) {
        formData.set("fundUnits", units.trim() ? String(p(units)) : "");
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
        formData.set("fundArrivalDate", isRedeemLike(subtype) ? arrivalDate : "");
        formData.set("fundArrivalAmount", isRedeemLike(subtype) && arrivalAmount.trim() ? String(p(arrivalAmount)) : "");
      }
      formData.set("feeRate", isDividend(subtype) ? "" : (feeRate.trim() ? feeRate : ""));
      formData.set("confirmDays", isDividend(subtype) ? "0" : String(confirmDays));
    } else {
      formData.set("type", "investment");
      formData.set("subtype", entry?.fundSubtype ?? subtype);
      formData.set("accountId", toAccountId);
      if (cashAccountId) formData.set("cashAccountId", cashAccountId);
      formData.set("date", effectiveDate);
      formData.set("amount", String(finalAmount));
      formData.set("note", memo.trim() || fundName.trim() || fundCode.trim());
      formData.set("fundProductType", productType);
      if (fundCode.trim()) formData.set("fundCode", fundCode.trim());
      if (!isDividend(subtype)) {
        if (finalUnits > 0) formData.set("fundUnits", String(finalUnits));
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
    }

    setSubmitting(true);
    try {
      const res = mode === "edit" && editAction ? await editAction(formData) : await createAction(formData);
      if (!res.ok) { window.alert(res.error); return; }
      if (mode === "create" && requestIdRef.current) {
        notifyAiSuccess(requestIdRef.current);
        requestIdRef.current = null;
      }
      if (keepOpen) {
        if (mode === "create") {
          // Advance date by 1, keep amount, clear units/nav/fee
          const nextDate = addDays(applyDate, 1);
          setApplyDate(nextDate);
          setConfirmDate(confirmDays > 0 ? addDays(nextDate, confirmDays) : nextDate);
          setNav("");
          setNavLoading(false);
          setUnits("");
          setFee("");
          setFeeEdited(false);
          setMemo("");
          unitsEditedRef.current = false;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        router.refresh();
      } else {
        setOpen(false);
        if (mode === "create") resetForCreate();
        await new Promise(resolve => setTimeout(resolve, 100));
        router.refresh();
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
      await new Promise(resolve => setTimeout(resolve, 100));
      router.refresh();
    } catch {
      window.alert("删除失败");
    } finally {
      setDeleting(false);
    }
  }

  const showCode = productType === "fund" || productType === "money";
  const showUnits = showUnitsFor(subtype, productType);
  const showFee = showFeeFor(subtype, productType);

  const title = mode === "edit" ? "编辑基金记录" : "投资记账";

  // 触发按钮
  const triggerButton = mode === "edit" ? (
    <div className="flex items-center gap-1">
      <button type="button" onClick={() => setOpen(true)}
        className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:text-blue-600 hover:border-blue-200">
        <Pencil className="w-3.5 h-3.5" />
      </button>
      <button type="button" onClick={onDelete} disabled={deleting}
        className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:text-red-600 hover:border-red-200 disabled:opacity-50">
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  ) : (
    <button type="button" onClick={() => { resetForCreate(); setOpen(true); }}
      className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 flex items-center gap-1 shadow-sm">
      <Plus className="w-4 h-4" />记账
    </button>
  );

  return (
    <>
      {triggerButton}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-md rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">
                {title}
                <span className="ml-2 text-xs font-normal text-slate-500">{PRODUCT_LABELS[productType]}</span>
              </div>
              <button type="button" onClick={() => { setOpen(false); if (mode === "create") resetForCreate(); }}
                className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">关闭</button>
            </div>

            <form className="p-4 space-y-3 overflow-y-auto max-h-[80vh]" onSubmit={onSubmit}>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">交易类型</div>
                <div className="space-y-1.5">
                  {PRODUCT_SUBTYPES[productType].map((group, gi) => (
                    <div key={gi} className="flex gap-1.5">
                      {group.map((s) => (
                        <button key={s} type="button" onClick={() => selectSubtype(s)}
                          className={`h-8 flex-1 rounded-md border text-xs ${subtype === s ? "bg-blue-50 text-blue-700 border-blue-200 font-medium" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                          {productType === "deposit" ? (DEPOSIT_LABELS[s as FundSubtype] ?? SUBTYPE_LABELS[s as FundSubtype]) : SUBTYPE_LABELS[s as FundSubtype]}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              {/* ===== 现金红利：极简布局 ===== */}
              {isDividend(subtype) ? (
                <>
                  {/* 现金红利：到账日期 */}
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">到账日期</div>
                    <input type="date" value={arrivalDate} onChange={(e) => setArrivalDate(e.target.value)}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                  </div>

                  {/* 现金红利：基金账户 + 到账资金账户 */}
                  <div className="grid grid-cols-2 gap-3">
                    {investmentAccounts && investmentAccounts.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">基金账户</div>
                        <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                          <option value="">选择基金账户</option>
                          {investmentAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                        </select>
                      </div>
                    )}
                    {cashAccounts && cashAccounts.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">到账资金账户</div>
                        <select value={cashAccountId} onChange={(e) => { cashAccountTouchedRef.current = true; cashAccountAutoRef.current = false; setCashAccountId(e.target.value); }}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                          <option value="">不关联</option>
                          {cashAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                        </select>
                      </div>
                    )}
                  </div>

                  {/* 现金红利：持仓基金可搜索选择 */}
                  {showCode && holdings && holdings.length > 0 ? (
                    <div className="relative space-y-1" ref={holdingDropdownRef}>
                      <div className="text-xs font-medium text-slate-600">持仓基金</div>
                      <div className="flex gap-1">
                        <input value={holdingSearch} onChange={(e) => {
                          setHoldingSearch(e.target.value);
                          setShowHoldingDropdown(true);
                          if (/^\d{6}$/.test(e.target.value)) {
                            setFundCode(e.target.value);
                            const h = holdings.find(p => p.fundCode === e.target.value);
                            if (h) setFundName(h.name);
                            else setFundName("");
                          } else {
                            setFundCode("");
                            setFundName("");
                          }
                        }}
                          onFocus={() => setShowHoldingDropdown(true)}
                          onBlur={handleFundCodeBlur}
                          placeholder="输入代码或名称筛选…"
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                        <button type="button" onClick={() => setShowHoldingDropdown(!showHoldingDropdown)}
                          className="h-9 w-9 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 shrink-0">
                          <ChevronDown className="h-4 w-4" />
                        </button>
                      </div>
                      {showHoldingDropdown && filteredHoldings.length > 0 && (
                        <div className="absolute z-50 mt-0 w-full max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
                          {filteredHoldings.map(h => (
                            <button key={h.fundCode} type="button" className="w-full text-left px-3 py-1.5 text-sm hover:bg-blue-50 border-b border-slate-100 last:border-b-0"
                              onClick={() => {
                                setFundCode(h.fundCode);
                                setFundName(h.name);
                                setHoldingSearch(`${h.fundCode} ${h.name}`);
                                setShowHoldingDropdown(false);
                              }}>
                              <span className="font-medium">{h.fundCode}</span> <span className="text-slate-600">{h.name}</span>
                              <span className="text-slate-400 ml-1">（{Number(h.units).toFixed(3)}份）</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : showCode ? (
                    <div className="grid grid-cols-[1fr_2fr] gap-2 items-end">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">基金代码</div>
                        <input value={fundCode} onChange={(e) => setFundCode(e.target.value)} onBlur={handleFundCodeBlur} placeholder="6位代码"
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">
                          基金名称{nameLoading && <span className="ml-1 text-slate-400 font-normal">获取中…</span>}
                        </div>
                        <input value={fundName} readOnly
                          className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none text-slate-600 cursor-not-allowed" />
                      </div>
                    </div>
                  ) : null}

                  {/* 现金红利：金额 */}
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">现金红利金额</div>
                    <input ref={dividendAmountRef} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                  </div>
                </>
              ) : (
              <>
              {/* 申请日期、T+N、确认日期 */}
              <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">申请日期</div>
                  <input type="date" value={applyDate}
                    onChange={(e) => setApplyDate(e.target.value)}
                    onBlur={() => {
                      if (confirmDays >= 0 && applyDate) {
                        setConfirmDate(confirmDays > 0 ? addDays(applyDate, confirmDays) : applyDate);
                      }
                    }}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                </div>
                {showConfirmFor(subtype) && (
                  <div className="flex items-center gap-1 text-xs text-slate-600 shrink-0 pb-1">
                    <span>T+</span>
                    <input inputMode="numeric" value={confirmDays}
                      onChange={(e) => {
                        const days = Number(e.target.value) || 0;
                        setConfirmDays(days);
                        setConfirmDaysEdited(true);
                        if (applyDate) setConfirmDate(addDays(applyDate, days));
                      }}
                      placeholder="0"
                      className="h-7 w-8 rounded border border-slate-200 bg-white text-xs outline-none px-1 text-center" />
                  </div>
                )}
                {showConfirmFor(subtype) && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">确认日期</div>
                    <input type="date" value={confirmDate} min={applyDate}
                      onChange={(e) => setConfirmDate(e.target.value)}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
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
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                          <option value="">选择基金账户</option>
                          {investmentAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">赎回到账账户</div>
                        <select value={cashAccountId} onChange={(e) => { cashAccountTouchedRef.current = true; cashAccountAutoRef.current = false; setCashAccountId(e.target.value); }}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                          <option value="">不关联</option>
                          {cashAccounts?.map(a => <option key={a.id} value={a.id}>{a.label}</option>) ?? []}
                        </select>
                      </div>
                    </div>
                  )}

                  {/* 赎回：持仓基金可搜索选择（输入筛选+下拉列表） */}
                  {showCode && holdings && holdings.length > 0 ? (
                    <div className="relative space-y-1" ref={holdingDropdownRef}>
                      <div className="text-xs font-medium text-slate-600">持仓基金</div>
                      <div className="flex gap-1">
                        <input value={holdingSearch} onChange={(e) => {
                          setHoldingSearch(e.target.value);
                          setShowHoldingDropdown(true);
                          // 输入6位数字时视为手工输入基金代码
                          if (/^\d{6}$/.test(e.target.value)) {
                            setFundCode(e.target.value);
                            const h = holdings.find(p => p.fundCode === e.target.value);
                            if (h) { setFundName(h.name); if (!unitsEditedRef.current) setUnits(Number(h.units).toFixed(3)); }
                            else { setFundName(""); }
                          } else {
                            setFundCode("");
                            setFundName("");
                          }
                        }}
                          onFocus={() => setShowHoldingDropdown(true)}
                          onBlur={handleFundCodeBlur}
                          placeholder="输入代码或名称筛选…"
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                        <button type="button" onClick={() => setShowHoldingDropdown(!showHoldingDropdown)}
                          className="h-9 w-9 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 shrink-0">
                          <ChevronDown className="h-4 w-4" />
                        </button>
                      </div>
                      {showHoldingDropdown && filteredHoldings.length > 0 && (
                        <div className="absolute z-50 mt-0 w-full max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
                          {filteredHoldings.map(h => (
                            <button key={h.fundCode} type="button" className="w-full text-left px-3 py-1.5 text-sm hover:bg-blue-50 border-b border-slate-100 last:border-b-0"
                              onClick={() => {
                                setFundCode(h.fundCode);
                                setFundName(h.name);
                                setHoldingSearch(`${h.fundCode} ${h.name}`);
                                if (!unitsEditedRef.current) setUnits(Number(h.units).toFixed(3));
                                setShowHoldingDropdown(false);
                              }}>
                              <span className="font-medium">{h.fundCode}</span> <span className="text-slate-600">{h.name}</span>
                              <span className="text-slate-400 ml-1">（{Number(h.units).toFixed(3)}份）</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : showCode ? (
                    <div className="grid grid-cols-[1fr_2fr] gap-2 items-end">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">基金代码</div>
                        <input value={fundCode} onChange={(e) => setFundCode(e.target.value)} onBlur={handleFundCodeBlur} placeholder="6位代码"
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">
                          基金名称{nameLoading && <span className="ml-1 text-slate-400 font-normal">获取中…</span>}
                        </div>
                        <input value={fundName} readOnly
                          className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none text-slate-600 cursor-not-allowed" />
                      </div>
                    </div>
                  ) : null}
                  {!showCode && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">产品名称</div>
                      <input placeholder="例如：招行朝朝宝" value={fundName} onChange={(e) => setFundName(e.target.value)}
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                    </div>
                  )}

                  {/* 赎回：份额 + 计算器 | 获取净值 + 净值 → 赎回金额 */}
                  <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">份额</div>
                      <CalcInput value={units}
                        onChange={(v) => { unitsEditedRef.current = true; setUnits(v); }}
                        placeholder="0.00"
                        label="份额" />
                    </div>
                    <button type="button" onClick={fetchNav} disabled={navLoading || !fundCode}
                      className="h-9 w-9 flex items-center justify-center rounded-md border border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-300 hover:bg-amber-100 disabled:opacity-50 shrink-0"
                      title="获取净值">
                      <DatabaseZap className={`h-4 w-4 ${navLoading ? "animate-pulse" : ""}`} />
                    </button>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">
                        净值{navLoading && <span className="ml-1 text-slate-400 font-normal">获取中…</span>}
                        {navActualDate && !navLoading && <span className="ml-1 text-amber-600 font-normal">({navActualDate}净值)</span>}
                      </div>
                      <input inputMode="decimal" value={nav} onChange={(e) => setNav(e.target.value)} onBlur={autoCalcUnits}
                        placeholder="1.2345"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">赎回金额</div>
                    <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={autoCalcUnits}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                  </div>

                  {/* 赎回：手续费率 + 手续费金额 */}
                  {showFee && (
                    <div className="grid grid-cols-2 gap-2 items-end">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">手续费率（%）</div>
                        <input inputMode="decimal" value={feeRate} onChange={(e) => { setFeeRate(e.target.value); setFeeRateEdited(true); }}
                          onBlur={() => {
                            const rate = p(feeRate) / 100;
                            const baseAmount = redeemGrossAmount > 0 ? redeemGrossAmount : p(amount);
                            if (baseAmount > 0 && rate > 0) {
                              setFee((baseAmount * rate).toFixed(2));
                              setFeeEdited(true);
                            }
                          }}
                          placeholder="0.15"
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">手续费金额</div>
                        <input inputMode="decimal" value={fee} onChange={(e) => { setFee(e.target.value); setFeeEdited(true); }} onBlur={autoCalcUnits} placeholder={computedFee || "0.00"}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                      </div>
                    </div>
                  )}

                  {/* 赎回：到账日期 + 到账金额 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">到账日期</div>
                      <input type="date" value={arrivalDate} min={applyDate} onChange={(e) => setArrivalDate(e.target.value)}
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">到账金额</div>
                      <input inputMode="decimal" value={arrivalAmount} onChange={(e) => setArrivalAmount(e.target.value)} placeholder="可手工填写"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
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
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                      <option value="">不关联</option>
                      {cashAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">基金账户</div>
                    <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                      <option value="">选择基金账户</option>
                      {investmentAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                    </select>
                  </div>
                </div>
              ) : showAccountSelectorsFor(subtype) && cashAccounts && cashAccounts.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">资金来源账户</div>
                  <select value={cashAccountId} onChange={(e) => { cashAccountTouchedRef.current = true; cashAccountAutoRef.current = false; setCashAccountId(e.target.value); }}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                    <option value="">不关联</option>
                    {cashAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </div>
              ) : investmentAccounts && investmentAccounts.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">基金账户</div>
                  <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                    <option value="">选择基金账户</option>
                    {investmentAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </div>
              ) : null}

              {/* 基金代码 + 名称 */}
              {showCode && (
                <div className="grid grid-cols-[1fr_2fr] gap-2 items-end">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">基金代码</div>
                    <input value={fundCode} onChange={(e) => setFundCode(e.target.value)} onBlur={handleFundCodeBlur} placeholder="6位代码"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">
                      基金名称{nameLoading && <span className="ml-1 text-slate-400 font-normal">获取中…</span>}
                    </div>
                    <input value={fundName} readOnly
                      className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none text-slate-600 cursor-not-allowed" />
                  </div>
                </div>
              )}

              {!showCode && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">产品名称</div>
                  <input placeholder="例如：招行朝朝宝" value={fundName} onChange={(e) => setFundName(e.target.value)}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
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
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                </div>
                <button type="button" onClick={fetchNav} disabled={navLoading || !fundCode}
                  className="h-9 w-9 flex items-center justify-center rounded-md border border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-300 hover:bg-amber-100 disabled:opacity-50 shrink-0"
                  title="获取净值">
                  <DatabaseZap className={`h-4 w-4 ${navLoading ? "animate-pulse" : ""}`} />
                </button>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{isBuyLike(subtype) ? "买入金额" : "金额"}</div>
                  <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={onAmountBlur}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                </div>
              </div>

              {/* 买入模式：手续费率 | 手续费金额 */}
              {showFee && (
                <div className="grid grid-cols-2 gap-2 items-end">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">手续费率（%）</div>
                    <input inputMode="decimal" value={feeRate}
                      onChange={(e) => { setFeeRate(e.target.value); setFeeRateEdited(true); }}
                      onBlur={() => {
                        const rate = p(feeRate) / 100;
                        const baseAmount = p(amount);
                        if (baseAmount > 0 && rate > 0) {
                          setFee((baseAmount * rate).toFixed(2));
                          setFeeEdited(true);
                        }
                      }}
                      placeholder="0.15"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">手续费金额</div>
                    <input inputMode="decimal" value={fee}
                      onChange={(e) => { setFee(e.target.value); setFeeEdited(true); }}
                      onBlur={autoCalcUnits}
                      placeholder={computedFee || "0.00"}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                  </div>
                </div>
              )}

              {/* 份额 */}
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">份额</div>
                <CalcInput value={units}
                  onChange={(v) => { unitsEditedRef.current = true; setUnits(v); }}
                  placeholder={computedUnits || "0.00"}
                  label="份额" />
              </div>
                </>
              )}

              {/* 备注 */}
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">备注</div>
                <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="可选"
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                {mode === "create" && (
                  <button type="button" disabled={submitting} onClick={(e) => { e.preventDefault(); onSubmit(e as any, true); }}
                    className="h-9 px-4 rounded-md border border-blue-200 bg-blue-50 text-blue-700 text-sm hover:bg-blue-100 disabled:opacity-50">
                    {submitting ? "保存中…" : "保存并继续"}
                  </button>
                )}
                <button type="submit" disabled={submitting}
                  className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50">
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