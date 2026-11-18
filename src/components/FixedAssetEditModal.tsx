"use client";

import { useEffect, useMemo, useState } from "react";
import { DateStepper } from "./DateStepper";
import { CalcInput } from "./CalcInput";
import { ClearableNoteField } from "./ClearableNoteField";
import { useI18n } from "@/lib/i18n";
/** 记账弹窗整窗外壳：宽度/标题栏/表单/卡片/固定页脚/高度锁定统一由它负责。 */
import { EntryModalShell } from "@/components/EntryModalShell";
import {
  FIXED_ASSET_ATTRIBUTE_FIELDS,
  FIXED_ASSET_TYPES,
  fixedAssetAttributeKeysToDrop,
  fixedAssetProductionDateLabelKey,
  fixedAssetSupportsWeight,
  type FixedAssetType,
} from "@/lib/fixed-asset";
import {
  DepreciationMethod,
  normalizeDepreciationMethod,
  resolveAssetDepreciation,
  type DepreciationMethod as DepreciationMethodValue,
} from "@/lib/fixed-asset-depreciation";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { formatMoney } from "@/lib/format";

type FixedAssetEditValue = {
  id: string;
  name: string;
  assetType: FixedAssetType;
  propertyType: string;
  address: string;
  attributes: Record<string, unknown>;
  purchaseDate: string;
  /** 生产日期（可空）：与购买日期并列的资产属性，不影响折旧。 */
  productionDate: string;
  /** 重量 + 单位（可空）：纯登记属性，不参与估值与折旧。 */
  weight: string;
  weightUnit: string;
  purchasePrice: string;
  /** 折旧方式：none = 累计折旧手填；straight_line = 按年限直线推算。 */
  depreciationMethod: DepreciationMethodValue;
  /** 折旧年限（年）：提交时 ×12 存成 usefulLifeMonths。 */
  usefulLifeYears: string;
  salvageValue: string;
  accumulatedDepreciation: string;
  note: string;
  status: string;
};

type FixedAssetEditMeta = {
  accountName?: string | null;
  marketValue?: number | null;
  cost?: number | null;
};

function typeLabel(t: (key: string) => string, assetType: FixedAssetType) {
  return t(`fixedAsset.type.${assetType}`);
}

