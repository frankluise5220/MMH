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
import { calculateDepositAccruedInterest, depositRenewalStartUtc } from "@/lib/deposit-maturity";
import {
  DEFAULT_DEPOSIT_TERM_DAYS,
  splitTermDays,
  TERM_UNIT_DAYS,
  type DepositTermUnit,
} from "@/lib/deposit-term";
import {
  clampDepositInterestPayoutInterval,
  encodeDepositInterestPayout,
  foldDepositPayoutWeekToDay,
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
  depositProductId?: string | null;
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
type DepositProductOption = {
  id: string;
  name: string;
  shortName?: string | null;
  currency?: string | null;
  institutionId?: string | null;
  annualRate?: number | null;
  termDays?: number | null;
  note?: string | null;
};
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
  /** 存单所挂存款产品的名称，仅用于显示（老存单 fundName 为 null，名称在产品上）。 */
  productName?: string | null;
  depositProductId?: string | null;
  startDate?: string | null;
  maturityDate?: string | null;
  remainingAmount: number;
  annualRate?: number | null;
  latestInterestDate?: string | null;
  depositAccountId?: string;
  depositAccountLabel?: string;
  status?: "open" | "closed";
};
type EditingRedeemSource = {
  id: string;
  fundName: string;
  /** 存单所挂存款产品的名称，仅用于显示（老存单 fundName 是占位名时靠它兜底）。 */
  productName?: string | null;
  depositProductId?: string | null;
  startDate?: string | null;
  maturityDate?: string | null;
  depositAccountId?: string;
  depositAccountLabel?: string;
  restoredRemainingAmount: number;
  annualRate?: number | null;
  latestInterestDate?: string | null;
};

