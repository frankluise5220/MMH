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
import {
  FIXED_ASSET_TYPES,
  fixedAssetProductionDateLabelKey,
  fixedAssetSupportsWeight,
  normalizeFixedAssetType,
  type FixedAssetType,
} from "@/lib/fixed-asset";
import { resolveAssetDepreciation } from "@/lib/fixed-asset-depreciation";
import { formatAmountDraft, formatMoney } from "@/lib/format";

/**
 * 固定资产记账三个页签：**资产变动** / **资产售出** / **资产处置**。
 *
 * 资产变动（change）：不选资产 = 新购入（purchase）；选资产 = 改产值（improvement），
 *   带金额就是追加投入，不带金额就只留一条产值变动记录。
 * 资产售出（sale）：必须选资产并填出售金额，服务端把产值换成回收净额、资产置为已售。
 * 资产处置（disposal）：没回款的清账（遗弃 / 赠送 / 报废）。回收金额可留空（＝0），
 *   服务端把产值换成回收净额、资产置为已处置，处置损失 = 账面成本 − 回收净额，
 *   差额进「历史持有」的已实现盈亏。有回款时按出售同样的口径要求收款账户。
 *
 * 三个页签都不再让用户先挑「购入 / 装修投入 / 出售 / 处置」这些业务类型，动作由页签 + 资产选择推断。
 */
const PropertyAction = {
  purchase: "purchase",
  improvement: "improvement",
  sale: "sale",
  disposal: "disposal",
} as const;
type PropertyAction = (typeof PropertyAction)[keyof typeof PropertyAction];
type ModalMode = "transaction" | "valuation";
/** 记账页签：资产变动 / 资产售出 / 资产处置（valuation 是「更新估值」单页入口，无页签）。 */
type EntryTab = "change" | "sale" | "disposal";
/**
 * 处置方式（2026-11-15 用户裁定）：
 * - 报废 / 赠送 / 遗弃（含「其他」）＝资产完全没有了，没有回款、没有残值，**不填折损率**；
 * - 损耗＝资产还剩下，**必须填折损率**：填 `20%` 是折损率，填 `1` 是损耗掉的重量
 *   （折损率 = 损耗量 / 资产重量）。剩余部分按比例重新入库，服务端在原账户下
 *   新建一条剩余资产继续持有，原资产按折损部分记处置损失。
 */
const DisposalReason = {
  scrap: "scrap",
  abandon: "abandon",
  gift: "gift",
  loss: "loss",
  other: "other",
} as const;
type DisposalReason = (typeof DisposalReason)[keyof typeof DisposalReason];
/**
 * 损耗处置的折损率默认值：100%（全损）。
 *
 * 处置＝资产没了，先按全损带出来；部分损耗（房产/汽车/设备只坏了一部分）再往下改。
 * 「报废 / 赠送 / 遗弃」不显示这一格，它们的损失本来就是账面净值的 100%。
 */
const DEFAULT_LOSS_RATIO_INPUT = "100%";

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
  /** 账面成本：处置页签要用它算「处置损益 = 回收净额 − 账面净值」。 */
  cost?: number | null;
  /** 资产所属的固定资产账户；选中资产后账户要跟着走，否则后端会拒（不属于当前账户）。 */
  accountId?: string | null;
  /** 资产状态（active / mortgaged / sold / disposed）：已售、已处置不再作为处置对象。 */
  status?: string | null;
  /** 抵押关联的贷款账户：非空即「抵押中」，售出 / 处置会被服务端 409 拒掉。 */
  mortgageLoanAccountId?: string | null;
  /** 折旧口径，见 src/lib/fixed-asset-depreciation.ts（处置页要显示累计折旧与账面净值）。 */
  purchaseDate?: string | null;
  depreciationMethod?: string | null;
  usefulLifeMonths?: number | null;
  salvageValue?: number | null;
  accumulatedDepreciation?: number | null;
  /** 重量 / 单位：损耗处置填数字（损耗掉的量）时用它折算折损率。 */
  weight?: number | null;
  weightUnit?: string | null;
};

/**
 * 抵押中的资产不能售出 / 处置（口径见 api/v1/properties 的 MORTGAGED_ASSET_LOCKED_MESSAGE）。
 * 服务端同时看 status 与 mortgageLoanAccountId，这里保持一致，别只判其中一项。
 */
