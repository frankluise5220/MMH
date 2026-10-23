"use client";

import { accountOptionFromParts } from "@/lib/account-display";
import { DateStepper } from "@/components/DateStepper";
import { ClearableNoteField } from "@/components/ClearableNoteField";
import { SmartSelect } from "@/components/SmartSelect";
import { EntryAttachmentButton } from "@/components/EntryAttachmentPanel";
import { ModalLayer } from "@/components/ModalLayer";
import { NestedAddModal } from "@/components/EntityCreateForm";
import { kindLabel } from "@/lib/account-kinds";
import { recordRecentAccount, sortByAccountUsage } from "@/lib/client/recentAccounts";
import { useI18n } from "@/lib/i18n";
import type { HoldingEntryFormApi } from "@/lib/holding-entry/useHoldingEntryForm";
import type { HoldingEntryNestedFieldData } from "@/lib/holding-entry/types";

/**
 * 「持仓型记账」通用字段块：理财（WealthFormModal）与债券（BondFormModal）共用。
 *
 * 这些块此前在两个表单里各写一份、只差 i18n 文案键，改动必须同步两处。抽出来后
 * 两个表单只保留品种专属字段（理财产品期限、债券条款等），共享字段一律走这里。
 * 所有状态读写都通过 `useHoldingEntryForm()` 的返回值（`form`）进行，组件自身
 * 不持有记账状态。
 */

type FormProps = { form: HoldingEntryFormApi };

/**
 * 核销 / 赎回 / 分红（收息）页签的头部：记账日期 + 投资账户 + 品种（持仓）选择。
 * 选择持仓后统一重置「用户改过份额」标记，避免赎回到账后份额被旧值锁住。
 */
export function HoldingHoldingFields({
  form,
  accountLabel,
  accountPlaceholder,
  holdingLabel,
  holdingPlaceholder,
  noHoldingPlaceholder,
  holdingHint,
  showUnits = false,
  showAccount = false,
}: FormProps & {
  /** 投资账户一列的表头与占位（理财「理财账户 / 选择理财账户」，债券「债券账户 / 选择债券账户」）。 */
  accountLabel: string;
  accountPlaceholder: string;
  holdingLabel: string;
  holdingPlaceholder: string;
  noHoldingPlaceholder: string;
  holdingHint: string;
  /** 提示里是否显示当日份额（理财有份额，债券存单没有）。 */
  showUnits?: boolean;
  /** 提示里是否显示所属账户。 */
  showAccount?: boolean;
}) {
  const { t } = useI18n();
  const {
    date, changeTradeDate,
    toAccountId, setToAccountId, selectOptions, accountUsage,
    ownerFilterLabel, cycleOwnerFilter,
    selectedHoldingId, setSelectedHoldingId, holdingSelectOptions, selectedHolding,
    selectedHoldingAmountAtDate, selectedHoldingUnitsAtDate,
    unitsEditedRef, autoFilledUnitsForRef,
  } = form;

  const summary = selectedHolding
    ? [
        t("wealthForm.dayPrincipal", { amount: selectedHoldingAmountAtDate.toFixed(2) }),
        showUnits && selectedHolding.hasUnits
          ? t("wealthForm.dayUnits", { units: selectedHoldingUnitsAtDate.toFixed(6) })
          : "",
        showAccount ? selectedHolding.wealthAccountLabel ?? "" : "",
      ].filter(Boolean).join(" · ")
    : "";

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <div className="form-label">{t("detail.column.date")}</div>
          <DateStepper value={date} onChange={changeTradeDate} />
        </div>
        <div className="space-y-1">
          <div className="form-label">{accountLabel}</div>
          <SmartSelect
            mode="single"
            value={toAccountId}
            onChange={(id) => { setToAccountId(id); recordRecentAccount(id); }}
            options={sortByAccountUsage(selectOptions, accountUsage)}
            placeholder={accountPlaceholder}
            onCycleOwnerFilter={cycleOwnerFilter}
            ownerFilterLabel={ownerFilterLabel}
          />
        </div>
      </div>
      <div className="space-y-1">
        <div className="form-label">{holdingLabel}</div>
        <SmartSelect
          mode="single"
          value={selectedHoldingId}
          onChange={(id) => {
            unitsEditedRef.current = false;
            autoFilledUnitsForRef.current = null;
            setSelectedHoldingId(id);
          }}
          options={holdingSelectOptions}
          placeholder={holdingSelectOptions.length > 0 ? holdingPlaceholder : noHoldingPlaceholder}
          searchable
        />
        <div className="text-[11px] text-slate-400">{summary || holdingHint}</div>
      </div>
    </>
  );
}