export function FixedAssetEditModal({
  open,
  saving,
  value,
  meta,
  onClose,
  onChange,
  onSaved,
}: {
  open: boolean;
  saving: boolean;
  value: FixedAssetEditValue | null;
  meta: FixedAssetEditMeta | null;
  onClose: () => void;
  onChange?: (next: FixedAssetEditValue | null) => void;
  onSaved: (next: FixedAssetEditValue) => Promise<void>;
}) {
  const [draft, setDraft] = useState<FixedAssetEditValue | null>(value);
  const { t } = useI18n();

  useEffect(() => {
    setDraft(value);
  }, [value]);

  // 折旧预览：与 API 结算、处置弹窗共用同一套口径（src/lib/fixed-asset-depreciation.ts），
  // 这里按「今天」推算给用户看累计折旧和账面净值，保存后服务端照同一口径落库。
  const depreciationPreview = useMemo(() => {
    if (!draft) return null;
    const years = Number(draft.usefulLifeYears);
    return resolveAssetDepreciation({
      cost: meta?.cost ?? 0,
      purchaseDate: draft.purchaseDate,
      status: draft.status,
      depreciationMethod: draft.depreciationMethod,
      usefulLifeMonths: Number.isFinite(years) && years > 0 ? Math.round(years * 12) : null,
      salvageValue: draft.salvageValue,
      accumulatedDepreciation: draft.accumulatedDepreciation,
    }, todayDateLocalYmd());
  }, [draft, meta?.cost]);

  if (!open || !draft || !meta) return null;

  const current = draft;

  function patch(next: Partial<FixedAssetEditValue>) {
    const merged = { ...current, ...next };
    setDraft(merged);
    onChange?.(merged);
  }

  function updateAttributes(key: string, value: string) {
    const next = { ...current, attributes: { ...current.attributes, [key]: value } };
    setDraft(next);
    onChange?.(next);
  }

  function attributeValue(key: string) {
    const raw = current.attributes?.[key];
    return raw == null ? "" : String(raw);
  }

  /* 切类型时把新类型用不到的登记值一并清掉（房产类型/地址、车牌号、品牌型号、重量…），
     否则它们只是被藏起来，保存后仍会留在库里，下次换回旧类型又冒出来。 */
  function switchAssetType(nextType: FixedAssetType) {
    const attributes = { ...(current.attributes ?? {}) };
    for (const key of fixedAssetAttributeKeysToDrop(current.assetType, nextType)) {
      delete attributes[key];
    }
    const keepsWeight = fixedAssetSupportsWeight(nextType);
    patch({
      assetType: nextType,
      attributes,
      propertyType: nextType === "property" ? current.propertyType : "",
      address: nextType === "property" ? current.address : "",
      weight: keepsWeight ? current.weight : "",
      weightUnit: keepsWeight ? current.weightUnit : "kg",
    });
  }

  return (
    /* 整窗外壳见 `EntryModalShell`（无页签：资产类型切换在表单内，内容长短变化由高度锁定吸收）；
       该弹窗原本就地渲染，故 `portal={false}` 保持挂载点不变。 */
    <EntryModalShell
      open={open}
      heightKey="fixed-asset-edit"
      width="md"
      title={t("fixedAssetEdit.editTitle")}
      onClose={onClose}
      portal={false}
      onSubmit={(event) => {
        event.preventDefault();
        void onSaved(draft);
      }}
      footer={(
        <>
          <button type="button" onClick={onClose} className="secondary-button h-9 px-4">
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="primary-button h-9 px-4 text-white disabled:opacity-50"
          >
            {saving ? t("fixedAssetEdit.saving") : t("common.save")}
          </button>
        </>
      )}
    >

            <div className="rounded-lg bg-slate-50/70 px-3 py-2 text-[11px] leading-5 text-slate-500">
              {[
                meta.accountName ? t("fixedAssetEdit.accountLine", { name: meta.accountName }) : "",
                meta.marketValue != null ? t("fixedAssetEdit.marketValueLine", { value: String(meta.marketValue) }) : "",
                meta.cost != null ? t("fixedAssetEdit.costLine", { value: String(meta.cost) }) : "",
              ]
                .filter(Boolean)
                .join("  ")}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="form-label">{t("propertyForm.propertyName")}</div>
                <input
                  value={draft.name}
                  onChange={(event) => {
                    const next = { ...draft, name: event.target.value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                  placeholder={t("propertyForm.namePlaceholder")}
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("fixedAssetEdit.assetType")}</div>
                <select
                  value={draft.assetType}
                  onChange={(event) => switchAssetType(event.target.value as FixedAssetType)}
                  className="form-input"
                >
                  {FIXED_ASSET_TYPES.map((assetType) => (
                    <option key={assetType} value={assetType}>
                      {typeLabel(t, assetType)}
                    </option>
                  ))}
                </select>
              </div>

              {draft.assetType === "property" ? (
                <>
                  <div className="space-y-1">
                    <div className="form-label">{t("fixedAssetEdit.attr.propertyType")}</div>
                    <input
                      value={draft.propertyType}
                      onChange={(event) => {
                        const next = { ...draft, propertyType: event.target.value };
                        setDraft(next);
                        onChange?.(next);
                      }}
                      className="form-input"
                      placeholder={t("fixedAssetEdit.attr.propertyTypePlaceholder")}
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("propertyForm.address")}</div>
                    <input
                      value={draft.address}
                      onChange={(event) => {
                        const next = { ...draft, address: event.target.value };
                        setDraft(next);
                        onChange?.(next);
                      }}
                      className="form-input"
                    />
                  </div>
                </>
              ) : null}

              {/* 类型专属登记属性（车辆＝车牌号/品牌型号、设备家具＝品牌/型号、收藏品＝类别/来源），
                  清单见 `FIXED_ASSET_ATTRIBUTE_FIELDS`，房产用上面的独立列。 */}
              {FIXED_ASSET_ATTRIBUTE_FIELDS[draft.assetType].map((field) => (
                <div className="space-y-1" key={field.key}>
                  <div className="form-label">{t(field.labelKey)}</div>
                  <input
                    value={attributeValue(field.key)}
                    onChange={(event) => updateAttributes(field.key, event.target.value)}
                    className="form-input"
                  />
                </div>
              ))}

              <div className="space-y-1">
                <div className="form-label">{t("fixedAssetEdit.purchaseDate")}</div>
                <DateStepper
                  value={draft.purchaseDate}
                  onChange={(value) => {
                    const next = { ...draft, purchaseDate: value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("fixedAssetEdit.purchasePrice")}</div>
                <CalcInput
                  value={draft.purchasePrice}
                  onChange={(value) => {
                    const next = { ...draft, purchasePrice: value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  label={t("fixedAssetEdit.purchasePrice")}
                  placeholder={t("fixedAssetEdit.purchasePricePlaceholder")}
                  precision={2}
                />
              </div>
              <div className="space-y-1">
                {/* 房子叫「建成年份」、车叫「出厂日期」，同一个 productionDate 列按类型换叫法。 */}
                <div className="form-label">{t(fixedAssetProductionDateLabelKey(draft.assetType))}</div>
                <DateStepper
                  value={draft.productionDate}
                  onChange={(value) => patch({ productionDate: value })}
                  className="form-input"
                />
              </div>
              {/* 重量只给按量计价的资产（设备 / 家具 / 收藏品）；房产、车辆不登记重量。 */}
              {fixedAssetSupportsWeight(draft.assetType) ? (
                <div className="space-y-1">
                  <div className="form-label">{t("fixedAssetEdit.weight")}</div>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <CalcInput
                        value={draft.weight}
                        onChange={(value) => patch({ weight: value })}
                        label={t("fixedAssetEdit.weight")}
                        placeholder={t("stockFee.optional")}
                        precision={3}
                      />
                    </div>
                    <select
                      value={draft.weightUnit}
                      onChange={(event) => patch({ weightUnit: event.target.value })}
                      className="form-input w-20 shrink-0"
                    >
                      <option value="kg">{t("fixedAssetEdit.weightUnit.kg")}</option>
                      <option value="t">{t("fixedAssetEdit.weightUnit.t")}</option>
                      <option value="g">{t("fixedAssetEdit.weightUnit.g")}</option>
                    </select>
                  </div>
                </div>
              ) : null}

              {/* 折旧：处置/出售时按账面净值算损益，折损掉的这部分才不会被当成全额损失。 */}
              <div className="col-span-2 space-y-1 border-t border-slate-100 pt-3">
                <div className="form-label">{t("fixedAssetEdit.depreciationSection")}</div>
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("fixedAssetEdit.depreciationMethodLabel")}</div>
                <select
                  value={draft.depreciationMethod}
                  onChange={(event) => patch({ depreciationMethod: normalizeDepreciationMethod(event.target.value) })}
                  className="form-input"
                >
                  <option value={DepreciationMethod.none}>{t("fixedAssetEdit.depreciationMethod.none")}</option>
                  <option value={DepreciationMethod.straightLine}>{t("fixedAssetEdit.depreciationMethod.straight_line")}</option>
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("fixedAssetEdit.usefulLifeYears")}</div>
                <CalcInput
                  value={draft.usefulLifeYears}
                  onChange={(value) => patch({ usefulLifeYears: value })}
                  label={t("fixedAssetEdit.usefulLifeYears")}
                  placeholder={t("stockFee.optional")}
                  precision={1}
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("fixedAssetEdit.salvageValue")}</div>
                <CalcInput
                  value={draft.salvageValue}
                  onChange={(value) => patch({ salvageValue: value })}
                  label={t("fixedAssetEdit.salvageValue")}
                  placeholder={t("stockFee.optional")}
                  precision={2}
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">
                  {draft.depreciationMethod === DepreciationMethod.straightLine
                    ? t("fixedAssetEdit.extraDepreciation")
                    : t("fixedAssetEdit.accumulatedDepreciation")}
                </div>
                <CalcInput
                  value={draft.accumulatedDepreciation}
                  onChange={(value) => patch({ accumulatedDepreciation: value })}
                  label={t("fixedAssetEdit.accumulatedDepreciation")}
                  placeholder={t("stockFee.optional")}
                  precision={2}
                />
              </div>
              {depreciationPreview ? (
                <div className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-slate-50/70 px-3 py-2 text-[11px] leading-5 text-slate-500">
                  <span>
                    {t("fixedAssetEdit.monthlyDepreciation")}
                    <span className="ml-1 font-medium tabular-nums text-slate-700">{formatMoney(depreciationPreview.monthly)}</span>
                  </span>
                  <span>
                    {t("fixedAssetEdit.accumulatedDepreciation")}
                    <span className="ml-1 font-medium tabular-nums text-slate-700">{formatMoney(depreciationPreview.accumulated)}</span>
                  </span>
                  <span>
                    {t("fixedAssetEdit.netBookValue")}
                    <span className="ml-1 font-medium tabular-nums text-slate-700">{formatMoney(depreciationPreview.netBookValue)}</span>
                  </span>
                </div>
              ) : null}

              <div className="col-span-2 space-y-1">
                <div className="form-label">{t("fixedAssetEdit.note")}</div>
                <ClearableNoteField
                  multiline
                  rows={3}
                  value={draft.note}
                  onValueChange={(value) => {
                    const next = { ...draft, note: value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input resize-none py-2"
                  placeholder={t("stockFee.optional")}
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="flex cursor-pointer select-none items-start gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={draft.status === "mortgaged"}
                  onChange={(event) => {
                    const next = { ...draft, status: event.target.checked ? "mortgaged" : "active" };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="mt-0.5 h-3.5 w-3.5 accent-indigo-600"
                />
                <span>{t("fixedAssetEdit.status.mortgaged")}</span>
              </label>
            </div>
    </EntryModalShell>
  );
}

export type { FixedAssetEditMeta, FixedAssetEditValue };