"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { parseNumber } from "@/lib/investment-config";
import { DateStepper } from "./DateStepper";
import { CalcInput } from "./CalcInput";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
/** 记账弹窗整窗外壳：宽度/标题栏/表单/FT 页签卡片/固定页脚/高度锁定统一由它负责。 */
import { EntryModalShell } from "@/components/EntryModalShell";
import {
  HoldingAccountCreateModal,
  HoldingHoldingFields,
  HoldingMemoField,
  HoldingProductModal,
} from "@/components/holding-entry/HoldingEntryFields";
import { recordRecentAccount, sortByAccountUsage } from "@/lib/client/recentAccounts";
import { compactFinanceAccountIds, dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";
import { depositTermMaturityUtc, type DepositTermUnit } from "@/lib/deposit-term";
import {
  type DepositInterestPayoutUnit,
  clampDepositInterestPayoutInterval,
  encodeDepositInterestPayout,
  maxDepositInterestPayoutInterval,
  parseDepositInterestPayout,
} from "@/lib/deposit-interest-payout";
import { uploadEntryAttachmentFiles } from "./EntryAttachmentPanel";
import { mergeProductOptions } from "@/lib/holding-entry/primitives";
import { useHoldingEntryForm } from "@/lib/holding-entry/useHoldingEntryForm";
import type { HoldingEntryEditDetail } from "@/lib/holding-entry/types";

type Entry = {
  id?: string;
  transactionId?: string;
  cashEntryId?: string | null;
  businessTransactionId?: string | null;
  /** 债券存单归属：子行指回所属存单；买入行自己就是存单（为 null）。 */
  sourceBondTransactionId?: string | null;
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
type BondProductOption = {
  id: string;
  name: string;
  shortName?: string | null;
  institutionId?: string | null;
  institutionName?: string | null;
  currency?: string | null;
  annualRate?: number | null;
  termDays?: number | null;
  productType?: string | null;
  maturityDate?: string | null;
  payoutFrequency?: string | null;
  interestCalcBasis?: string | null;
  firstPayoutDate?: string | null;
  note?: string | null;
};
type BondHoldingOption = {
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
type BondSubtype = "buy" | "redeem" | "dividend_cash" | "write_off";
/**
 * 债券存单（持仓）：一笔买入 = 一张存单 = 一个持仓。同一债单可以有多张存单，
 * 各自带起息日与条款，因此付息/赎回/核销必须指明所属存单（bondSourceLotId）。
 */
type BondLotOption = {
  id: string;
  name: string;
  accountId: string;
  certificateIndex: number;
  startDate: string | null;
  maturityDate: string | null;
  annualRate: number | null;
  principal: number;
  status: "open" | "closed";
};

export function BondFormModal({
  mode = "create",
  accountId: defaultAccountId,
  entry,
  listenForEditEvents,
  openSignal,
  cashAccounts = [],
  investmentAccounts = [],
  cashAccountSSOptions,
  investmentAccountSSOptions,
  bondLotOptions = [],
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
  /** 债券存单下拉：付息/赎回/核销按存单选（债券是存单粒度，不是产品聚合持仓）。 */
  bondLotOptions?: BondLotOption[];
  /** Groups & institutions data for NestedAddModal compact account creation */
  nestedFieldData?: NestedFieldData;
  createAction: (formData: FormData) => Promise<{ ok: true; data?: { id?: string; cashEntryId?: string } } | { ok: false; error: string }>;
  editAction?: (formData: FormData) => Promise<{ ok: true; data?: { id?: string; cashEntryId?: string } } | { ok: false; error: string }>;
}) {
  const { t } = useI18n();
  // 文案键说明：债券表单复用「持仓型记账」的通用文案（wealthForm.* 是建表时的
  // 历史命名，见 src/lib/i18n-core.ts）；债券专属条款文案使用 bondForm.*。
  // 数据字段同理：Entry.wealthProductId / wealthAccountId 是既有数据契约，不改名。

  // 品种专属状态留在本组件：债券条款（期限/到期日/付息/计息基准）与产品主数据。
  const [bondTermUnit, setBondTermUnit] = useState<DepositTermUnit>("year");
  const [bondTermCount, setBondTermCount] = useState("1");
  const [bondMaturityDate, setBondMaturityDate] = useState("");
  const bondMaturityDateTouchedRef = useRef(false);
  const [bondPayoutUnit, setBondPayoutUnit] = useState<"maturity" | DepositInterestPayoutUnit>("maturity");
  const [bondPayoutInterval, setBondPayoutInterval] = useState("1");
  const [bondFirstPayoutDate, setBondFirstPayoutDate] = useState("");
  const bondFirstPayoutDateTouchedRef = useRef(false);
  const bondProductRestoredRef = useRef(false);
  const [bondCalcBasis, setBondCalcBasis] = useState<"daily" | "monthly">("daily");
  const [bondProducts, setBondProducts] = useState<BondProductOption[]>([]);
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [productSaving, setProductSaving] = useState(false);
  const [productDraft, setProductDraft] = useState({
    name: "",
    shortName: "",
    annualRate: "",
    termDays: "",
    note: "",
    productType: "standard",
    maturityDate: "",
    payoutFrequency: "maturity",
    firstPayoutDate: "",
  });
  const [productError, setProductError] = useState("");

  // 债券持仓 = 存单。同一债单多张存单用「名称 #序号」区分；无份额/净值概念。
  const typedHoldingOptions = useMemo<BondHoldingOption[]>(() => {
    const accountLabelById = new Map(
      investmentAccounts.map((account) => [account.id, account.label || ""]),
    );
    return bondLotOptions.map((lot) => ({
      id: lot.id,
      label: lot.certificateIndex > 1 ? `${lot.name} #${lot.certificateIndex}` : lot.name,
      subLabel: [
        accountLabelById.get(lot.accountId) ?? "",
        lot.annualRate != null ? t("wealthForm.annualRateShort", { rate: lot.annualRate }) : "",
        lot.maturityDate ? t("bondForm.maturityShort", { date: lot.maturityDate }) : "",
        t("bondForm.lotPrincipal", { amount: lot.principal.toFixed(2) }),
      ].filter(Boolean).join(" · "),
      fundName: lot.name,
      wealthProductId: null,
      wealthAccountId: lot.accountId,
      wealthAccountLabel: accountLabelById.get(lot.accountId) ?? null,
      remainingAmount: lot.principal,
      remainingUnits: null,
      hasUnits: false,
      annualRate: lot.annualRate,
      termDays: null,
      // 存单本金只有一个锚点（起息日买入），供按日期取本金用。
      movements: lot.startDate ? [{ date: lot.startDate, delta: lot.principal }] : [],
      unitMovements: [],
    }));
  }, [bondLotOptions, investmentAccounts, t]);

  // 存单归属（sourceBondTransactionId）经 sourceLotId 交给共享状态机；
  // 编辑事件里由 mapEditDetail 归一，避免共享层出现品种字段名。
  const hookEntry = useMemo(
    () => (entry ? { ...entry, sourceLotId: entry.sourceBondTransactionId ?? null } : undefined),
    [entry],
  );
  const holdingActionRef = useRef(false);
  const form = useHoldingEntryForm({
    mode,
    entry: hookEntry,
    defaultAccountId,
    openSignal,
    listenForEditEvents,
    cashAccounts,
    investmentAccounts,
    cashAccountSSOptions,
    investmentAccountSSOptions,
    nestedFieldData,
    typedHoldingOptions,
    productKind: "bond",
    eventNamespace: "bond",
    defaultAccountKey: "defaultBondAccountId",
    requiresUnitsOnBuy: false,
    resolveProductName: (id) => bondProducts.find((product) => product.id === id)?.name,
    mapEditDetail: (detail) => ({
      ...detail,
      sourceLotId:
        detail.sourceLotId
        ?? (detail as HoldingEntryEditDetail & { sourceBondTransactionId?: string | null }).sourceBondTransactionId
        ?? null,
    }),
    matchHolding: ({ detail, nextAccountId, holdings }) => {
      const lotId = detail.sourceLotId
        ?? (detail.nextSubtype === "buy" ? detail.businessTransactionId ?? null : null);
      return holdings.find((holding) => holding.id === lotId)
        ?? holdings.find(
          (holding) =>
            holding.wealthAccountId === nextAccountId
            && !!detail.fundName
            && holding.fundName === detail.fundName,
        );
    },
    resolveRestoredSourceId: ({ detail }) =>
      detail.sourceLotId ?? (detail.nextSubtype === "buy" ? detail.businessTransactionId ?? null : null),
    editEventEntryIdMode: "detail",
    onDomainReset: () => {
      bondProductRestoredRef.current = false;
      setBondTermUnit("year");
      setBondTermCount("1");
      setBondMaturityDate("");
      bondMaturityDateTouchedRef.current = false;
      setBondPayoutUnit("maturity");
      setBondPayoutInterval("1");
      setBondFirstPayoutDate("");
      bondFirstPayoutDateTouchedRef.current = false;
      setBondCalcBasis("daily");
    },
    onTradeDateChange: () => {
      // 条款只在买入页签可见：动作页签改日期不必重置触碰标记。
      if (holdingActionRef.current) return;
      bondMaturityDateTouchedRef.current = false;
      bondFirstPayoutDateTouchedRef.current = false;
    },
  });
  const {
    open, setOpen, subtype, date,
    arrivalDate, amount, setAmount, units,
    productId: wealthProductId, setProductId: setWealthProductId, fundName, setFundName,
    annualRate, setAnnualRate, termDays, setTermDays,
    interestAmount, arrivalAmount, setArrivalAmount, arrivalEdited, setArrivalEdited,
    cashAccountId, setCashAccountId, toAccountId, setToAccountId,
    memo, setMemo, pendingAttachmentFiles, setPendingAttachmentFiles, submitting, setSubmitting,
    requestId, editEntryId, editBusinessTransactionId,
    setInvestmentAccountList, setLocalInvestSSOpts, setNestedEntityType,
    isRedeem, isDividend, isWriteOff, isHoldingAction,
    selectedCashAccount, accountIds: bondAccountIds,
    selectableAccountIds: selectableBondAccountIds,
    selectOptions: bondSelectOptions, selectedInvestAccount: selectedBondAccount,
    productInstitutionId, redeemCashOptions,
    selectedHolding, selectedHoldingId, selectedBuyProductRequiresUnits,
    interestNumber, redeemPrincipalNumber, arrivalPreview,
    accountUsage, cfLabel, cfCycle, cashSelectOptions,
    ownerFilterLabel: bondOwnerLabel, cycleOwnerFilter: cycleBondOwner,
    reset, resetAfterKeepAdding, changeTradeDate, changeArrivalDate,
    changeRedeemPrincipal, changeRedeemInterest, selectSubtypeTab,
  } = form;
  holdingActionRef.current = isHoldingAction;

  const bondProductOptions: SmartSelectOption[] = useMemo(
    () =>
      bondProducts
        // 产品按模式过滤：债券直达模式只列城投债产品；普通理财模式不列债券产品（两类互不混排）。
        .filter((product) => product.productType === "bond")
        .map((product) => ({
          id: product.id,
          label: product.shortName?.trim() || product.name,
          subLabel: [product.shortName?.trim() ? product.name : "", product.institutionName || ""]
            .filter(Boolean)
            .join(" · "),
        })),
    [bondProducts],
  );





  useEffect(() => {
    if (subtype !== "buy" || bondMaturityDateTouchedRef.current) return;
    setBondMaturityDate(bondTermMaturityFromTerm(bondTermUnit, parseNumber(bondTermCount) || 0));
  }, [bondTermCount, bondTermUnit, date, subtype]);

  useEffect(() => {
    if (subtype !== "buy" || bondFirstPayoutDateTouchedRef.current) return;
    if (bondPayoutUnit === "maturity") { setBondFirstPayoutDate(bondMaturityDate); return; }
    setBondFirstPayoutDate(bondFirstPayoutDateFromFrequency(bondPayoutUnit, parseNumber(bondPayoutInterval) || 1));
  }, [bondPayoutInterval, bondPayoutUnit, bondMaturityDate, date, subtype]);

  // In edit mode the product master owns the bond terms (maturity date, payout
  // cycle, calc basis, first payout date, coupon rate). Once the product list
  // has loaded, apply the saved terms so the form reopens with the values
  // saved on the product instead of the defaults restored above.
  useEffect(() => {
    if (mode !== "edit" || !open || !wealthProductId || bondProductRestoredRef.current) return;
    const product = bondProducts.find((item) => item.id === wealthProductId);
    if (!product) return;
    bondProductRestoredRef.current = true;
    applyBondProductToDraft(product);
    if (product.annualRate != null) setAnnualRate(String(product.annualRate));
    if (product.termDays != null) setTermDays(String(product.termDays));
  }, [mode, open, wealthProductId, bondProducts]);






  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const institutionId = productInstitutionId ?? "";
    // 读债券产品主数据（/api/v1/bond-products）。
    const basePath = "/api/v1/bond-products";
    const url = institutionId
      ? `${basePath}?institutionId=${encodeURIComponent(institutionId)}`
      : basePath;
    void fetch(url, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data?.ok) return;
        const products = ((data.products ?? []) as BondProductOption[])
          .map((product) => ({ ...product, productType: "bond" }));
        if (wealthProductId && institutionId && !products.some((product) => product.id === wealthProductId)) {
          setWealthProductId("");
          setFundName("");
        }
        setBondProducts((prev) => {
          const selectedLocalProducts = prev.filter((product) =>
            (!institutionId || product.institutionId === institutionId) && (
              product.id === wealthProductId ||
              (!!fundName && (product.name === fundName || product.shortName === fundName))
            ),
          );
          return mergeProductOptions(products, selectedLocalProducts);
        });
        if (!wealthProductId && fundName) {
          const matched = products.find((product) => product.name === fundName || product.shortName === fundName);
          if (matched) setWealthProductId(matched.id);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fundName, open, productInstitutionId, wealthProductId]);

  function openBondProductModal() {
    // 产品弹窗只做新建（名称+备注）；条款（利率/到期日/付息）在购买界面按次填写。
    setProductDraft({
      name: fundName.trim(),
      shortName: "",
      annualRate,
      termDays,
      note: "",
      // 债券直达模式下新建产品默认城投债类型，免去再手动切换。
      productType: "bond",
      maturityDate: "",
      payoutFrequency: "maturity",
      firstPayoutDate: "",
    });
    setProductError(selectedCashAccount ? "" : t("wealthForm.alert.selectSourceFirst"));
    setProductModalOpen(true);
  }

  function openBondAccountModal() {
    if (!selectedCashAccount) {
      window.alert(t("wealthForm.alert.selectSourceFirst"));
      return;
    }
    if (!selectedCashAccount.groupId || !selectedCashAccount.institutionId) {
      window.alert(t("wealthForm.alert.sourceAccountMissingOwnerOrInstitution"));
      return;
    }
    setNestedEntityType("bond-account");
  }

  function productAccountHint() {
    if (selectedBondAccount) return t("wealthForm.productHintWillAssignTo", { account: selectedBondAccount.label });
    if (selectedCashAccount) {
      // 债券/理财是两类账户：自动建账提示按当前模式显示对应账户类型。
      return t("bondForm.productHintAutoCreate", { account: selectedCashAccount.label });
    }
    return t("wealthForm.productHintSelectSourceFirst");
  }

  function splitBondTermDays(days: number | null | undefined): { unit: DepositTermUnit; count: number } {
    const total = Math.max(0, Math.trunc(Number(days ?? 0)));
    const startDate = new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
    if (Number.isFinite(startDate.getTime()) && total > 0) {
      for (let years = Math.floor(total / 365) + 1; years >= 1; years--) {
        const anniversary = depositTermMaturityUtc(startDate, "year", years);
        const days = Math.round((anniversary.getTime() - startDate.getTime()) / 86400000);
        if (days === total || days + 1 === total) return { unit: "year", count: years };
      }
      for (let months = Math.floor(total / 28) + 1; months >= 1; months--) {
        const anniversary = depositTermMaturityUtc(startDate, "month", months);
        const days = Math.round((anniversary.getTime() - startDate.getTime()) / 86400000);
        if (days === total || days + 1 === total) return { unit: "month", count: months };
      }
    }
    if (total % 365 === 0 && total > 0) return { unit: "year", count: total / 365 };
    if (total % 30 === 0 && total > 0) return { unit: "month", count: total / 30 };
    return { unit: "day", count: total };
  }

  function bondTermMaturityFromTerm(unit: DepositTermUnit, count: number): string {
    if (!date) return "";
    const start = new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
    if (!Number.isFinite(start.getTime())) return "";
    const quantity = Math.max(0, Math.trunc(Number(count) || 0));
    if (quantity <= 0) return "";
    return depositTermMaturityUtc(start, unit, quantity).toISOString().slice(0, 10);
  }

  function bondTermDaysFromMaturity(maturityDate: string): number {
    if (!date || !maturityDate) return 0;
    const start = new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
    const end = new Date(`${maturityDate.slice(0, 10)}T00:00:00.000Z`);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end.getTime() <= start.getTime()) return 0;
    return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
  }

  function changeBondMaturityDate(nextMaturityDate: string) {
    bondMaturityDateTouchedRef.current = true;
    setBondMaturityDate(nextMaturityDate);
  }

  function changeBondPayoutFrequency(unit: "maturity" | DepositInterestPayoutUnit, interval: number) {
    setBondPayoutUnit(unit);
    setBondPayoutInterval(String(Math.max(1, Math.trunc(interval || 1))));
  }

  function changeBondFirstPayoutDate(value: string) {
    bondFirstPayoutDateTouchedRef.current = true;
    setBondFirstPayoutDate(value);
  }

  function bondTermDaysForProduct() {
    const quantity = Math.max(0, Math.trunc(parseNumber(bondTermCount) || 0));
    const derivedMaturity = bondTermMaturityFromTerm(bondTermUnit, quantity);
    return bondMaturityDate
      ? bondTermDaysFromMaturity(bondMaturityDate)
      : (derivedMaturity ? Math.max(1, Math.round((new Date(`${derivedMaturity}T00:00:00.000Z`).getTime() - new Date(`${date}T00:00:00.000Z`).getTime()) / 86400000)) : 0);
  }

  function applyBondProductToDraft(product: BondProductOption | undefined) {
    if (!product || product.productType !== "bond") return;
    const term = splitBondTermDays(product.termDays);
    setBondTermUnit(term.unit);
    setBondTermCount(String(term.count));
    setBondMaturityDate(product.maturityDate ?? "");
    bondMaturityDateTouchedRef.current = Boolean(product.maturityDate);
    const payout = parseDepositInterestPayout(product.payoutFrequency);
    setBondPayoutUnit(payout.kind === "periodic" ? payout.unit : "maturity");
    setBondPayoutInterval(payout.kind === "periodic" ? String(payout.interval) : "1");
    setBondFirstPayoutDate(product.firstPayoutDate ?? "");
    bondFirstPayoutDateTouchedRef.current = Boolean(product.firstPayoutDate);
    setBondCalcBasis(product.interestCalcBasis === "monthly" ? "monthly" : "daily");
  }

  function encodedBondPayoutFrequency() {
    return bondPayoutUnit === "maturity"
      ? "maturity"
      : encodeDepositInterestPayout({
          kind: "periodic",
          unit: bondPayoutUnit,
          interval: clampDepositInterestPayoutInterval(bondTermDaysForProduct(), bondPayoutUnit, parseNumber(bondPayoutInterval) || 1),
        });
  }

  function bondFirstPayoutDateFromFrequency(unit: "maturity" | DepositInterestPayoutUnit, interval: number): string {
    if (!date || unit === "maturity") return "";
    const quantity = Math.max(1, Math.trunc(interval || 1));
    const start = new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
    if (!Number.isFinite(start.getTime())) return "";
    if (unit === "week") {
      const next = new Date(start.getTime() + quantity * 7 * 86400000);
      return Number.isFinite(next.getTime()) ? next.toISOString().slice(0, 10) : "";
    }
    const next = depositTermMaturityUtc(start, unit, quantity);
    return Number.isFinite(next.getTime()) ? next.toISOString().slice(0, 10) : "";
  }

  function effectiveBondFirstPayoutDate() {
    if (bondFirstPayoutDateTouchedRef.current && bondFirstPayoutDate) return bondFirstPayoutDate;
    if (bondPayoutUnit === "maturity") return bondMaturityDate || bondFirstPayoutDate;
    return bondFirstPayoutDateFromFrequency(bondPayoutUnit, parseNumber(bondPayoutInterval) || 1) || bondFirstPayoutDate;
  }

  async function saveBondProduct() {
    const name = productDraft.name.trim();
    setProductError("");
    if (!selectedCashAccount) {
      setProductError(t("wealthForm.alert.selectSourceFirst"));
      return;
    }
    if (!name) {
      setProductError(t("wealthForm.alert.enterProductName"));
      return;
    }
    setProductSaving(true);
    try {
      // 新建产品只登记名称（利率/到期日/付息条款在购买界面按次填写，之后可在
      // 债单条款卡里编辑），避免一进弹窗就要求填齐条款。
      // 债券产品写独立主数据（/api/v1/bond-products），不写进理财产品表。
      const res = await fetch("/api/v1/bond-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          note: productDraft.note.trim() || undefined,
          cashAccountId: selectedCashAccount.id,
          bondAccountId: selectedBondAccount?.id ?? undefined,
          currency: selectedBondAccount?.currency ?? selectedCashAccount.currency ?? "CNY",
          annualRate: parseNumber(annualRate) > 0 ? String(parseNumber(annualRate)) : undefined,
          termDays: bondTermDaysForProduct() > 0 ? String(bondTermDaysForProduct()) : undefined,
          maturityDate: bondMaturityDate ? bondMaturityDate : undefined,
          payoutFrequency: encodedBondPayoutFrequency(),
          interestCalcBasis: bondCalcBasis,
          firstPayoutDate: effectiveBondFirstPayoutDate() ? effectiveBondFirstPayoutDate() : undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      const accountPayload = data?.bondAccount ?? data?.wealthAccount;
      if (!data?.ok || !data.product || !accountPayload) {
        throw new Error(data?.error ?? t("wealthForm.alert.createProductFailed"));
      }
      const product = ({ ...(data.product as BondProductOption), productType: "bond" });
      const account = accountPayload as {
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
        subLabel: [account.groupName, accountLabelText].filter(Boolean).join(" · "),
        kind: account.kind,
        groupId: account.groupId ?? null,
        // 此处拿到的是债券产品接口返回的债券账户；DB 未标记品种时按债券处理，
        // 否则该账户会因 investProductType 过滤而无法出现在债券账户下拉里。
        investProductType: account.investProductType ?? "bond",
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
      setBondProducts((prev) => prev.some((item) => item.id === product.id) ? prev : [...prev, product]);
      setWealthProductId(product.id);
      setFundName(product.name);
      applyBondProductToDraft(product);
      if (product.annualRate != null) setAnnualRate(String(product.annualRate));
      if (product.termDays != null) setTermDays(String(product.termDays));
      if (product.productType === "bond") {
        const term = splitBondTermDays(product.termDays);
        setBondTermUnit(term.unit);
        setBondTermCount(String(term.count));
        setBondMaturityDate(product.maturityDate ?? "");
        const payout = parseDepositInterestPayout(product.payoutFrequency);
        setBondPayoutUnit(payout.kind === "periodic" ? payout.unit : "maturity");
        setBondPayoutInterval(payout.kind === "periodic" ? String(payout.interval) : "1");
        setBondFirstPayoutDate(product.firstPayoutDate ?? "");
        bondFirstPayoutDateTouchedRef.current = Boolean(product.firstPayoutDate);
        setBondCalcBasis(product.interestCalcBasis === "monthly" ? "monthly" : "daily");
      }
      setProductModalOpen(false);
    } catch (err) {
      setProductError(err instanceof Error ? err.message : t("wealthForm.alert.createProductFailed"));
    } finally {
      setProductSaving(false);
    }
  }

  async function saveBondTransaction(keepAdding: boolean) {
    if (submitting) return;
    const amt = isRedeem ? redeemPrincipalNumber : parseNumber(amount);
    if (amt <= 0) { window.alert(t("wealthForm.alert.enterAmount")); return; }
    const selectedProduct = bondProducts.find((product) => product.id === wealthProductId);
    const resolvedFundName = selectedHolding?.fundName || selectedProduct?.name || fundName.trim();
    if (!resolvedFundName) { window.alert(t("wealthForm.alert.selectOrCreateProductName")); return; }
    if (!isHoldingAction) {
      if (parseNumber(annualRate) <= 0) { window.alert(t("bondForm.alert.annualRateRequired")); return; }
      if (!bondMaturityDate) { window.alert(t("bondForm.alert.maturityDateRequired")); return; }
    }
    if (!isWriteOff && !cashAccountId) { window.alert(isHoldingAction ? t("wealthForm.alert.selectArrivalAccount") : t("txForm.alert.selectCashSourceAccount")); return; }
    if (toAccountId && !bondAccountIds.has(toAccountId)) { window.alert(t("wealthForm.alert.selectWealthAccount")); return; }
    if (!isHoldingAction && toAccountId && !selectableBondAccountIds.has(toAccountId)) {
      window.alert(t("wealthForm.alert.wealthAccountScope"));
      return;
    }
    if (isHoldingAction && !toAccountId) { window.alert(t("wealthForm.alert.selectWealthAccount")); return; }
    if (isHoldingAction && !selectedHoldingId) { window.alert(t("wealthForm.alert.selectHoldingProduct")); return; }
    if (isHoldingAction && !isWriteOff && !cashAccountId) { window.alert(t("wealthForm.alert.selectArrivalAccount")); return; }
    const unitsValue = parseNumber(units);
    if (!isHoldingAction && selectedBuyProductRequiresUnits && unitsValue <= 0) {
      window.alert(t("wealthForm.alert.unitsRequiredForExisting"));
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("type", "investment");
      fd.set("subtype", subtype);
      // 提交 fundProductType=bond：服务端据此解析/校验债券账户（与理财账户互斥）。
      fd.set("productType", "bond");
      fd.set("date", date);
      fd.set("amount", String(amt));
      fd.set("fundName", resolvedFundName);
      const resolvedBondProductId = selectedHolding?.wealthProductId || wealthProductId;
      if (resolvedBondProductId) fd.set("wealthProductId", resolvedBondProductId);
      fd.set("note", memo);
      fd.set("memo", memo);
      if (toAccountId) {
        fd.set("accountId", toAccountId);
        fd.set("toAccountId", toAccountId);
      }
      if (!isWriteOff) fd.set("cashAccountId", cashAccountId);
      if ((isRedeem || isDividend) && !isWriteOff) fd.set("fundArrivalDate", arrivalDate || date);
      const rateValue = parseNumber(annualRate);
      if (rateValue > 0 && !isWriteOff) fd.set("depositAnnualRate", String(rateValue));
      // 债券条款：存单（买入行）自己落一份快照，付息/赎回/核销沿用该存单的条款。
      // 字段名是债券自己的（服务端 bondEntryInputFromFormData 只认这几个）。
      if (!isHoldingAction) {
        const termDaysValue = bondTermDaysForProduct();
        if (termDaysValue > 0) fd.set("bondTermDays", String(termDaysValue));
        if (bondMaturityDate) fd.set("bondMaturityDate", bondMaturityDate);
        fd.set("bondPayoutFrequency", encodedBondPayoutFrequency());
        const firstPayoutValue = effectiveBondFirstPayoutDate();
        if (firstPayoutValue) fd.set("bondFirstPayoutDate", firstPayoutValue);
        fd.set("bondInterestCalcBasis", bondCalcBasis);
      }
      // 付息/赎回/核销必须指明所属存单（同一债单可能有多张存单）。
      if (isHoldingAction && selectedHoldingId) fd.set("bondSourceLotId", selectedHoldingId);
      if (isRedeem) {
        const arrivalValue = arrivalEdited ? parseNumber(arrivalAmount) : arrivalPreview;
        if (arrivalValue <= 0) throw new Error(t("wealthForm.alert.arrivalAmountInvalid"));
        fd.set("fundArrivalAmount", String(arrivalValue));
        if (interestAmount.trim()) fd.set("depositInterest", String(interestNumber));
      }
      const cashEntryIdForEdit = entry?.cashEntryId ?? editEntryId;
      const businessTransactionIdForEdit = entry?.businessTransactionId ?? editBusinessTransactionId;
      if (mode === "edit" && (cashEntryIdForEdit || businessTransactionIdForEdit)) {
        if (cashEntryIdForEdit) fd.set("entryId", cashEntryIdForEdit);
        if (businessTransactionIdForEdit) fd.set("businessTransactionId", businessTransactionIdForEdit);
        fd.set("fundProductType", "bond");
        const res = editAction ? await editAction(fd) : { ok: false as const, error: t("wealthForm.alert.missingEditAction") };
        if (!res.ok) throw new Error(res.error ?? t("wealthForm.alert.saveFailed"));
        if (cashEntryIdForEdit && pendingAttachmentFiles.length > 0) {
          await uploadEntryAttachmentFiles(cashEntryIdForEdit, pendingAttachmentFiles);
          setPendingAttachmentFiles([]);
        }
        window.dispatchEvent(new CustomEvent("mmh:bond:edit:success", { detail: { requestId } }));
      } else {
        fd.set("fundProductType", "bond");
        const res = await createAction(fd);
        if (!res.ok) throw new Error(res.error ?? t("txForm.alert.saveFailed"));
        const createdEntryId = res.data?.id ?? res.data?.cashEntryId ?? null;
        if (createdEntryId && pendingAttachmentFiles.length > 0) {
          await uploadEntryAttachmentFiles(createdEntryId, pendingAttachmentFiles);
          setPendingAttachmentFiles([]);
        }
      }
      if (!isHoldingAction && selectedProduct?.productType === "bond") {
        // 债券条款写债券主数据（/api/v1/bond-products/[id]），不再写理财产品表。
        await fetch(`/api/v1/bond-products/${selectedProduct.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            annualRate: String(parseNumber(annualRate)),
            termDays: bondTermDaysForProduct() > 0 ? String(bondTermDaysForProduct()) : null,
            maturityDate: bondMaturityDate || null,
            payoutFrequency: encodedBondPayoutFrequency(),
            interestCalcBasis: bondCalcBasis,
            firstPayoutDate: effectiveBondFirstPayoutDate() || null,
          }),
        }).then(async (res) => {
          const data = await res.json().catch(() => null);
          if (!data?.ok || !data.product) throw new Error(data?.error ?? t("wealthForm.alert.saveFailed"));
          setBondProducts((prev) => prev.map((item) => (item.id === data.product.id ? { ...item, ...data.product } : item)));
        });
      }
      if (keepAdding && mode === "create") {
        resetAfterKeepAdding();
      } else {
        setOpen(false);
        if (mode === "create") reset();
      }
      requestAnimationFrame(() => {
        dispatchFinanceDataChanged({
          reason: "bond-save",
          accountIds: compactFinanceAccountIds([toAccountId, cashAccountId]),
        });
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t("wealthForm.alert.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await saveBondTransaction(false);
  }
  useCloseOnNavigation(open, () => {
    setOpen(false);
    if (mode === "create") reset();
  });
  const accountLabelText = t("bondForm.accountLabel");
  const accountPlaceholderText = t("bondForm.selectAccount");

  if (!open) return null;

  return (
    // 整窗外壳见 `EntryModalShell`：买入/赎回/收息/核销由表单内分段按钮提到窗口顶部，成为 FT 页签；
  // 切换时的字段重置逻辑原样搬到 `selectSubtypeTab()`。
      <EntryModalShell
        open={open}
        heightKey="bond"
        width="lg"
        title={mode === "edit" ? t("bondForm.title.edit") : t("bondForm.title.create")}
        onClose={() => {
          setOpen(false);
          if (mode === "create") reset();
        }}
        closeLabel={t("table.close")}
        onSubmit={onSubmit}
        tabs={[
          { id: "buy", label: t("fund.subtype.buy") },
          { id: "redeem", label: t("bondForm.redeem") },
          { id: "dividend_cash", label: t("bondForm.interestReceipt") },
          { id: "write_off", label: t("fund.subtype.write_off") },
        ]}
        activeTabId={subtype}
        onTabChange={(id) => selectSubtypeTab(id as BondSubtype)}
        footer={(
          <>
            {mode === "create" ? (
              <button
                type="button"
                disabled={submitting}
                onClick={() => { void saveBondTransaction(true); }}
                className="secondary-button h-9 px-4 text-sm disabled:opacity-50"
              >
                {submitting ? t("txForm.saving") : t("txForm.saveAndRepeat")}
              </button>
            ) : null}
            <button
              type="submit"
              disabled={submitting}
              className={`h-9 rounded-[10px] px-4 text-sm text-white disabled:opacity-50 ${isRedeem ? "bg-orange-600 hover:bg-orange-700" : isDividend ? "bg-emerald-600 hover:bg-emerald-700" : "primary-button"}`}
            >
              {submitting ? t("txForm.saving") : mode === "edit" ? t("txForm.saveChanges") : isRedeem ? t("wealthForm.recordRedeem") : isDividend ? t("wealthForm.recordDividend") : t("wealthForm.recordBuy")}
            </button>
          </>
        )}
        overlays={
            <>
            <HoldingAccountCreateModal
              form={form}
              investmentEntityType="bond-account"
              investProductType="bond"
              title={t("bondForm.addAccount")}
              nameLabel={t("bondForm.accountName")}
              accountLabelText={accountLabelText}
              nestedFieldData={nestedFieldData}
            />
            {/* 内层窗口：`ModalLayer` 自带 portal 到 body，并自动取「当前窗口层 + 步长」，调用方不写层级。
                本组件挂在 `.page-header`（sticky + backdrop-filter）内部，该祖先同时是 fixed 后代的
                包含块与 z-30 层叠上下文 —— 就地渲染会被压扁进标题条、并永远压不过外层遮罩
                （「新增产品」窗口藏在记账窗口后面）。 */}
            {productModalOpen ? (
              <HoldingProductModal
                title={t("bondForm.addProduct")}
                accountLabel={selectedBondAccount?.label || selectedCashAccount?.label || ""}
                draft={productDraft}
                onDraftChange={(patch) => setProductDraft((prev) => ({ ...prev, ...patch }))}
                hint={productAccountHint()}
                error={productError}
                saving={productSaving}
                onClose={() => setProductModalOpen(false)}
                onSave={() => { void saveBondProduct(); }}
              />
            ) : null}
            </>
        }
      >

              {isWriteOff ? (
                <>
                  <HoldingHoldingFields
                    form={form}
                    accountLabel={accountLabelText}
                    accountPlaceholder={accountPlaceholderText}
                    holdingLabel={t("bondForm.lotLabel")}
                    holdingPlaceholder={t("bondForm.selectLot")}
                    noHoldingPlaceholder={t("bondForm.noAvailableLot")}
                    holdingHint={t("bondForm.lotHint")}
                  />
                  <div className="space-y-1">
                    <div className="form-label">{t("wealthForm.writeOffAmount")}</div>
                    <CalcInput value={amount} onChange={setAmount} placeholder="0.00" label={t("wealthForm.writeOffAmount")} precision={2} />
                    <div className="text-[11px] leading-5 text-orange-600">{t("wealthForm.writeOffHint")}</div>
                  </div>
                </>
              ) : isHoldingAction ? (
                <>
                  <HoldingHoldingFields
                    form={form}
                    accountLabel={accountLabelText}
                    accountPlaceholder={accountPlaceholderText}
                    holdingLabel={t("bondForm.lotLabel")}
                    holdingPlaceholder={t("bondForm.selectLot")}
                    noHoldingPlaceholder={t("bondForm.noAvailableLot")}
                    holdingHint={t("bondForm.lotHint")}
                    showAccount
                  />
                  {isRedeem ? (
                    <div className={`grid grid-cols-2 gap-3 ${"sm:grid-cols-3"}`}>
                      <div className="space-y-1">
                        <div className="form-label">{t("wealthForm.redeemPrincipal")}</div>
                        <CalcInput
                          value={amount}
                          onChange={changeRedeemPrincipal}
                          placeholder="0.00"
                          label={t("wealthForm.redeemPrincipal")}
                          precision={2}
                        />
                      </div>
                      {null}
                      <div className="space-y-1">
                        <div className="form-label">{t("wealthForm.annualRatePercent")}</div>
                        <CalcInput
                          value={annualRate}
                          onChange={setAnnualRate}
                          placeholder={t("wealthForm.rateExample")}
                          label={t("wealthForm.annualRate")}
                          precision={4}
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.interest")}</div>
                        <CalcInput
                          value={interestAmount}
                          onChange={changeRedeemInterest}
                          placeholder="0.00"
                          label={t("txForm.interest")}
                          precision={2}
                        />
                      </div>
                    </div>
                  ) : null}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <div className="form-label">{t("wealthForm.arrivalAccount")}</div>
                      <SmartSelect
                        mode="single"
                        value={cashAccountId}
                        onChange={(id) => { setCashAccountId(id); recordRecentAccount(id); }}
                        options={sortByAccountUsage(redeemCashOptions, accountUsage)}
                        placeholder={
                          redeemCashOptions.length > 0
                            ? isRedeem ? t("wealthForm.selectArrivalBankDebitOrEwallet") : t("wealthForm.selectSameInstitutionDebit")
                            : isRedeem ? t("wealthForm.noDebitOrEwallet") : t("wealthForm.noDebitInInstitution")
                        }
                        onCreateClick={() => setNestedEntityType("cash-account")}
                        createLabel={t("settings.accounts.add")}
                        onCycleOwnerFilter={cfCycle}
                        ownerFilterLabel={cfLabel}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("wealthForm.arrivalDate")}</div>
                      <DateStepper value={arrivalDate} onChange={changeArrivalDate} />
                    </div>
                    <div className="space-y-1 sm:col-span-2">
                      <div className="form-label">{isDividend ? (t("bondForm.interestAmount")) : t("wealthForm.arrivalAmount")}</div>
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
                        label={isDividend ? (t("bondForm.interestAmount")) : t("wealthForm.arrivalAmount")}
                        precision={2}
                      />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <div className="form-label">{t("detail.column.date")}</div>
                      <DateStepper value={date} onChange={changeTradeDate} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("wealthForm.sourceAccount")}</div>
                      <SmartSelect
                        mode="single"
                        value={cashAccountId}
                        onChange={(id) => { setCashAccountId(id); recordRecentAccount(id); }}
                        options={sortByAccountUsage(cashSelectOptions, accountUsage)}
                        placeholder={t("wealthForm.selectAccount")}
                        onCreateClick={() => setNestedEntityType("cash-account")}
                        createLabel={t("settings.accounts.add")}
                        onCycleOwnerFilter={cfCycle}
                        ownerFilterLabel={cfLabel}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <div className="form-label">{accountLabelText}</div>
                      <SmartSelect
                        mode="single"
                        value={toAccountId}
                        onChange={(id) => { setToAccountId(id); recordRecentAccount(id); }}
                        options={sortByAccountUsage(bondSelectOptions, accountUsage)}
                        placeholder={bondSelectOptions.length > 0 ? t("wealthForm.selectSameInstitutionOrPayment") : t("wealthForm.autoCreateAfterAddProduct")}
                        onCreateClick={openBondAccountModal}
                        createLabel={t("bondForm.addAccount")}
                        onCycleOwnerFilter={cycleBondOwner}
                        ownerFilterLabel={bondOwnerLabel}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("wealthForm.productName")}</div>
                      <SmartSelect
                        mode="single"
                        value={wealthProductId}
                        onChange={(id) => {
                          setWealthProductId(id);
                          const product = bondProducts.find((item) => item.id === id);
                          setFundName(product?.name ?? "");
                          applyBondProductToDraft(product);
                          if (product?.annualRate != null) setAnnualRate(String(product.annualRate));
                          if (product?.termDays != null) setTermDays(String(product.termDays));
                        }}
                        options={bondProductOptions}
                        placeholder={bondProductOptions.length > 0
                          ? (t("bondForm.selectProduct"))
                          : (t("bondForm.noProductClickAdd"))}
                        searchable
                        onCreateClick={() => openBondProductModal()}
                        createLabel={t("bondForm.addProduct")}
                      />
                    </div>
                  </div>

                  {(() => {
                    const termDays = bondTermDaysForProduct();
                    const isMaturityPayout = bondPayoutUnit === "maturity";
                    const bondPayoutMaxInterval = isMaturityPayout
                      ? 1
                      : maxDepositInterestPayoutInterval(termDays, bondPayoutUnit as DepositInterestPayoutUnit);
                    const payoutColumnCount = isMaturityPayout ? 2 : bondPayoutUnit === "month" ? 4 : 3;
                    return (
                      <div className="space-y-2">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                          <div className="space-y-1">
                            <div className="form-label">{t("bondForm.termUnit")}</div>
                            <select
                              value={bondTermUnit}
                              onChange={(e) => setBondTermUnit(e.target.value as DepositTermUnit)}
                              className="form-input"
                            >
                              <option value="year">{t("depositForm.termUnit.year")}</option>
                              <option value="month">{t("depositForm.termUnit.month")}</option>
                              <option value="day">{t("depositForm.termUnit.day")}</option>
                            </select>
                          </div>
                          <div className="space-y-1">
                            <div className="form-label">{t("bondForm.termQuantity")}</div>
                            <input
                              type="number"
                              min={0}
                              value={bondTermCount}
                              onChange={(e) => setBondTermCount(e.target.value)}
                              className="form-input"
                            />
                          </div>
                          <div className="space-y-1">
                            <div className="form-label">{t("wealthForm.maturityDate")}</div>
                            <input
                              type="date"
                              value={bondMaturityDate}
                              onChange={(e) => changeBondMaturityDate(e.target.value)}
                              className="form-input"
                            />
                          </div>
                        </div>
                        <div className={`grid grid-cols-1 gap-3 ${payoutColumnCount === 2 ? "sm:grid-cols-2" : payoutColumnCount === 3 ? "sm:grid-cols-3" : "sm:grid-cols-4"}`}>
                          <div className="space-y-1">
                            <div className="form-label">{t("wealthForm.payoutFrequency")}</div>
                            <select
                              value={bondPayoutUnit}
                              onChange={(e) => changeBondPayoutFrequency(e.target.value as "maturity" | DepositInterestPayoutUnit, 1)}
                              className="form-input"
                            >
                              <option value="maturity">{t("wealthForm.payout.maturity")}</option>
                              <option value="year">{t("wealthForm.payout.yearly")}</option>
                              <option value="month">{t("wealthForm.payout.monthly")}</option>
                              <option value="week">{t("wealthForm.payout.weekly")}</option>
                            </select>
                          </div>
                          {bondPayoutUnit === "month" ? (
                            <div className="space-y-1">
                              <div className="form-label">{t("deposit.calcBasis.label")}</div>
                              <select
                                value={bondCalcBasis}
                                onChange={(e) => setBondCalcBasis(e.target.value === "monthly" ? "monthly" : "daily")}
                                title={bondCalcBasis === "monthly" ? t("deposit.calcBasis.monthlyHint") : undefined}
                                className="form-input"
                              >
                                <option value="daily">{t("deposit.calcBasis.daily")}</option>
                                <option value="monthly">{t("deposit.calcBasis.monthly")}</option>
                              </select>
                            </div>
                          ) : null}
                          {!isMaturityPayout ? (
                            <div className="space-y-1">
                              <div className="form-label">{t("bondForm.payoutQuantity")}</div>
                              <input
                                type="number"
                                min={1}
                                max={bondPayoutMaxInterval}
                                value={bondPayoutInterval}
                                onChange={(e) => {
                                  const quantity = clampDepositInterestPayoutInterval(
                                    termDays,
                                    bondPayoutUnit as DepositInterestPayoutUnit,
                                    Math.max(1, Math.trunc(Number(e.target.value) || 1)),
                                  );
                                  setBondPayoutInterval(String(quantity));
                                }}
                                title={t("deposit.payoutFrequency.intervalTitle", { max: String(bondPayoutMaxInterval) })}
                                className="form-input"
                              />
                            </div>
                          ) : null}
                          <div className="space-y-1">
                            <div className="form-label">{t("wealthForm.firstPayoutDate")}</div>
                            <input
                              type="date"
                              value={effectiveBondFirstPayoutDate()}
                              onChange={(e) => changeBondFirstPayoutDate(e.target.value)}
                              disabled={isMaturityPayout}
                              title={isMaturityPayout ? t("wealthForm.firstPayoutMaturityHint") : undefined}
                              className="form-input disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  <div className={"grid grid-cols-2 gap-3"}>
                    {(
                      <div className="space-y-1">
                        <div className="form-label">{t("wealthForm.annualRatePercent")}</div>
                        <input inputMode="decimal" value={annualRate} onChange={(e) => setAnnualRate(e.target.value)} placeholder={t("wealthForm.rateExample")} className="form-input" />
                      </div>
                    )}
                    <div className={""}>
                      <div className="form-label">{t("wealthForm.buyAmount")}</div>
                      <CalcInput value={amount} onChange={setAmount} placeholder="0.00" label={t("fund.subtype.buy")} precision={2} />
                    </div>
                    {/* 债券的期限由起息日与到期日决定（到期日−购买日），与到期日重复，
                        故债券模式不显示期限天数；银行理财才用「180天期」这类期限表达。 */}
                    {null}
                  </div>
                </>
              )}

              <HoldingMemoField
                memo={memo}
                onMemoChange={setMemo}
                editEntryId={editEntryId}
                pendingFiles={pendingAttachmentFiles}
                onPendingFilesChange={setPendingAttachmentFiles}
              />

      </EntryModalShell>

  );
}
