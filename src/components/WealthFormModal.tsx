"use client";
import { accountOptionFromParts } from "@/lib/account-display";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
/** 记账弹窗整窗外壳：宽度/标题栏/表单/FT 页签卡片/固定页脚/高度锁定统一由它负责。 */
import { EntryModalShell } from "@/components/EntryModalShell";
import {
  HoldingAccountCreateModal,
  HoldingHoldingFields,
  HoldingMemoField,
  HoldingProductModal,
} from "@/components/holding-entry/HoldingEntryFields";
import { parseNumber } from "@/lib/investment-config";
import { Lock, LockOpen } from "lucide-react";
import { DateStepper } from "./DateStepper";
import { CalcInput } from "./CalcInput";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { recordRecentAccounts, sortByAccountUsage } from "@/lib/client/recentAccounts";
import { compactFinanceAccountIds, dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";
import { uploadEntryAttachmentFiles } from "./EntryAttachmentPanel";
import { mergeProductOptions } from "@/lib/holding-entry/primitives";
import { useHoldingEntryForm } from "@/lib/holding-entry/useHoldingEntryForm";
import { isPersonalInstitutionType } from "@/lib/institution-rules";
import type { WealthHoldingOption } from "@/lib/wealth-holdings";

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
type WealthSubtype = "buy" | "redeem" | "dividend_cash" | "write_off";
/** 稳定引用：默认空持仓若用字面量 `[]`，每次渲染都是新数组，同步 effect 会自激成死循环。 */
const EMPTY_WEALTH_HOLDING_OPTIONS: WealthHoldingOption[] = [];
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
  family = "wealth",
  accountId: defaultAccountId,
  entry,
  listenForEditEvents,
  openSignal,
  cashAccounts = [],
  investmentAccounts = [],
  cashAccountSSOptions,
  investmentAccountSSOptions,
  wealthHoldingOptions = EMPTY_WEALTH_HOLDING_OPTIONS,
  nestedFieldData,
  createAction,
  editAction,
  createEventName,
  editEventName,
}: {
  mode?: "create" | "edit";
  /**
   * 账户家族锁定：wealth=理财窗口（默认），advisor=投顾组合窗口。两类是独立弹窗
   * （独立实例 + 独立打开事件），不共用同一个窗口内部切换；交易链路服务端共用。
   */
  family?: "wealth" | "advisor";
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
  /** 打开事件名覆盖：advisor 实例用 mmh:advisor:create / mmh:advisor:edit，与理财窗口互不抢事件。 */
  createEventName?: string;
  editEventName?: string;
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
  // 投顾窗口「新增产品」的机构归属选择：产品与自动建的投顾账户都落到所选机构。
  const [productInstitutionChoice, setProductInstitutionChoice] = useState("");
  const [wealthProducts, setWealthProducts] = useState<WealthProductOption[]>([]);

  // 可赎回持仓：初次渲染用服务端 props，保存后由 /api/v1/wealth/holdings 重取。
  // 理财保存只失效 tag、不重渲染当前路由（见 revalidateAfterFundShellChange），
  // 所以不能只依赖 props，否则新增买入在赎回页签里看不到，必须手动刷新页面。
  const [holdingOptions, setHoldingOptions] = useState<WealthHoldingOption[]>(wealthHoldingOptions);
  useEffect(() => {
    setHoldingOptions(wealthHoldingOptions);
  }, [wealthHoldingOptions]);

  // 账户家族由 props 锁定（独立弹窗实例，不做窗口内切换）；驱动账户下拉、
  // 可赎回持仓过滤（productKind）与提交时的 fundProductType。
  const accountFamily = family;
  // 提交时把账户侧类型（wealth / advisor）透传给服务端，服务端据此解析对应类型的投资账户。
  const advisorMode = accountFamily === "advisor";

  // 投顾窗口文案：复用理财文案表，整体把「理财/Wealth」替换成投顾口径，
  // 避免为投顾再维护一份 40+ key 的平行文案表（分类名与现金流备注在服务端分家）。
  const label = useCallback((key: string, vars?: Record<string, string | number>) => {
    if (!advisorMode) return t(key, vars);
    return t(key, vars)
      .replace(/理财/g, "投顾")
      .replace(/理財/g, "投顧")
      .replace(/Wealth/g, "Advisory")
      .replace(/wealth product/g, "advisory product");
  }, [t, advisorMode]);

  // 理财与债券是两类独立账户：理财弹窗只认当前家族（理财/投顾）账户上的持仓。
  const typedHoldingOptions = useMemo(
    () =>
      holdingOptions
        .filter((holding) => {
          const holdingAccount = investmentAccounts.find((account) => account.id === holding.wealthAccountId);
          // 账户不在 props 里说明是本弹窗刚建的新账户（props 尚未重渲染），保留；
          // 已知账户则只认当前家族：props 里同时带着债券持仓，不能混排进赎回。
          return holdingAccount ? holdingAccount.investProductType === accountFamily : true;
        })
        // 账户展示名以账户下拉为准（接口只回原始账户名）。
        .map((holding) => {
          const holdingAccount = investmentAccounts.find((account) => account.id === holding.wealthAccountId);
          return holdingAccount?.label && holdingAccount.label !== holding.wealthAccountLabel
            ? { ...holding, wealthAccountLabel: holdingAccount.label }
            : holding;
        }),
    [investmentAccounts, holdingOptions, accountFamily],
  );

  const wealthProductOptions: SmartSelectOption[] = useMemo(
    () =>
      wealthProducts
        // 产品按家族过滤（互不混排）：理财窗口不列债券/投顾产品；投顾窗口只列投顾产品。
        // 投顾产品必须归属机构（2026-11-03 用户裁定）：没有机构的通用产品、以及其它机构的
        // 投顾产品都不进投顾下拉，否则一笔投顾记录会挂到「不属于任何机构」的产品上。
        .filter((product) => {
          if (!advisorMode) return product.productType !== "bond" && product.productType !== "advisor";
          if (product.productType !== "advisor" || !product.institutionId) return false;
          return !productInstitutionChoice || product.institutionId === productInstitutionChoice;
        })
        .map((product) => ({
          id: product.id,
          label: product.shortName?.trim() || product.name,
          // 不指定机构的产品是「通用」的，任何机构的理财下拉里都能选到，这里标出来。
          subLabel: [
            product.shortName?.trim() ? product.name : "",
            product.institutionName || (product.institutionId ? "" : label("wealthForm.universalProduct")),
          ]
            .filter(Boolean)
            .join(" · "),
        })),
    [advisorMode, wealthProducts, label, productInstitutionChoice],
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
    productKind: accountFamily,
    eventNamespace: "wealth",
    createEventName,
    editEventName,
    defaultAccountKey: "defaultWealthAccountId",
    // 投顾赎回回款目的地放开：任意资金账户（基金平台账户/银行卡均可），理财保持原口径。
    redeemArrivalAnyCash: advisorMode,
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
    unrestrictedAccounts, setUnrestrictedAccounts,
    productInstitutionId, redeemCashOptions,
    selectedHolding, selectedHoldingId, selectedBuyProductRequiresUnits,
    interestNumber, redeemPrincipalNumber, arrivalPreview,
    accountUsage, cfLabel, cfCycle,
    ownerFilterLabel: wealthOwnerLabel, cycleOwnerFilter: cycleWealthOwner, cashSelectOptions,
    reset, resetAfterKeepAdding, changeTradeDate, changeArrivalDate,
    changeRedeemPrincipal, changeRedeemUnits, changeRedeemNav, changeRedeemInterest,
    selectSubtypeTab, unitsEditedRef,
  } = form;

  // 可赎回持仓重取：打开弹窗时 + 每次保存成功后。页面 props 在理财保存后不会变，
  // 只靠 props 会让赎回页签停留在旧快照（新增买入看不到可赎回份额）。
  const holdingOptionsRequestRef = useRef(0);
  const reloadHoldingOptions = useCallback(() => {
    const requestSeq = holdingOptionsRequestRef.current + 1;
    holdingOptionsRequestRef.current = requestSeq;
    void fetch("/api/v1/wealth/holdings", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        // 只认最后一次请求，避免连续保存时旧响应覆盖新数据。
        if (holdingOptionsRequestRef.current !== requestSeq) return;
        if (!data?.ok || !Array.isArray(data.holdings)) return;
        setHoldingOptions(data.holdings as WealthHoldingOption[]);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    reloadHoldingOptions();
  }, [open, reloadHoldingOptions]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // 投顾窗口：机构归属选择优先（选了机构就查该机构 + 通用产品的池子）。
    const institutionId = advisorMode ? (productInstitutionChoice || productInstitutionId || "") : (productInstitutionId ?? "");
    // 读理财产品主数据（/api/v1/wealth-products）。
    const basePath = "/api/v1/wealth-products";
    const url = institutionId
      ? `${basePath}?institutionId=${encodeURIComponent(institutionId)}`
      : basePath;
    void fetch(url, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data?.ok) return;
        const fetched = (data.products ?? []) as WealthProductOption[];
        // 投顾窗口的池子先剔掉「通用产品」：投顾产品必须归属机构（2026-11-03 用户裁定）。
        const products = advisorMode
          ? fetched.filter((product) => product.productType === "advisor" && !!product.institutionId)
          : fetched;
        if (wealthProductId) {
          // 理财窗口只在明确选了机构时才清空（切换机构后原产品可能不在池子里）；
          // 投顾窗口任何时候都不允许停在无机构/异家族的产品上。
          const stillSelectable = advisorMode
            ? products.some((product) => product.id === wealthProductId)
            : !institutionId || products.some((product) => product.id === wealthProductId);
          if (!stillSelectable) {
            setWealthProductId("");
            setFundName("");
          }
        }
        setWealthProducts((prev) => {
          const selectedLocalProducts = prev.filter((product) =>
            // 通用产品（无机构）在任何机构下都保留，别在机构切换的瞬间把它挤掉；投顾窗口不保留。
            (!advisorMode && (!institutionId || product.institutionId === institutionId || product.institutionId == null)) && (
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
  }, [advisorMode, fundName, open, productInstitutionChoice, productInstitutionId, wealthProductId]);

  function openWealthProductModal() {
    // 产品弹窗只做新建（名称+备注）；条款（利率/到期日/付息）在购买界面按次填写。
    // 投顾窗口默认机构跟随已选投顾账户/资金账户，可在弹窗里改选；
    // 但金融产品不能归属往来主体/保险机构（2026-11-03 用户裁定），这类默认值直接清空。
    let defaultInstitutionId = "";
    if (advisorMode) {
      const candidate = selectedWealthAccount?.institutionId ?? selectedCashAccount?.institutionId ?? "";
      const candidateType = (nestedFieldData?.institutionId ?? []).find((item) => item.id === candidate)?.type;
      const excluded = !candidate || isPersonalInstitutionType(candidateType) || candidateType === "insurance";
      defaultInstitutionId = excluded ? "" : candidate;
    }
    setProductInstitutionChoice(defaultInstitutionId);
    setProductDraft({
      name: fundName.trim(),
      shortName: "",
      annualRate,
      termDays,
      note: "",
      // 债券直达模式下新建产品默认城投债类型，免去再手动切换；
      // 投顾窗口新建的产品直接落 advisor 家族（不进理财池）。
      productType: advisorMode ? "advisor" : "standard",
      maturityDate: "",
      payoutFrequency: "maturity",
      firstPayoutDate: "",
    });
    setProductError(selectedCashAccount ? "" : label("wealthForm.alert.selectSourceFirst"));
    setProductModalOpen(true);
  }

  function openWealthAccountModal() {
    if (!selectedCashAccount) {
      window.alert(label("wealthForm.alert.selectSourceFirst"));
      return;
    }
    if (!selectedCashAccount.groupId || !selectedCashAccount.institutionId) {
      window.alert(label("wealthForm.alert.sourceAccountMissingOwnerOrInstitution"));
      return;
    }
    setNestedEntityType("wealth-account");
  }

  function productAccountHint() {
    if (selectedWealthAccount) return label("wealthForm.productHintWillAssignTo", { account: selectedWealthAccount.label });
    if (selectedCashAccount) {
      // 债券/理财是两类账户：自动建账提示按当前模式显示对应账户类型。
      return label("wealthForm.productHintAutoCreate", { account: selectedCashAccount.label });
    }
    return label("wealthForm.productHintSelectSourceFirst");
  }

  async function saveWealthProduct() {
    const name = productDraft.name.trim();
    setProductError("");
    // 投顾产品必须归属机构（2026-11-03 用户裁定），不提供「通用（不限机构）」。
    if (advisorMode && !productInstitutionChoice) {
      setProductError(label("wealthForm.alert.selectInstitution"));
      return;
    }
    if (!selectedCashAccount) {
      setProductError(label("wealthForm.alert.selectSourceFirst"));
      return;
    }
    if (!name) {
      setProductError(label("wealthForm.alert.enterProductName"));
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
          // 投顾窗口：产品与自动建的投顾账户落到所选机构（空 = 跟随资金账户机构）。
          institutionId: advisorMode ? productInstitutionChoice : undefined,
          annualRate: parseNumber(annualRate) > 0 ? String(parseNumber(annualRate)) : undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      const accountPayload = data?.wealthAccount;
      if (!data?.ok || !data.product || !accountPayload) {
        throw new Error(data?.error ?? label("wealthForm.alert.createProductFailed"));
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
      // 走统一入口：按「账户显示格式」渲染，不再手拼机构·名称。
      const accountOptionDisplay = accountOptionFromParts({
        id: account.id,
        name: account.name,
        kind: account.kind,
        institutionName: account.institutionName,
        institutionShortName: account.institutionShortName,
        currency: account.currency,
        groupName: account.groupName,
      });
      const accountOption: AccountOption = {
        id: account.id,
        label: accountOptionDisplay.label,
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
      setProductError(err instanceof Error ? err.message : label("wealthForm.alert.createProductFailed"));
    } finally {
      setProductSaving(false);
    }
  }

  async function saveWealthTransaction(keepAdding: boolean) {
    if (submitting) return;
    const amt = isRedeem ? redeemPrincipalNumber : parseNumber(amount);
    if (amt <= 0) { window.alert(label("wealthForm.alert.enterAmount")); return; }
    const selectedProduct = wealthProducts.find((product) => product.id === wealthProductId);
    const resolvedFundName = selectedHolding?.fundName || selectedProduct?.name || fundName.trim();
    if (!resolvedFundName) { window.alert(label("wealthForm.alert.selectOrCreateProductName")); return; }
    if (!isWriteOff && !cashAccountId) { window.alert(isHoldingAction ? label("wealthForm.alert.selectArrivalAccount") : t("txForm.alert.selectCashSourceAccount")); return; }
    if (toAccountId && !wealthAccountIds.has(toAccountId)) { window.alert(label("wealthForm.alert.selectWealthAccount")); return; }
    if (!isHoldingAction && toAccountId && !selectableWealthAccountIds.has(toAccountId)) {
      window.alert(label("wealthForm.alert.wealthAccountScope"));
      return;
    }
    if (isHoldingAction && !toAccountId) { window.alert(label("wealthForm.alert.selectWealthAccount")); return; }
    if (isHoldingAction && !selectedHoldingId) { window.alert(label("wealthForm.alert.selectHoldingProduct")); return; }
    if (isHoldingAction && !isWriteOff && !cashAccountId) { window.alert(label("wealthForm.alert.selectArrivalAccount")); return; }
    const unitsValue = parseNumber(units);
    if (!isHoldingAction && selectedBuyProductRequiresUnits && unitsValue <= 0) {
      window.alert(label("wealthForm.alert.unitsRequiredForExisting"));
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("type", "investment");
      fd.set("subtype", subtype);
      // 提交 fundProductType=wealth|advisor：服务端据此解析/校验对应类型的投资账户。
      fd.set("productType", advisorMode ? "advisor" : "wealth");
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
        if (arrivalValue <= 0) throw new Error(label("wealthForm.alert.arrivalAmountInvalid"));
        fd.set("fundArrivalAmount", String(arrivalValue));
        if (interestAmount.trim()) fd.set("depositInterest", String(interestNumber));
      }
      const cashEntryIdForEdit = entry?.cashEntryId ?? editEntryId;
      const businessTransactionIdForEdit = entry?.businessTransactionId ?? editBusinessTransactionId;
      if (mode === "edit" && (cashEntryIdForEdit || businessTransactionIdForEdit)) {
        if (cashEntryIdForEdit) fd.set("entryId", cashEntryIdForEdit);
        if (businessTransactionIdForEdit) fd.set("businessTransactionId", businessTransactionIdForEdit);
        fd.set("fundProductType", advisorMode ? "advisor" : "wealth");
        const res = editAction ? await editAction(fd) : { ok: false as const, error: label("wealthForm.alert.missingEditAction") };
        if (!res.ok) throw new Error(res.error ?? label("wealthForm.alert.saveFailed"));
        if (cashEntryIdForEdit && pendingAttachmentFiles.length > 0) {
          await uploadEntryAttachmentFiles(cashEntryIdForEdit, pendingAttachmentFiles);
          setPendingAttachmentFiles([]);
        }
        window.dispatchEvent(new CustomEvent("mmh:wealth:edit:success", { detail: { requestId } }));
      } else {
        fd.set("fundProductType", advisorMode ? "advisor" : "wealth");
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
      // 保存后立即重取可赎回持仓（连续新增/赎回时赎回页签与下一次赎回都要看到最新份额）。
      reloadHoldingOptions();
      requestAnimationFrame(() => {
        const accountIds = compactFinanceAccountIds([toAccountId, cashAccountId]);
        recordRecentAccounts(accountIds);
        dispatchFinanceDataChanged({
          reason: "wealth-save",
          accountIds,
        });
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : label("wealthForm.alert.saveFailed"));
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

  const accountLabelText = label("wealthForm.accountLabel");
  const accountPlaceholderText = label("wealthForm.selectWealthAccount");

  // 「不限账户种类」锁形开关：挂在账户类 SS 下拉的 headerExtra 上。
  // 锁 = 按账户种类/机构过滤（默认）；开锁 = 解除过滤（服务端规则仍兜底）。
  const accountKindToggle = (
    <button
      type="button"
      onClick={() => setUnrestrictedAccounts((prev) => !prev)}
      title={unrestrictedAccounts ? label("wealthForm.unrestrictedOn") : label("wealthForm.unrestrictedOff")}
      aria-label={unrestrictedAccounts ? label("wealthForm.unrestrictedOn") : label("wealthForm.unrestrictedOff")}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border transition-colors ${
        unrestrictedAccounts
          ? "border-amber-300 bg-amber-50 text-amber-600"
          : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
      }`}
    >
      {unrestrictedAccounts ? <LockOpen className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
    </button>
  );

  if (!open) return null;

  return (
    // 整窗外壳见 `EntryModalShell`：买入/赎回/分红/核销由表单内分段按钮提到窗口顶部，成为 FT 页签；
  // 切换时的字段重置逻辑原样搬到 `selectSubtypeTab()`。
      <EntryModalShell
        open={open}
        heightKey="wealth"
        width="lg"
        title={mode === "edit"
          ? t(family === "advisor" ? "advisorForm.title.edit" : "wealthForm.title.edit")
          : t(family === "advisor" ? "advisorForm.title.create" : "wealthForm.title.create")}
        onClose={() => {
          setOpen(false);
          if (mode === "create") reset();
        }}
        closeLabel={t("table.close")}
        onSubmit={onSubmit}
        tabs={family === "advisor"
          // 投顾组合只有买入/赎回：分红在投顾平台直接体现为组合净值变化，核销不适用。
          ? [
              { id: "buy", label: t("fund.subtype.buy") },
              { id: "redeem", label: t("fund.subtype.redeem") },
            ]
          : [
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
              className={`h-9 rounded-[10px] px-4 text-sm text-white disabled:opacity-50 ${isRedeem ? "bg-orange-600 hover:bg-orange-700" : isDividend ? "bg-emerald-600 hover:bg-emerald-700" : isWriteOff ? "bg-slate-600 hover:bg-slate-700" : "primary-button"}`}
            >
              {submitting ? t("txForm.saving") : mode === "edit" ? t("txForm.saveChanges") : isRedeem ? label("wealthForm.recordRedeem") : isDividend ? label("wealthForm.recordDividend") : isWriteOff ? label("wealthForm.recordWriteOff") : label("wealthForm.recordBuy")}
            </button>
          </>
        )}
        overlays={
            <>
            <HoldingAccountCreateModal
              form={form}
              investmentEntityType="wealth-account"
              investProductType={advisorMode ? "advisor" : "wealth"}
              title={label("wealthForm.addWealthAccount")}
              nameLabel={label("wealthForm.wealthAccountName")}
              accountLabelText={accountLabelText}
              nestedFieldData={nestedFieldData}
            />
            {/* 内层窗口：`ModalLayer` 自带 portal 到 body，并自动取「当前窗口层 + 步长」，调用方不写层级。
                本组件挂在 `.page-header`（sticky + backdrop-filter）内部，该祖先同时是 fixed 后代的
                包含块与 z-30 层叠上下文 —— 就地渲染会被压扁进标题条、并永远压不过外层遮罩
                （「新增产品」窗口藏在记账窗口后面）。 */}
            {productModalOpen ? (
              <HoldingProductModal
                title={label("wealthForm.addProduct")}
                accountLabel={selectedWealthAccount?.label || selectedCashAccount?.label || ""}
                draft={productDraft}
                onDraftChange={(patch) => setProductDraft((prev) => ({ ...prev, ...patch }))}
                hint={productAccountHint()}
                institutionOptions={advisorMode
                  // 金融产品的发行方不能是往来人员/往来组织/家庭成员/保险机构，下拉直接排除。
                  ? (nestedFieldData?.institutionId ?? [])
                      .filter((item) => !isPersonalInstitutionType(item.type) && item.type !== "insurance")
                      .map((item) => ({ id: item.id, name: item.name }))
                  : undefined}
                institutionId={productInstitutionChoice}
                onInstitutionChange={advisorMode ? setProductInstitutionChoice : undefined}
                institutionRequired={advisorMode}
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
                    holdingLabel={label("wealthForm.holdingProductLabel")}
                    holdingPlaceholder={label("wealthForm.selectRedeemableProduct")}
                    noHoldingPlaceholder={label("wealthForm.noAvailableHolding")}
                    holdingHint={label("wealthForm.holdingHint")}
                  />
                  <div className="space-y-1">
                    <div className="form-label">{label("wealthForm.writeOffAmount")}</div>
                    <CalcInput value={amount} onChange={setAmount} placeholder="0.00" label={label("wealthForm.writeOffAmount")} precision={2} />
                    <div className="text-[11px] leading-5 text-orange-600">{label("wealthForm.writeOffHint")}</div>
                  </div>
                </>
              ) : isHoldingAction ? (
                <>
                  <HoldingHoldingFields
                    form={form}
                    accountLabel={accountLabelText}
                    accountPlaceholder={accountPlaceholderText}
                    holdingLabel={isDividend ? (label("wealthForm.dividendProductLabel")) : label("wealthForm.holdingProductLabel")}
                    holdingPlaceholder={isDividend ? label("wealthForm.selectDividendHolding") : label("wealthForm.selectRedeemableProduct")}
                    noHoldingPlaceholder={label("wealthForm.noAvailableHolding")}
                    holdingHint={label("wealthForm.holdingHint")}
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
                        <div className="form-label">{label("wealthForm.redeemPrincipal")}</div>
                        <CalcInput
                          value={amount}
                          onChange={changeRedeemPrincipal}
                          placeholder="0.00"
                          label={label("wealthForm.redeemPrincipal")}
                          precision={2}
                        />
                      </div>
                    ) : null}
                    <div className="space-y-1 sm:col-span-2">
                      <div className="form-label">{label("wealthForm.arrivalAccount")}</div>
                      <SmartSelect
                        mode="single"
                        value={cashAccountId}
                        onChange={(id) => { setCashAccountId(id); }}
                        options={sortByAccountUsage(redeemCashOptions, accountUsage)}
                        headerExtra={accountKindToggle}
                        placeholder={
                          redeemCashOptions.length > 0
                            ? isRedeem
                              ? advisorMode ? label("advisorForm.selectArrival") : label("wealthForm.selectArrivalBankDebitOrEwallet")
                              : label("wealthForm.selectSameInstitutionFunding")
                            : isRedeem
                              ? advisorMode ? label("advisorForm.noArrival") : label("wealthForm.noDebitOrEwallet")
                              : label("wealthForm.noFundingInInstitution")
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
                          <div className="form-label">{label("wealthForm.redeemUnits")}</div>
                          <CalcInput
                            value={units}
                            onChange={changeRedeemUnits}
                            placeholder={t("stockFee.optional")}
                            label={label("wealthForm.redeemUnits")}
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
                          <div className="form-label">{label("wealthForm.annualRatePercent")}</div>
                          <CalcInput
                            value={annualRate}
                            onChange={setAnnualRate}
                            placeholder={label("wealthForm.rateExample")}
                            label={label("wealthForm.annualRate")}
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
                      <div className="form-label">{label("wealthForm.arrivalDate")}</div>
                      <DateStepper value={arrivalDate} onChange={changeArrivalDate} />
                    </div>
                    <div className={`space-y-1 ${isRedeem ? "sm:col-span-2" : "col-span-2 sm:col-span-4"}`}>
                      <div className="form-label">{isDividend ? (label("wealthForm.dividendAmount")) : label("wealthForm.arrivalAmount")}</div>
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
                        label={isDividend ? (label("wealthForm.dividendAmount")) : label("wealthForm.arrivalAmount")}
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
                      <div className="form-label">{label("wealthForm.sourceAccount")}</div>
                      <SmartSelect
                        mode="single"
                        value={cashAccountId}
                        onChange={(id) => { setCashAccountId(id); }}
                        options={sortByAccountUsage(cashSelectOptions, accountUsage)}
                        placeholder={label("wealthForm.selectAccount")}
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
                        onChange={(id) => { setToAccountId(id); }}
                        headerExtra={accountKindToggle}
                        options={sortByAccountUsage(wealthSelectOptions, accountUsage)}
                        placeholder={wealthSelectOptions.length > 0 ? label("wealthForm.selectSameInstitutionOrPayment") : label("wealthForm.autoCreateAfterAddProduct")}
                        onCreateClick={openWealthAccountModal}
                        createLabel={label("wealthForm.addWealthAccount")}
                        onCycleOwnerFilter={cycleWealthOwner}
                        ownerFilterLabel={wealthOwnerLabel}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{label("wealthForm.productName")}</div>
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
                          ? (label("wealthForm.selectProduct"))
                          : (label("wealthForm.noProductClickAdd"))}
                        searchable
                        onCreateClick={() => openWealthProductModal()}
                        createLabel={label("wealthForm.addProduct")}
                      />
                    </div>
                  </div>

                  

                  <div className={"grid grid-cols-1 gap-3 sm:grid-cols-3"}>
                    {(
                      <>
                        <div className="space-y-1">
                          <div className="form-label">{t("viewImport.units")}{selectedBuyProductRequiresUnits ? label("wealthForm.unitsRequiredSuffix") : ""}</div>
                          <CalcInput value={units} onChange={(value) => { unitsEditedRef.current = true; setUnits(value); }} placeholder={selectedBuyProductRequiresUnits ? t("batchImport.required") : t("stockFee.optional")} label={t("viewImport.units")} precision={6} />
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">{label("wealthForm.avgPrice")}</div>
                          <div className="form-input flex items-center justify-end text-xs tabular-nums text-slate-500">{parseNumber(units) > 0 && parseNumber(amount) > 0 ? (parseNumber(amount) / parseNumber(units)).toFixed(4) : "-"}</div>
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">{label("wealthForm.annualRatePercent")}</div>
                          <input inputMode="decimal" value={annualRate} onChange={(e) => setAnnualRate(e.target.value)} placeholder={label("wealthForm.rateExample")} className="form-input" />
                        </div>
                      </>
                    )}
                    <div className={"sm:col-span-2"}>
                      <div className="form-label">{label("wealthForm.buyAmount")}</div>
                      <CalcInput value={amount} onChange={setAmount} placeholder="0.00" label={t("fund.subtype.buy")} precision={2} />
                    </div>
                    {/* 债券的期限由起息日与到期日决定（到期日−购买日），与到期日重复，
                        故债券模式不显示期限天数；银行理财才用「180天期」这类期限表达。 */}
                    {(
                      <div className="space-y-1">
                        <div className="form-label">{label("wealthForm.termDays")}</div>
                        <select
                          value={termDays}
                          onChange={(e) => setTermDays(e.target.value)}
                          className="form-input"
                        >
                          <option value="">{label("wealthForm.termPresetPlaceholder")}</option>
                          {TERM_PRESETS.map((preset) => (
                            <option key={preset.days} value={String(preset.days)}>
                              {t(preset.labelKey)}
                            </option>
                          ))}
                          {termDays && !TERM_PRESETS.some((preset) => String(preset.days) === termDays) ? (
                            <option value={termDays}>{label("wealthForm.daysSuffix", { days: termDays })}</option>
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
