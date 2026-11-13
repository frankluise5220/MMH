"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { X } from "lucide-react";
/** 记账弹窗整窗外壳：宽度/标题栏/表单/FT 页签卡片/固定页脚/高度锁定统一由它负责。 */
import { EntryModalShell } from "@/components/EntryModalShell";

import { CalcInput } from "@/components/CalcInput";
import { ClearableNoteField } from "@/components/ClearableNoteField";
import { DateStepper } from "@/components/DateStepper";
import { SmartSelect, type SmartSelectOption } from "@/components/SmartSelect";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { REQUIRED_FIELD_CLASS } from "@/lib/client/required-field";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { useI18n } from "@/lib/i18n";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { FIXED_ASSET_TYPES, normalizeFixedAssetType, type FixedAssetType } from "@/lib/fixed-asset";
import { formatAmountDraft, formatMoney } from "@/lib/format";

/**
 * 固定资产记账两个页签：**资产变动** / **资产售出**。
 *
 * 资产变动（change）：不选资产 = 新购入（purchase）；选资产 = 改产值（improvement），
 *   带金额就是追加投入，不带金额就只留一条产值变动记录。
 * 资产售出（sale）：必须选资产并填出售金额，服务端把产值换成回收净额、资产置为已售。
 *
 * 两个页签都不再让用户先挑「购入 / 装修投入 / 出售」这三种业务类型，动作由页签 + 资产选择推断；
 * disposal（无回款报废）仍由服务端支持，但前端不再产生，避免和售出混淆。
 */
const PropertyAction = {
  purchase: "purchase",
  improvement: "improvement",
  sale: "sale",
} as const;
type PropertyAction = (typeof PropertyAction)[keyof typeof PropertyAction];
type ModalMode = "transaction" | "valuation";
/** 记账页签：资产变动 / 资产售出（valuation 是「更新估值」单页入口，无页签）。 */
type EntryTab = "change" | "sale";

type AccountOption = {
  id: string;
  name?: string;
  label: string;
  title?: string;
  hoverTitle?: string;
  kind?: string | null;
  currency?: string | null;
  investProductType?: string | null;
};

type PropertyAssetOption = {
  id: string;
  name: string;
  marketValue?: number | null;
  /** 资产所属的固定资产账户；选中资产后账户要跟着走，否则后端会拒（不属于当前账户）。 */
  accountId?: string | null;
};

type PropertyCreateEventDetail = {
  requestId?: string;
  defaultPropertyAccountId?: string;
  defaultCashAccountId?: string;
  /** 旧入口还会带动作，页面已单页化，仅保留以兼容调用方。 */
  defaultAction?: PropertyAction;
};

type PropertyValuationEventDetail = {
  requestId?: string;
  defaultPropertyAccountId?: string;
  propertyAssetId?: string;
  propertyName?: string;
  currentMarketValue?: number | null;
};

type Props = {
  defaultPropertyAccountId?: string;
  defaultCashAccountId?: string;
  /** 打开时「资产类型」下拉的初值：视图当前正在看哪类资产（房产/车辆…），新购入就默认记成那一类。 */
  defaultAssetType?: string | null;
  propertyAccounts: AccountOption[];
  propertyAccountSSOptions?: SmartSelectOption[];
  cashAccounts: AccountOption[];
  cashAccountSSOptions?: SmartSelectOption[];
  propertyAssets?: PropertyAssetOption[];
};

function todayYmd() {
  return todayDateLocalYmd();
}

function accountToOption(account: AccountOption): SmartSelectOption {
  return {
    id: account.id,
    label: account.label || account.name || account.id,
    title: account.hoverTitle || account.title || account.label || account.name || account.id,
  };
}

function parseAmount(value: string) {
  const num = Number(String(value || "0").replace(/,/g, ""));
  return Number.isFinite(num) ? num : 0;
}