function isAssetMortgaged(asset: { status?: string | null; mortgageLoanAccountId?: string | null }) {
  return asset.status === "mortgaged" || Boolean(asset.mortgageLoanAccountId);
}

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
  /**
   * 已经替用户自动选过资产的账户 id。
   *
   * 「账户下只有一个资产」时自动选中，省掉第二次点击；但用户主动清除（变动页不选＝新购入）
   * 之后不能再补回来，否则清空这个动作等于无效。换到别的账户、或切到必须选资产的页签才重新自动。
   *
   * 用 state 而不是 ref：重置它要让下面那条 effect 重新跑一次（ref 变化不会触发重渲染）。
   */
  const [autoPickedAccount, setAutoPickedAccount] = useState("");
  /** 上面那条自动选中填进去的资产 id：手动改选 / 清除后失效，用来决定要不要显示「已自动选中」提示。 */
  const [autoPickedAssetId, setAutoPickedAssetId] = useState("");
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
  /** 处置方式：默认「报废」，只用于说明这笔为什么没了，会被写进备注。 */
  const [disposalReason, setDisposalReason] = useState<DisposalReason>(DisposalReason.scrap);
  /**
   * 本次折损 / 折旧（售出、处置时可选）：在「按日期推算的累计折旧」之上再补一笔，
   * 服务端把 `累计折旧 + 本笔` 结算进资产，损益按账面净值算 —— 这样处置不是
   * 「资产连同全部成本一起消失」，折损掉的部分留在账上可追溯。
   */
  const [depreciation, setDepreciation] = useState("");
  /**
   * 损耗处置的折损率 / 损耗量（只在处置方式＝损耗时用）：
   * 填 `20%` 是折损率；填 `1` 是损耗掉的重量，折损率 = 1 / 资产重量。
   *
   * 默认 `100%`（用户 2026-11-15 裁定）：处置的前提是「资产没了」，先按全损带出来，
   * 部分损耗（房产/汽车/设备只坏了一部分）再把比例改小；让人从空框开始填，
   * 等于每次都先算一遍「这次损失了几成」。
   */
  const [disposalLossInput, setDisposalLossInput] = useState(DEFAULT_LOSS_RATIO_INPUT);
  /** 新购入时可选填的资产属性（生产日期 / 重量），不填就走空。 */
  const [productionDate, setProductionDate] = useState("");
  const [weight, setWeight] = useState("");
  const [weightUnit, setWeightUnit] = useState<"kg" | "t" | "g">("kg");
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
  // 全账簿资产：页面带下来的（固定资产视图当页）∪ 按需补拉列表，按 id 去重。
  // 只做去重，不在这里按账户裁剪——估值回填、归属校验都要能按 id 找到别的账户行。
  const allAssets = useMemo(() => {
    const map = new Map<string, PropertyAssetOption>();
    for (const asset of propertyAssets) map.set(asset.id, asset);
    for (const asset of extraAssets ?? []) map.set(asset.id, asset);
    return Array.from(map.values()).filter((asset) => asset.status !== "sold" && asset.status !== "disposed");
  }, [extraAssets, propertyAssets]);

  // 账户是资产的上位：选了哪个固定资产账户，资产下拉就只列这个账户下的资产
  // （2026-11-15 用户裁定）。要操作别的账户的车/房，先在上面把账户切过去，
  // 而不是让下拉跨账户抓取——那会让「账户」这一栏失去意义。
  const assetSource = useMemo(
    () => allAssets.filter((asset) => asset.accountId === propertyAccountId),
    [allAssets, propertyAccountId],
  );

  // 同账户内部是平铺的；一个账户下可以有多套资产（PropertyAsset.accountId 是 N:1）。
  // 抵押中的资产照样列出（不然用户又以为「选不出来」），只是挂个「抵押中」标签，
  // 选中后终态页签会亮红灯并由服务端 409 兜底。
  const assetOptions = useMemo<SmartSelectOption[]>(
    () => assetSource.map((asset) => ({
      id: asset.id,
      label: asset.name,
      title: asset.name,
      subLabel: isAssetMortgaged(asset) ? t("propertyForm.assetMortgagedTag") : undefined,
    })),
    [assetSource, t],
  );

  // 资产下拉现在常显（不选 = 新购入）。每次打开都整份重拉：页面传下来的只是当前视图/账户的
  // positions，菜单入口更是一份都没有，只靠它就会漏资产（`transactions=0` 只要资产，不拖明细）。
  useEffect(() => {
    if (!open) return;
    if (extraAssets !== null) return;
    let cancelled = false;
    fetch("/api/v1/properties?transactions=0", { cache: "no-store" })
      .then((res) => res.json())
      .then((body: { ok?: boolean; data?: { assets?: Array<{
        id: string;
        name: string;
        marketValue?: number | null;
        cost?: number | null;
        accountId?: string | null;
        status?: string | null;
        mortgageLoanAccountId?: string | null;
        purchaseDate?: string | null;
        depreciationMethod?: string | null;
        usefulLifeMonths?: number | null;
        salvageValue?: number | null;
        accumulatedDepreciation?: number | null;
        weight?: number | null;
        weightUnit?: string | null;
      }> } } | null) => {
        if (cancelled) return;
        setExtraAssets((body?.data?.assets ?? []).map((asset) => ({
          id: asset.id,
          name: asset.name,
          marketValue: asset.marketValue ?? null,
          cost: asset.cost ?? null,
          accountId: asset.accountId ?? null,
          status: asset.status ?? null,
          mortgageLoanAccountId: asset.mortgageLoanAccountId ?? null,
          purchaseDate: asset.purchaseDate ?? null,
          depreciationMethod: asset.depreciationMethod ?? null,
          usefulLifeMonths: asset.usefulLifeMonths ?? null,
          salvageValue: asset.salvageValue ?? null,
          accumulatedDepreciation: asset.accumulatedDepreciation ?? null,
          weight: asset.weight ?? null,
          weightUnit: asset.weightUnit ?? null,
        })));
      })
      // 拉不到就退回页面那份（保存时后端还会校验资产），别把弹窗卡死。
      .catch(() => { if (!cancelled) setExtraAssets([]); });
    return () => { cancelled = true; };
  }, [open, extraAssets]);

  /** 已选资产（含当前产值，用于提示「当前产值 → 变动后产值」）。 */
  const selectedAsset = useMemo(
    () => assetSource.find((asset) => asset.id === propertyAssetId) ?? null,
    [assetSource, propertyAssetId],
  );

  // 兜底：编辑回填/先选资产再换账户留下的跨账户资产都清掉，
  // 否则下拉里显示不出这个值，提交又会被后端以「资产不属于当前账户」拒掉。
  useEffect(() => {
    if (!open || !propertyAssetId) return;
    const asset = allAssets.find((item) => item.id === propertyAssetId);
    if (asset && asset.accountId !== propertyAccountId) setPropertyAssetId("");
  }, [open, allAssets, propertyAccountId, propertyAssetId]);

  // 账户下只有一个资产时替用户选中，省掉「选完账户再选一次资产」。
  // 资产列表是异步补拉的，所以这里等到真的只剩一条才动手；用户主动清除后不补（见 autoPickedAccount）。
  useEffect(() => {
    if (!open || !propertyAccountId || propertyAssetId) return;
    if (assetSource.length !== 1) return;
    if (autoPickedAccount === propertyAccountId) return;
    setAutoPickedAccount(propertyAccountId);
    const [only] = assetSource;
    setPropertyAssetId(only.id);
    setAutoPickedAssetId(only.id);
    // 估值是「在这个资产上改产值」，直接把现值带出来；变动/售出的金额留给用户填。
    if (mode === "valuation" && only.marketValue != null) setMarketValue(formatAmountDraft(only.marketValue));
  }, [assetSource, autoPickedAccount, mode, open, propertyAccountId, propertyAssetId]);

  const isSaleTab = entryTab === "sale";
  const isDisposalTab = entryTab === "disposal";
  // 售出 / 处置都是资产终点：资产必选，产值由服务端按回收净额写回。
  const isTerminalTab = isSaleTab || isDisposalTab;
  /**
   * 抵押中的资产不能售出 / 处置：贷款还压在这套资产上，卖了它贷款就悬空了。
   * 「资产变动」（改产值、加装修成本）不受影响，只有终态页签拦。
   */
  const selectedAssetMortgaged = Boolean(selectedAsset && isAssetMortgaged(selectedAsset));
  const terminalMortgageLocked = isTerminalTab && selectedAssetMortgaged;
  const marketValueFilled = marketValue.trim() !== "";
  const changeValue = parseAmount(marketValue);
  const amountValue = parseAmount(amount);
  // 售出/处置页必须先选资产；变动页不选资产＝新购入。
  const isNewAsset = !isTerminalTab && !propertyAssetId;
  // 变动页把产值填成 0 等于在清空资产，那不是「变动」，提示去售出页签。
  const isClosingAsset = !isTerminalTab && !isNewAsset && marketValueFilled && changeValue <= 0;
  const resolvedAction: PropertyAction = isNewAsset
    ? PropertyAction.purchase
    : isSaleTab
      ? PropertyAction.sale
      : isDisposalTab
        ? PropertyAction.disposal
        : PropertyAction.improvement;
  const currentMarketValue = selectedAsset?.marketValue ?? 0;
  const marketValueDelta = changeValue - currentMarketValue;
  const recoveryNetProceeds = Math.max(0, amountValue - parseAmount(fee) - parseAmount(tax));
  const assetBookCost = selectedAsset?.cost ?? 0;
  /**
   * 已选资产的折旧：口径统一走 src/lib/fixed-asset-depreciation.ts（与 API 结算同一套），
   * 这里只做展示与「处置损益」预估。没有登记折旧时累计折旧为 0，行为和旧版完全一致。
   */
  const assetDepreciation = useMemo(
    () => (selectedAsset
      ? resolveAssetDepreciation({
        cost: selectedAsset.cost,
        purchaseDate: selectedAsset.purchaseDate,
        status: selectedAsset.status,
        depreciationMethod: selectedAsset.depreciationMethod,
        usefulLifeMonths: selectedAsset.usefulLifeMonths,
        salvageValue: selectedAsset.salvageValue,
        accumulatedDepreciation: selectedAsset.accumulatedDepreciation,
      }, tradeDate)
      : null),
    [selectedAsset, tradeDate],
  );
  const impairmentValue = parseAmount(depreciation);
  /** 结算后的账面净值 = 成本 − (推算/手填的累计折旧 + 本次折损)。 */
  const settledAccumulated = Math.min(assetBookCost, (assetDepreciation?.accumulated ?? 0) + impairmentValue);
  const netBookValue = Math.max(0, assetBookCost - settledAccumulated);
  /** 处置方式＝损耗：只有它要填折损率，剩余部分按比例重新入库。 */
  const isLossDisposal = isDisposalTab && disposalReason === DisposalReason.loss;
  /**
   * 折损率解析：`20%` → 0.2；`1` → 损耗掉 1 个重量单位，折损率 = 1 / 资产重量。
   * 没登记重量的资产不能填数字（只能填百分比），由 invalid 负责提示。
   */
  const lossParsed = useMemo(() => {
    const raw = disposalLossInput.trim().replace(/％/g, "%").replace(/,/g, "");
    const empty = { ratio: 0, lossWeight: null as number | null, invalid: false, percentMode: false };
    if (!raw) return empty;
    const percentMode = raw.endsWith("%");
    const numeric = Number((percentMode ? raw.slice(0, -1) : raw).trim());
    if (!Number.isFinite(numeric) || numeric < 0) return { ...empty, invalid: true, percentMode };
    const assetWeight = selectedAsset?.weight ?? null;
    if (percentMode) {
      const ratio = Math.min(1, numeric / 100);
      return {
        ratio,
        lossWeight: assetWeight != null && assetWeight > 0 ? assetWeight * ratio : null,
        invalid: false,
        percentMode,
      };
    }
    if (assetWeight == null || assetWeight <= 0) return { ...empty, invalid: true, percentMode };
    return { ratio: Math.min(1, numeric / assetWeight), lossWeight: numeric, invalid: false, percentMode };
  }, [disposalLossInput, selectedAsset]);
  /** 损耗折损率（0~1）：等于 1 时和报废一样是「完全没有了」。 */
  const lossRatio = isLossDisposal ? lossParsed.ratio : 0;
  /** 损耗掉的价值 = 净值 × 折损率；剩余 = 净值 × (1 − 折损率)，按净值重新入库。 */
  const lossAmountValue = netBookValue * lossRatio;
  const lossReentryValue = netBookValue - lossAmountValue;
  const lossRemainWeight = selectedAsset?.weight != null ? selectedAsset.weight * (1 - lossRatio) : null;
  /** 折损率展示（20% / 12.5%），最多两位小数。 */
  const lossPercentText = `${Math.round(lossRatio * 10000) / 100}%`;
  /** 已实现盈亏（正=赚、负=亏）= 回收净额 − 账面净值；处置没有回款，回收净额就是 0。 */
  const terminalPnL = recoveryNetProceeds - netBookValue;
  /**
   * 售出展示「已实现盈亏」，处置展示「处置损失」：报废 / 赠送 / 遗弃是整个净值都损失，
   * 损耗只损失折损掉的那部分（剩余部分会重新入库）。
   */
  const terminalDisplayValue = isSaleTab ? terminalPnL : isLossDisposal ? lossAmountValue : -terminalPnL;
  const terminalDisplayTone = isSaleTab
    ? terminalPnL > 0 ? "text-emerald-600" : terminalPnL < 0 ? "text-rose-600" : "text-slate-500"
    : terminalPnL < 0 ? "text-rose-600" : terminalPnL > 0 ? "text-emerald-600" : "text-slate-500";

  const resetTransactionDraft = useCallback((detail?: PropertyCreateEventDetail) => {
    setMode("transaction");
    // 旧入口（菜单「固定资产 ▸ 出售」）仍可能带 action=sale，直接落到售出页签。
    setEntryTab(detail?.defaultAction === "sale" ? "sale" : "change");
    setRequestId(detail?.requestId ?? "");
    setPropertyAccountId(detail?.defaultPropertyAccountId || defaultPropertyAccountId || propertyAccounts[0]?.id || "");
    setCashAccountId(detail?.defaultCashAccountId || defaultCashAccountId || cashAccounts[0]?.id || "");
    setPropertyAssetId("");
    // 每次打开重新判断「唯一资产自动选中」，上次会话里清除过的痕迹不能留。
    setAutoPickedAccount("");
    setAutoPickedAssetId("");
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
    setDisposalReason(DisposalReason.scrap);
    // 本次折损/折旧只在售出时填；处置页的折损率只在「损耗」时填。
    // 折损率带默认 100%（全损），本次折损清空。
    setDepreciation("");
    setDisposalLossInput(DEFAULT_LOSS_RATIO_INPUT);
    setProductionDate("");
    setWeight("");
    setWeightUnit("kg");
    setNote("");
  }, [cashAccounts, defaultAssetType, defaultCashAccountId, defaultPropertyAccountId, propertyAccounts]);

  const resetValuationDraft = useCallback((detail?: PropertyValuationEventDetail) => {
    const accountId = detail?.defaultPropertyAccountId || defaultPropertyAccountId || propertyAccounts[0]?.id || "";
    setAutoPickedAccount("");
    setAutoPickedAssetId("");
    setMode("valuation");
    setRequestId(detail?.requestId ?? "");
    setPropertyAccountId(accountId);
    setCashAccountId(defaultCashAccountId || cashAccounts[0]?.id || "");
    // 兜底默认值也要落在该账户下，否则下拉里看不到选中的资产。
    setPropertyAssetId(
      detail?.propertyAssetId
      || allAssets.find((asset) => asset.accountId === accountId)?.id
      || "",
    );
    setName(detail?.propertyName || "");
    setPropertyType("");
    setAddress("");
    setTradeDate(todayYmd());
    setSettlementDate("");
    setAmount("");
    setFee("");
    setTax("");
    setMarketValue(detail?.currentMarketValue != null ? String(detail.currentMarketValue) : "");
    setDepreciation("");
    setProductionDate("");
    setWeight("");
    setWeightUnit("kg");
    setNote("");
  }, [allAssets, cashAccounts, defaultCashAccountId, defaultPropertyAccountId, propertyAccounts]);

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
    // 抵押中的资产不能售出 / 处置：服务端会 409，前端先在这里说清楚怎么解除。
    if (terminalMortgageLocked) {
      window.alert(t("propertyForm.alert.mortgagedAssetLocked"));
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
    // 处置（遗弃 / 赠送 / 报废 / 损耗）没有回款：金额固定为 0，损失进已实现盈亏。
    if (isDisposalTab) {
      if (!propertyAssetId) {
        window.alert(t("propertyForm.alert.selectProperty"));
        return;
      }
      // 只有「损耗」要填折损率：报废 / 赠送 / 遗弃是完全没有了，什么都不用填。
      if (isLossDisposal) {
        if (lossParsed.invalid) {
          window.alert(
            t(lossParsed.percentMode ? "propertyForm.alert.enterLossRate" : "propertyForm.alert.lossNeedWeight"),
          );
          return;
        }
        if (lossRatio <= 0) {
          window.alert(t("propertyForm.alert.enterLossRate"));
          return;
        }
      }
    }
    // 已有资产：产值和资金总得动一样，否则这一笔什么都不记。
    if (!isTerminalTab && !isNewAsset && !marketValueFilled && amountValue <= 0) {
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
    // 处置方式没有独立列可放（服务端只存备注），直接拼进备注开头：
    // 「赠送 · 送给表弟」比只留一句备注更容易在明细里看懂这笔为什么没了。
    const submissionNote = isDisposalTab
      ? [t(`propertyForm.disposalReason.${disposalReason}`), note.trim()].filter(Boolean).join(" · ")
      : note.trim();
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
          // 资产属性只在新购入时提交（已有资产改这些走「编辑资产」）。
          productionDate: isNewAsset && productionDate ? productionDate : undefined,
          // 房产、车辆不登记重量，改成它们之后不提交（与编辑窗同一份口径）。
          weight: isNewAsset && weight.trim() && fixedAssetSupportsWeight(assetType) ? weight : undefined,
          weightUnit: isNewAsset && weight.trim() && fixedAssetSupportsWeight(assetType) ? weightUnit : undefined,
          // 本次折损/折旧（只在售出时用）：服务端把它加进累计折旧，损益按账面净值算。
          // 处置不做「手填折旧」——报废类是完全没了，损耗类由折损率决定。
          depreciation: isSaleTab && impairmentValue > 0 ? depreciation : undefined,
          // 处置方式：报废 / 赠送 / 遗弃 = 全损；损耗带折损率（0<r<1）时服务端把剩余部分重新入库。
          disposalReason: isDisposalTab ? disposalReason : undefined,
          lossRatio: isLossDisposal && lossRatio > 0 && lossRatio < 1 ? lossRatio : undefined,
          tradeDate,
          settlementDate: settlementDate || undefined,
          amount: amountValue > 0 ? amount : "0",
          fee: fee || undefined,
          tax: tax || undefined,
          // 售出 / 处置不传产值：服务端按「金额 − 手续费 − 税费」作为回收净额写入产值。
          marketValue: !isTerminalTab && marketValueFilled ? marketValue : undefined,
          note: submissionNote || undefined,
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
    /* 整窗外壳见 `EntryModalShell`：记账走三个 FT 页签（资产变动 / 资产售出 / 资产处置），
       购入与产值变动靠「是否选资产」推断，售出与处置是独立页签，见文件头说明。 */
    <EntryModalShell
      open={open}
      heightKey="property"
      width="sm"
      title={mode === "valuation"
        ? t("propertyForm.title.updateValuation")
        : isSaleTab
          ? t("propertyForm.tab.sale")
          : isDisposalTab ? t("propertyForm.tab.disposal") : t("propertyForm.tab.change")}
      tabs={mode === "transaction"
        ? [
          { id: "change", label: t("propertyForm.tab.change") },
          { id: "sale", label: t("propertyForm.tab.sale") },
          { id: "disposal", label: t("propertyForm.tab.disposal") },
        ]
        : undefined}
      activeTabId={entryTab}
      onTabChange={(id) => {
        const next: EntryTab = id === "sale" ? "sale" : id === "disposal" ? "disposal" : "change";
        if (next === entryTab) return;
        // 售出 / 处置必须选资产：从「资产变动」里刚清空过（＝新购入）切过来时，把自动选中的机会还回去。
        if (next !== "change") setAutoPickedAccount("");
        // 资产选择跨页签保留；产值/金额语义不同（追加投入 vs 出售回款），切页签时清掉免得串味。
        setEntryTab(next);
        setMarketValue("");
        setAmount("");
        // 处置没有回款，手续费/税费不该跟着串到下一笔。
        setFee("");
        setTax("");
      }}
      rulerLabels={[t("propertyForm.tab.change"), t("propertyForm.tab.sale"), t("propertyForm.tab.disposal")]}
      onClose={close}
      closeLabel={<X className="h-4 w-4" />}
      closeTitle={t("table.close")}
      onSubmit={submit}
      footer={(
        <button
          type="submit"
          className="primary-button"
          disabled={submitting || terminalMortgageLocked}
          title={terminalMortgageLocked ? t("propertyForm.hint.mortgagedAssetLocked") : undefined}
        >
          {submitting ? t("stockFee.saving") : t("common.save")}
        </button>
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
              // 换账户后原来选中的资产不属于新账户了，清掉重新选；
              // 没选资产（＝新购入）时不动金额，别把刚填的初始产值抹掉。
              if (propertyAssetId) {
                setPropertyAssetId("");
                setAutoPickedAssetId("");
                setMarketValue("");
              }
            }}
            options={propertyOptions}
            placeholder={t("propertyForm.propertyAccountPlaceholder")}
            behavior={{ search: true, minDropdownWidth: 260 }}
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
              // 用户自己点过（包括点清除＝改记新购入），「已自动选中」就过期了。
              setAutoPickedAssetId("");
              const asset = assetSource.find((item) => item.id === value);
              if (asset?.marketValue != null && mode === "valuation") setMarketValue(formatAmountDraft(asset.marketValue));
            }}
            options={assetOptions}
            placeholder={assetSource.length === 0
              ? t("propertyForm.propertyEmptyInAccount")
              : mode === "valuation" || isTerminalTab
                ? t("propertyForm.propertyPlaceholder")
                : t("propertyForm.propertyPlaceholderNew")}
            behavior={{ search: true, minDropdownWidth: 280 }}
          />
          {/* 抵押中的资产不能卖：先说清「为什么不能、怎么解除」，再去管空账户的情况。 */}
          {terminalMortgageLocked ? (
            <div className="text-xs text-rose-600">{t("propertyForm.hint.mortgagedAssetLocked")}</div>
          ) : isTerminalTab && extraAssets !== null && assetSource.length === 0 ? (
            /* 售出/处置必须选资产：本账户下一套都没有时，说清「去上面换账户」而不是留个空下拉。 */
            <div className="text-xs text-slate-500">{t("propertyForm.hint.assetEmptyInAccount")}</div>
          ) : autoPickedAssetId && autoPickedAssetId === propertyAssetId && !isTerminalTab && mode === "transaction" ? (
            /* 变动页不选资产＝新购入：自动选中了唯一资产，得说清怎么变回「新购入」。 */
            <div className="text-xs text-slate-500">{t("propertyForm.hint.autoPickedOnlyAsset")}</div>
          ) : null}
        </div>
        {/* 处置没有回款，不涉及资金账户，别让用户以为要选一个。 */}
        {mode === "transaction" && !isDisposalTab ? (
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
              behavior={{ search: true, minDropdownWidth: 260 }}
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
                // 房产、车辆不登记重量：换了类型就把刚填的重量清掉，免得藏起来还提交上去。
                if (!fixedAssetSupportsWeight(next)) {
                  setWeight("");
                  setWeightUnit("kg");
                }
              }}
              options={FIXED_ASSET_TYPES.map((type) => ({ id: type, label: t(`fixedAsset.type.${type}`), title: t(`fixedAsset.type.${type}`) }))}
              behavior={{ minDropdownWidth: 200 }}
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
          {/* 资产属性：生产日期 / 重量（2026-11-15 用户要求）。两个都能留空，之后在
              「编辑资产」里也能改；重量只是登记属性，不参与估值或折旧计算。
              2026-11-17：房子叫「建成年份」、车叫「出厂日期」，且房产/车辆不登记重量。 */}
          <div className="space-y-1">
            <div className="form-label">{t(fixedAssetProductionDateLabelKey(assetType))} <span className="text-slate-400">{t("stockFee.optional")}</span></div>
            <DateStepper value={productionDate} onChange={setProductionDate} />
          </div>
          {fixedAssetSupportsWeight(assetType) ? (
            <div className="space-y-1">
              <div className="form-label">{t("fixedAssetEdit.weight")} <span className="text-slate-400">{t("stockFee.optional")}</span></div>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <CalcInput value={weight} onChange={setWeight} placeholder={t("stockFee.optional")} label={t("fixedAssetEdit.weight")} precision={3} />
                </div>
                <div className="w-20 shrink-0">
                  <SmartSelect
                    mode="single"
                    value={weightUnit}
                    onChange={(value) => setWeightUnit(value === "t" ? "t" : value === "g" ? "g" : "kg")}
                    options={[
                      { id: "kg", label: t("fixedAssetEdit.weightUnit.kg"), title: t("fixedAssetEdit.weightUnit.kg") },
                      { id: "t", label: t("fixedAssetEdit.weightUnit.t"), title: t("fixedAssetEdit.weightUnit.t") },
                      { id: "g", label: t("fixedAssetEdit.weightUnit.g"), title: t("fixedAssetEdit.weightUnit.g") },
                    ]}
                    behavior={{ minDropdownWidth: 120 }}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {mode === "transaction" && !isTerminalTab ? (
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

      {/* 处置方式只解释「为什么没了」：处置没有回款，所以这一页签不摆金额/手续费/税费。 */}
      {mode === "transaction" && isDisposalTab ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <div className="form-label">{t("propertyForm.disposalReason")}</div>
            <SmartSelect
              mode="single"
              value={disposalReason}
              onChange={(value) => {
                const next = (Object.values(DisposalReason) as string[]).includes(value) ? (value as DisposalReason) : DisposalReason.other;
                setDisposalReason(next);
                // 切到「损耗」时空着就先带 100%（全损），别让人从空框开始估比例。
                if (next === DisposalReason.loss && !disposalLossInput.trim()) setDisposalLossInput(DEFAULT_LOSS_RATIO_INPUT);
              }}
              options={Object.values(DisposalReason).map((reason) => ({
                id: reason,
                label: t(`propertyForm.disposalReason.${reason}`),
                title: t(`propertyForm.disposalReason.${reason}`),
              }))}
              behavior={{ minDropdownWidth: 200 }}
            />
          </div>
          {/* 折损率一直摆着：处置＝资产没了，默认 100%（全损）；只有「损耗」能改（部分损坏）。 */}
          <div className="space-y-1">
            <div className="form-label">
              {t("propertyForm.lossRatio")}
              {isLossDisposal ? null : (
                <span className="text-slate-400"> {t("propertyForm.lossRatioAllLostTag")}</span>
              )}
            </div>
            <input
              className={`form-input${isLossDisposal ? "" : " cursor-not-allowed bg-slate-50 text-slate-400"}`}
              value={isLossDisposal ? disposalLossInput : DEFAULT_LOSS_RATIO_INPUT}
              onChange={(event) => setDisposalLossInput(event.target.value)}
              placeholder={t("propertyForm.lossRatioPlaceholder")}
              inputMode="decimal"
              disabled={!isLossDisposal}
            />
            <div className="text-[11px] leading-tight text-slate-400">
              {isLossDisposal
                ? `${t("propertyForm.hint.lossRatio")}${selectedAsset?.weight != null
                  ? ` · ${t("propertyForm.hint.lossAssetWeight")}${selectedAsset.weight} ${selectedAsset.weightUnit ?? ""}`
                  : ""}`
                : t("propertyForm.hint.lossRatioFixed")}
            </div>
          </div>
        </div>
      ) : null}

      {mode === "transaction" && !isDisposalTab ? (
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
      ) : null}

      {mode === "valuation" ? (
        <div className="space-y-1">
          <div className="form-label">{t("propertyForm.marketValueLatest")}</div>
          <CalcInput value={marketValue} onChange={setMarketValue} placeholder={t("propertyForm.marketValuePlaceholderManual")} label={t("propertyForm.marketValue")} precision={2} />
        </div>
      ) : null}

      {mode === "transaction" && !isTerminalTab && !isNewAsset && marketValueFilled ? (
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

      {/* 售出 / 处置都先结转累计折旧，损益按**账面净值**算（回收净额 − 净值），
          不是「成本全额消失」。折损/折旧这里可以再补一笔（保险赔付差额、事故贬值、
          提前报废的差额），服务端把它和按年限推算的折旧一起结算进资产。
          没登记折旧时累计折旧 = 0、净值 = 成本，数字与旧版完全一致。 */}
      {mode === "transaction" && isTerminalTab ? (
        <div className="space-y-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              {t("propertyForm.bookCost")}
              <span className="ml-1 font-medium tabular-nums text-slate-800">{propertyAssetId ? formatMoney(assetBookCost) : "—"}</span>
            </span>
            <span>
              {t("propertyForm.accumulatedDepreciation")}
              {/* 展示的是结算后的累计折旧（含下面填的「本次折损」），
                  否则「成本 − 累计折旧」和旁边那个账面净值对不上。 */}
              <span className="ml-1 font-medium tabular-nums text-slate-800">{propertyAssetId ? formatMoney(settledAccumulated) : "—"}</span>
            </span>
            <span>
              {t("propertyForm.netBookValue")}
              <span className="ml-1 font-medium tabular-nums text-slate-800">{propertyAssetId ? formatMoney(netBookValue) : "—"}</span>
            </span>
            <span>
              {isSaleTab ? t("propertyForm.realizedPnl") : t("propertyForm.disposalLoss")}
              <span className={`ml-1 font-medium tabular-nums ${terminalDisplayTone}`}>
                {propertyAssetId ? formatMoney(terminalDisplayValue) : "—"}
              </span>
            </span>
          </div>
          {/* 手填折损/折旧只留给售出（事故贬值、提前报废的差额就填这里）；
              处置页不填——报废 / 赠送 / 遗弃是完全没有了，损耗只由折损率表达。 */}
          {isSaleTab ? (
            <div className="flex items-center gap-2">
              <span className="shrink-0">{t("propertyForm.depreciationThisTime")}</span>
              <div className="w-36">
                <CalcInput
                  value={depreciation}
                  onChange={setDepreciation}
                  placeholder={t("stockFee.optional")}
                  label={t("propertyForm.depreciationThisTime")}
                  precision={2}
                />
              </div>
              <span className="text-[11px] leading-tight text-slate-400">{t("propertyForm.hint.depreciation")}</span>
            </div>
          ) : null}
          {isLossDisposal && propertyAssetId ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
              <span>
                {t("propertyForm.lossRatio")}
                <span className="ml-1 font-medium tabular-nums text-slate-800">{lossPercentText}</span>
              </span>
              {lossParsed.lossWeight != null ? (
                <span>
                  {t("propertyForm.lossWeight")}
                  <span className="ml-1 font-medium tabular-nums text-slate-800">
                    {lossParsed.lossWeight} {selectedAsset?.weightUnit ?? ""}
                  </span>
                </span>
              ) : null}
              {lossRemainWeight != null ? (
                <span>
                  {t("propertyForm.lossRemainWeight")}
                  <span className="ml-1 font-medium tabular-nums text-slate-800">
                    {Math.round(lossRemainWeight * 1000) / 1000} {selectedAsset?.weightUnit ?? ""}
                  </span>
                </span>
              ) : null}
              <span>
                {t("propertyForm.lossReentry")}
                <span className="ml-1 font-medium tabular-nums text-slate-800">{formatMoney(lossReentryValue)}</span>
              </span>
            </div>
          ) : null}
          <div className="text-amber-700">{isSaleTab ? t("propertyForm.hint.saleTerminal") : t("propertyForm.hint.disposalTerminal")}</div>
        </div>
      ) : null}

      {/* 入账金额：售出这笔在账上真正进账的钱（出售金额 − 手续费 − 税费），单独一行贴着备注。
          服务端 `propertyCashAmount` 对 sale 就是按这个公式入账，这里只是把它显式摆出来。 */}
      {mode === "transaction" && isSaleTab ? (
        <div className="space-y-1">
          <div className="form-label">{t("propertyForm.amountCredited")}</div>
          <div className="form-input flex items-center justify-between bg-slate-50">
            <span className="tabular-nums text-slate-800">{formatMoney(recoveryNetProceeds)}</span>
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
