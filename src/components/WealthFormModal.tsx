"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
/** 记账弹窗整窗外壳：宽度/标题栏/表单/FT 页签卡片/固定页脚/高度锁定统一由它负责。 */
import { EntryModalShell } from "@/components/EntryModalShell";
import {
  HoldingAccountCreateModal,
  HoldingHoldingFields,
  HoldingMemoField,
  HoldingProductModal,
} from "@/components/holding-entry/HoldingEntryFields";
import { parseNumber } from "@/lib/investment-config";
import { DateStepper } from "./DateStepper";
import { CalcInput } from "./CalcInput";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { recordRecentAccount, sortByAccountUsage } from "@/lib/client/recentAccounts";
import { compactFinanceAccountIds, dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";
import { uploadEntryAttachmentFiles } from "./EntryAttachmentPanel";
import { mergeProductOptions } from "@/lib/holding-entry/primitives";
import { useHoldingEntryForm } from "@/lib/holding-entry/useHoldingEntryForm";

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
  productType?: string | null;
  maturityDate?: string | null;
  payoutFrequency?: string | null;
  interestCalcBasis?: string | null;
  firstPayoutDate?: string | null;
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
type WealthSubtype = "buy" | "redeem" | "dividend_cash" | "write_off";
const TERM_PRESETS = [
  { labelKey: "wealthForm.term.3months", days: 90 },
  { labelKey: "wealthForm.term.halfYear", days: 180 },
  { labelKey: "wealthForm.term.1year", days: 365 },
  { labelKey: "wealthForm.term.2years", days: 730 },
  { labelKey: "wealthForm.term.3years", days: 1095 },
  { labelKey: "wealthForm.term.5years", days: 1825 },
] as const;

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
  createAction: (formData: FormData) => Promise<{ ok: true; data?: { id?: string; cashEntryId?: string } } | { ok: false; error: string }>;
  editAction?: (formData: FormData) => Promise<{ ok: true; data?: { id?: string; cashEntryId?: string } } | { ok: false; error: string }>;
}) {
  const { t } = useI18n();

  // 产品主数据（品种自有，留在组件内）
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
  const [wealthProducts, setWealthProducts] = useState<WealthProductOption[]>([]);

  // 理财与债券是两类独立账户：理财弹窗只认理财账户上的持仓。
  const typedHoldingOptions = useMemo(
    () =>
      wealthHoldingOptions.filter((holding) => {
        const holdingAccount = investmentAccounts.find((account) => account.id === holding.wealthAccountId);
        return holdingAccount?.investProductType === "wealth";
      }),
    [investmentAccounts, wealthHoldingOptions],
  );

  const wealthProductOptions: SmartSelectOption[] = useMemo(
    () =>
      wealthProducts
        // 产品按模式过滤：理财模式不列债券产品（两类互不混排）。
        .filter((product) => product.productType !== "bond")
        .map((product) => ({
          id: product.id,
          label: product.shortName?.trim() || product.name,
          subLabel: [product.shortName?.trim() ? product.name : "", product.institutionName || ""]
            .filter(Boolean)
            .join(" · "),
        })),
    [wealthProducts],
  );

  const form = useHoldingEntryForm({
    mode,
    entry,
    defaultAccountId,
    openSignal,
    listenForEditEvents,
    cashAccounts,
    investmentAccounts,
    cashAccountSSOptions,
    investmentAccountSSOptions,
    nestedFieldData,
    typedHoldingOptions,
    productKind: "wealth",
    eventNamespace: "wealth",
    defaultAccountKey: "defaultWealthAccountId",
    resolveProductName: (id) => wealthProducts.find((product) => product.id === id)?.name,
  });
  const {
    open, setOpen, subtype, date,
    arrivalDate, amount, setAmount, units, setUnits, nav,
    productId: wealthProductId, setProductId: setWealthProductId, fundName, setFundName,
    annualRate, setAnnualRate, termDays, setTermDays, interestAmount,
    arrivalAmount, setArrivalAmount, arrivalEdited, setArrivalEdited,
    cashAccountId, setCashAccountId, toAccountId, setToAccountId,
    memo, setMemo, pendingAttachmentFiles, setPendingAttachmentFiles, submitting, setSubmitting,
    requestId, editEntryId, editBusinessTransactionId,
    setInvestmentAccountList, setLocalInvestSSOpts, setNestedEntityType,
    isRedeem, isDividend, isWriteOff, isHoldingAction,
    selectedCashAccount, accountIds: wealthAccountIds,
    selectableAccountIds: selectableWealthAccountIds,
    selectOptions: wealthSelectOptions, selectedInvestAccount: selectedWealthAccount,
    productInstitutionId, redeemCashOptions,
    selectedHolding, selectedHoldingId, selectedBuyProductRequiresUnits,
    interestNumber, redeemPrincipalNumber, arrivalPreview,
    accountUsage, cfLabel, cfCycle,
    ownerFilterLabel: wealthOwnerLabel, cycleOwnerFilter: cycleWealthOwner, cashSelectOptions,
    reset, resetAfterKeepAdding, changeTradeDate, changeArrivalDate,
    changeRedeemPrincipal, changeRedeemUnits, changeRedeemNav, changeRedeemInterest,
    selectSubtypeTab, unitsEditedRef,
  } = form;



  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const institutionId = productInstitutionId ?? "";
    // 读理财产品主数据（/api/v1/wealth-products）。
    const basePath = "/api/v1/wealth-products";
    const url = institutionId
      ? `${basePath}?institutionId=${encodeURIComponent(institutionId)}`
      : basePath;
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

  function openWealthProductModal() {
    // 产品弹窗只做新建（名称+备注）；条款（利率/到期日/付息）在购买界面按次填写。
    setProductDraft({
      name: fundName.trim(),
      shortName: "",
      annualRate,
      termDays,
      note: "",
      // 债券直达模式下新建产品默认城投债类型，免去再手动切换。
      productType: "standard",
      maturityDate: "",
      payoutFrequency: "maturity",
      firstPayoutDate: "",
    });
    setProductError(selectedCashAccount ? "" : t("wealthForm.alert.selectSourceFirst"));
    setProductModalOpen(true);
  }

  function openWealthAccountModal() {
    if (!selectedCashAccount) {
      window.alert(t("wealthForm.alert.selectSourceFirst"));
      return;
    }
    if (!selectedCashAccount.groupId || !selectedCashAccount.institutionId) {
      window.alert(t("wealthForm.alert.sourceAccountMissingOwnerOrInstitution"));
      return;
    }
    setNestedEntityType("wealth-account");
  }

  function productAccountHint() {
    if (selectedWealthAccount) return t("wealthForm.productHintWillAssignTo", { account: selectedWealthAccount.label });
    if (selectedCashAccount) {
      // 债券/理财是两类账户：自动建账提示按当前模式显示对应账户类型。
      return t("wealthForm.productHintAutoCreate", { account: selectedCashAccount.label });
    }
    return t("wealthForm.productHintSelectSourceFirst");
  }

  async function saveWealthProduct() {
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
      const res = await fetch("/api/v1/wealth-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          note: productDraft.note.trim() || undefined,
          cashAccountId: selectedCashAccount.id,
          wealthAccountId: selectedWealthAccount?.id ?? undefined,
          currency: selectedWealthAccount?.currency ?? selectedCashAccount.currency ?? "CNY",
          productType: productDraft.productType,
          annualRate: parseNumber(annualRate) > 0 ? String(parseNumber(annualRate)) : undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      const accountPayload = data?.wealthAccount;
      if (!data?.ok || !data.product || !accountPayload) {
        throw new Error(data?.error ?? t("wealthForm.alert.createProductFailed"));
      }
      const product = ((data.product as WealthProductOption));
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
      setProductError(err instanceof Error ? err.message : t("wealthForm.alert.createProductFailed"));
    } finally {
      setProductSaving(false);
    }
  }

  async function saveWealthTransaction(keepAdding: boolean) {
    if (submitting) return;
    const amt = isRedeem ? redeemPrincipalNumber : parseNumber(amount);
    if (amt <= 0) { window.alert(t("wealthForm.alert.enterAmount")); return; }
    const selectedProduct = wealthProducts.find((product) => product.id === wealthProductId);
    const resolvedFundName = selectedHolding?.fundName || selectedProduct?.name || fundName.trim();
    if (!resolvedFundName) { window.alert(t("wealthForm.alert.selectOrCreateProductName")); return; }
    if (!isWriteOff && !cashAccountId) { window.alert(isHoldingAction ? t("wealthForm.alert.selectArrivalAccount") : t("txForm.alert.selectCashSourceAccount")); return; }
    if (toAccountId && !wealthAccountIds.has(toAccountId)) { window.alert(t("wealthForm.alert.selectWealthAccount")); return; }
    if (!isHoldingAction && toAccountId && !selectableWealthAccountIds.has(toAccountId)) {
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
      // 提交 fundProductType=wealth：服务端据此解析/校验理财账户。
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
      if (!isWriteOff) fd.set("cashAccountId", cashAccountId);
      if ((isRedeem || isDividend) && !isWriteOff) fd.set("fundArrivalDate", arrivalDate || date);
      if (unitsValue > 0) fd.set("fundUnits", String(unitsValue));
      const enteredNavValue = parseNumber(nav);
      const navValue = enteredNavValue > 0
        ? enteredNavValue
        : (!isHoldingAction && unitsValue > 0 ? amt / unitsValue : 0);
      if (navValue > 0) fd.set("fundNav", String(navValue));
      const rateValue = parseNumber(annualRate);
      if (rateValue > 0 && !isWriteOff) fd.set("depositAnnualRate", String(rateValue));
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
        fd.set("fundProductType", "wealth");
        const res = editAction ? await editAction(fd) : { ok: false as const, error: t("wealthForm.alert.missingEditAction") };
        if (!res.ok) throw new Error(res.error ?? t("wealthForm.alert.saveFailed"));
        if (cashEntryIdForEdit && pendingAttachmentFiles.length > 0) {
          await uploadEntryAttachmentFiles(cashEntryIdForEdit, pendingAttachmentFiles);
          setPendingAttachmentFiles([]);
        }
        window.dispatchEvent(new CustomEvent("mmh:wealth:edit:success", { detail: { requestId } }));
      } else {
        fd.set("fundProductType", "wealth");
        const res = await createAction(fd);
        if (!res.ok) throw new Error(res.error ?? t("txForm.alert.saveFailed"));
        const createdEntryId = res.data?.id ?? res.data?.cashEntryId ?? null;
        if (createdEntryId && pendingAttachmentFiles.length > 0) {
          await uploadEntryAttachmentFiles(createdEntryId, pendingAttachmentFiles);
          setPendingAttachmentFiles([]);
        }
      }
      if (keepAdding && mode === "create") {
        resetAfterKeepAdding();
      } else {
        setOpen(false);
        if (mode === "create") reset();
      }
      requestAnimationFrame(() => {
        dispatchFinanceDataChanged({
          reason: "wealth-save",
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
    await saveWealthTransaction(false);
  }
  useCloseOnNavigation(open, () => {
    setOpen(false);
    if (mode === "create") reset();
  });

  const accountLabelText = t("wealthForm.accountLabel");
  const accountPlaceholderText = t("wealthForm.selectWealthAccount");

  if (!open) return null;

  return (
    // 整窗外壳见 `EntryModalShell`：买入/赎回/分红/核销由表单内分段按钮提到窗口顶部，成为 FT 页签；
  // 切换时的字段重置逻辑原样搬到 `selectSubtypeTab()`。
      <EntryModalShell
        open={open}
        heightKey="wealth"
        width="lg"
        title={mode === "edit" ? t("wealthForm.title.edit") : t("wealthForm.title.create")}
        onClose={() => {
          setOpen(false);
          if (mode === "create") reset();
        }}
        closeLabel={t("table.close")}
        onSubmit={onSubmit}
        tabs={[
          { id: "buy", label: t("fund.subtype.buy") },
          { id: "redeem", label: t("fund.subtype.redeem") },
          { id: "dividend_cash", label: t("stockPanel.action.dividend") },
          { id: "write_off", label: t("fund.subtype.write_off") },
        ]}
        activeTabId={subtype}
        onTabChange={(id) => selectSubtypeTab(id as WealthSubtype)}
        footer={(
          <>
            {mode === "create" ? (
              <button
                type="button"
                disabled={submitting}
                onClick={() => { void saveWealthTransaction(true); }}
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
              investmentEntityType="wealth-account"
              investProductType="wealth"
              title={t("wealthForm.addWealthAccount")}
              nameLabel={t("wealthForm.wealthAccountName")}
              accountLabelText={accountLabelText}
              nestedFieldData={nestedFieldData}
            />
            {/* 内层窗口：`ModalLayer` 自带 portal 到 body，并自动取「当前窗口层 + 步长」，调用方不写层级。
                本组件挂在 `.page-header`（sticky + backdrop-filter）内部，该祖先同时是 fixed 后代的
                包含块与 z-30 层叠上下文 —— 就地渲染会被压扁进标题条、并永远压不过外层遮罩
                （「新增产品」窗口藏在记账窗口后面）。 */}
            {productModalOpen ? (
              <HoldingProductModal
                title={t("wealthForm.addProduct")}
                accountLabel={selectedWealthAccount?.label || selectedCashAccount?.label || ""}
                draft={productDraft}
                onDraftChange={(patch) => setProductDraft((prev) => ({ ...prev, ...patch }))}
                hint={productAccountHint()}
                error={productError}
                saving={productSaving}
                onClose={() => setProductModalOpen(false)}
                onSave={() => { void saveWealthProduct(); }}
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
                    holdingLabel={t("wealthForm.holdingProductLabel")}
                    holdingPlaceholder={t("wealthForm.selectRedeemableProduct")}
                    noHoldingPlaceholder={t("wealthForm.noAvailableHolding")}
                    holdingHint={t("wealthForm.holdingHint")}
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
                    holdingLabel={isDividend ? (t("wealthForm.dividendProductLabel")) : t("wealthForm.holdingProductLabel")}
                    holdingPlaceholder={isDividend ? t("wealthForm.selectDividendHolding") : t("wealthForm.selectRedeemableProduct")}
                    noHoldingPlaceholder={t("wealthForm.noAvailableHolding")}
                    holdingHint={t("wealthForm.holdingHint")}
                    showUnits
                    showAccount
                  />
                  {/* 赎回 / 分红字段共用一个 4 列栅格，按状态给跨列，压缩窗口高度：
                      赎回三行 —— ① 赎回本金 | 入账资金账户　② 赎回份额 | 净值 | 年化收益率 | 利息
                      ③ 到账日期 | 到账金额；
                      分红两行 —— ① 入账资金账户 | 到账日期　② 分红/到账金额（整行）。
                      `<sm` 降为 2 列，窄屏每行两个、不再一列到底。 */}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {isRedeem ? (
                      <div className="space-y-1 sm:col-span-2">
                        <div className="form-label">{t("wealthForm.redeemPrincipal")}</div>
                        <CalcInput
                          value={amount}
                          onChange={changeRedeemPrincipal}
                          placeholder="0.00"
                          label={t("wealthForm.redeemPrincipal")}
                          precision={2}
                        />
                      </div>
                    ) : null}
                    <div className="space-y-1 sm:col-span-2">
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
                    {isRedeem ? (
                      <>
                        <div className="space-y-1">
                          <div className="form-label">{t("wealthForm.redeemUnits")}</div>
                          <CalcInput
                            value={units}
                            onChange={changeRedeemUnits}
                            placeholder={t("stockFee.optional")}
                            label={t("wealthForm.redeemUnits")}
                            precision={6}
                          />
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">{t("viewImport.nav")}</div>
                          <CalcInput
                            value={nav}
                            onChange={changeRedeemNav}
                            placeholder={t("stockFee.optional")}
                            label={t("viewImport.nav")}
                            precision={6}
                          />
                        </div>
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
                      </>
                    ) : null}
                    <div className="space-y-1 sm:col-span-2">
                      <div className="form-label">{t("wealthForm.arrivalDate")}</div>
                      <DateStepper value={arrivalDate} onChange={changeArrivalDate} />
                    </div>
                    <div className={`space-y-1 ${isRedeem ? "sm:col-span-2" : "col-span-2 sm:col-span-4"}`}>
                      <div className="form-label">{isDividend ? (t("wealthForm.dividendAmount")) : t("wealthForm.arrivalAmount")}</div>
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
                        label={isDividend ? (t("wealthForm.dividendAmount")) : t("wealthForm.arrivalAmount")}
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
                        options={sortByAccountUsage(wealthSelectOptions, accountUsage)}
                        placeholder={wealthSelectOptions.length > 0 ? t("wealthForm.selectSameInstitutionOrPayment") : t("wealthForm.autoCreateAfterAddProduct")}
                        onCreateClick={openWealthAccountModal}
                        createLabel={t("wealthForm.addWealthAccount")}
                        onCycleOwnerFilter={cycleWealthOwner}
                        ownerFilterLabel={wealthOwnerLabel}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("wealthForm.productName")}</div>
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
                        placeholder={wealthProductOptions.length > 0
                          ? (t("wealthForm.selectProduct"))
                          : (t("wealthForm.noProductClickAdd"))}
                        searchable
                        onCreateClick={() => openWealthProductModal()}
                        createLabel={t("wealthForm.addProduct")}
                      />
                    </div>
                  </div>

                  

                  <div className={"grid grid-cols-1 gap-3 sm:grid-cols-3"}>
                    {(
                      <>
                        <div className="space-y-1">
                          <div className="form-label">{t("viewImport.units")}{selectedBuyProductRequiresUnits ? t("wealthForm.unitsRequiredSuffix") : ""}</div>
                          <CalcInput value={units} onChange={(value) => { unitsEditedRef.current = true; setUnits(value); }} placeholder={selectedBuyProductRequiresUnits ? t("batchImport.required") : t("stockFee.optional")} label={t("viewImport.units")} precision={6} />
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">{t("wealthForm.avgPrice")}</div>
                          <div className="form-input flex items-center justify-end text-xs tabular-nums text-slate-500">{parseNumber(units) > 0 && parseNumber(amount) > 0 ? (parseNumber(amount) / parseNumber(units)).toFixed(4) : "-"}</div>
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">{t("wealthForm.annualRatePercent")}</div>
                          <input inputMode="decimal" value={annualRate} onChange={(e) => setAnnualRate(e.target.value)} placeholder={t("wealthForm.rateExample")} className="form-input" />
                        </div>
                      </>
                    )}
                    <div className={"sm:col-span-2"}>
                      <div className="form-label">{t("wealthForm.buyAmount")}</div>
                      <CalcInput value={amount} onChange={setAmount} placeholder="0.00" label={t("fund.subtype.buy")} precision={2} />
                    </div>
                    {/* 债券的期限由起息日与到期日决定（到期日−购买日），与到期日重复，
                        故债券模式不显示期限天数；银行理财才用「180天期」这类期限表达。 */}
                    {(
                      <div className="space-y-1">
                        <div className="form-label">{t("wealthForm.termDays")}</div>
                        <select
                          value={termDays}
                          onChange={(e) => setTermDays(e.target.value)}
                          className="form-input"
                        >
                          <option value="">{t("wealthForm.termPresetPlaceholder")}</option>
                          {TERM_PRESETS.map((preset) => (
                            <option key={preset.days} value={String(preset.days)}>
                              {t(preset.labelKey)}
                            </option>
                          ))}
                          {termDays && !TERM_PRESETS.some((preset) => String(preset.days) === termDays) ? (
                            <option value={termDays}>{t("wealthForm.daysSuffix", { days: termDays })}</option>
                          ) : null}
                        </select>
                      </div>
                    )}
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