export function PropertyFormModal({
  defaultPropertyAccountId = "",
  defaultCashAccountId = "",
  defaultAssetType = null,
  propertyAccounts,
  propertyAccountSSOptions,
  cashAccounts,
  cashAccountSSOptions,
  propertyAssets = [],
}: Props) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const [mode, setMode] = useState<ModalMode>("transaction");
  const [entryTab, setEntryTab] = useState<EntryTab>("change");
  const [requestId, setRequestId] = useState("");
  const [propertyAccountId, setPropertyAccountId] = useState(defaultPropertyAccountId);
  const [cashAccountId, setCashAccountId] = useState(defaultCashAccountId);
  const [propertyAssetId, setPropertyAssetId] = useState("");
  const [name, setName] = useState("");
  // 资产类型（固定资产一级分类，房产/车辆/设备…）：新购入时用下拉选，决定这笔挂在固定资产视图的哪个分组。
  const [assetType, setAssetType] = useState<FixedAssetType>(() => normalizeFixedAssetType(defaultAssetType));
  // 细分类型（房产类型：商品房/别墅…），自由文本，只有房产才有这一层。
  const [propertyType, setPropertyType] = useState("");
  const [address, setAddress] = useState("");
  const [tradeDate, setTradeDate] = useState(todayYmd());
  const [settlementDate, setSettlementDate] = useState("");
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState("");
  const [tax, setTax] = useState("");
  const [marketValue, setMarketValue] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /**
   * 按需拉取的资产列表。
   *
   * 只有固定资产视图（`view=investproperty`）会把 `propertyAssets` 传下来；从概览或
   * 账户页的「记一笔 → 固定资产」打开时它是空的，资产下拉会一个选项都没有。
   * `null` = 还没拉过，空数组也是一次有效结果（新账簿没资产）。
   */
  const [extraAssets, setExtraAssets] = useState<PropertyAssetOption[] | null>(null);

  const propertyOptions = useMemo(
    () => propertyAccountSSOptions?.length ? propertyAccountSSOptions : propertyAccounts.map(accountToOption),
    [propertyAccountSSOptions, propertyAccounts],
  );
  const cashOptions = useMemo(
    () => cashAccountSSOptions?.length ? cashAccountSSOptions : cashAccounts.map(accountToOption),
    [cashAccountSSOptions, cashAccounts],
  );
  // 资产数据源：页面上带了就用页面那份（固定资产视图），否则用按需补拉的。
  const assetSource = extraAssets && extraAssets.length > 0 ? extraAssets : propertyAssets;
  const assetOptions = useMemo(
    () => assetSource.map((asset) => ({ id: asset.id, label: asset.name, title: asset.name })),
    [assetSource],
  );

  // 资产下拉现在常显（不选 = 新购入），入口未必在固定资产视图里，缺列表就补拉一次
  // （`transactions=0` 只要资产，不拖明细）。
  useEffect(() => {
    if (!open) return;
    if (propertyAssets.length > 0 || extraAssets !== null) return;
    let cancelled = false;
    fetch("/api/v1/properties?transactions=0", { cache: "no-store" })
      .then((res) => res.json())
      .then((body: { ok?: boolean; data?: { assets?: Array<{ id: string; name: string; marketValue?: number | null; accountId?: string | null }> } } | null) => {
        if (cancelled) return;
        setExtraAssets((body?.data?.assets ?? []).map((asset) => ({
          id: asset.id,
          name: asset.name,
          marketValue: asset.marketValue ?? null,
          accountId: asset.accountId ?? null,
        })));
      })
      // 拉不到就让下拉空着（保存时后端还会校验资产），别把弹窗卡死。
      .catch(() => { if (!cancelled) setExtraAssets([]); });
    return () => { cancelled = true; };
  }, [open, propertyAssets.length, extraAssets]);

  /** 已选资产（含当前产值，用于提示「当前产值 → 变动后产值」）。 */
  const selectedAsset = useMemo(
    () => assetSource.find((asset) => asset.id === propertyAssetId) ?? null,
    [assetSource, propertyAssetId],
  );

  const isSaleTab = entryTab === "sale";
  const marketValueFilled = marketValue.trim() !== "";
  const changeValue = parseAmount(marketValue);
  const amountValue = parseAmount(amount);
  // 售出页必须先选资产；变动页不选资产＝新购入。
  const isNewAsset = !isSaleTab && !propertyAssetId;
  // 变动页把产值填成 0 等于在清空资产，那不是「变动」，提示去售出页签。
  const isClosingAsset = !isSaleTab && !isNewAsset && marketValueFilled && changeValue <= 0;
  const resolvedAction: PropertyAction = isNewAsset
    ? PropertyAction.purchase
    : isSaleTab
      ? PropertyAction.sale
      : PropertyAction.improvement;
  const currentMarketValue = selectedAsset?.marketValue ?? 0;
  const marketValueDelta = changeValue - currentMarketValue;
  const saleNetProceeds = Math.max(0, amountValue - parseAmount(fee) - parseAmount(tax));

  const resetTransactionDraft = useCallback((detail?: PropertyCreateEventDetail) => {
    setMode("transaction");
    // 旧入口（菜单「固定资产 ▸ 出售」）仍可能带 action=sale，直接落到售出页签。
    setEntryTab(detail?.defaultAction === "sale" ? "sale" : "change");
    setRequestId(detail?.requestId ?? "");
    setPropertyAccountId(detail?.defaultPropertyAccountId || defaultPropertyAccountId || propertyAccounts[0]?.id || "");
    setCashAccountId(detail?.defaultCashAccountId || defaultCashAccountId || cashAccounts[0]?.id || "");
    setPropertyAssetId("");
    // 每次打开都重拉资产：刚在别处新增的车/房，不该因为上一次的缓存而选不到。
    setExtraAssets(null);
    setName("");
    setAssetType(normalizeFixedAssetType(defaultAssetType));
    setPropertyType("");
    setAddress("");
    setTradeDate(todayYmd());
    setSettlementDate("");
    setAmount("");
    setFee("");
    setTax("");
    setMarketValue("");
    setNote("");
  }, [cashAccounts, defaultAssetType, defaultCashAccountId, defaultPropertyAccountId, propertyAccounts]);

  const resetValuationDraft = useCallback((detail?: PropertyValuationEventDetail) => {
    setMode("valuation");
    setRequestId(detail?.requestId ?? "");
    setPropertyAccountId(detail?.defaultPropertyAccountId || defaultPropertyAccountId || propertyAccounts[0]?.id || "");
    setCashAccountId(defaultCashAccountId || cashAccounts[0]?.id || "");
    setPropertyAssetId(detail?.propertyAssetId || propertyAssets[0]?.id || "");
    setName(detail?.propertyName || "");
    setPropertyType("");
    setAddress("");
    setTradeDate(todayYmd());
    setSettlementDate("");
    setAmount("");
    setFee("");
    setTax("");
    setMarketValue(detail?.currentMarketValue != null ? String(detail.currentMarketValue) : "");
    setNote("");
  }, [cashAccounts, defaultCashAccountId, defaultPropertyAccountId, propertyAccounts, propertyAssets]);

  useEffect(() => {
    function onCreate(event: Event) {
      resetTransactionDraft((event as CustomEvent<PropertyCreateEventDetail>).detail ?? {});
      setOpen(true);
    }
    function onValuation(event: Event) {
      resetValuationDraft((event as CustomEvent<PropertyValuationEventDetail>).detail ?? {});
      setOpen(true);
    }
    window.addEventListener("mmh:property:create", onCreate);
    window.addEventListener("mmh:property:valuation", onValuation);
    return () => {
      window.removeEventListener("mmh:property:create", onCreate);
      window.removeEventListener("mmh:property:valuation", onValuation);
    };
  }, [resetTransactionDraft, resetValuationDraft]);

  const close = useCallback(() => {
    if (!submitting) setOpen(false);
  }, [submitting]);
  useCloseOnNavigation(open, () => setOpen(false));

  async function submit(event: FormEvent) {
    event.preventDefault();
    await saveProperty();
  }

  async function saveProperty() {
    if (submitting) return;
    if (mode === "valuation") {
      if (!propertyAssetId) {
        window.alert(t("propertyForm.alert.selectProperty"));
        return;
      }
      if (parseAmount(marketValue) < 0 || !marketValue.trim()) {
        window.alert(t("propertyForm.alert.enterMarketValue"));
        return;
      }
      setSubmitting(true);
      try {
        const res = await fetch("/api/v1/properties/valuations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            propertyAssetId,
            valuationDate: tradeDate,
            marketValue,
            note: note.trim() || undefined,
          }),
        });
        const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("propertyForm.alert.updateFailed"));
        if (requestId) window.dispatchEvent(new CustomEvent("mmh:property:valuation:success", { detail: { requestId } }));
        requestAnimationFrame(() => dispatchFinanceDataChanged({ reason: "property-valuation-save", accountIds: [propertyAccountId].filter(Boolean) }));
        setOpen(false);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : t("propertyForm.alert.updateFailed"));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!propertyAccountId) {
      window.alert(t("propertyForm.alert.selectPropertyAccount"));
      return;
    }
    // 新购入没有资产可挑，名称由用户自己写：留空会让服务端回退成账户名，几笔购入就重名了。
    if (isNewAsset && !name.trim()) {
      window.alert(t("propertyForm.alert.enterPropertyName"));
      return;
    }
    if (isSaleTab) {
      if (!propertyAssetId) {
        window.alert(t("propertyForm.alert.selectProperty"));
        return;
      }
      if (amountValue <= 0) {
        window.alert(t("propertyForm.alert.enterSaleAmount"));
        return;
      }
      // 出售一定要有收款账户，否则钱既不在资金账户里、资产又已经没了。
      if (!cashAccountId) {
        window.alert(t("propertyForm.alert.selectCashAccount"));
        return;
      }
    }
    // 已有资产：产值和资金总得动一样，否则这一笔什么都不记。
    if (!isSaleTab && !isNewAsset && !marketValueFilled && amountValue <= 0) {
      window.alert(t("propertyForm.alert.enterChangeValue"));
      return;
    }
    // 产值清零不是「变动」，清空资产走售出页签（服务端会置为已售并记回收金额）。
    if (isClosingAsset) {
      window.alert(t("propertyForm.hint.useSaleTab"));
      return;
    }
    // 新购入的名称已在上面校验为非空；已有资产的变动/售出不带名字（改名走资产编辑窗）。
    const purchaseName = isNewAsset ? name.trim() : "";
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/properties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: propertyAccountId,
          // 没金额就没有资金流水，别把资金账户挂上去。
          cashAccountId: amountValue > 0 ? (cashAccountId || undefined) : undefined,
          propertyAssetId: propertyAssetId || undefined,
          action: resolvedAction,
          name: purchaseName || undefined,
          // 资产类型只在新购入时提交：已有资产改类型属于「编辑资产」，不混进记账。
          assetType: isNewAsset ? assetType : undefined,
          propertyType: isNewAsset && assetType === "property" ? propertyType.trim() || undefined : undefined,
          address: isNewAsset && assetType === "property" ? address.trim() || undefined : undefined,
          tradeDate,
          settlementDate: settlementDate || undefined,
          amount: amountValue > 0 ? amount : "0",
          fee: fee || undefined,
          tax: tax || undefined,
          // 售出不传产值：服务端按「金额 − 手续费 − 税费」作为回收净额写入产值。
          marketValue: !isSaleTab && marketValueFilled ? marketValue : undefined,
          note: note.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; data?: { transaction?: { id?: string; cashEntryId?: string | null } | null } } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("propertyForm.alert.saveFailed"));
      if (requestId) window.dispatchEvent(new CustomEvent("mmh:property:create:success", { detail: { requestId } }));
      requestAnimationFrame(() => {
        dispatchFinanceDataChanged({
          reason: "property-transaction-save",
          accountIds: Array.from(new Set([propertyAccountId, cashAccountId].filter(Boolean))),
          entryIds: [data.data?.transaction?.cashEntryId ?? "", data.data?.transaction?.id ?? ""].filter(Boolean),
        });
      });
      setOpen(false);
      resetTransactionDraft();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("propertyForm.alert.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open || typeof document === "undefined") return null;

  /** 资金字段的文案随这一笔的性质走：新购入、产值变动、出售回款。 */
  const amountLabel = isNewAsset
    ? t("propertyForm.amountPurchase")
    : isSaleTab
      ? t("propertyForm.amountSale")
      : t("propertyForm.amountInvest");
  const marketValueLabel = isNewAsset
    ? t("propertyForm.marketValueInitial")
    : t("propertyForm.marketValueAfterChange");

  return (
    /* 整窗外壳见 `EntryModalShell`：记账走两个 FT 页签（资产变动 / 资产售出），
       购入与产值变动靠「是否选资产」推断，售出是独立页签，见文件头说明。 */
    <EntryModalShell
      open={open}
      heightKey="property"
      width="sm"
      title={mode === "valuation"
        ? t("propertyForm.title.updateValuation")
        : isSaleTab ? t("propertyForm.tab.sale") : t("propertyForm.tab.change")}
      tabs={mode === "transaction"
        ? [
          { id: "change", label: t("propertyForm.tab.change") },
          { id: "sale", label: t("propertyForm.tab.sale") },
        ]
        : undefined}
      activeTabId={entryTab}
      onTabChange={(id) => {
        const next: EntryTab = id === "sale" ? "sale" : "change";
        if (next === entryTab) return;
        // 资产选择跨页签保留；产值/金额语义不同（追加投入 vs 出售回款），切页签时清掉免得串味。
        setEntryTab(next);
        setMarketValue("");
        setAmount("");
      }}
      rulerLabels={[t("propertyForm.tab.change"), t("propertyForm.tab.sale")]}
      onClose={close}
      closeLabel={<X className="h-4 w-4" />}
      closeTitle={t("table.close")}
      onSubmit={submit}
      footer={(
        <button type="submit" className="primary-button" disabled={submitting}>{submitting ? t("stockFee.saving") : t("common.save")}</button>
      )}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="form-label">{mode === "valuation" ? t("propertyForm.dateValuation") : t("propertyForm.dateTransaction")}</div>
          <DateStepper value={tradeDate} onChange={setTradeDate} />
        </div>
        <div className="space-y-1">
          <div className="form-label">{t("propertyForm.propertyAccount")}</div>
          <SmartSelect
            mode="single"
            value={propertyAccountId}
            onChange={(value) => {
              setPropertyAccountId(value);
              // 换账户后原来选中的资产不属于新账户了，清掉重新选。
              setPropertyAssetId("");
            }}
            options={propertyOptions}
            placeholder={t("propertyForm.propertyAccountPlaceholder")}
            behavior={{ search: true, density: "compact", minDropdownWidth: 260 }}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="form-label">{t("propertyForm.property")}</div>
          <SmartSelect
            mode="single"
            value={propertyAssetId}
            onChange={(value) => {
              setPropertyAssetId(value);
              const asset = assetSource.find((item) => item.id === value);
              // 资产列表是全部固定资产账户的合集，选到别的账户的资产时把账户一起换过去，
              // 否则提交会被后端以「房产不存在或不属于当前账户」拒掉。
              if (asset?.accountId && asset.accountId !== propertyAccountId) setPropertyAccountId(asset.accountId);
              if (asset?.marketValue != null && mode === "valuation") setMarketValue(formatAmountDraft(asset.marketValue));
            }}
            options={assetOptions}
            placeholder={mode === "valuation" || isSaleTab
              ? t("propertyForm.propertyPlaceholder")
              : t("propertyForm.propertyPlaceholderNew")}
            behavior={{ search: true, density: "compact", minDropdownWidth: 280 }}
          />
        </div>
        {mode === "transaction" ? (
          <div className="space-y-1">
            <div className="form-label">
              {t("propertyForm.cashAccount")}
              {isSaleTab ? null : <span className="text-slate-400"> {t("stockFee.optional")}</span>}
            </div>
            <SmartSelect
              mode="single"
              value={cashAccountId}
              onChange={setCashAccountId}
              options={cashOptions}
              placeholder={t("propertyForm.cashAccountPlaceholder")}
              behavior={{ search: true, density: "compact", minDropdownWidth: 260 }}
            />
          </div>
        ) : null}
      </div>

      {mode === "transaction" && isNewAsset ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            {/* 新购入没有资产可挑，名称必须由用户写（留空会让服务端回退成账户名，几笔购入就重名）。 */}
            <div className="form-label">{t("propertyForm.propertyName")}</div>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={`form-input ${REQUIRED_FIELD_CLASS}`}
              placeholder={t("propertyForm.namePlaceholder")}
            />
          </div>
          <div className="space-y-1">
            <div className="form-label">{t("fixedAssetEdit.assetType")}</div>
            <SmartSelect
              mode="single"
              value={assetType}
              onChange={(value) => {
                const next = normalizeFixedAssetType(value);
                setAssetType(next);
                // 换成非房产后，房产专属字段留着会误导，直接清掉。
                if (next !== "property") {
                  setPropertyType("");
                  setAddress("");
                }
              }}
              options={FIXED_ASSET_TYPES.map((type) => ({ id: type, label: t(`fixedAsset.type.${type}`), title: t(`fixedAsset.type.${type}`) }))}
              behavior={{ density: "compact", minDropdownWidth: 200 }}
            />
          </div>
          {assetType === "property" ? (
            <>
              <div className="space-y-1">
                <div className="form-label">{t("fixedAssetEdit.attr.propertyType")} <span className="text-slate-400">{t("stockFee.optional")}</span></div>
                <input
                  value={propertyType}
                  onChange={(event) => setPropertyType(event.target.value)}
                  className="form-input"
                  placeholder={t("fixedAssetEdit.attr.propertyTypePlaceholder")}
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("propertyForm.address")} <span className="text-slate-400">{t("stockFee.optional")}</span></div>
                <input value={address} onChange={(event) => setAddress(event.target.value)} className="form-input" placeholder={t("stockFee.optional")} />
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {mode === "transaction" && !isSaleTab ? (
        <div className="space-y-1">
          <div className="form-label">
            {marketValueLabel}
            {isNewAsset ? <span className="text-slate-400"> {t("stockFee.optional")}</span> : null}
          </div>
          <CalcInput
            value={marketValue}
            onChange={setMarketValue}
            placeholder={isNewAsset ? t("propertyForm.marketValuePlaceholderDefault") : t("propertyForm.marketValuePlaceholderChange")}
            label={t("propertyForm.marketValue")}
            precision={2}
          />
        </div>
      ) : null}

      {mode === "transaction" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <div className="form-label">
              {amountLabel}
              {isSaleTab ? null : <span className="text-slate-400"> {t("stockFee.optional")}</span>}
            </div>
            <CalcInput value={amount} onChange={setAmount} placeholder={isSaleTab ? "" : t("stockFee.optional")} label={amountLabel} precision={2} />
          </div>
          <div className="space-y-1">
            <div className="form-label">{t("txForm.fee")}</div>
            <CalcInput value={fee} onChange={setFee} placeholder={t("stockFee.optional")} label={t("txForm.fee")} precision={2} />
          </div>
          <div className="space-y-1">
            <div className="form-label">{t("propertyForm.tax")}</div>
            <CalcInput value={tax} onChange={setTax} placeholder={t("stockFee.optional")} label={t("propertyForm.tax")} precision={2} />
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="form-label">{t("propertyForm.marketValueLatest")}</div>
          <CalcInput value={marketValue} onChange={setMarketValue} placeholder={t("propertyForm.marketValuePlaceholderManual")} label={t("propertyForm.marketValue")} precision={2} />
        </div>
      )}

      {mode === "transaction" && !isSaleTab && !isNewAsset && marketValueFilled ? (
        <div className="space-y-1 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <div>
            {t("propertyForm.currentMarketValue")} {formatMoney(currentMarketValue)}
            <span className="mx-1.5 text-slate-400">→</span>
            {marketValueLabel} {formatMoney(changeValue)}
            <span className={`ml-2 font-medium ${marketValueDelta > 0 ? "text-emerald-600" : marketValueDelta < 0 ? "text-rose-600" : "text-slate-500"}`}>
              {marketValueDelta > 0 ? "+" : marketValueDelta < 0 ? "-" : ""}
              {formatMoney(Math.abs(marketValueDelta))}
            </span>
          </div>
          {isClosingAsset ? (
            <div className="text-amber-700">{t("propertyForm.hint.useSaleTab")}</div>
          ) : null}
        </div>
      ) : null}

      {mode === "transaction" && isSaleTab ? (
        <div className="space-y-1 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <div>{t("propertyForm.currentMarketValue")} {propertyAssetId ? formatMoney(currentMarketValue) : "—"}</div>
          <div className="text-amber-700">{t("propertyForm.hint.saleTerminal")}</div>
        </div>
      ) : null}

      {/* 入账金额：售出这笔在账上真正进账的钱（出售金额 − 手续费 − 税费），单独一行贴着备注。
          服务端 `propertyCashAmount` 对 sale 就是按这个公式入账，这里只是把它显式摆出来。 */}
      {mode === "transaction" && isSaleTab ? (
        <div className="space-y-1">
          <div className="form-label">{t("propertyForm.amountCredited")}</div>
          <div className="form-input flex items-center justify-between bg-slate-50">
            <span className="tabular-nums text-slate-800">{formatMoney(saleNetProceeds)}</span>
            <span className="text-xs text-slate-400">{t("propertyForm.amountCreditedFormula")}</span>
          </div>
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="form-label">{t("detail.column.remark")}</div>
        <ClearableNoteField multiline value={note} onValueChange={setNote} className="form-input min-h-[72px] resize-none py-2" placeholder={t("stockFee.optional")} />
      </div>
    </EntryModalShell>
  );
}
