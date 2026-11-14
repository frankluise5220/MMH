"use client";

/**
 * 贵金属投资记账窗口的「提取实物」页签字段区（不再单独开一个弹窗）。
 *
 * 字段只负责收集与校验；成本结转、明细落库、固定资产入库、持仓回算全在
 * `extractMetalToFixedAsset` 里按移动加权口径完成。提交函数通过 `submitRef`
 * 交给外层 `InvestmentFormModal` 的统一底栏按钮调用。
 */
import { useEffect, useMemo, useState } from "react";
import { formatAccountHoverTitle } from "@/lib/account-display";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { METAL_QUANTITY_DECIMALS } from "@/lib/fund/unit-precision-core";
import { useI18n } from "@/lib/i18n";
import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { NestedAddModal } from "./EntityCreateForm";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";

export type MetalExtractSubmitResult =
  | { ok: true; formData: FormData }
  | { ok: false; error: string };

export type MetalExtractSubmitRef = {
  current: (() => MetalExtractSubmitResult) | null;
};

type MetalHoldingRow = {
  accountId: string;
  metalTypeId: string;
  metalTypeName: string | null;
  metalUnitId: string;
  metalUnitName: string | null;
  quantity: number;
  avgCost: number;
  latestPrice: number | null;
};

function holdingKey(row: { metalTypeId: string; metalUnitId: string }) {
  return `${row.metalTypeId}|${row.metalUnitId}`;
}

function trimQty(value: number) {
  return String(Number(value.toFixed(METAL_QUANTITY_DECIMALS)));
}

