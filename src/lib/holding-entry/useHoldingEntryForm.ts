"use client";

/**
 * 持仓型记账表单的共享状态机：日期 / 动作页签 / 金额 / 份额 / 资金账户 /
 * 持仓（存单）选择 / 赎回份额守卫 / 编辑回填 / 打开与重置。
 *
 * 中性层只描述「持仓型记账」的通用行为；品种差异（账户品种、事件名、
 * 持仓来源、领域字段复位）通过选项注入，此处不出现具体品种词汇。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SmartSelectOption } from "@/components/SmartSelect";
import { useAccountSSFilter } from "@/components/accountSSFilter";
import { restrictAccountsByType } from "@/lib/client/account-dropdown-filter";
import { useAccountUsage } from "@/lib/client/recentAccounts";
import { useI18n } from "@/lib/i18n";
import { formatAmountDraft } from "@/lib/format";
import { parseNumber } from "@/lib/investment-config";
import { isCashAccountAllowedForInvestAccount } from "@/lib/cash-invest-account-rules";
import {
  holdingAmountAt,
  holdingUnitsAt,
  inferRedeemPrincipalAmount,
  isDividendArrivalAccount,
  isRedeemArrivalAccount,
  parseSignedNumber,
} from "./primitives";
import { todayDateLocalYmd } from "@/lib/date-utils";
import type {
  HoldingEntryAccountOption,
  HoldingEntryEditDetail,
  HoldingEntryEntry,
  HoldingEntryHoldingOption,
  HoldingEntryNestedFieldData,
  HoldingEntryRedeemSource,
  HoldingEntrySubtype,
} from "./types";

export type UseHoldingEntryFormOptions = {
  mode?: "create" | "edit";
  entry?: HoldingEntryEntry;
  defaultAccountId: string;
  openSignal?: number;
  listenForEditEvents?: boolean;
  cashAccounts?: HoldingEntryAccountOption[];
  investmentAccounts?: HoldingEntryAccountOption[];
  cashAccountSSOptions?: SmartSelectOption[];
  investmentAccountSSOptions?: SmartSelectOption[];
  nestedFieldData?: HoldingEntryNestedFieldData;
  /** 已按品种构建好的持仓 / 存单选项。 */
  typedHoldingOptions: HoldingEntryHoldingOption[];
  /** 投资账户品种值：用于过滤账户下拉（investProductType === productKind）。 */
  productKind: string;
  /** 事件命名空间：`mmh:<eventNamespace>:edit` / `mmh:<eventNamespace>:create`。 */
  eventNamespace: string;
  /** create 事件里「默认投资账户」字段名。 */
  defaultAccountKey: string;
  /** 买入已有份额型产品时是否必须有份额（默认 true；无份额品种传 false）。 */
  requiresUnitsOnBuy?: boolean;
  /** 产品 id → 名称，用于判断「买入同产品已有份额」。 */
  resolveProductName?: (productId: string) => string | undefined;
  /** 重置草稿时追加的品种动作（条款字段复位等）。 */
  onDomainReset?: () => void;
  /** 交易日期变化时追加的品种动作（条款触碰标记复位等）。 */
  onTradeDateChange?: () => void;
  /** 编辑回填时的持仓匹配（品种可覆盖，如存单 id 优先）。 */
  matchHolding?: (params: {
    detail: HoldingEntryEditDetail;
    nextAccountId: string;
    holdings: HoldingEntryHoldingOption[];
  }) => HoldingEntryHoldingOption | undefined;
  /** 回填「赎回前持仓」的额外 id（如存单 id）。 */
  resolveRestoredSourceId?: (params: { detail: HoldingEntryEditDetail }) => string | null;
  /** 编辑事件明细归一（如把品种自己的「来源单」字段映射成 sourceLotId）。 */
  mapEditDetail?: (detail: HoldingEntryEditDetail) => HoldingEntryEditDetail;
  /**
   * 编辑事件里 editEntryId 的取法：
   * `cashOnly` 只认 cashEntryId（默认）；`detail` 再用明细 entryId 兜底，避免编辑退化成新增。
   */
  editEventEntryIdMode?: "cashOnly" | "detail";
};