/** 备注 + 附件：两种表单完全一致。 */
export function HoldingMemoField({
  memo,
  onMemoChange,
  editEntryId,
  pendingFiles,
  onPendingFilesChange,
}: {
  memo: string;
  onMemoChange: (value: string) => void;
  editEntryId: string | null;
  pendingFiles: File[];
  onPendingFilesChange: (files: File[]) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-1">
      <div className="form-label">{t("detail.column.remark")}</div>
      <div className="flex items-start gap-2">
        <ClearableNoteField
          wrapperClassName="flex-1"
          value={memo}
          onValueChange={onMemoChange}
          placeholder={t("stockFee.optional")}
          className="form-input"
        />
        <EntryAttachmentButton
          entryId={editEntryId}
          pendingFiles={pendingFiles}
          onPendingFilesChange={onPendingFilesChange}
        />
      </div>
    </div>
  );
}

/**
 * 「新增产品」内层窗口。母版是理财表单里那份：`ModalLayer` 必须 portal 到 body，
 * 否则会被记账窗口的遮罩压住（原因见 WealthFormModal 的注释）。
 */
export function HoldingProductModal({
  title,
  accountLabel,
  draft,
  onDraftChange,
  hint,
  error,
  saving,
  onClose,
  onSave,
}: {
  title: string;
  accountLabel: string;
  draft: { name: string; note: string };
  onDraftChange: (patch: { name?: string; note?: string }) => void;
  hint: string;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  return (
    <ModalLayer>
      <div className="app-modal-panel max-w-[min(30rem,calc(100vw-1rem))]">
        <div className="modal-header">
          <div>
            <div className="text-sm font-semibold text-slate-800">{title}</div>
            <div className="mt-0.5 text-xs text-slate-500">
              {accountLabel || t("txForm.alert.selectCashSourceAccount")}
            </div>
          </div>
          <button type="button" onClick={onClose} className="secondary-button h-8 px-2">
            {t("table.close")}
          </button>
        </div>
        <div className="space-y-3 p-3 sm:p-4">
          <div className="space-y-1">
            <div className="form-label">{t("wealthForm.productName")}</div>
            <input
              value={draft.name}
              onChange={(e) => onDraftChange({ name: e.target.value })}
              placeholder={t("wealthForm.productNamePlaceholder")}
              className="form-input"
              autoFocus
            />
          </div>
          <div className="rounded-[10px] border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-700">
            {hint}
          </div>
          {error ? (
            <div className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          ) : null}
          {/* 条款（利率/到期日/付息方式/首次付息日）不在产品弹窗填写：
              新建只登记名称，条款在购买界面按次填写并写入产品真源。 */}
          <div className="space-y-1">
            <div className="form-label">{t("detail.column.remark")}</div>
            <ClearableNoteField
              value={draft.note}
              onValueChange={(value) => onDraftChange({ note: value })}
              placeholder={t("stockFee.optional")}
              className="form-input"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="secondary-button h-9 px-4 text-sm"
              disabled={saving}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="primary-button h-9 px-4 text-sm disabled:opacity-50"
            >
              {saving ? t("txForm.saving") : t("wealthForm.saveAndSelect")}
            </button>
          </div>
        </div>
      </div>
    </ModalLayer>
  );
}

/**
 * 「新增资金账户 / 新增投资账户」内层窗口。两个品种只差实体类型标识与文案：
 * - 理财：`wealth-account` + `investProductType: "wealth"`
 * - 债券：`bond-account` + `investProductType: "bond"`
 */
export function HoldingAccountCreateModal({
  form,
  investmentEntityType,
  investProductType,
  title,
  nameLabel,
  accountLabelText,
  nestedFieldData,
}: FormProps & {
  investmentEntityType: string;
  investProductType: "wealth" | "bond";
  title: string;
  nameLabel: string;
  accountLabelText: string;
  /** 父级下发的账户分组/机构候选，用于新建账户表单的联动下拉。 */
  nestedFieldData?: HoldingEntryNestedFieldData;
}) {
  const { t } = useI18n();
  const {
    nestedEntityType, setNestedEntityType,
    localNestedFieldData, handleNestedOptionCreated,
    selectedCashAccount,
    setInvestmentAccountList, setLocalInvestSSOpts, setToAccountId,
    setCashAccountList, setLocalCashSSOpts, setCashAccountId,
  } = form;

  if (!nestedEntityType) return null;
  const isInvestAccount = nestedEntityType === investmentEntityType;

  return (
    <NestedAddModal
      mode="compact"
      entityType="account"
      open={true}
      onClose={() => setNestedEntityType(null)}
      onCreated={(id, name, extra) => {
        const kind = extra?.kind || "bank_debit";
        // 走统一入口：按「账户显示格式」渲染，不再手拼机构·名称。
        const display = accountOptionFromParts({
          id,
          name,
          kind,
          institutionName: extra?.institutionName,
          institutionShortName: extra?.institutionShortName,
          currency: extra?.currency,
          groupName: extra?.groupName,
        });
        const option = {
          id,
          label: display.label,
          subLabel: [
            extra?.groupName,
            isInvestAccount ? accountLabelText : kindLabel(kind),
          ].filter(Boolean).join(" · "),
          parentId: extra?.groupId ? `group:${extra.groupId}` : undefined,
          kind,
          groupId: extra?.groupId ?? null,
          institutionId: extra?.institutionId ?? null,
          institutionType: nestedFieldData?.institutionId?.find((item) => item.id === extra?.institutionId)?.type ?? null,
          currency: extra?.currency ?? "CNY",
          investProductType: isInvestAccount ? investProductType : null,
        };
        if (isInvestAccount) {
          setInvestmentAccountList((prev) => [...prev.filter((item) => item.id !== id), option]);
          setLocalInvestSSOpts((prev) => (prev ? [...prev.filter((item) => item.id !== id), option] : [option]));
          setToAccountId(id);
        } else {
          setCashAccountList((prev) => [...prev.filter((item) => item.id !== id), option]);
          setLocalCashSSOpts((prev) => (prev ? [...prev.filter((item) => item.id !== id), option] : [option]));
          setCashAccountId(id);
        }
        setNestedEntityType(null);
      }}
      title={isInvestAccount ? title : undefined}
      nameLabel={isInvestAccount ? nameLabel : undefined}
      namePlaceholder={isInvestAccount ? t("wealthForm.wealthAccountNamePlaceholder") : undefined}
      defaultType={isInvestAccount ? "investment" : "bank_debit"}
      extraFields={
        isInvestAccount && selectedCashAccount
          ? {
              kind: "investment",
              investProductType,
              ...(selectedCashAccount.groupId ? { groupId: selectedCashAccount.groupId } : {}),
              ...(selectedCashAccount.institutionId ? { institutionId: selectedCashAccount.institutionId } : {}),
              currency: selectedCashAccount.currency ?? "CNY",
            }
          : undefined
      }
      hiddenFields={isInvestAccount ? ["kind", "investProductType"] : undefined}
      readOnlyFields={isInvestAccount ? ["groupId", "institutionId", "currency"] : undefined}
      allowedAccountKinds={isInvestAccount ? undefined : ["bank_debit", "ewallet"]}
      nestedFieldData={localNestedFieldData ?? nestedFieldData}
      onNestedCreated={handleNestedOptionCreated}
    />
  );
}