/** 续存建新存单时，被结清的旧存单快照（来自存单行「续存」入口）。 */
type RenewSourceInfo = {
  lotId: string;
  fundName: string;
  depositProductId?: string | null;
  /** 旧存单起存日（计息区间起点）。 */
  startDate?: string | null;
  /** 旧存单到期日 = 取出日 = 新存单起存日。 */
  maturityDate?: string | null;
  /** 旧存单剩余本金。 */
  principal: number;
  /** 旧存单这一段应计利息（整月按 月数/12 计）。 */
  interest: number;
  annualRate?: number | null;
  maturityAction?: string | null;
  interestPayoutFrequency?: string | null;
  interestCalcBasis?: string | null;
  depositAccountId?: string;
  depositAccountLabel?: string;
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
  renewAction,
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
  /**
   * 存单续存：弹窗以「存款存入」表单预填新存单要素，提交时改走续存动作
   * （旧存单在取出日结清，同时建出一张新存单）。不传则续存入口不可用。
   */
  renewAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const { t } = useI18n();
  const parentModalZIndex = useModalLayerZIndex();
  const modalZIndex = getNextModalLayerZIndex(parentModalZIndex);

  const initIsRedeem = mode === "edit" && entry ? entry.amount > 0 : false;
  const initAmount = mode === "edit" && entry ? String(Math.abs(entry.amount)) : "";
  const initDate = mode === "edit" && entry?.date ? entry.date.slice(0, 10) : today;
  const initName = mode === "edit" && entry?.fundName ? entry.fundName : "";
  const initDepositProductId = mode === "edit" && entry?.depositProductId ? entry.depositProductId : "";
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
  const [depositProductId, setDepositProductId] = useState(initDepositProductId);
  const [depositProducts, setDepositProducts] = useState<DepositProductOption[]>([]);
  // 镜像一份最新产品列表给下面的机构同步 effect 用：effect 的依赖里不能加 depositProducts，
  // 否则它自己 setDepositProducts 会再触发一轮请求。用它来判断「已选产品属于哪个机构」。
  const depositProductsRef = useRef<DepositProductOption[]>([]);
  useEffect(() => {
    depositProductsRef.current = depositProducts;
  }, [depositProducts]);
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [productSaving, setProductSaving] = useState(false);
  const [productError, setProductError] = useState("");
  const [productDraft, setProductDraft] = useState({
    name: "",
    shortName: "",
    annualRate: "",
    termDays: "",
    note: "",
  });
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
  // 取款本金「用户已手动编辑」标记：用户输入过金额后，不再被「选中存单时自动填剩余本金」覆盖，
  // 否则部分取款（如取 1013）会被 selectedRedeemLot 的 effect 强制改回剩余本金全额（2026-09-30 事故）。
  const [amountEdited, setAmountEdited] = useState(false);
  const [cashAccountId, setCashAccountId] = useState(initCashAccountId);
  const [depositAccountId, setDepositAccountId] = useState(initDepositAccountId);
  const [selectedRedeemLotId, setSelectedRedeemLotId] = useState("");
  const [memo, setMemo] = useState(initMemo);
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const [editingRedeemSource, setEditingRedeemSource] = useState<EditingRedeemSource | null>(null);
  // 续存来源存单：非空时本弹窗处于「续存建新存单」模式，提交走 renewAction。
  const [renewSource, setRenewSource] = useState<RenewSourceInfo | null>(null);
  const [renewMode, setRenewMode] = useState<"renew_principal" | "renew_principal_interest">(
    "renew_principal_interest",
  );
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
  // 取息周期选项只有 天/月/年；老存单的 "weekly" 折成等价的「每 N 天」，避免选中项落空。
  const initPayout = foldDepositPayoutWeekToDay(
    parseDepositInterestPayout(mode === "edit" ? entry?.depositInterestPayoutFrequency : null),
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
  const [fetchedRedeemLotOptions, setFetchedRedeemLotOptions] = useState<RedeemLotOption[]>([]);
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
    filteredOptions: depositFiltered,
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

  const depositProductOptions: SmartSelectOption[] = useMemo(
    () => depositProducts.map((product) => ({
      id: product.id,
      label: product.shortName?.trim() || product.name,
      subLabel: product.shortName?.trim() ? product.name : undefined,
    })),
    [depositProducts],
  );

  function openDepositProductModal() {
    const count = Math.trunc(parseNumber(termCount));
    const draftTermDays = Number.isFinite(count) && count > 0 ? String(count * TERM_UNIT_DAYS[termUnit]) : "";
    setProductDraft({
      name: fundName.trim(),
      shortName: "",
      annualRate,
      termDays: draftTermDays,
      note: "",
    });
    setProductError("");
    setProductModalOpen(true);
  }

  async function saveDepositProduct() {
    const name = productDraft.name.trim();
    if (!productInstitutionId) {
      setProductError(t("txForm.alert.selectCashSourceAccount"));
      return;
    }
    if (!name) {
      setProductError(t("wealthForm.alert.enterProductName"));
      return;
    }
    setProductSaving(true);
    setProductError("");
    try {
      const res = await fetch("/api/v1/deposit-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          shortName: productDraft.shortName.trim() || undefined,
          institutionId: productInstitutionId || undefined,
          currency: selectedDepositAccount?.currency ?? selectedCashAccount?.currency ?? "CNY",
          annualRate: productDraft.annualRate || undefined,
          termDays: productDraft.termDays || undefined,
          note: productDraft.note.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok || !data.product) throw new Error(data?.error ?? t("depositForm.alert.createProductFailed"));
      const product = data.product as DepositProductOption;
      setDepositProducts((prev) => {
        const next = prev.filter((item) => item.id !== product.id);
        next.push(product);
        return next.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
      });
      setDepositProductId(product.id);
      setFundName(product.name);
      if (product.annualRate != null && !annualRate.trim()) setAnnualRate(String(product.annualRate));
      if (product.termDays != null && !termCount.trim()) {
        const termSplit = splitTermDays(Number(product.termDays));
        setTermUnit(termSplit.unit);
        setTermCount(String(termSplit.count));
      }
      setProductModalOpen(false);
    } catch (err) {
      setProductError(err instanceof Error ? err.message : t("depositForm.alert.createProductFailed"));
    } finally {
      setProductSaving(false);
    }
  }

  const redeemDepositOptions = useMemo(
    () => depositAccountList.filter((option) => isDepositLikeOption(option)),
    [depositAccountList],
  );
  const isRedeem = subtype === "redeem";
  const isRenew = !!renewSource;
  // 本息续存：本息原地滚入新存单，不经过外部资金账户，资金账户选择无意义。
  const isRenewRollIn = isRenew && renewMode === "renew_principal_interest";
  // 期间付息的存单利息已逐期付过，没有可滚入的利息。
  const rollInDisabledForRenew =
    !!renewSource && parseDepositInterestPayout(renewSource.interestPayoutFrequency ?? null).kind === "periodic";
  /**
   * 取回存单下拉的显示名。
   *
   * 存单名称有三个来源，且**老存单的 fundName 是 null**（真实名称挂在
   * `DepositProduct.name` 上，接口以 `productName` 返回）：
   *   - `fundName` —— 存单自身名称（`/api/v1/deposit/lots` 返回）
   *   - `label`    —— 父级（存单列表）/ 编辑态算好的显示名
   *   - `productName` —— 所挂存款产品的名称
   * 父级与编辑态在拿不到名字时会塞入占位名「未命名存款」，那不是真实名称：
   * 必须跳过占位名，否则产品名会被它盖住，下拉渲染成「有记录、没文字」的空条目
   * （2026-10-01 用户报障：刚打开能看到两条存单，约 2 秒后接口返回把选项覆盖成空白）。
   */
  const redeemLotDisplayName = useCallback(
    (lot: RedeemLotOption) => {
      const placeholders = new Set([t("depositForm.unnamedDeposit"), t("sidebar.deposit.unnamed")]);
      for (const candidate of [lot.fundName, lot.label, lot.productName]) {
        const value = String(candidate ?? "").trim();
        if (value && !placeholders.has(value)) return value;
      }
      return t("sidebar.deposit.unnamed");
    },
    [t],
  );
  const availableRedeemLotOptions = useMemo(
    () => {
      const byId = new Map<string, RedeemLotOption>();
      for (const lot of redeemLotOptions) byId.set(lot.id, lot);
      for (const lot of fetchedRedeemLotOptions) {
        const previous = byId.get(lot.id);
        if (!previous) {
          byId.set(lot.id, lot);
          continue;
        }
        // 接口返回的存单带的是最新剩余本金，但它没有 label / subLabel，老存单的
        // fundName 还是空串 —— 整条覆盖会把父级已经算好的显示名和副标题抹掉，
        // 表现就是「刚打开能看见两条存单，约 2 秒后变空白」（2026-10-01 用户报障）。
        // 只在接口确实给得出名称时覆盖显示字段，其余沿用父级；fundName 保持接口值，
        // 不改写存单自身名称语义。
        const fetchedName = (lot.fundName ?? "").trim() || (lot.productName ?? "").trim();
        byId.set(lot.id, {
          ...lot,
          label: fetchedName || previous.label,
          subLabel: previous.subLabel ?? lot.subLabel,
        });
      }
      return [...byId.values()];
    },
    [fetchedRedeemLotOptions, redeemLotOptions],
  );
  useEffect(() => {
    if (!open || !isRedeem || depositAccountList.length === 0) {
      if (!open || !isRedeem) setFetchedRedeemLotOptions([]);
      return;
    }
    let cancelled = false;
    // 只取「仍有剩余本金」的存单（includeClosed 缺省即 false）。
    // 编辑态**不要**改传 includeClosed=1：被编辑的那张存单由下面的 excludeEntryId 把
    // 当前取回本金加回，余额自然 > 0 仍会出现在选项里；而 includeClosed=1 会把**已全额
    // 取回**的存单也一并列出，表现为「编辑提前取款时，取出存单下拉出现 3 项，实际只应 2 项」
    // （2026-10-01 用户报障：民泰账户 3 张存单里有 1 张已全额取回、余额 0）。
    const params = new URLSearchParams({
      accountIds: depositAccountList.map((option) => option.id).join(","),
    });
    if (editEntryId) params.set("excludeEntryId", editEntryId);
    void fetch(`/api/v1/deposit/lots?${params.toString()}`, { cache: "no-store" })
      .then((response) => response.json().catch(() => null))
      .then((data) => {
        if (cancelled) return;
        setFetchedRedeemLotOptions(data?.ok && Array.isArray(data.lots) ? data.lots as RedeemLotOption[] : []);
      })
      .catch(() => {
        if (!cancelled) setFetchedRedeemLotOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [depositAccountList, editEntryId, isRedeem, open]);
  const effectiveRedeemLotOptions = useMemo(() => {
    if (!editingRedeemSource || !isRedeem) return availableRedeemLotOptions;
    const restored: RedeemLotOption = {
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
      productName: editingRedeemSource.productName ?? null,
      depositProductId: editingRedeemSource.depositProductId ?? null,
      startDate: editingRedeemSource.startDate,
      maturityDate: editingRedeemSource.maturityDate,
      remainingAmount: editingRedeemSource.restoredRemainingAmount,
      annualRate: editingRedeemSource.annualRate ?? null,
      latestInterestDate: editingRedeemSource.latestInterestDate ?? null,
      depositAccountId: editingRedeemSource.depositAccountId,
      depositAccountLabel: editingRedeemSource.depositAccountLabel,
    } satisfies RedeemLotOption;
    if (availableRedeemLotOptions.some((lot) => lot.id === editingRedeemSource.id)) {
      return availableRedeemLotOptions.map((lot) =>
        lot.id === editingRedeemSource.id
          ? { ...lot, ...restored }
          : lot,
      );
    }
    return [restored, ...availableRedeemLotOptions];
  }, [availableRedeemLotOptions, editingRedeemSource, isRedeem, t]);
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
        label: redeemLotDisplayName(lot),
        subLabel: lot.subLabel,
      })),
    [sortedRedeemLotOptions, redeemLotDisplayName],
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
  const productInstitutionId = selectedDepositAccount?.institutionId
    ?? selectedCashAccount?.institutionId
    ?? contextInstitutionId
    ?? null;
  const cashCurrency = (selectedCashAccount?.currency || "CNY").toUpperCase();
  const depositCurrency = (selectedDepositAccount?.currency || "CNY").toUpperCase();
  const showCurrencyConversion = !isRedeem && !!cashAccountId && !!depositAccountId && cashCurrency !== depositCurrency;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const institutionId = productInstitutionId ?? "";
    // 已选产品只在「它属于另一家机构」时才该被清掉（用户确实换了银行）。
    // institutionId 为空的产品（迁移遗留）任何机构下拉都查不到，不能因此清空用户已选/存单自带的产品
    // —— 否则编辑一张老存单时产品会被清空，界面看起来像「这个产品不存在」。
    const selectedKnown = depositProductsRef.current.find((product) => product.id === depositProductId) ?? null;
    const selectedIsCrossInstitution = !!selectedKnown?.institutionId && selectedKnown.institutionId !== institutionId;
    if (!institutionId) {
      // 机构还没定（存款账户与资金账户都未选）：只清掉按机构拉来的候选，保留已选产品。
      setDepositProducts((prev) => prev.filter((product) => product.id === depositProductId));
      return () => { cancelled = true; };
    }
    const url = "/api/v1/deposit-products?institutionId=" + encodeURIComponent(institutionId);
    void fetch(url, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data?.ok) return;
        const products = (data.products ?? []) as DepositProductOption[];
        if (selectedIsCrossInstitution && depositProductId && !products.some((product) => product.id === depositProductId)) {
          setDepositProductId("");
          setFundName("");
        }
        setDepositProducts((prev) => {
          const selectedLocal = prev.filter((product) =>
            (product.id === depositProductId && !selectedIsCrossInstitution) ||
            (product.institutionId === institutionId && (
              product.id === depositProductId ||
              (!!fundName && (product.name === fundName || product.shortName === fundName))
            )),
          );
          const merged = [...products];
          const seen = new Set(merged.map((item) => item.id));
          for (const item of selectedLocal) {
            if (!seen.has(item.id)) {
              merged.push(item);
              seen.add(item.id);
            }
          }
          return merged;
        });
        if (!depositProductId && fundName) {
          const matched = products.find((product) => product.name === fundName || product.shortName === fundName);
          if (matched) setDepositProductId(matched.id);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [depositProductId, fundName, open, productInstitutionId]);
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
    const firstOpenLot = [...availableRedeemLotOptions].sort(compareRedeemLots)[0];
    if (firstOpenLot?.depositAccountId) return firstOpenLot.depositAccountId;
    return depositAccountList[0]?.id ?? "";
  }, [availableRedeemLotOptions, currentContextAccount, depositAccountList, sameInstitutionDepositAccounts]);

  const resolveDefaultRedeemLot = useCallback((depositId: string) => {
    return [...availableRedeemLotOptions]
      .filter((lot) => (depositId ? lot.depositAccountId === depositId : true))
      .sort(compareRedeemLots)[0]?.id ?? "";
  }, [availableRedeemLotOptions]);

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
    // 显式指定存单优先（存单行「取回」按钮走这条）；否则按存款账户挑一张默认。
    const explicitLotId = detail?.defaultRedeemLotId;
    const requestedLot = explicitLotId ? availableRedeemLotOptions.find((lot) => lot.id === explicitLotId) : undefined;
    const nextRedeemLotId = requestedLot
      ? requestedLot.id
      : resolveDefaultRedeemLot(nextDepositAccountId);
    // 指定存单时以它自己的存款账户为准，避免账户与存单不匹配。
    const effectiveDepositAccountId = requestedLot?.depositAccountId || nextDepositAccountId;
    setSubtype("redeem");
    setArrivalDate(date || today);
    arrivalDateTouchedRef.current = false;
    setDepositAccountId(effectiveDepositAccountId);
    setCashAccountId(resolveDefaultRedeemCashAccount(effectiveDepositAccountId, detail?.defaultCashAccountId));
    setSelectedRedeemLotId(nextRedeemLotId);
    setInterestEdited(false);
    setArrivalEdited(false);
  }, [availableRedeemLotOptions, date, resolveDefaultRedeemCashAccount, resolveDefaultRedeemDepositAccount, resolveDefaultRedeemLot, today]);

  /**
   * 续存：以「存款存入」表单预填新存单全部要素 —— 取出日（= 新存单起存日）取旧
   * 存单到期日、金额取本息（本金续存取本金）、利率/期限/到期方式/付息方式/产品
   * 全部沿用旧存单。提交时改走 renewAction，旧存单在同一事务里结清、明细保留。
   */
  const applyRenewDefaults = useCallback((detail: {
    defaultRenewLotId?: string;
    defaultRenewFundName?: string;
    defaultRenewProductId?: string;
    defaultRenewStartDate?: string;
    defaultRenewMaturityDate?: string;
    defaultRenewPrincipal?: number;
    defaultRenewAnnualRate?: number;
    defaultRenewMaturityAction?: string;
    defaultRenewPayoutFrequency?: string;
    defaultRenewCalcBasis?: string;
    defaultDepositAccountId?: string;
    defaultCashAccountId?: string;
  }) => {
    const lotId = detail.defaultRenewLotId ?? "";
    if (!lotId) return;
    const start = detail.defaultRenewStartDate ?? "";
    const maturity = detail.defaultRenewMaturityDate ?? "";
    const principal = detail.defaultRenewPrincipal ?? 0;
    const rate = detail.defaultRenewAnnualRate ?? 0;
    const payout = foldDepositPayoutWeekToDay(
      parseDepositInterestPayout(detail.defaultRenewPayoutFrequency ?? null),
    );
    // 期间付息的存单利息已经逐期付过了，没有可滚入的利息，只能本金续存。
    const rollInDisabled = payout.kind === "periodic";
    const nextMode: "renew_principal" | "renew_principal_interest" =
      detail.defaultRenewMaturityAction === "renew_principal" || rollInDisabled
        ? "renew_principal"
        : "renew_principal_interest";
    const startUtc = start ? new Date(`${start}T00:00:00.000Z`) : null;
    const maturityUtc = maturity ? new Date(`${maturity}T00:00:00.000Z`) : null;
    // 遗留月周期到期日（起存日 + N 月 − 1 天）归一到周年：取出日回到 2026-07-15，
    // 旧存单这一段利息按 6/12 算（13.00）而不是 180 天（12.82）。
    const redeemDate = startUtc && maturityUtc
      ? depositRenewalStartUtc(startUtc, maturityUtc)
      : maturityUtc;
    const interest = startUtc && maturityUtc
      ? calculateDepositAccruedInterest({
          principal,
          annualRatePercent: rate > 0 ? rate : null,
          startDate: startUtc,
          endDate: redeemDate ?? maturityUtc,
        })
      : 0;
    const nextPrincipal =
      nextMode === "renew_principal_interest" ? Number((principal + interest).toFixed(2)) : principal;
    const nextMaturityAction =
      detail.defaultRenewMaturityAction === "redeem" ||
      detail.defaultRenewMaturityAction === "renew_principal" ||
      detail.defaultRenewMaturityAction === "renew_principal_interest"
        ? detail.defaultRenewMaturityAction
        : nextMode;
    // 期限从「起存日 → 归一化取出日」反推，保证新存单默认与原期限一致（6 个月 → 6 个月）。
    const redeemYmd = redeemDate ? redeemDate.toISOString().slice(0, 10) : "";
    const spanDays = startUtc && redeemDate
      ? Math.max(1, Math.round((redeemDate.getTime() - startUtc.getTime()) / 86400000))
      : DEFAULT_DEPOSIT_TERM_DAYS;
    const split = splitTermDays(spanDays, start || null);

    setSubtype("buy");
    setLockedSubtype("buy");
    setRenewSource({
      lotId,
      fundName: detail.defaultRenewFundName ?? "",
      depositProductId: detail.defaultRenewProductId ?? null,
      startDate: start || null,
      maturityDate: redeemYmd || null,
      principal,
      interest,
      annualRate: rate > 0 ? rate : null,
      maturityAction: detail.defaultRenewMaturityAction ?? null,
      interestPayoutFrequency: detail.defaultRenewPayoutFrequency ?? null,
      interestCalcBasis: detail.defaultRenewCalcBasis ?? null,
      depositAccountId: detail.defaultDepositAccountId ?? "",
    });
    setRenewMode(nextMode);
    setDate(redeemYmd || today);
    setAmount(nextPrincipal > 0 ? String(nextPrincipal) : "");
    setFundName(detail.defaultRenewFundName ?? "");
    setDepositProductId(detail.defaultRenewProductId ?? "");
    setAnnualRate(rate > 0 ? String(rate) : "");
    setDepositAccountId(resolveDefaultBuyDepositAccount(detail.defaultDepositAccountId));
    setCashAccountId(resolveDefaultBuyCashAccount(detail.defaultCashAccountId));
    setSelectedRedeemLotId("");
    setInterestAmount(interest > 0 ? interest.toFixed(2) : "");
    setArrivalAmount("");
    setInterestEdited(false);
    setArrivalEdited(false);
    setTermUnit(split.unit);
    setTermCount(String(split.count));
    setMaturityAction(nextMaturityAction);
    setInterestPayoutUnit(payout.kind === "periodic" ? payout.unit : "maturity");
    setInterestPayoutInterval(payout.kind === "periodic" ? String(payout.interval) : "1");
    setInterestCalcBasis(detail.defaultRenewCalcBasis === "daily" ? "daily" : "monthly");
    setMemo("");
  }, [
    resolveDefaultBuyCashAccount,
    resolveDefaultBuyDepositAccount,
    today,
  ]);

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
  const interestPreview = useMemo(() => {
    if (!isRedeem) {
      if (amountNumber <= 0 || annualRateNumber <= 0 || termDaysNumber <= 0) return 0;
      // 与到期日同一口径：整月跨度按 月数/12（6 个月 1.3% → 本金×1.3%×6/12），
      // 其余按 天数/365。日期走 depositTermMaturityUtc，避免预览与落库不一致。
      const startUtc = date ? new Date(`${date.slice(0, 10)}T00:00:00.000Z`) : null;
      const count = Math.trunc(parseNumber(termCount));
      const endUtc = startUtc
        ? Number.isFinite(count) && count > 0
          ? depositTermMaturityUtc(startUtc, termUnit, count)
          : new Date(startUtc.getTime() + termDaysNumber * 86400000)
        : null;
      return calculateDepositAccruedInterest({
        principal: amountNumber,
        annualRatePercent: annualRateNumber,
        startDate: startUtc,
        endDate: endUtc,
      });
    }
    const start = selectedRedeemLot?.startDate
      ? new Date(`${selectedRedeemLot.startDate.slice(0, 10)}T00:00:00.000Z`)
      : null;
    const requestedEnd = date ? new Date(`${date.slice(0, 10)}T00:00:00.000Z`) : null;
    const maturity = selectedRedeemLot?.maturityDate
      ? new Date(`${selectedRedeemLot.maturityDate.slice(0, 10)}T00:00:00.000Z`)
      : null;
    const end = requestedEnd && maturity && requestedEnd > maturity ? maturity : requestedEnd;
    return calculateDepositAccruedInterest({
      principal: amountNumber,
      annualRatePercent: annualRateNumber,
      startDate: start,
      endDate: end,
    });
  }, [amountNumber, annualRateNumber, date, isRedeem, selectedRedeemLot, termCount, termDaysNumber, termUnit]);
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
    setDepositProductId("");
    setAnnualRate("");
    setExchangeRate("");
    setCashAmount("");
    setTermUnit(splitTermDays(DEFAULT_DEPOSIT_TERM_DAYS).unit);
    setTermCount(String(splitTermDays(DEFAULT_DEPOSIT_TERM_DAYS).count));
    setInterestAmount("");
    setArrivalAmount("");
    setInterestEdited(false);
    setArrivalEdited(false);
    setAmountEdited(false);
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
        depositProductId?: string | null;
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
      setDepositProductId(detail.depositProductId ?? "");
      const detailAnnualRate = detail.depositAnnualRate ?? detail.fundNav ?? null;
      setAnnualRate(detailAnnualRate != null ? String(detailAnnualRate) : "");
      setMemo(detail.note ?? "");
      setArrivalAmount(detail.amount ? String(Math.abs(detail.amount)) : "");
      setInterestAmount(
        detail.depositInterest != null && Number.isFinite(detail.depositInterest)
          ? String(detail.depositInterest)
          : "",
      );
      // 编辑既有记录：库里的利息/到账额是用户上次保存的真值，必须标成「已手改」，
      // 否则下面两个预览 effect（interestEdited/arrivalEdited 为 false 时）会立刻用
      // 存单条款公式覆盖它 —— 用户看到的就是「利息没被带进来、保存后数字变了」。
      // 改本金时 amount 的 onChange 会把两个标记清掉并重算，手动纠正路径不受影响。
      const hasStoredInterest = detail.depositInterest != null && Number.isFinite(detail.depositInterest);
      const hasStoredArrival = !!detail.amount && Math.abs(Number(detail.amount)) > 0;
      setInterestEdited(hasStoredInterest);
      setArrivalEdited(isRedeem ? hasStoredArrival : mode === "edit");
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
        const lotSearchPool = [...(allRedeemLotOptions ?? []), ...availableRedeemLotOptions];
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
                // 老存单 fundName 为 null，产品名才是真正的显示名；编辑态下拉要靠它显示文字。
                productName: matchedLot?.productName ?? null,
                depositProductId: detail.depositProductId ?? matchedLot?.depositProductId ?? null,
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
                latestInterestDate: matchedLot?.latestInterestDate ?? null,
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
        const payout = foldDepositPayoutWeekToDay(
          parseDepositInterestPayout(detail.depositInterestPayoutFrequency),
        );
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
  }, [allRedeemLotOptions, availableRedeemLotOptions, defaultAccountId, depositAccountList, mode, t, today]);

  useEffect(() => {
    if (!isRedeem || !editEntryId || !editingRedeemSource?.id) return;
    const sourceId = editingRedeemSource.id;
    const fetchedMatchedLot = fetchedRedeemLotOptions.find((lot) => lot.id === sourceId);
    const matchedLot = fetchedMatchedLot ?? availableRedeemLotOptions.find((lot) => lot.id === sourceId);
    if (!matchedLot) return;
    // 编辑取款时接口带 excludeEntryId，返回余额已经把当前取款本金加回。
    // 只有接口尚未返回该存单时，才需要从服务端初始列表上加回当前取款本金。
    const restoredRemainingAmount = Number((matchedLot.remainingAmount + (fetchedMatchedLot ? 0 : amountNumber)).toFixed(2));
    const nextDepositProductId = matchedLot.depositProductId ?? editingRedeemSource.depositProductId ?? null;
    const nextAnnualRate = matchedLot.annualRate ?? editingRedeemSource.annualRate ?? null;
    const nextAccountLabel = matchedLot.depositAccountLabel ?? editingRedeemSource.depositAccountLabel;
    const nextProductName = matchedLot.productName ?? editingRedeemSource.productName ?? null;
    if (
      editingRedeemSource.startDate === matchedLot.startDate &&
      editingRedeemSource.maturityDate === matchedLot.maturityDate &&
      editingRedeemSource.depositProductId === nextDepositProductId &&
      editingRedeemSource.annualRate === nextAnnualRate &&
      editingRedeemSource.latestInterestDate === (matchedLot.latestInterestDate ?? null) &&
      editingRedeemSource.restoredRemainingAmount === restoredRemainingAmount &&
      editingRedeemSource.depositAccountId === matchedLot.depositAccountId &&
      editingRedeemSource.depositAccountLabel === nextAccountLabel &&
      editingRedeemSource.productName === nextProductName
    ) {
      return;
    }
    setEditingRedeemSource((current) => {
      if (!current || current.id !== sourceId) return current;
      return {
        ...current,
        productName: nextProductName,
        depositProductId: nextDepositProductId,
        startDate: matchedLot.startDate,
        maturityDate: matchedLot.maturityDate,
        annualRate: nextAnnualRate,
        latestInterestDate: matchedLot.latestInterestDate ?? null,
        restoredRemainingAmount,
        depositAccountId: matchedLot.depositAccountId,
        depositAccountLabel: nextAccountLabel,
      };
    });
  }, [amountNumber, availableRedeemLotOptions, editEntryId, editingRedeemSource?.id, fetchedRedeemLotOptions, isRedeem]);

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
        defaultRenewLotId?: string;
        defaultRenewFundName?: string;
        defaultRenewProductId?: string;
        defaultRenewStartDate?: string;
        defaultRenewMaturityDate?: string;
        defaultRenewPrincipal?: number;
        defaultRenewAnnualRate?: number;
        defaultRenewMaturityAction?: string;
        defaultRenewPayoutFrequency?: string;
        defaultRenewCalcBasis?: string;
      }>).detail;
      // 存单「续存」入口：同一张存款存入表单，但提交走续存动作。
      const isRenew = !!detail?.defaultRenewLotId;
      const nextSubtype = isRenew ? "buy" : detail?.defaultSubtype === "redeem" ? "redeem" : "buy";
      setRequestId(detail?.requestId ?? null);
      reset();
      setSubtype(nextSubtype);
      setCashAccountId(detail?.defaultCashAccountId ?? "");
      setDate(detail?.defaultDate || today);
      setArrivalDate(detail?.defaultDate || today);
      arrivalDateTouchedRef.current = false;
      if (typeof detail?.defaultAmount === "number" && detail.defaultAmount > 0) setAmount(String(detail.defaultAmount));
      setLockedSubtype(null);
      setRenewSource(null);
      if (isRenew) {
        applyRenewDefaults(detail);
      } else if (nextSubtype === "redeem") {
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
  }, [applyBuyDefaults, applyRedeemDefaults, applyRenewDefaults, mode, today]);

  function changeDate(nextDate: string) {
    setDate(nextDate);
    if (isRedeem) {
      setInterestEdited(false);
      setArrivalEdited(false);
    }
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
    if (!isRedeem || editEntryId || !selectedRedeemLot) return;
    setFundName(selectedRedeemLot.fundName);
    setDepositProductId(selectedRedeemLot.depositProductId ?? "");
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
    if (!amountEdited) {
      setAmount(selectedRedeemLot.remainingAmount > 0 ? selectedRedeemLot.remainingAmount.toFixed(2) : "");
    }
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
  }, [cashAccountList, depositAccountList, editEntryId, isRedeem, mode, selectedRedeemLot]);

  useEffect(() => {
    // 只在「新建」时把取出日顺延到最近一次已生成利息之后（防止取出早于结息）。
    // 两个必须的守卫：
    //   1. `editEntryId` —— 编辑既有记录时，库里的日期就是用户保存的真值，改它等于篡改历史；
    //      而且 latestInterestDate 由该存单全部记录算出，必然 ≥ 本条记录日期，会把日期顶走。
    //   2. 日期必须已输入完整 —— 原生 date 输入在分段键入途中 value 为 ""，
    //      若此时判定 `"" < minimumDate` 就会把中间态顶成 minimumDate，
    //      表现为「数字键打不进去 / 一输入就变成另一个日期」。
    if (!isRedeem || editEntryId) return;
    const minimumDate = selectedRedeemLot?.latestInterestDate ?? null;
    if (!minimumDate || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (date >= minimumDate) return;
    setDate(minimumDate);
  }, [date, editEntryId, isRedeem, selectedRedeemLot]);

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
    if (!isRedeem || editEntryId) return;
    if (amountEdited) return;
    if (selectedRedeemLot) {
      const nextAmount = selectedRedeemLot.remainingAmount > 0 ? selectedRedeemLot.remainingAmount.toFixed(2) : "";
      setAmount((current) => current === nextAmount ? current : nextAmount);
    }
  }, [amountEdited, editEntryId, isRedeem, selectedRedeemLot]);

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
    setCashAmount("");
    setInterestAmount("");
    setArrivalAmount("");
    setInterestEdited(false);
    setArrivalEdited(false);
    setAmountEdited(false);
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
    if (!isRedeem && !depositProductId && !fundName.trim()) {
      window.alert(t("depositForm.alert.selectOrCreateProductName"));
      return;
    }
    if (isRedeem && !selectedRedeemLotId) {
      window.alert(t("depositForm.alert.selectRedeemLot"));
      return;
    }
    if (!isRedeem && !isRenewRollIn && !cashAccountId) {
      window.alert(t("txForm.alert.selectCashSourceAccount"));
      return;
    }
    if (isRenew && !renewAction) {
      window.alert(t("depositForm.alert.missingRenewAction"));
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("type", "investment");
      fd.set("subtype", lockedSubtype ?? subtype);
      fd.set("productType", "deposit");
      fd.set("date", date);
      const redeemAmount = amt;
      const cashAmt = showCurrencyConversion ? parseNumber(cashAmount) : amt;
      if (showCurrencyConversion && cashAmt <= 0) {
        throw new Error(t("depositForm.alert.enterConvertedCashAmount"));
      }
      fd.set("amount", String(isRedeem ? redeemAmount : cashAmt));
      fd.set("fundName", fundName.trim());
      if (depositProductId) fd.set("depositProductId", depositProductId);
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
        // 始终提交利息（含 0）与「用户是否手改过」标记：服务端据此决定用用户输入
        // 还是按存单条款重算 —— 否则手填的利息会被公式覆盖（编辑取回记录时丢失）。
        fd.set("depositInterest", String(interestValue));
        fd.set("depositInterestEdited", interestEdited ? "1" : "0");
        fd.set("fundArrivalAmount", String(arrivalValue));
        fd.set("fundArrivalAmountEdited", arrivalEdited ? "1" : "0");
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
          // 月/年周期按日历月/对年对日滚动（到期日 = 起存日 + N 月/年），不能用 30/365 天块近似。
          const maturityDate = new Date(`${date}T00:00:00.000Z`);
          const normalizedMaturityDate = depositTermMaturityUtc(maturityDate, termUnit, termCountNumber);
          fd.set("fundArrivalDate", normalizedMaturityDate.toISOString().slice(0, 10));
        } else {
          fd.set("fundArrivalDate", "");
        }
      }

      if (isRenew && renewSource && renewAction) {
        // 续存：新存单要素已在上面按「存款存入」字段填好，这里补上旧存单标识与
        // 续存方式；服务端在同一事务里结清旧存单（明细保留）并建出新存单。
        fd.set("entryId", renewSource.lotId);
        fd.set("renewSourceLotId", renewSource.lotId);
        fd.set("renewMode", renewMode);
        if (renewSource.interest > 0) fd.set("interest", String(renewSource.interest));
        const res = await renewAction(fd);
        if (!res.ok) throw new Error(res.error ?? t("txForm.alert.saveFailed"));
      } else if (mode === "edit" && (entry?.id || editEntryId)) {
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
  const depositFallbackSSOptions: SmartSelectOption[] = (localDepositSSOpts ?? depositAccountList.map((option) => ({
    id: option.id,
    label: option.label,
    subLabel: option.subLabel,
    kind: option.kind,
    investProductType: option.investProductType,
    institutionId: option.institutionId,
    currency: option.currency,
  })));
  const visibleCashOptions = sortByAccountUsage(cashFiltered ?? cashFallbackSSOptions, accountUsage);
  const visibleDepositOptions = sortByAccountUsage(
    (depositFiltered ?? depositFallbackSSOptions).filter((option) => !option.isHeader && isDepositLikeOption(option)),
    accountUsage,
  );

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
                {mode === "edit"
                  ? t("depositForm.title.edit")
                  : isRenew
                    ? t("deposit.renew.title")
                    : t("depositForm.title.create")}
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

              {/* 续存：旧存单在取出日结清（明细保留），这里填的是新存单。 */}
              {isRenew && renewSource ? (
                <div className="space-y-2 rounded-[10px] border border-emerald-200 bg-emerald-50/70 p-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-800">
                    <Repeat className="h-3.5 w-3.5" />
                    {t("deposit.renew.title")}
                  </div>
                  <div className="text-[11px] text-emerald-800/90">
                    {t("deposit.renew.renewBanner", {
                      name: renewSource.fundName || t("depositForm.unnamedDeposit"),
                      date: renewSource.maturityDate || "-",
                      amount: renewSource.principal.toFixed(2),
                    })}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={rollInDisabledForRenew}
                      title={rollInDisabledForRenew ? t("deposit.renew.rollInDisabledHint") : undefined}
                      onClick={() => {
                        setRenewMode("renew_principal_interest");
                        setAmount(String(Number((renewSource.principal + renewSource.interest).toFixed(2))));
                      }}
                      className={`segment-button h-8 flex-1 text-xs ${renewMode === "renew_principal_interest" ? "segment-button-active font-medium" : ""} ${rollInDisabledForRenew ? "cursor-not-allowed opacity-50" : ""}`}
                    >
                      {t("deposit.renew.modeRollIn")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRenewMode("renew_principal");
                        setAmount(String(renewSource.principal));
                      }}
                      className={`segment-button h-8 flex-1 text-xs ${renewMode === "renew_principal" ? "segment-button-active font-medium" : ""}`}
                    >
                      {t("deposit.renew.modePayout")}
                    </button>
                  </div>
                  <div className="flex justify-between text-[11px] text-emerald-800/90">
                    <span>{t("deposit.renew.accruedInterest")}</span>
                    <span className="font-medium tabular-nums">{renewSource.interest.toFixed(2)}</span>
                  </div>
                </div>
              ) : null}

              <div className={isRedeem ? "space-y-3" : "grid grid-cols-2 gap-3"}>
                <div className="space-y-1">
                  <div className="form-label">
                    {isRenew ? t("deposit.renew.redeemDateLabel") : t("detail.column.date")}
                  </div>
                  <DateStepper
                    value={date}
                    onChange={changeDate}
                    min={isRedeem ? selectedRedeemLot?.latestInterestDate ?? "1900-01-01" : "1900-01-01"}
                  />
                  {isRenew ? (
                    <div className="text-[11px] text-slate-400">{t("deposit.renew.redeemDateHint")}</div>
                  ) : null}
                </div>
                {isRedeem ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("depositForm.redeemAccount")}</div>
                      <SmartSelect
                        mode="single"
                        value={depositAccountId}
                        onChange={setDepositAccountId}
                        options={visibleDepositOptions}
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
                  <SmartSelect
                    mode="single"
                    value={depositProductId}
                    onChange={(id) => {
                      setDepositProductId(id);
                      const product = depositProducts.find((item) => item.id === id);
                      setFundName(product?.name ?? "");
                      if (product?.annualRate != null && !annualRate.trim()) setAnnualRate(String(product.annualRate));
                      if (product?.termDays != null && !termCount.trim()) {
                        const termSplit = splitTermDays(Number(product.termDays));
                        setTermUnit(termSplit.unit);
                        setTermCount(String(termSplit.count));
                      }
                    }}
                    options={depositProductOptions}
                    placeholder={depositProductOptions.length > 0 ? t("depositForm.selectProduct") : t("depositForm.noProductClickAdd")}
                    searchable
                    onCreateClick={() => openDepositProductModal()}
                    createLabel={t("depositForm.addProduct")}
                  />
                </div>
              )}

              {isRedeem ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("depositForm.withdrawPrincipal")}</div>
                      <CalcInput
                        value={amount}
                        onChange={(value) => {
                          setInterestEdited(false);
                          setArrivalEdited(false);
                          setAmountEdited(true);
                          setAmount(value);
                        }}
                        onBlur={() => applyRedeemComputedAmounts(true)}
                        placeholder={t("depositForm.amountPlaceholder")}
                        label={t("depositForm.withdrawPrincipal")}
                        precision={2}
                      />
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
                // 到期行为 + 取息相关控件统一铺满整宽、共用同一列宽，
                // 每一行都填满、不留空白格：
                //   到期一次付 → [到期行为][取息周期]
                //   按天/按年 → [到期行为][取息周期][取息间隔]（三列同一行）
                //   按月     → [到期行为][取息周期][计息方式][取息间隔]（四列同一行）
                <div className={`grid grid-cols-1 items-start gap-3 ${
                  isPeriodicInterestPayout
                    ? interestPayoutUnit === "month"
                      ? "sm:grid-cols-[1fr_1fr_1.4fr_0.6fr]"
                      : "sm:grid-cols-3"
                    : "sm:grid-cols-2"
                }`}>
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
                      <option value="day">{t("deposit.payoutFrequency.daily")}</option>
                      <option value="month">{t("deposit.payoutFrequency.monthly")}</option>
                      <option value="year">{t("deposit.payoutFrequency.yearly")}</option>
                    </select>
                  </div>
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
                  {isPeriodicInterestPayout ? (
                    <div className="space-y-1">
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
                      {/* 按天/按年取息时，取息说明跟在间隔下方（这一行只有它，说明放这里最贴近）。 */}
                      {interestPayoutUnit === "month" ? null : (
                        <div className="text-[11px] text-slate-400">
                          {!showGuideHints
                            ? ""
                            : t("deposit.payoutFrequency.periodicHint", {
                                interval: String(Math.trunc(parseNumber(interestPayoutInterval)) || 1),
                                unit: t(
                                  interestPayoutUnit === "day"
                                    ? "depositForm.termUnit.day"
                                    : "depositForm.termUnit.year",
                                ),
                                max: String(maxInterestPayoutInterval),
                              })}
                        </div>
                      )}
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
                <div className={isRenewRollIn ? "grid grid-cols-1 gap-3" : "grid grid-cols-2 gap-3"}>
                  {isRenewRollIn ? null : (
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
                  )}
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
                {mode === "create" && !isRenew ? (
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
                  {submitting
                    ? t("txForm.saving")
                    : isRenew
                      ? t("deposit.renew.submit")
                      : mode === "edit"
                        ? t("txForm.saveChanges")
                        : isRedeem
                          ? t("depositForm.recordRedeem")
                          : t("depositForm.recordBuy")}
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
                const extraWithCurrency = extra as typeof extra & { currency?: unknown; institutionId?: unknown };
                const currency = extraWithCurrency?.currency ? String(extraWithCurrency.currency) : "CNY";
                const institutionId = extraWithCurrency?.institutionId ? String(extraWithCurrency.institutionId) : null;

                if (nestedEntityType === "cash-account") {
                  const flat = { id, label: optionLabel, subLabel: optionSubLabel, currency, institutionId };
                  setCashAccountList((prev) => appendFlatOption(prev, flat));
                  setLocalCashSSOpts((prev) =>
                    appendSmartSelectOption(prev, { id, label: optionLabel, subLabel: optionSubLabel }, groupId, groupName),
                  );
                  setCashAccountId(id);
                } else {
                  const flat = { id, label: optionLabel, subLabel: optionSubLabel, currency, institutionId };
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
      {productModalOpen ? createPortal(
        <div className="app-modal-backdrop" style={{ zIndex: getNextModalLayerZIndex(modalZIndex) }}>
          <div className="app-modal-panel max-w-[min(30rem,calc(100vw-1rem))]">
            <div className="modal-header">
              <div>
                <div className="text-sm font-semibold text-slate-800">{t("depositForm.addProduct")}</div>
              </div>
              <button
                type="button"
                onClick={() => setProductModalOpen(false)}
                className="secondary-button h-8 px-2"
              >
                {t("table.close")}
              </button>
            </div>
            <div className="space-y-3 p-3 sm:p-4">
              <div className="space-y-1">
                <div className="form-label">{t("wealthForm.productName")}</div>
                <input
                  value={productDraft.name}
                  onChange={(e) => setProductDraft((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder={t("depositForm.productNamePlaceholder")}
                  className="form-input"
                  autoFocus
                />
              </div>
              {productError ? (
                <div className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {productError}
                </div>
              ) : null}
              <div className="space-y-1">
                <div className="form-label">{t("wealthForm.shortName")}</div>
                <input
                  value={productDraft.shortName}
                  onChange={(e) => setProductDraft((prev) => ({ ...prev, shortName: e.target.value }))}
                  placeholder={t("wealthForm.shortNamePlaceholder")}
                  className="form-input"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="form-label">{t("depositForm.annualRatePercent")}</div>
                  <input
                    inputMode="decimal"
                    value={productDraft.annualRate}
                    onChange={(e) => setProductDraft((prev) => ({ ...prev, annualRate: e.target.value }))}
                    placeholder={t("depositForm.rateExample")}
                    className="form-input"
                  />
                </div>
                <div className="space-y-1">
                  <div className="form-label">{t("wealthForm.termDays")}</div>
                  <input
                    inputMode="numeric"
                    value={productDraft.termDays}
                    onChange={(e) => setProductDraft((prev) => ({ ...prev, termDays: e.target.value }))}
                    placeholder={t("stockFee.optional")}
                    className="form-input"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("detail.column.remark")}</div>
                <ClearableNoteField
                  value={productDraft.note}
                  onValueChange={(value) => setProductDraft((prev) => ({ ...prev, note: value }))}
                  placeholder={t("stockFee.optional")}
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
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => { void saveDepositProduct(); }}
                  disabled={productSaving}
                  className="primary-button h-9 px-4 text-sm disabled:opacity-50"
                >
                  {productSaving ? t("txForm.saving") : t("wealthForm.saveAndSelect")}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </ModalLayerProvider>
  );
}

function isDepositLikeOption(option: { kind?: string | null; investProductType?: string | null } | null) {
  if (!option) return false;
  return option.kind === "deposit" || option.investProductType === "deposit";
}