export function useHoldingEntryForm(options: UseHoldingEntryFormOptions) {
  const {
    mode = "create",
    entry,
    defaultAccountId,
    openSignal,
    listenForEditEvents,
    cashAccounts = [],
    investmentAccounts = [],
    cashAccountSSOptions,
    investmentAccountSSOptions,
    nestedFieldData,
    typedHoldingOptions,
    productKind,
    eventNamespace,
    defaultAccountKey,
    requiresUnitsOnBuy = true,
  } = options;

  const today = todayDateLocalYmd();
  const { t } = useI18n();

  const initIsDividend = mode === "edit" && entry?.fundSubtype === "dividend_cash";
  const initIsWriteOff = mode === "edit" && entry?.fundSubtype === "write_off";
  const initIsRedeem = mode === "edit" && entry
    ? entry.fundSubtype
      ? entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out"
      : entry.amount > 0
    : false;
  const initAmount = mode === "edit" && entry ? formatAmountDraft(inferRedeemPrincipalAmount(entry)) : "";
  const initDate = mode === "edit" && entry?.date ? entry.date.slice(0, 10) : today;
  const initArrivalDate = mode === "edit" && entry?.fundArrivalDate ? entry.fundArrivalDate.slice(0, 10) : initDate;
  const initName = mode === "edit" && entry?.fundName ? entry.fundName : "";
  const initMemo = mode === "edit" && entry?.note ? entry.note : "";
  const initUnits = mode === "edit" && entry?.fundUnits != null ? String(Math.abs(entry.fundUnits)) : "";
  const initNav = mode === "edit" && entry?.fundNav != null ? String(Math.abs(entry.fundNav)) : "";
  const initOutgoing = initIsRedeem || initIsDividend || initIsWriteOff;
  const initCashAccountId = mode === "edit" && entry
    ? (initIsWriteOff ? "" : initOutgoing ? (entry.toAccountId ?? "") : (entry.accountId ?? ""))
    : "";
  const initToAccountId = mode === "edit" && entry
    ? (initOutgoing ? (entry.accountId ?? defaultAccountId) : (entry.toAccountId ?? defaultAccountId))
    : defaultAccountId;
  const [open, setOpen] = useState(false);
  const [subtype, setSubtype] = useState<HoldingEntrySubtype>(
    initIsDividend ? "dividend_cash" : initIsWriteOff ? "write_off" : initIsRedeem ? "redeem" : "buy",
  );
  const [date, setDate] = useState(initDate);
  const [holdingFilterDate, setHoldingFilterDate] = useState(initDate);
  const [arrivalDate, setArrivalDate] = useState(initArrivalDate);
  const arrivalDateTouchedRef = useRef(mode === "edit");
  const [amount, setAmount] = useState(initAmount);
  const [units, setUnits] = useState(initUnits);
  const [nav, setNav] = useState(initNav);
  const [productId, setProductId] = useState(mode === "edit" && entry?.wealthProductId ? entry.wealthProductId : "");
  const [fundName, setFundName] = useState(initName);
  const [annualRate, setAnnualRate] = useState("");
  const [termDays, setTermDays] = useState("");
  const [interestAmount, setInterestAmount] = useState(
    mode === "edit" && initIsRedeem && entry?.depositInterest != null ? formatAmountDraft(entry.depositInterest) : "",
  );
  const [arrivalAmount, setArrivalAmount] = useState(
    mode === "edit" && entry && entry.amount > 0 ? formatAmountDraft(Math.abs(entry.amount)) : "",
  );
  const [interestEdited, setInterestEdited] = useState(false);
  const [arrivalEdited, setArrivalEdited] = useState(false);
  const [cashAccountId, setCashAccountId] = useState(initCashAccountId);
  const [toAccountId, setToAccountId] = useState(initToAccountId);
  const [selectedHoldingId, setSelectedHoldingId] = useState("");
  const [editingRedeemSource, setEditingRedeemSource] = useState<HoldingEntryRedeemSource | null>(null);
  const [memo, setMemo] = useState(initMemo);
  const [pendingAttachmentFiles, setPendingAttachmentFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const [editBusinessTransactionId, setEditBusinessTransactionId] = useState<string | null>(null);
  const unitsEditedRef = useRef(mode === "edit");
  const autoFilledUnitsForRef = useRef<string | null>(null);

  const [cashAccountList, setCashAccountList] = useState(cashAccounts);
  const [investmentAccountList, setInvestmentAccountList] = useState(investmentAccounts);
  const [localCashSSOpts, setLocalCashSSOpts] = useState(cashAccountSSOptions);
  const [localInvestSSOpts, setLocalInvestSSOpts] = useState(investmentAccountSSOptions);
  const [nestedEntityType, setNestedEntityType] = useState<string | null>(null);
  const [localNestedFieldData, setLocalNestedFieldData] = useState<HoldingEntryNestedFieldData | undefined>(nestedFieldData);

  /** 领域回调走 ref，避免调用方内联函数导致依赖抖动。 */
  const domainResetRef = useRef(options.onDomainReset);
  domainResetRef.current = options.onDomainReset;
  const tradeDateChangeRef = useRef(options.onTradeDateChange);
  tradeDateChangeRef.current = options.onTradeDateChange;
  const matchHoldingRef = useRef(options.matchHolding);
  matchHoldingRef.current = options.matchHolding;
  const restoredSourceIdRef = useRef(options.resolveRestoredSourceId);
  restoredSourceIdRef.current = options.resolveRestoredSourceId;
  const resolveProductNameRef = useRef(options.resolveProductName);
  resolveProductNameRef.current = options.resolveProductName;
  const mapEditDetailRef = useRef(options.mapEditDetail);
  mapEditDetailRef.current = options.mapEditDetail;

  useEffect(() => {
    if (nestedFieldData) setLocalNestedFieldData(nestedFieldData);
  }, [nestedFieldData]);
  const { ownerFilterLabel: cfLabel, cycleOwnerFilter: cfCycle, filteredOptions: cashFiltered } = useAccountSSFilter(localCashSSOpts);
  const isRedeem = subtype === "redeem";
  const isDividend = subtype === "dividend_cash";
  const isWriteOff = subtype === "write_off";
  const isHoldingAction = isRedeem || isDividend || isWriteOff;

  const selectedCashAccount = useMemo(
    () => cashAccountList.find((account) => account.id === cashAccountId) ?? null,
    [cashAccountId, cashAccountList],
  );

  const accountList = useMemo(
    () => restrictAccountsByType(investmentAccountList, (account) => account.investProductType === productKind),
    [investmentAccountList, productKind],
  );
  const accountIds = useMemo(() => new Set(accountList.map((account) => account.id)), [accountList]);
  const isInvestAccountAllowed = useCallback(
    (cashAccount: HoldingEntryAccountOption, account: HoldingEntryAccountOption) =>
      isCashAccountAllowedForInvestAccount({
        cashGroupId: cashAccount.groupId ?? "",
        cashInstitutionId: cashAccount.institutionId,
        investGroupId: account.groupId ?? "",
        investInstitutionId: account.institutionId,
        investInstitutionType: account.institutionType,
      }),
    [],
  );

  const selectableAccountList = useMemo(() => {
    if (isHoldingAction) return accountList;
    if (!selectedCashAccount?.groupId) return [];
    return accountList.filter((account) => isInvestAccountAllowed(selectedCashAccount, account));
  }, [isHoldingAction, selectedCashAccount, accountList, isInvestAccountAllowed]);
  const selectableAccountIds = useMemo(
    () => new Set(selectableAccountList.map((account) => account.id)),
    [selectableAccountList],
  );
  const localAccountSSOpts = useMemo(
    () => (localInvestSSOpts ?? []).filter((option) => option.isHeader || selectableAccountIds.has(option.id)),
    [localInvestSSOpts, selectableAccountIds],
  );
  const { ownerFilterLabel, cycleOwnerFilter, filteredOptions: accountFiltered } = useAccountSSFilter(localAccountSSOpts);
  const cashAccountOptions = useMemo<SmartSelectOption[]>(
    () => cashAccountList.map((account) => ({ ...account, kind: account.kind ?? null })),
    [cashAccountList],
  );
  const accountOptions = useMemo<SmartSelectOption[]>(
    () => selectableAccountList.map((account) => ({ ...account, kind: account.kind ?? null })),
    [selectableAccountList],
  );
  const cashSelectOptions = cashFiltered ?? cashAccountOptions;
  const selectOptions = accountFiltered ?? accountOptions;
  const selectedInvestAccount = useMemo(
    () => accountList.find((account) => account.id === toAccountId) ?? null,
    [toAccountId, accountList],
  );
  const productInstitutionId = selectedInvestAccount?.institutionId ?? selectedCashAccount?.institutionId ?? null;
  const selectedInvestInstitutionId = selectedInvestAccount?.institutionId ?? null;
  const redeemCashOptions = useMemo(
    () =>
      cashAccountList.filter((account) =>
        isRedeem
          ? isRedeemArrivalAccount(account, selectedInvestInstitutionId)
          : isDividendArrivalAccount(account, selectedInvestInstitutionId),
      ),
    [cashAccountList, isRedeem, selectedInvestInstitutionId],
  );

  const resolveAccountForCashAccount = useCallback((cashId: string, explicitAccountId?: string | null) => {
    const cashAccount = cashAccountList.find((account) => account.id === cashId);
    if (!cashAccount?.groupId) return "";
    const allowedAccounts = accountList.filter((account) => isInvestAccountAllowed(cashAccount, account));
    if (explicitAccountId && allowedAccounts.some((account) => account.id === explicitAccountId)) return explicitAccountId;
    const sameInstitution = allowedAccounts.find((account) => account.institutionId === cashAccount.institutionId);
    if (sameInstitution) return sameInstitution.id;
    if (allowedAccounts.some((account) => account.id === defaultAccountId)) return defaultAccountId;
    return "";
  }, [cashAccountList, defaultAccountId, accountList, isInvestAccountAllowed]);

  useEffect(() => { setCashAccountList(cashAccounts); }, [cashAccounts]);
  useEffect(() => { setInvestmentAccountList(investmentAccounts); }, [investmentAccounts]);
  useEffect(() => { setLocalCashSSOpts(cashAccountSSOptions); }, [cashAccountSSOptions]);
  useEffect(() => { setLocalInvestSSOpts(investmentAccountSSOptions); }, [investmentAccountSSOptions]);
  const accountUsage = useAccountUsage();
  const shouldListenForEditEvents = listenForEditEvents ?? (mode === "edit" && !entry);
  const effectiveHoldingOptions = useMemo(() => {
    if (!editingRedeemSource || !isRedeem) return typedHoldingOptions;
    const restored: HoldingEntryHoldingOption = {
      id: editingRedeemSource.id,
      label: editingRedeemSource.label,
      subLabel: [
        editingRedeemSource.wealthAccountLabel,
        t("wealthForm.editBeforePrincipal", { amount: editingRedeemSource.restoredRemainingAmount.toFixed(2) }),
        editingRedeemSource.annualRate != null ? t("wealthForm.annualRateShort", { rate: editingRedeemSource.annualRate }) : "",
        editingRedeemSource.termDays ? t("wealthForm.daysSuffix", { days: editingRedeemSource.termDays }) : "",
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
        ...(editingRedeemSource.restoredUnits != null
          ? [{ date: holdingFilterDate, delta: editingRedeemSource.restoredUnits }]
          : []),
      ],
    };
    if (typedHoldingOptions.some((holding) => holding.id === editingRedeemSource.id)) {
      return typedHoldingOptions.map((holding) =>
        holding.id === editingRedeemSource.id ? { ...holding, ...restored } : holding,
      );
    }
    return [restored, ...typedHoldingOptions];
  }, [editingRedeemSource, holdingFilterDate, isRedeem, typedHoldingOptions, t]);

  const filteredHoldingOptions = useMemo(
    () =>
      effectiveHoldingOptions.filter((holding) => {
        if (toAccountId && holding.wealthAccountId !== toAccountId) return false;
        if (!isHoldingAction) return true;
        if (holding.hasUnits) return holdingUnitsAt(holding, holdingFilterDate) > 0.000001;
        return holdingAmountAt(holding, holdingFilterDate) > 0.0001;
      }),
    [effectiveHoldingOptions, holdingFilterDate, isHoldingAction, toAccountId],
  );
  const holdingSelectOptions: SmartSelectOption[] = useMemo(
    () =>
      filteredHoldingOptions.map((holding) => ({
        id: holding.id,
        label: holding.label,
        subLabel: [
          holding.wealthAccountLabel,
          holding.hasUnits
            ? t("wealthForm.dayUnits", { units: holdingUnitsAt(holding, holdingFilterDate).toFixed(6) })
            : t("wealthForm.dayPrincipal", { amount: holdingAmountAt(holding, holdingFilterDate).toFixed(2) }),
          holding.annualRate != null ? t("wealthForm.annualRateShort", { rate: holding.annualRate }) : "",
          holding.termDays ? t("wealthForm.daysSuffix", { days: holding.termDays }) : "",
        ].filter(Boolean).join(" · "),
      })),
    [filteredHoldingOptions, holdingFilterDate, t],
  );
  const selectedHolding = useMemo(
    () => effectiveHoldingOptions.find((holding) => holding.id === selectedHoldingId) ?? null,
    [effectiveHoldingOptions, selectedHoldingId],
  );
  const selectedHoldingAmountAtDate = useMemo(
    () => (selectedHolding ? holdingAmountAt(selectedHolding, holdingFilterDate) : 0),
    [holdingFilterDate, selectedHolding],
  );
  const selectedHoldingUnitsAtDate = useMemo(
    () => (selectedHolding ? holdingUnitsAt(selectedHolding, holdingFilterDate) : 0),
    [holdingFilterDate, selectedHolding],
  );
  const selectedBuyProductRequiresUnits = useMemo(() => {
    if (!requiresUnitsOnBuy || isHoldingAction || !toAccountId) return false;
    const productName = resolveProductNameRef.current?.(productId) ?? fundName.trim();
    return typedHoldingOptions.some((holding) => {
      if (!holding.hasUnits || holding.wealthAccountId !== toAccountId) return false;
      if (productId && holding.wealthProductId === productId) return true;
      return !!productName && holding.fundName === productName;
    });
  }, [fundName, isHoldingAction, productId, requiresUnitsOnBuy, toAccountId, typedHoldingOptions]);
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

  function changeRedeemPrincipal(value: string) {
    setAmount(value);
    if (isRedeem) setArrivalEdited(false);
  }
  function changeRedeemUnits(value: string) {
    unitsEditedRef.current = true;
    setUnits(value);
    if (isRedeem) setArrivalEdited(false);
  }
  function changeRedeemNav(value: string) {
    setNav(value);
    if (isRedeem) setArrivalEdited(false);
  }
  function changeRedeemInterest(value: string) {
    setInterestEdited(true);
    setInterestAmount(value);
    if (isRedeem) setArrivalEdited(false);
  }

  function changeTradeDate(nextDate: string) {
    setDate(nextDate);
    tradeDateChangeRef.current?.();
    if (isHoldingAction) {
      setHoldingFilterDate(nextDate);
      autoFilledUnitsForRef.current = null;
    }
    if (mode === "create" && isHoldingAction && !arrivalDateTouchedRef.current) {
      setArrivalDate(nextDate);
    }
  }
  function changeArrivalDate(nextDate: string) {
    arrivalDateTouchedRef.current = true;
    setArrivalDate(nextDate);
  }

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
    setProductId("");
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
    setPendingAttachmentFiles([]);
    setRequestId(null);
    setEditEntryId(null);
    setEditBusinessTransactionId(null);
    domainResetRef.current?.();
  }

  /**
   * 保存并再记一笔：日期、产品、账户、利率、期限、所选持有项都留在原处；
   * 金额与由金额派生的份额/净值/利息/到账，以及备注清空 —— 必须让用户看到表单确实变了。
   * 只清理「这一笔」的会话态：已上传附件、requestId 与编辑态标识。
   */
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
    setPendingAttachmentFiles([]);
    setRequestId(null);
    setEditEntryId(null);
    setEditBusinessTransactionId(null);
  }

  /** 动作页签切换：字段重置逻辑沿用原分段按钮，逐项照搬以保证行为不变。 */
  function selectSubtypeTab(next: HoldingEntrySubtype) {
    if (next === "buy") {
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
      return;
    }
    if (next === "redeem") {
      setSubtype("redeem");
      setAmount("");
      setUnits("");
      setNav("");
      unitsEditedRef.current = false;
      autoFilledUnitsForRef.current = null;
      if (!arrivalDateTouchedRef.current) setArrivalDate(date);
      setInterestEdited(false);
      setArrivalEdited(false);
      return;
    }
    if (next === "dividend_cash") {
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
      return;
    }
    setSubtype("write_off");
    setAmount("");
    setUnits("");
    setNav("");
    unitsEditedRef.current = false;
    autoFilledUnitsForRef.current = null;
    setInterestAmount("");
    setArrivalAmount("");
    setInterestEdited(false);
    setArrivalEdited(false);
  }
  /** 把一条记录摊回草稿；事件路径与 openSignal 路径的既有差异通过 opts 表达。 */
  function applyDraft(
    source: HoldingEntryEntry,
    opts: { nextSubtype: HoldingEntrySubtype; eventPath: boolean; requestId?: string | null; keepZeroAmount: boolean },
  ) {
    const baseDate = source.date?.slice(0, 10) || today;
    if (opts.eventPath) {
      setRequestId(opts.requestId ?? null);
      setEditEntryId(
        options.editEventEntryIdMode === "detail"
          ? (source.cashEntryId ?? source.entryId ?? null)
          : (source.cashEntryId ?? null),
      );
    } else {
      setEditEntryId(source.cashEntryId ?? source.id ?? source.transactionId ?? null);
    }
    setEditBusinessTransactionId(source.businessTransactionId ?? null);
    setSubtype(opts.nextSubtype);
    domainResetRef.current?.();
    setDate(baseDate);
    setHoldingFilterDate(baseDate);
    setArrivalDate(source.fundArrivalDate?.slice(0, 10) || baseDate);
    arrivalDateTouchedRef.current = true;
    const principal = inferRedeemPrincipalAmount(source);
    setAmount(opts.keepZeroAmount ? formatAmountDraft(principal) : principal ? formatAmountDraft(principal) : "");
    setUnits(source.fundUnits != null ? String(Math.abs(source.fundUnits)) : "");
    setNav(source.fundNav != null ? String(Math.abs(source.fundNav)) : "");
    unitsEditedRef.current = opts.nextSubtype === "redeem";
    setProductId(source.wealthProductId ?? "");
    setFundName(source.fundName ?? "");
    setInterestAmount(opts.nextSubtype === "redeem" && source.depositInterest != null ? formatAmountDraft(source.depositInterest) : "");
    setArrivalAmount(opts.nextSubtype === "redeem" ? formatAmountDraft(Math.abs(source.fundArrivalAmount ?? source.amount ?? 0)) : "");
    setInterestEdited(false);
    setArrivalEdited(false);
    setMemo(source.note ?? "");
    const outgoing = opts.nextSubtype === "redeem" || opts.nextSubtype === "dividend_cash" || opts.nextSubtype === "write_off";
    setCashAccountId(opts.nextSubtype === "write_off" ? "" : outgoing ? (source.toAccountId ?? "") : (source.accountId ?? ""));
    const nextAccountId = outgoing ? (source.accountId ?? defaultAccountId) : (source.toAccountId ?? defaultAccountId);
    setToAccountId(
      opts.eventPath
        ? (accountIds.has(nextAccountId) ? nextAccountId : (accountList[0]?.id ?? ""))
        : nextAccountId,
    );
    const detail: HoldingEntryEditDetail = {
      requestId: opts.requestId ?? "",
      entryId: source.entryId ?? source.id ?? "",
      cashEntryId: source.cashEntryId ?? null,
      businessTransactionId: source.businessTransactionId ?? null,
      type: source.fundProductType ?? "",
      date: source.date ?? today,
      amount: source.amount ?? 0,
      note: source.note ?? "",
      accountId: source.accountId ?? undefined,
      toAccountId: source.toAccountId ?? undefined,
      fundName: source.fundName ?? undefined,
      wealthProductId: source.wealthProductId ?? null,
      fundSubtype: source.fundSubtype ?? undefined,
      fundArrivalDate: source.fundArrivalDate ?? null,
      fundUnits: source.fundUnits ?? null,
      fundNav: source.fundNav ?? null,
      depositInterest: source.depositInterest ?? null,
      fundArrivalAmount: source.fundArrivalAmount ?? null,
      fundProductType: source.fundProductType ?? undefined,
      sourceLotId: source.sourceLotId ?? null,
      nextSubtype: opts.nextSubtype,
    };
    const matchedHolding = matchHoldingRef.current
      ? matchHoldingRef.current({ detail, nextAccountId, holdings: typedHoldingOptions })
      : typedHoldingOptions.find((holding) => {
        if (holding.wealthAccountId !== nextAccountId) return false;
        if (detail.wealthProductId && holding.wealthProductId === detail.wealthProductId) return true;
        return !!detail.fundName && holding.fundName === detail.fundName;
      });
    setSelectedHoldingId(matchedHolding?.id ?? "");
    if (opts.nextSubtype !== "redeem") {
      setEditingRedeemSource(null);
      return;
    }
    const restoredPrincipalAmount = inferRedeemPrincipalAmount(source);
    const restoredUnits = source.fundUnits != null ? Math.abs(source.fundUnits) : null;
    const restoredHoldingId = matchedHolding?.id
      ?? restoredSourceIdRef.current?.({ detail })
      ?? `${nextAccountId}\u001f${detail.wealthProductId ? `product:${detail.wealthProductId}` : `name:${detail.fundName ?? t("wealthForm.unnamedProduct")}`}`;
    const restoreBaseDate = source.date || today;
    setEditingRedeemSource({
      id: restoredHoldingId,
      label: matchedHolding?.label ?? detail.fundName ?? t("wealthForm.unnamedProduct"),
      fundName: detail.fundName ?? matchedHolding?.fundName ?? t("wealthForm.unnamedProduct"),
      wealthProductId: detail.wealthProductId ?? matchedHolding?.wealthProductId ?? null,
      wealthAccountId: nextAccountId,
      wealthAccountLabel:
        matchedHolding?.wealthAccountLabel
        ?? accountList.find((account) => account.id === nextAccountId)?.label
        ?? t("wealthForm.accountLabel"),
      restoredPrincipalAmount: Number(restoredPrincipalAmount.toFixed(2)),
      restoredRemainingAmount: Number(
        ((matchedHolding ? holdingAmountAt(matchedHolding, restoreBaseDate) : 0) + restoredPrincipalAmount).toFixed(2),
      ),
      restoredUnits,
      restoredRemainingUnits: restoredUnits == null
        ? matchedHolding?.remainingUnits ?? null
        : Number(((matchedHolding ? holdingUnitsAt(matchedHolding, restoreBaseDate) : 0) + restoredUnits).toFixed(6)),
      hasUnits: matchedHolding?.hasUnits || restoredUnits != null,
      annualRate: matchedHolding?.annualRate ?? null,
      termDays: matchedHolding?.termDays ?? null,
      movements: matchedHolding?.movements ?? [],
      unitMovements: matchedHolding?.unitMovements ?? [],
    });
    setSelectedHoldingId(restoredHoldingId);
  }
  useEffect(() => {
    if (mode !== "edit" || !entry || !openSignal) return;
    const nextSubtype: HoldingEntrySubtype =
      entry.fundSubtype === "dividend_cash" ? "dividend_cash"
        : entry.fundSubtype === "write_off" ? "write_off"
          : initIsRedeem ? "redeem" : "buy";
    applyDraft(entry, { nextSubtype, eventPath: false, keepZeroAmount: true });
    setOpen(true);
  }, [defaultAccountId, entry, initIsRedeem, mode, openSignal, today, accountList, typedHoldingOptions]);

  // 编辑事件：明细字段与 openSignal 路径一致，但 requestId / editEntryId / 账户兜底不同。
  useEffect(() => {
    if (!shouldListenForEditEvents) return;
    function onEdit(ev: Event) {
      const rawDetail = (ev as CustomEvent<HoldingEntryEditDetail>).detail;
      const detail = mapEditDetailRef.current ? mapEditDetailRef.current(rawDetail) : rawDetail;
      if (!detail?.requestId || !detail.entryId) return;
      const nextSubtype: HoldingEntrySubtype =
        detail.fundSubtype === "dividend_cash" ? "dividend_cash"
          : detail.fundSubtype === "write_off" ? "write_off"
            : detail.fundSubtype === "redeem" ? "redeem" : "buy";
      applyDraft(
        { ...detail, id: detail.entryId, entryId: detail.entryId },
        { nextSubtype, eventPath: true, requestId: detail.requestId, keepZeroAmount: false },
      );
      setOpen(true);
    }
    window.addEventListener(`mmh:${eventNamespace}:edit`, onEdit as EventListener);
    return () => window.removeEventListener(`mmh:${eventNamespace}:edit`, onEdit as EventListener);
  }, [accountIds, accountList, defaultAccountId, eventNamespace, mode, shouldListenForEditEvents, today, typedHoldingOptions]);

  // 新建事件：外部（账户页/移动端）请求直接打开表单。
  useEffect(() => {
    if (mode !== "create") return;
    function onCreate(ev: Event) {
      const detail = (ev as CustomEvent<Record<string, unknown> & {
        requestId?: string;
        defaultCashAccountId?: string;
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
      if (typeof detail?.defaultAmount === "number" && detail.defaultAmount > 0) setAmount(formatAmountDraft(detail.defaultAmount));
      const explicitAccountId = detail?.[defaultAccountKey];
      setToAccountId(
        resolveAccountForCashAccount(
          nextCashAccountId,
          typeof explicitAccountId === "string" ? explicitAccountId : undefined,
        ),
      );
      setOpen(true);
    }
    window.addEventListener(`mmh:${eventNamespace}:create`, onCreate as EventListener);
    return () => window.removeEventListener(`mmh:${eventNamespace}:create`, onCreate as EventListener);
  }, [defaultAccountKey, eventNamespace, mode, resolveAccountForCashAccount, today]);

  useEffect(() => {
    setHoldingFilterDate(date);
  }, [date, isHoldingAction]);

  useEffect(() => {
    if (!open || mode !== "create" || !cashAccountId || subtype !== "buy") return;
    const nextAccountId = resolveAccountForCashAccount(cashAccountId, toAccountId);
    if (nextAccountId !== toAccountId) setToAccountId(nextAccountId);
  }, [cashAccountId, mode, open, resolveAccountForCashAccount, subtype, toAccountId]);
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
    setProductId(selectedHolding.wealthProductId ?? "");
    setFundName(selectedHolding.fundName);
    if (isRedeem && !editEntryId) {
      setAmount(selectedHoldingAmountAtDate > 0 ? selectedHoldingAmountAtDate.toFixed(2) : "");
      const autoFillKey = `${selectedHoldingId}:${holdingFilterDate}`;
      // 用户手动改过份额后一律不覆盖；只有自动回填且日期/持仓变化时才刷新（见产品规则）。
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
  }, [
    editEntryId, holdingFilterDate, isHoldingAction, isRedeem, selectedHolding,
    selectedHoldingAmountAtDate, selectedHoldingId, selectedHoldingUnitsAtDate, toAccountId,
  ]);

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

  /** 账户弹窗里新建了分组/机构后，保持嵌套选项是最新的。 */
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
  return {
    // 开合与草稿
    open, setOpen,
    subtype, setSubtype,
    date, setDate,
    holdingFilterDate, setHoldingFilterDate,
    arrivalDate, setArrivalDate,
    amount, setAmount,
    units, setUnits,
    nav, setNav,
    productId, setProductId,
    fundName, setFundName,
    annualRate, setAnnualRate,
    termDays, setTermDays,
    interestAmount, setInterestAmount,
    arrivalAmount, setArrivalAmount,
    interestEdited, setInterestEdited,
    arrivalEdited, setArrivalEdited,
    memo, setMemo,
    pendingAttachmentFiles, setPendingAttachmentFiles,
    submitting, setSubmitting,
    requestId, setRequestId,
    editEntryId, setEditEntryId,
    editBusinessTransactionId, setEditBusinessTransactionId,
    editingRedeemSource, setEditingRedeemSource,
    selectedHoldingId, setSelectedHoldingId,
    // 账户
    cashAccountId, setCashAccountId,
    toAccountId, setToAccountId,
    cashAccountList, setCashAccountList,
    investmentAccountList, setInvestmentAccountList,
    localCashSSOpts, setLocalCashSSOpts,
    localInvestSSOpts, setLocalInvestSSOpts,
    nestedEntityType, setNestedEntityType,
    localNestedFieldData,
    handleNestedOptionCreated,
    selectedCashAccount,
    accountList,
    accountIds,
    selectableAccountList,
    selectableAccountIds,
    accountOptions,
    selectOptions,
    cashAccountOptions,
    cashSelectOptions,
    selectedInvestAccount,
    productInstitutionId,
    selectedInvestInstitutionId,
    redeemCashOptions,
    resolveAccountForCashAccount,
    accountUsage,
    cfLabel,
    cfCycle,
    cashFiltered,
    ownerFilterLabel,
    cycleOwnerFilter,
    // 动作与持仓
    isRedeem,
    isDividend,
    isWriteOff,
    isHoldingAction,
    effectiveHoldingOptions,
    filteredHoldingOptions,
    holdingSelectOptions,
    selectedHolding,
    selectedHoldingAmountAtDate,
    selectedHoldingUnitsAtDate,
    selectedBuyProductRequiresUnits,
    shouldListenForEditEvents,
    // 数值
    amountNumber,
    unitsNumber,
    navNumber,
    interestNumber,
    redeemPrincipalNumber,
    arrivalPreview,
    // 交互
    reset,
    resetAfterKeepAdding,
    changeTradeDate,
    changeArrivalDate,
    changeRedeemPrincipal,
    changeRedeemUnits,
    changeRedeemNav,
    changeRedeemInterest,
    selectSubtypeTab,
    // 供调用方在输入框事件里读取/复位（赎回份额守卫）
    unitsEditedRef,
    autoFilledUnitsForRef,
  };
}

/** 共享状态机的返回值，供通用字段块（`HoldingEntryFields`）整包接收。 */
export type HoldingEntryFormApi = ReturnType<typeof useHoldingEntryForm>;