export function MetalExtractFields({
  accountId,
  metalTypeId,
  metalUnitId,
  propertyAccounts,
  nestedFieldData,
  submitRef,
}: {
  accountId: string;
  metalTypeId?: string | null;
  metalUnitId?: string | null;
  /** 只含贵金属实物账户（房产 / 汽车 / 设备等已在服务端过滤掉）。 */
  propertyAccounts: SmartSelectOption[];
  nestedFieldData?: Record<string, Array<{ id: string; name: string; type?: string }>>;
  submitRef: MetalExtractSubmitRef;
}) {
  const { t } = useI18n();
  const today = todayDateLocalYmd();

  const [holdings, setHoldings] = useState<MetalHoldingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [holdingKeyValue, setHoldingKeyValue] = useState("");
  const [quantity, setQuantity] = useState("");
  const [date, setDate] = useState(today);
  const [propertyAccountId, setPropertyAccountId] = useState("");
  const [createdPropertyAccounts, setCreatedPropertyAccounts] = useState<SmartSelectOption[]>([]);
  const [propertyAccountCreateOpen, setPropertyAccountCreateOpen] = useState(false);
  const [assetName, setAssetName] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setQuantity("");
    setAssetName("");
    setNote("");
    setDate(today);
    fetch(`/api/v1/precious-metals/holdings?accountId=${encodeURIComponent(accountId)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((payload: { ok?: boolean; holdings?: MetalHoldingRow[]; error?: string }) => {
        if (cancelled) return;
        const rows = payload?.holdings ?? [];
        setHoldings(rows);
        // 入口带品种时优先选中该品种的持仓行；其余默认第一行。
        const preferred =
          (metalTypeId
            ? rows.find(
                (row) =>
                  row.metalTypeId === metalTypeId &&
                  (!metalUnitId || row.metalUnitId === metalUnitId),
              )
            : null) ?? rows[0];
        setHoldingKeyValue(preferred ? holdingKey(preferred) : "");
        if (!rows.length) setLoadError(t("metalExtract.noHolding"));
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : t("metalExtract.holdingsLoadFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, metalTypeId, metalUnitId, today, t]);

  // 现场新建的账户还没回流到 RSC，先并进本地选项，避免被下面的默认选中逻辑清掉。
  const visiblePropertyAccounts = useMemo(() => {
    const known = new Set(propertyAccounts.map((option) => option.id));
    return [...propertyAccounts, ...createdPropertyAccounts.filter((option) => !known.has(option.id))];
  }, [propertyAccounts, createdPropertyAccounts]);

  useEffect(() => {
    // 账户下拉可能是分组结构，第一条往往是表头（id 形如 owner:xxx），
    // 拿它当默认账户会被服务端判成「固定资产账户不存在」。
    const selectable = visiblePropertyAccounts.filter((option) => !option.isHeader);
    setPropertyAccountId((current) => {
      if (current && selectable.some((option) => option.id === current)) return current;
      const preferred =
        selectable.find((option) => option.investProductType === "property") ?? selectable[0];
      return preferred?.id ?? "";
    });
  }, [visiblePropertyAccounts]);

  const holdingOptions: SmartSelectOption[] = useMemo(
    () =>
      holdings.map((row) => ({
        id: holdingKey(row),
        label: `${row.metalTypeName ?? row.metalTypeId} · ${row.metalUnitName ?? ""}`.trim(),
        subLabel: `${t("metalExtract.availableShort")} ${trimQty(row.quantity)} ${row.metalUnitName ?? ""}`.trim(),
      })),
    [holdings, t],
  );

  const holding = holdings.find((row) => holdingKey(row) === holdingKeyValue) ?? null;
  const quantityValue = Number(quantity);
  const costPreview =
    holding && quantityValue > 0 ? Number((holding.avgCost * Math.min(quantityValue, holding.quantity)).toFixed(2)) : 0;

  const buildSubmit = (): MetalExtractSubmitResult => {
    if (loading) return { ok: false, error: t("common.loading") };
    if (!holding) return { ok: false, error: loadError ?? t("metalExtract.noHolding") };
    if (!(quantityValue > 0)) return { ok: false, error: t("metalExtract.invalidQuantity") };
    if (quantityValue > holding.quantity + 1e-6) {
      return { ok: false, error: t("metalExtract.quantityExceed").replace("{available}", trimQty(holding.quantity)) };
    }
    if (!propertyAccountId) return { ok: false, error: t("metalExtract.selectPropertyAccount") };
    const fd = new FormData();
    fd.set("accountId", accountId);
    fd.set("metalTypeId", holding.metalTypeId);
    fd.set("metalUnitId", holding.metalUnitId);
    fd.set("quantity", String(quantityValue));
    fd.set("date", date);
    fd.set("propertyAccountId", propertyAccountId);
    fd.set("name", assetName.trim());
    fd.set("note", note.trim());
    return { ok: true, formData: fd };
  };

  // 每次渲染都刷新提交闭包，保证底栏「确认提取实物」拿到的是最新输入值。
  useEffect(() => {
    submitRef.current = buildSubmit;
    return () => {
      if (submitRef.current === buildSubmit) submitRef.current = null;
    };
  });

  return (
    <>
      {loading ? <div className="text-xs text-slate-500">{t("common.loading")}</div> : null}
      {!loading && loadError ? <div className="text-xs text-rose-600">{loadError}</div> : null}

      {holdings.length > 1 ? (
        <div className="space-y-1">
          <div className="form-label">{t("metalExtract.holding")}</div>
          <SmartSelect
            mode="single"
            value={holdingKeyValue}
            onChange={setHoldingKeyValue}
            options={holdingOptions}
            placeholder={t("metalExtract.holdingPlaceholder")}
            behavior={{ hierarchy: false, search: "auto", clearable: false }}
          />
        </div>
      ) : null}

      {holding ? (
        <div className="rounded-[10px] bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <div className="flex justify-between">
            <span>{t("metalExtract.available")}</span>
            <span className="font-medium tabular-nums">
              {trimQty(holding.quantity)} {holding.metalUnitName ?? t("metalExtract.unitSuffix")}
            </span>
          </div>
          <div className="flex justify-between">
            <span>{t("metalExtract.avgCost")}</span>
            <span className="tabular-nums">{holding.avgCost.toFixed(4)}</span>
          </div>
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="form-label">{t("metalExtract.quantity")}</div>
        <CalcInput
          value={quantity}
          onChange={setQuantity}
          placeholder={holding ? trimQty(holding.quantity) : "0"}
          label={t("metalExtract.quantity")}
          precision={METAL_QUANTITY_DECIMALS}
        />
        {holding ? (
          <div className="text-[11px] text-slate-400">
            {t("metalExtract.costPreview")}: <span className="tabular-nums">{costPreview.toFixed(2)}</span>
          </div>
        ) : null}
      </div>

      <div className="space-y-1">
        <div className="form-label">{t("metalExtract.date")}</div>
        <DateStepper value={date} onChange={setDate} />
      </div>

      <div className="space-y-1">
        <div className="form-label">{t("metalExtract.propertyAccount")}</div>
        <SmartSelect
          mode="single"
          value={propertyAccountId}
          onChange={setPropertyAccountId}
          options={visiblePropertyAccounts}
          placeholder={t("fundShell.selectAccount")}
          onCreateClick={() => setPropertyAccountCreateOpen(true)}
          createLabel={t("metalExtract.createPropertyAccount")}
          behavior={{ hierarchy: false, search: "auto", clearable: false, minDropdownWidth: 320 }}
        />
        {visiblePropertyAccounts.length === 0 ? (
          <div className="text-[11px] text-amber-600">{t("metalExtract.propertyAccountEmpty")}</div>
        ) : null}
      </div>

      <div className="space-y-1">
        <div className="form-label">{t("metalExtract.name")}</div>
        <input
          value={assetName}
          onChange={(event) => setAssetName(event.target.value)}
          placeholder={t("metalExtract.namePlaceholder")}
          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none focus:border-slate-400"
        />
      </div>

      <div className="space-y-1">
        <div className="form-label">{t("metalExtract.note")}</div>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t("metalExtract.notePlaceholder")}
          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none focus:border-slate-400"
        />
      </div>

      <div className="text-[11px] text-slate-400">{t("metalExtract.help")}</div>

      {propertyAccountCreateOpen ? (
        <NestedAddModal
          mode="compact"
          entityType="account"
          open
          onClose={() => setPropertyAccountCreateOpen(false)}
          title={t("metalExtract.createPropertyAccount")}
          defaultType="investment"
          defaultName={t("metalExtract.newAccountDefaultName")}
          notice={t("metalExtract.createPropertyAccountNotice")}
          nestedFieldData={nestedFieldData}
          hiddenFields={[
            "kind",
            "investProductType",
            "fixedAssetType",
            "fundUnitsDecimals",
            "tradingCalendar",
            "costBasisMethod",
          ]}
          extraFields={{ kind: "investment", investProductType: "property", fixedAssetType: "collectible" }}
          onCreated={(id, name, extra) => {
            const groupName = extra?.groupName?.trim() ?? "";
            const subLabel = [groupName, t("account.kind.investment")].filter(Boolean).join(" · ");
            const option: SmartSelectOption = {
              id,
              label: name,
              subLabel,
              title: formatAccountHoverTitle({ groupName, label: name, subLabel }),
              kind: "investment",
              investProductType: "property",
            };
            setCreatedPropertyAccounts((prev) => (prev.some((item) => item.id === id) ? prev : [...prev, option]));
            setPropertyAccountId(id);
            setPropertyAccountCreateOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
