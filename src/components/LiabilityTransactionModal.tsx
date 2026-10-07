"use client";

import { ArrowLeftRight, ArrowRight, CheckCircle2, ChevronDown, Info, Plus, RefreshCw, Repeat } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { CalcInput } from "./CalcInput";
import { ClearableNoteField } from "./ClearableNoteField";
import { DateStepper } from "./DateStepper";
import { EntryTagsField } from "./EntryTagsField";
import { EntityCreateForm } from "./EntityCreateForm";
import { ModalLayerProvider, getNextModalLayerZIndex, useModalLayerZIndex } from "./ModalLayer";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { buildCategoryTreeOptions, type CategorySource } from "./categorySmartSelect";
import { institutionTypeLabel, isSettlementCounterpartyType, isInstitutionTypeOf, LOAN_DIALOG_INSTITUTION_TYPE_VALUES } from "@/lib/account-kinds";
import { buildAccountDisplayOption, formatAccountHoverTitle } from "@/lib/account-display";
import { recordRecentAccount, sortByAccountUsage, useAccountUsage } from "@/lib/client/recentAccounts";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { formatDateLocal as formatDateInput, parseDateInputToUtc as dateInputToUtcDate } from "@/lib/date-utils";
import {
  fetchSettingsAccountData,
  SETTINGS_DATA_CHANGED_EVENT,
  type SettingsDataChangedDetail,
} from "@/lib/client/settingsCache";
import {
  buildMortgageLprRateAdjustments,
  calcMortgageAnnualRateFromLprDiscount,
  getLatestFiveYearLpr,
  getMortgageBankExecutionRate,
} from "@/lib/loan-lpr";
import {
  EQUAL_PAYMENT_REPAYMENT_METHOD,
  EQUAL_PRINCIPAL_REPAYMENT_METHOD,
  FREE_REPAYMENT_METHOD,
  INSTALLMENT_REPAYMENT_METHOD,
  INTEREST_FIRST_REPAYMENT_METHOD,
  allowsZeroAnnualRateRepaymentMethod,
  buildLoanRepaymentSchedulePreview,
  getEffectiveLoanAnnualRate,
  isInstallmentRepaymentMethod,
  normalizeLoanRateAdjustments,
  normalizeLoanRepaymentMethod,
  type LoanRateAdjustment,
} from "@/lib/loan-repayment";
import { formatLoanRecalculateSuccessMessage } from "@/lib/loan-repayment-recalculate-result";
import { DEFAULT_LOAN_PREPAY_STRATEGY, type LoanPrepayStrategy } from "@/lib/loan-prepay-strategy";
import { isHomeLoanType, LOAN_TYPES, resolveLoanTypeValue, type LoanTypeValue } from "@/lib/loan-type";
import { allowsLiabilityInterest, swapLiabilityFlowDirection } from "@/lib/liability";
import {
  decodeScheduledTaskMemo,
  getLoanScheduledPlanRole,
  shouldPreferLoanAutoDebitPlan,
  shouldPreferLoanScheduledPlan,
} from "@/lib/scheduled-task";
import { useI18n } from "@/lib/i18n";
import { getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";
import { restrictAccountsByType } from "@/lib/client/account-dropdown-filter";

type LiabilityMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";
type PrepayStrategy = LoanPrepayStrategy;
type LoanFundingMode = "cash_disbursement" | "financed_purchase";
type LoanTab = LoanTypeValue | "repay_out";
type CategoryOption = {
  id: string;
  label: string;
  name?: string;
  parentId: string | null;
  type: string;
  sortOrder?: number;
  isSystem?: boolean;
};

type AccountOption = {
  id: string;
  label: string;
  subLabel?: string;
  kind?: string | null;
  institutionId?: string | null;
  counterpartyId?: string | null;
  institutionType?: string | null;
  isInstitutionLoan?: boolean;
  isConsumerLoan?: boolean;
  loanType?: LoanTypeValue | null;
  liabilityDirection?: "payable" | "receivable" | null;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;
type SettingsAccountRecord = {
  id: string;
  name: string;
  kind?: string | null;
  isActive?: boolean | null;
  isPlaceholder?: boolean | null;
  institutionId?: string | null;
  counterpartyId?: string | null;
  liabilityDirection?: "payable" | "receivable" | null;
  Institution?: { name: string | null; shortName?: string | null; type?: string | null } | null;
  Counterparty?: { name: string | null; shortName?: string | null; type?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
  isConsumerLoan?: boolean | null;
  loanType?: string | null;
};
type HistoricalRateRow = { key: string; effectiveDate: string; annualRate: string };
type RepaymentLprCheck = {
  mortgageLprDiscount: number | null;
  currentAnnualRate: number | null;
  loanRateAdjustments: LoanRateAdjustment[];
};
type RepayableLoanAccountRow = {
  accountId: string;
  balance: number;
  currentPlanId?: string | null;
  currentDueDate?: string | null;
  currentPrincipal?: number | null;
  currentInterest?: number | null;
  currentPayment?: number | null;
  currentPaidAmount?: number | null;
  currentUnpaidPeriod?: number | null;
  currentPeriodPaid?: boolean;
  /** 该贷款的还款账户（自动扣款计划的资金账户），用于表单预填。 */
  repaymentAccountId?: string | null;
  // 消费贷提前还款应计利息预览（服务端按借款日至还款日按日计息）
  prepayInterest?: number | null;
  prepayInterestFromDate?: string | null;
  prepayInterestDays?: number | null;
  prepayAnnualRate?: number | null;
};
type FixedAssetAssetOption = {
  id: string;
  accountId: string;
  mortgageLoanAccountId?: string | null;
  name: string;
  status?: string | null;
  /** 固定资产类型（property=房产）。房贷只允许关联房产型。 */
  assetType?: string | null;
};
type FixedAssetLinkedTransaction = {
  accountId: string;
  propertyAssetId: string;
};


const MODE_LABELS: Record<LiabilityMode, string> = {
  borrow_in: "liabilityTx.mode.borrowIn",
  repay_out: "liabilityShell.repayment",
  prepay_out: "liabilityShell.prepayment",
  lend_out: "liabilityTx.mode.lendOut",
  collect_in: "liabilityTx.mode.collectIn",
};

const PREPAY_STRATEGY_LABELS: Record<PrepayStrategy, string> = {
  reduce_term: "liabilityTx.prepayStrategy.reduceTerm",
  reduce_payment: "liabilityTx.prepayStrategy.reducePayment",
  settle: "liabilityTx.prepayStrategy.settle",
};

const FIXED_REPAYMENT_METHODS = new Set(["等额本息", "等额本金", INSTALLMENT_REPAYMENT_METHOD, "先还利息一次性还本"]);

function isFixedRepaymentMethodValue(method: string) {
  return FIXED_REPAYMENT_METHODS.has(normalizeLoanRepaymentMethod(method));
}

function addMonthsInput(dateInput: string, months: number) {
  const date = new Date(`${dateInput}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return dateInput;
  date.setMonth(date.getMonth() + months);
  return formatDateInput(date);
}

function dateInputTime(value: string) {
  const time = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(time) ? time : null;
}

function shouldPromptHistoricalRepayments(params: {
  mode: LiabilityMode;
  isFixedRepaymentMethod: boolean;
  firstRepaymentDate: string;
  today: string;
  repaymentIntervalMonths: string;
}) {
  if (params.mode !== "borrow_in" || !params.isFixedRepaymentMethod || !params.firstRepaymentDate) return false;
  const intervalMonths = Math.max(1, Number(params.repaymentIntervalMonths) || 1);
  const thresholdTime = dateInputTime(addMonthsInput(params.today, -intervalMonths));
  const firstTime = dateInputTime(params.firstRepaymentDate);
  return firstTime != null && thresholdTime != null && firstTime <= thresholdTime;
}

function parseNumberText(value: string) {
  const text = value.replace(/,/g, "").trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function parsePositiveNumberText(value: string) {
  const num = parseNumberText(value);
  return num != null && num > 0 ? num : null;
}

function parseNonNegativeNumberText(value: string) {
  const num = parseNumberText(value);
  return num != null && num >= 0 ? num : null;
}

function parseMoneyText(value: string) {
  const num = Number(value.replace(/,/g, ""));
  return Number.isFinite(num) ? num : 0;
}

function parseAbsMoneyText(value: string) {
  return Math.abs(parseMoneyText(value));
}

function roundMoneyValue(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatMoneyPreview(value: number, language: string) {
  return value.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isValidDateInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
function createHistoricalRateRow(defaultDate = "", defaultRate = ""): HistoricalRateRow {
  return {
    key: `rate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    effectiveDate: defaultDate,
    annualRate: defaultRate,
  };
}

function liabilityObjectOptionId(id: string, type?: string | null) {
  return `${isSettlementCounterpartyType(type) ? "counterparty" : "institution"}:${id}`;
}

function isLiabilityObjectRef(value: string) {
  return /^(?:counterparty|institution):/.test(value);
}

function canCreateLiabilityItemForMode(mode: LiabilityMode) {
  return mode === "borrow_in" || mode === "lend_out";
}

function rawLiabilityObjectId(value: string) {
  const match = /^(?:counterparty|institution):(.+)$/.exec(value);
  return match?.[1] ?? value;
}

function liabilityDirectionForMode(mode: LiabilityMode): "payable" | "receivable" {
  return mode === "borrow_in" || mode === "repay_out" || mode === "prepay_out" ? "payable" : "receivable";
}

function canSwitchLiabilityEditMode(currentMode: LiabilityMode, nextMode: LiabilityMode) {
  if (currentMode === nextMode) return true;
  return canCreateLiabilityItemForMode(currentMode) && canCreateLiabilityItemForMode(nextMode);
}

function accountOptionLoanType(account: Pick<AccountOption, "kind" | "isInstitutionLoan" | "isConsumerLoan" | "loanType">): LoanTypeValue | null {
  if (account.kind !== "loan" && account.isInstitutionLoan !== true) return null;
  return resolveLoanTypeValue(account.loanType, account.isConsumerLoan);
}

function accountMatchesLoanType(account: AccountOption, loanType: LoanTypeValue) {
  return accountOptionLoanType(account) === loanType;
}

function settingsAccountToLiabilityOption(account: SettingsAccountRecord, t: (key: string, params?: Record<string, string | number>) => string): AccountOption {
  const display = buildAccountDisplayOption(account as Parameters<typeof buildAccountDisplayOption>[0], undefined, { fields: getAccountLabelFieldsPreference() });
  const counterpartyName = account.Counterparty?.shortName?.trim() || account.Counterparty?.name?.trim() || "";
  const institutionType = account.Institution?.type ?? null;
  const isInstitutionLoan = Boolean(account.kind === "loan" && !account.counterpartyId);
  // 口径（2026-09-13）：挂在往来对象上的贷款账户不再显示「往来款」。
  const isCounterpartyLoan = account.kind === "loan" && !!account.counterpartyId;
  return {
    id: account.id,
    label: display.selectorLabel || display.label,
    subLabel: isCounterpartyLoan
      ? (counterpartyName ? t("liabilityTx.subLabel.counterpartyLoan", { name: counterpartyName }) : display.subLabel)
      : counterpartyName ? t("liabilityTx.subLabel.settlement", { name: counterpartyName }) : display.subLabel,
    kind: account.kind ?? null,
    institutionId: account.institutionId ?? null,
    counterpartyId: account.counterpartyId ?? null,
    institutionType,
    isInstitutionLoan,
    isConsumerLoan: account.isConsumerLoan === true,
    loanType: isInstitutionLoan ? resolveLoanTypeValue(account.loanType, account.isConsumerLoan) : null,
    liabilityDirection: account.liabilityDirection ?? null,
  };
}

function normalizeLiabilityObjectValue(value: string | undefined, data?: NestedFieldData) {
  const id = String(value ?? "").trim();
  if (!id || isLiabilityObjectRef(id)) return id;
  if ((data?.counterpartyId ?? []).some((entry) => entry.id === id)) return `counterparty:${id}`;
  const item = (data?.institutionId ?? []).find((entry) => entry.id === id);
  return item ? liabilityObjectOptionId(item.id, item.type) : id;
}

function serializeHistoricalRateRows(rows: HistoricalRateRow[], t: (key: string, params?: Record<string, string | number>) => string) {
  const filledRows = rows.filter((row) => row.effectiveDate.trim() || row.annualRate.trim());
  if (filledRows.length === 0) {
    return { ok: false as const, error: t("liabilityTx.historicalRate.minOne") };
  }

  const seenDates = new Set<string>();
  const normalized = filledRows.map((row) => {
    const effectiveDate = row.effectiveDate.trim();
    const annualRate = Number(row.annualRate.trim());
    if (!isValidDateInput(effectiveDate)) {
      return { ok: false as const, error: t("liabilityTx.historicalRate.invalidDate") };
    }
    if (seenDates.has(effectiveDate)) {
      return { ok: false as const, error: t("liabilityTx.historicalRate.duplicateDate", { date: effectiveDate }) };
    }
    seenDates.add(effectiveDate);
    if (!Number.isFinite(annualRate) || annualRate < 0) {
      return { ok: false as const, error: t("liabilityTx.historicalRate.mustBePositive") };
    }
    return { ok: true as const, effectiveDate, annualRate };
  });
  const invalid = normalized.find((row) => !row.ok);
  if (invalid && !invalid.ok) return invalid;

  const text = normalized
    .filter((row): row is { ok: true; effectiveDate: string; annualRate: number } => row.ok)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
    .map((row) => `${row.effectiveDate} ${row.annualRate}`)
    .join("\n");

  return { ok: true as const, text };
}

function FixedAssetCreateDialog({
  open,
  onClose,
  accountOptions,
  accountValue,
  onAccountChange,
  onAccountCreateClick,
  accountCreateForm,
  name,
  onNameChange,
  purchaseDate,
  onPurchaseDateChange,
  amount,
  onAmountChange,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  accountOptions: SmartSelectOption[];
  accountValue: string;
  onAccountChange: (id: string) => void;
  onAccountCreateClick: () => void;
  accountCreateForm?: ReactNode;
  name: string;
  onNameChange: (value: string) => void;
  purchaseDate: string;
  onPurchaseDateChange: (value: string) => void;
  amount: string;
  onAmountChange: (value: string) => void;
  submitting: boolean;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  const parentModalZIndex = useModalLayerZIndex();
  const modalZIndex = getNextModalLayerZIndex(parentModalZIndex);
  if (!open) return null;
  return (
    <ModalLayerProvider value={modalZIndex}>
      {createPortal(
        <div className="app-modal-backdrop" style={{ zIndex: modalZIndex }}>
          <div className="app-modal-panel max-w-md">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">{t("txForm.createFixedAsset")}</div>
              <button
                type="button"
                onClick={onClose}
                className="secondary-button h-8 px-2"
                disabled={submitting}
              >
                {t("table.close")}
              </button>
            </div>
            <form
              className="space-y-3 p-4"
              onSubmit={(event) => {
                event.preventDefault();
                onSubmit();
              }}
            >
              <div className="space-y-1">
                <div className="form-label">{t("txForm.fixedAssetAccount")}</div>
                <SmartSelect
                  mode="single"
                  value={accountValue}
                  onChange={onAccountChange}
                  options={accountOptions}
                  placeholder={t("txForm.selectFixedAssetAccount")}
                  onCreateClick={onAccountCreateClick}
                  createLabel={t("txForm.createFixedAssetAccount")}
                  behavior={{
                    hierarchy: "auto",
                    search: "auto",
                    clearable: false,
                    minDropdownWidth: 360,
                  }}
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">
                  {t("txForm.fixedAssetName")} <span className="text-slate-400">{t("stockFee.optional")}</span>
                </div>
                <input
                  type="text"
                  value={name}
                  onChange={(event) => onNameChange(event.target.value)}
                  placeholder={t("stockFee.optional")}
                  className="form-input rounded-[8px] px-2 text-xs"
                  style={{ height: 32, minHeight: 32 }}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <div className="form-label">{t("txForm.fixedAssetPurchaseDate")}</div>
                  <DateStepper value={purchaseDate} onChange={onPurchaseDateChange} />
                </div>
                <div className="space-y-1">
                  <div className="form-label">
                    {t("txForm.fixedAssetPurchaseAmount")} <span className="text-slate-400">{t("stockFee.optional")}</span>
                  </div>
                  <CalcInput
                    value={amount}
                    onChange={onAmountChange}
                    placeholder={t("liabilityTx.placeholder.exampleAmount")}
                    label={t("txForm.fixedAssetPurchaseAmount")}
                    precision={2}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="secondary-button h-9 px-3"
                  disabled={submitting}
                  onClick={onClose}
                >
                  {t("common.cancel")}
                </button>
                <button type="submit" className="primary-button h-9 px-3" disabled={submitting}>
                  {submitting ? t("txForm.saving") : t("txForm.createFixedAsset")}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body,
      )}
      {accountCreateForm}
    </ModalLayerProvider>
  );
}

export function LiabilityTransactionModal({
  dialogType = "settlement",
  liabilityAccounts,
  cashAccounts,
  liabilityObjectOptions,
  cashAccountSSOptions,
  nestedFieldData,
  expenseCategories,
  fixedAssetAccounts,
  fixedAssetAccountSSOptions,
  defaultLiabilityAccountId,
  defaultLiabilityInstitutionId,
  defaultCashAccountId,
  action,
  showTriggerButton = true,
  triggerLabel,
}: {
  dialogType?: "settlement" | "loan";
  liabilityAccounts: AccountOption[];
  cashAccounts: AccountOption[];
  liabilityObjectOptions?: SmartSelectOption[];
  cashAccountSSOptions?: SmartSelectOption[];
  nestedFieldData?: NestedFieldData;
  expenseCategories?: CategoryOption[];
  fixedAssetAccounts?: SmartSelectOption[];
  fixedAssetAccountSSOptions?: SmartSelectOption[];
  defaultLiabilityAccountId?: string;
  defaultLiabilityInstitutionId?: string;
  defaultCashAccountId?: string;
  action: (formData: FormData) => Promise<
    | { ok: true; warning?: string; recalculateAfterSave?: { accountId: string; startDate: string } | null }
    | { ok: false; error: string }
  >;
  showTriggerButton?: boolean;
  triggerLabel?: string;
}) {
  const isLoanDialog = dialogType === "loan";
  const today = useMemo(() => formatDateInput(new Date()), []);
  const { t, language } = useI18n();
  const parentModalZIndex = useModalLayerZIndex();
  const modalZIndex = getNextModalLayerZIndex(parentModalZIndex);
  const confirmModalZIndex = getNextModalLayerZIndex(modalZIndex);
  const rateModalZIndex = getNextModalLayerZIndex(confirmModalZIndex);
  const [localLiabilityAccounts, setLocalLiabilityAccounts] = useState(liabilityAccounts);
  const [localLiabilityObjectOptions, setLocalLiabilityObjectOptions] = useState(liabilityObjectOptions);
  const [localNestedFieldData, setLocalNestedFieldData] = useState<NestedFieldData | undefined>(nestedFieldData);
  const [liabilityObjectNestedOpen, setLiabilityObjectNestedOpen] = useState(false);
  const fallbackLiabilityObjectOptions: SmartSelectOption[] = useMemo(() => {
    const counterpartyOptions = isLoanDialog ? [] : (localNestedFieldData?.counterpartyId ?? []).map((item) => ({
      id: `counterparty:${item.id}`,
      label: item.name,
      subLabel: institutionTypeLabel(item.type, t),
    }));
    const institutionOptions = isLoanDialog
      ? (localNestedFieldData?.institutionId ?? [])
          .filter((item) => isInstitutionTypeOf(item.type, LOAN_DIALOG_INSTITUTION_TYPE_VALUES))
          .map((item) => ({
            id: `institution:${item.id}`,
            label: item.name,
            subLabel: institutionTypeLabel(item.type ?? null, t),
          }))
      : [];

    return [
      ...(counterpartyOptions.length > 0
        ? [{ id: "counterparty-header", label: t("txForm.counterparty"), isHeader: true }, ...counterpartyOptions]
        : []),
      ...(institutionOptions.length > 0
        ? [{ id: "institution-source-header", label: t("liabilityTx.loanInstitutionHeader"), isHeader: true }, ...institutionOptions]
        : []),
    ];
  }, [isLoanDialog, localNestedFieldData, t]);
  const visibleLiabilityObjectOptions = useMemo(
    () => mergeSmartSelectOptions(
      mergeSmartSelectOptions(liabilityObjectOptions, localLiabilityObjectOptions),
      fallbackLiabilityObjectOptions,
    ),
    [liabilityObjectOptions, fallbackLiabilityObjectOptions, localLiabilityObjectOptions],
  );
  // 资金账户下拉里新增的账户（本地追加，供当前弹窗立刻可选）
  const [cashAccountNestedOpen, setCashAccountNestedOpen] = useState(false);
  const [localCashAccountList, setLocalCashAccountList] = useState<SmartSelectOption[]>([]);
  const cashOptions: SmartSelectOption[] = useMemo(
    () => cashAccounts.map((item) => ({ id: item.id, label: item.label, subLabel: item.subLabel, kind: item.kind })),
    [cashAccounts],
  );
  const {
    ownerFilterLabel: cashOwnerFilterLabel,
    cycleOwnerFilter: cycleCashOwnerFilter,
    filteredOptions: cashAccountSSFiltered,
  } = useAccountSSFilter(cashAccountSSOptions);
  const accountUsage = useAccountUsage();
  const visibleCashOptions = sortByAccountUsage(
    [...(cashAccountSSFiltered ?? cashAccountSSOptions ?? cashOptions), ...localCashAccountList],
    accountUsage,
  );
  const cashOwnerCycleButton = cashAccountSSOptions?.some((option) => option.isHeader) ? (
    <button
      type="button"
      onClick={cycleCashOwnerFilter}
      title={t("liabilityTx.ownerFilterTitle", { label: cashOwnerFilterLabel })}
      aria-label={t("liabilityTx.ownerFilterAria", { label: cashOwnerFilterLabel })}
      className="secondary-button !px-0 h-7 w-7 shrink-0 text-slate-500"
    >
      <Repeat className="h-3.5 w-3.5" />
    </button>
  ) : undefined;

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState("");
  // True when the open/edit event already carried repayment-plan defaults
  // (liability-side edit); the plan fetch prefill then stays off.
  const planDefaultsFromEventRef = useRef(false);
  // 结清自动填剩余本金：用户在结清态下手改本金后置 true，自动填入停手；
  // 重新选择策略时复位。
  const settlePrincipalManualRef = useRef(false);
  // 还款日自动带出：用户手改日期后置 true，期次预定还款日不再覆盖。
  const scheduledDateManualRef = useRef(false);
  // 还款表自动带出（日期/本金/利息/还款账户）：每次打开弹窗只自动带出一次，
  // 之后以用户输入为准，避免数据刷新时覆盖用户已修改的内容。
  const scheduledDraftAutoAppliedRef = useRef(false);
  // 可还贷款列表是否已有一次请求落地：打开弹窗的首帧 rows 还没回来，
  // 若此时执行"账户不在列表即清空"会把预选账户误清（清空竞态，2026-09-14 实证）。
  const repayableFetchSettledRef = useRef(false);
  const [liabilityAccountNestedOpen, setLiabilityAccountNestedOpen] = useState(false);
  const [mode, setMode] = useState<LiabilityMode>("borrow_in");
  const [loanFundingMode, setLoanFundingMode] = useState<LoanFundingMode>("cash_disbursement");
  const [loanType, setLoanType] = useState<LoanTypeValue | null>(null);
  const [date, setDate] = useState(today);
  const [liabilityAccountId, setLiabilityAccountId] = useState(defaultLiabilityAccountId ?? liabilityAccounts[0]?.id ?? "");
  const [liabilityInstitutionId, setLiabilityInstitutionId] = useState(normalizeLiabilityObjectValue(defaultLiabilityInstitutionId, nestedFieldData));
  const [liabilityItemName, setLiabilityItemName] = useState("");
  const [cashAccountId, setCashAccountId] = useState(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
  const [autoDebitCashAccountId, setAutoDebitCashAccountId] = useState(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
  const [principal, setPrincipal] = useState("");
  const [originalPrincipalForEdit, setOriginalPrincipalForEdit] = useState("");
  const [editRecalculateStartDate, setEditRecalculateStartDate] = useState("");
  const [interest, setInterest] = useState("");
  const [penalty, setPenalty] = useState("");
  const [prepayTotal, setPrepayTotal] = useState("");
  const [prepayTotalManual, setPrepayTotalManual] = useState(false);
  // 往来款单界面：本金 / 利息 / 入账总金额三者互推，最后编辑的为准。
  // 总额 = 本金 + 利息；直接改总额时反推本金（利息保持不变）。
  const [flowTotalManual, setFlowTotalManual] = useState(false);
  const [flowTotalDraft, setFlowTotalDraft] = useState("");
  const [prepayInterestManual, setPrepayInterestManual] = useState(false);
  const [prepayStrategy, setPrepayStrategy] = useState<PrepayStrategy>(DEFAULT_LOAN_PREPAY_STRATEGY);
  const [annualRate, setAnnualRate] = useState("");
  const [annualRateManuallyEdited, setAnnualRateManuallyEdited] = useState(false);
  const [mortgageLprDiscount, setMortgageLprDiscount] = useState("");
  const [repaymentMethod, setRepaymentMethod] = useState(FREE_REPAYMENT_METHOD);
  // Loan repayment execution mode: auto-debit or bill-only.
  const [autoDebit, setAutoDebit] = useState(true);
  const [autoDebitFirstDate, setAutoDebitFirstDate] = useState(addMonthsInput(today, 1));
  const [repaymentIntervalMonths, setRepaymentIntervalMonths] = useState("1");
  const [loanTotalRuns, setLoanTotalRuns] = useState("300");
  const [firstBillDate, setFirstBillDate] = useState(addMonthsInput(today, 1));
  const [firstRepaymentDate, setFirstRepaymentDate] = useState(addMonthsInput(today, 1));
  const [note, setNote] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [historyConfirmOpen, setHistoryConfirmOpen] = useState(false);
  const [pendingKeepAdding, setPendingKeepAdding] = useState(false);
  const [createHistoricalRepaymentRecords, setCreateHistoricalRepaymentRecords] = useState(false);
  const [showHistoricalRates, setShowHistoricalRates] = useState(false);
  const [historicalRateRows, setHistoricalRateRows] = useState<HistoricalRateRow[]>([]);
  const [historicalRatesOpen, setHistoricalRatesOpen] = useState(false);
  const [repaymentLprCheck, setRepaymentLprCheck] = useState<RepaymentLprCheck | null>(null);
  const [repayableLoanAccountRows, setRepayableLoanAccountRows] = useState<RepayableLoanAccountRow[]>([]);
  const [repayableLoanAccountsLoading, setRepayableLoanAccountsLoading] = useState(false);
  const [activeLoanTab, setActiveLoanTab] = useState<LoanTab>("consumer");
  // 2026-10-07 贷款类别（下拉）：四个内置类别由服务端播种，口径由类别的 baseType 派生，
  // `activeLoanTab` 继续作为内部口径驱动（房贷/消费贷/抵押贷/其他），行为分支不用改。
  const [loanCategoryId, setLoanCategoryId] = useState("");
  const [loanCategoryOptions, setLoanCategoryOptions] = useState<
    Array<{ id: string; name: string; baseType: LoanTypeValue; isSystem: boolean }>
  >([]);
  const [loanPurposeCategoryId, setLoanPurposeCategoryId] = useState("");
  const [fixedAssetLinked, setFixedAssetLinked] = useState(false);
  const [fixedAssetAccountId, setFixedAssetAccountId] = useState("");
  const [fixedAssetAssetId, setFixedAssetAssetId] = useState("");
  const [fixedAssetAccountList, setFixedAssetAccountList] = useState<SmartSelectOption[]>(fixedAssetAccounts ?? []);
  const [localFixedAssetAccountSSOpts, setLocalFixedAssetAccountSSOpts] = useState<SmartSelectOption[] | undefined>(fixedAssetAccountSSOptions);
  const [fixedAssetAssets, setFixedAssetAssets] = useState<FixedAssetAssetOption[]>([]);
  const [fixedAssetAssetsLoading, setFixedAssetAssetsLoading] = useState(false);
  // Linked fixed asset of the edited borrow record; undefined until fetched.
  const [fixedAssetLinkedTx, setFixedAssetLinkedTx] = useState<FixedAssetLinkedTransaction | null | undefined>(undefined);
  const [fixedAssetAccountNestedOpen, setFixedAssetAccountNestedOpen] = useState(false);
  const [fixedAssetAssetNestedOpen, setFixedAssetAssetNestedOpen] = useState(false);
  const [fixedAssetCreateAccountId, setFixedAssetCreateAccountId] = useState("");
  const [fixedAssetCreateName, setFixedAssetCreateName] = useState("");
  const [fixedAssetCreateDate, setFixedAssetCreateDate] = useState("");
  const [fixedAssetCreateAmount, setFixedAssetCreateAmount] = useState("");
  const [fixedAssetCreateSubmitting, setFixedAssetCreateSubmitting] = useState(false);
  // One-shot guard: prefill the linked fixed asset at most once per edit open,
  // so the user can still unlink it afterwards.
  const fixedAssetLinkPrefilledRef = useRef(false);

  function mergeSmartSelectOptions(base?: SmartSelectOption[], extra?: SmartSelectOption[]) {
    const merged = [...(base ?? [])];
    const seen = new Set(merged.map((option) => option.id));
    for (const option of extra ?? []) {
      if (!seen.has(option.id)) merged.push(option);
    }
    return merged;
  }

  async function openLiabilityObjectCreate() {
    setLiabilityObjectNestedOpen(true);
    const data = await fetchSettingsAccountData({ force: true }).catch(() => null);
    if (!data) return;
    setLocalNestedFieldData({
      groupId: (data.groups ?? [])
        .filter((group: { name: string }) => group.name !== "未指定")
        .map((group: { id: string; name: string }) => ({ id: group.id, name: group.name })),
      institutionId: (data.institutions ?? []).map((institution: { id: string; name: string; shortName?: string | null; type?: string | null }) => ({
        id: institution.id,
        name: institution.shortName?.trim() || institution.name,
        type: institution.type ?? "",
      })),
      counterpartyId: (data.counterparties ?? []).map((counterparty: { id: string; name: string; shortName?: string | null; type?: string | null }) => ({
        id: counterparty.id,
        name: counterparty.shortName?.trim() || counterparty.name,
        type: counterparty.type ?? "organization",
      })),
    });
  }

  function openLiabilityAccountCreate() {
    if (!isLiabilityObjectRef(liabilityInstitutionId)) return;
    setLiabilityAccountNestedOpen(true);
  }

  const resetDraft = useCallback(() => {
    const normalizedDefaultObject = normalizeLiabilityObjectValue(defaultLiabilityInstitutionId, localNestedFieldData ?? nestedFieldData);
    const defaultLiabilityAccount = defaultLiabilityAccountId
      ? localLiabilityAccounts.find((account) => account.id === defaultLiabilityAccountId)
      : undefined;
    const defaultAccountObject = liabilityObjectValueForAccount(defaultLiabilityAccount);
    const nextLiabilityObjectId = normalizedDefaultObject || defaultAccountObject;
    setMode("borrow_in");
    setLoanFundingMode(isLoanDialog ? "financed_purchase" : "cash_disbursement");
    setLoanType(null);
    setEditingEntryId("");
    setDate(today);
    setLiabilityInstitutionId(nextLiabilityObjectId);
    setLiabilityAccountId(nextLiabilityObjectId && defaultLiabilityAccountId ? defaultLiabilityAccountId : "");
    setLiabilityItemName("");
    setCashAccountId(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
    setAutoDebitCashAccountId(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
    setPrincipal("");
    setOriginalPrincipalForEdit("");
    setEditRecalculateStartDate("");
    setInterest("");
    setPenalty("");
    setPrepayTotal("");
    setPrepayTotalManual(false);
    setPrepayInterestManual(false);
    settlePrincipalManualRef.current = false;
    scheduledDateManualRef.current = false;
    scheduledDraftAutoAppliedRef.current = false;
    repayableFetchSettledRef.current = false;
    setPrepayStrategy(DEFAULT_LOAN_PREPAY_STRATEGY);
    setAnnualRate("");
    setAnnualRateManuallyEdited(false);
    setMortgageLprDiscount("");
    setRepaymentMethod(FREE_REPAYMENT_METHOD);
    setAutoDebit(isLoanDialog ? false : true);
    setAutoDebitFirstDate(addMonthsInput(today, 1));
    setRepaymentIntervalMonths("1");
    setLoanTotalRuns("300");
    setFirstBillDate(addMonthsInput(today, 1));
    setFirstRepaymentDate(addMonthsInput(today, 1));
    setNote("");
    setSelectedTagIds([]);
    setHistoryConfirmOpen(false);
    setPendingKeepAdding(false);
    setCreateHistoricalRepaymentRecords(false);
    setShowHistoricalRates(false);
    setHistoricalRateRows([]);
    setHistoricalRatesOpen(false);
    setRepaymentLprCheck(null);
    setRepayableLoanAccountRows([]);
    setRepayableLoanAccountsLoading(false);
    setActiveLoanTab("consumer");
    setLoanCategoryId("");
    setLoanPurposeCategoryId("");
    setFixedAssetLinked(false);
    setFixedAssetAccountId("");
    setFixedAssetAssetId("");
    setFixedAssetAssets([]);
    setFixedAssetAssetsLoading(false);
    setFixedAssetAccountNestedOpen(false);
    setFixedAssetAssetNestedOpen(false);
    setFixedAssetCreateAccountId("");
    setFixedAssetCreateName("");
    setFixedAssetCreateDate("");
    setFixedAssetCreateAmount("");
    setFixedAssetCreateSubmitting(false);
  }, [cashAccounts, defaultCashAccountId, defaultLiabilityAccountId, defaultLiabilityInstitutionId, isLoanDialog, localLiabilityAccounts, localNestedFieldData, nestedFieldData, today]);

  useEffect(() => {
    setLocalLiabilityAccounts(liabilityAccounts);
  }, [liabilityAccounts]);

  useEffect(() => {
    setLocalLiabilityObjectOptions(liabilityObjectOptions);
  }, [liabilityObjectOptions]);

  useEffect(() => {
    setLocalNestedFieldData(nestedFieldData);
  }, [nestedFieldData]);

  useEffect(() => {
    setFixedAssetAccountList(fixedAssetAccounts ?? []);
  }, [fixedAssetAccounts]);

  useEffect(() => {
    if (fixedAssetAccountSSOptions) {
      setLocalFixedAssetAccountSSOpts((prev) => mergeSmartSelectOptions(fixedAssetAccountSSOptions, prev));
    }
  }, [fixedAssetAccountSSOptions]);

  useEffect(() => {
    if (!open || !isLoanDialog) {
      setFixedAssetAssets([]);
      setFixedAssetAssetsLoading(false);
      setFixedAssetLinkedTx(undefined);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setFixedAssetAssetsLoading(true);
    // transactions=0: the full transaction list is never used by this dialog.
    // Borrow-edit opens also ask for the single property transaction linked to
    // the edited record (fixed-asset prefill) instead of scanning the list.
    const params = new URLSearchParams({ transactions: "0" });
    if (mode === "borrow_in" && editingEntryId) params.set("linkedCashEntryId", editingEntryId);
    fetch(`/api/v1/properties?${params.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (cancelled) return;
        const assets = Array.isArray(payload?.data?.assets) ? payload.data.assets : [];
        setFixedAssetAssets(assets.flatMap((asset: { id?: unknown; accountId?: unknown; mortgageLoanAccountId?: unknown; name?: unknown; status?: unknown; assetType?: unknown }) => {
          const id = typeof asset.id === "string" ? asset.id : "";
          const accountId = typeof asset.accountId === "string" ? asset.accountId : "";
          const name = typeof asset.name === "string" ? asset.name : "";
          if (!id || !accountId || !name) return [];
          return [{
            id,
            accountId,
            name,
            mortgageLoanAccountId: typeof asset.mortgageLoanAccountId === "string" ? asset.mortgageLoanAccountId : null,
            status: typeof asset.status === "string" ? asset.status : null,
            assetType: typeof asset.assetType === "string" ? asset.assetType : null,
          }];
        }));
        const linked = payload?.data?.linkedTransaction;
        setFixedAssetLinkedTx(linked && typeof linked === "object"
          ? {
              accountId: typeof linked.accountId === "string" ? linked.accountId : "",
              propertyAssetId: typeof linked.propertyAssetId === "string" ? linked.propertyAssetId : "",
            }
          : null);
      })
      .catch(() => {
        if (!cancelled) {
          setFixedAssetAssets([]);
          setFixedAssetLinkedTx(null);
        }
      })
      .finally(() => {
        if (!cancelled) setFixedAssetAssetsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isLoanDialog, mode, editingEntryId, open]);

  useEffect(() => {
    let cancelled = false;
    async function refreshLiabilitySettingsData() {
      const data = await fetchSettingsAccountData({ force: true }).catch(() => null);
      if (cancelled || !data) return;
      const liabilityRows = restrictAccountsByType(
        (data.accounts as SettingsAccountRecord[]).filter(
          (account) => account.isPlaceholder !== true && account.isActive !== false,
        ),
        (account) => account.kind === "loan" || account.kind === "settlement",
      );
      setLocalLiabilityAccounts(liabilityRows.map((account) => settingsAccountToLiabilityOption(account, t)));
      const nextNested: NestedFieldData = {
        groupId: (data.groups ?? []).map((group) => ({ id: group.id, name: group.name })),
        institutionId: (data.institutions ?? []).map((institution) => ({
          id: institution.id,
          name: institution.shortName?.trim() || institution.name,
          type: institution.type ?? "",
        })),
        counterpartyId: (data.counterparties ?? []).map((counterparty) => ({
          id: counterparty.id,
          name: counterparty.shortName?.trim() || counterparty.name,
          type: counterparty.type ?? "organization",
        })),
      };
      setLocalNestedFieldData(nextNested);
      const counterpartyOptions = nextNested.counterpartyId.map((item) => ({
        id: liabilityObjectOptionId(item.id, item.type),
        label: item.name,
        subLabel: institutionTypeLabel(item.type, t),
      }));
      const institutionOptions = nextNested.institutionId
        .filter((item) => isInstitutionTypeOf(item.type, LOAN_DIALOG_INSTITUTION_TYPE_VALUES))
        .map((item) => ({
          id: liabilityObjectOptionId(item.id, item.type),
          label: item.name,
          subLabel: institutionTypeLabel(item.type ?? null, t),
        }));
      setLocalLiabilityObjectOptions(mergeSmartSelectOptions(liabilityObjectOptions, isLoanDialog ? institutionOptions : counterpartyOptions));
    }

    function onSettingsChanged(ev: Event) {
      const detail = (ev as CustomEvent<SettingsDataChangedDetail>).detail;
      const scope = detail?.scope ?? "all";
      if (scope === "accounts" || scope === "all") void refreshLiabilitySettingsData();
    }

    window.addEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    };
  }, [liabilityObjectOptions, isLoanDialog, t]);

  useEffect(() => {
    function onCreate(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId?: string;
        editEntryId?: string;
        mode?: LiabilityMode;
        loanType?: LoanTypeValue;
        defaultLiabilityAccountId?: string;
        defaultLiabilityAccountName?: string | null;
        defaultLoanPurposeCategoryId?: string | null;
        defaultLiabilityInstitutionId?: string;
        defaultCashAccountId?: string;
        defaultAutoDebitCashAccountId?: string;
        defaultFixedAssetAccountId?: string;
        defaultFixedAssetAssetId?: string;
        defaultDate?: string;
        defaultPrincipal?: number | string | null;
        defaultInterest?: number | string | null;
        defaultPenalty?: number | string | null;
        defaultRecalculateStartDate?: string | null;
        defaultPrepayStrategy?: PrepayStrategy;
        defaultCurrentAnnualRate?: number | null;
        defaultMortgageLprDiscount?: number | null;
        defaultLoanRateAdjustments?: LoanRateAdjustment[];
        defaultLoanFundingMode?: LoanFundingMode;
        defaultNote?: string | null;
        defaultRepaymentMethod?: string | null;
        defaultAnnualRate?: number | null;
        defaultRepaymentIntervalMonths?: number | null;
        defaultLoanTotalRuns?: number | null;
        defaultFirstBillDate?: string | null;
        defaultFirstRepaymentDate?: string | null;
        defaultAutoDebit?: boolean | null;
        defaultAutoDebitFirstDate?: string | null;
        defaultTagIds?: string[] | null;
      }>).detail;
      const detailLoanType = detail?.loanType ? resolveLoanTypeValue(detail.loanType, detail.loanType === "consumer") : null;
      const isLoanRepaymentEvent = isLoanDialog && (detail?.mode === "repay_out" || detail?.mode === "prepay_out");
      // Edit events opened outside the liability module (e.g. account detail view) may
      // not carry loanType; derive it from the edited loan account so the correct
      // loan tab opens instead of always defaulting to consumer.
      const editEventLiabilityAccount = isLoanDialog && detail?.editEntryId && detail.mode === "borrow_in" && detail.defaultLiabilityAccountId
        ? localLiabilityAccounts.find((account) => account.id === detail.defaultLiabilityAccountId)
        : undefined;
      const editEventLoanType = editEventLiabilityAccount ? accountOptionLoanType(editEventLiabilityAccount) : null;
      const effectiveLoanType = detailLoanType ?? editEventLoanType;
      resetDraft();
      fixedAssetLinkPrefilledRef.current = false;
      planDefaultsFromEventRef.current = !!(
        detail?.defaultRepaymentMethod ||
        detail?.defaultRepaymentIntervalMonths != null ||
        detail?.defaultLoanTotalRuns != null ||
        detail?.defaultFirstRepaymentDate ||
        detail?.defaultAnnualRate != null
      );
      if (detail?.editEntryId) setEditingEntryId(detail.editEntryId);
      if (detail?.mode) setMode(detail.mode);
      if (isLoanRepaymentEvent) {
        setActiveLoanTab("repay_out");
        if (detailLoanType) setLoanType(detailLoanType);
        setLoanFundingMode("cash_disbursement");
      } else if (effectiveLoanType) {
        setLoanType(effectiveLoanType);
        setActiveLoanTab(effectiveLoanType);
        if (effectiveLoanType === "consumer") {
          setLoanFundingMode("financed_purchase");
          setRepaymentMethod(EQUAL_PAYMENT_REPAYMENT_METHOD);
          setLoanTotalRuns("12");
          setAutoDebit(false);
          setAutoDebitFirstDate(addMonthsInput(today, 1));
        } else if (effectiveLoanType === "mortgage") {
          setLoanFundingMode("cash_disbursement");
          setRepaymentMethod(EQUAL_PAYMENT_REPAYMENT_METHOD);
          setLoanTotalRuns("300");
          setAutoDebit(false);
          setAutoDebitFirstDate(addMonthsInput(today, 1));
        } else {
          // 其他贷款：默认现金放款（入账资金账户），借款资金进用户选的资金账户。
          setLoanFundingMode("cash_disbursement");
          setRepaymentMethod(EQUAL_PAYMENT_REPAYMENT_METHOD);
          setLoanTotalRuns("300");
          setAutoDebit(false);
          setAutoDebitFirstDate(addMonthsInput(today, 1));
        }
      } else if (detail?.mode === "repay_out" || detail?.mode === "prepay_out") {
        setMode(detail.mode);
        setActiveLoanTab("repay_out");
      }
      if (detail?.defaultLoanFundingMode) setLoanFundingMode(detail.defaultLoanFundingMode);
      if (detail?.defaultDate) setDate(detail.defaultDate);
      const eventLiabilityAccount = detail?.defaultLiabilityAccountId
        ? localLiabilityAccounts.find((account) => account.id === detail.defaultLiabilityAccountId)
        : undefined;
      const eventLiabilityObject = liabilityObjectValueForAccount(eventLiabilityAccount);
      if (detail?.defaultLiabilityInstitutionId) {
        setLiabilityInstitutionId(normalizeLiabilityObjectValue(detail.defaultLiabilityInstitutionId, localNestedFieldData ?? nestedFieldData));
      } else if (eventLiabilityObject) {
        setLiabilityInstitutionId(eventLiabilityObject);
      }
      if (detail?.defaultLiabilityAccountId) {
        setLiabilityAccountId(detail.defaultLiabilityAccountId);
      } else if (detailLoanType) {
        // When no account is supplied, select the first account matching the loan type.
        const matched = localLiabilityAccounts.find((account) => accountMatchesLoanType(account, detailLoanType));
        if (matched) {
          setLiabilityAccountId(matched.id);
          setLiabilityInstitutionId(liabilityObjectValueForAccount(matched));
        }
      }
      if (detail?.defaultLiabilityAccountName) setLiabilityItemName(detail.defaultLiabilityAccountName);
      if (
        detail?.defaultLoanPurposeCategoryId &&
        (!effectiveLoanType || effectiveLoanType === "consumer") &&
        expenseCategories?.some((category) => category.id === detail.defaultLoanPurposeCategoryId)
      ) {
        setLoanPurposeCategoryId(detail.defaultLoanPurposeCategoryId);
      }
      if (detail?.defaultCashAccountId) setCashAccountId(detail.defaultCashAccountId);
      if (detail?.defaultAutoDebitCashAccountId) setAutoDebitCashAccountId(detail.defaultAutoDebitCashAccountId);
      else if (detail?.defaultCashAccountId) setAutoDebitCashAccountId(detail.defaultCashAccountId);
      if (detail?.defaultAutoDebit != null) setAutoDebit(detail.defaultAutoDebit);
      if (detail?.defaultPrincipal != null) {
        const nextPrincipal = String(parseAbsMoneyText(String(detail.defaultPrincipal)));
        setPrincipal(nextPrincipal);
        setOriginalPrincipalForEdit(nextPrincipal);
      }
      if (detail?.defaultRecalculateStartDate) setEditRecalculateStartDate(detail.defaultRecalculateStartDate);
      if (detail?.defaultInterest != null) {
        setInterest(String(parseAbsMoneyText(String(detail.defaultInterest))));
        if (detail?.mode === "prepay_out") setPrepayInterestManual(true);
      }
      if (detail?.defaultPenalty != null) {
        const nextPenalty = String(parseAbsMoneyText(String(detail.defaultPenalty)));
        setPenalty(nextPenalty);
        if (detail?.mode === "prepay_out") {
          const editInterest = detail.defaultInterest != null ? parseAbsMoneyText(String(detail.defaultInterest)) : 0;
          setPrepayTotal(roundMoneyValue(parseAbsMoneyText(String(detail.defaultPrincipal ?? "")) + editInterest + parseMoneyText(nextPenalty)).toFixed(2));
          setPrepayTotalManual(false);
        }
      }
      if (detail?.defaultPrepayStrategy) setPrepayStrategy(detail.defaultPrepayStrategy);
      if (detail?.defaultNote != null) setNote(String(detail.defaultNote));
      if (Array.isArray(detail?.defaultTagIds)) setSelectedTagIds(detail.defaultTagIds.filter((id): id is string => typeof id === "string" && id.length > 0));
      if (detail?.defaultRepaymentMethod) setRepaymentMethod(normalizeLoanRepaymentMethod(detail.defaultRepaymentMethod));
      if (detail?.defaultAnnualRate != null && Number.isFinite(detail.defaultAnnualRate)) {
        setAnnualRate(formatRateInput(detail.defaultAnnualRate));
      } else if (detail?.defaultRepaymentMethod && isInstallmentRepaymentMethod(detail.defaultRepaymentMethod)) {
        setAnnualRate("0");
      }
      if (detail?.defaultMortgageLprDiscount != null && Number.isFinite(detail.defaultMortgageLprDiscount)) {
        setMortgageLprDiscount(formatRateInput(detail.defaultMortgageLprDiscount));
      }
      if (detail?.defaultRepaymentIntervalMonths != null && Number.isFinite(detail.defaultRepaymentIntervalMonths)) {
        setRepaymentIntervalMonths(String(detail.defaultRepaymentIntervalMonths));
      }
      if (detail?.defaultLoanTotalRuns != null && Number.isFinite(detail.defaultLoanTotalRuns)) {
        setLoanTotalRuns(String(detail.defaultLoanTotalRuns));
      }
      if (detail?.defaultFirstBillDate) setFirstBillDate(detail.defaultFirstBillDate);
      if (detail?.defaultFirstRepaymentDate) setFirstRepaymentDate(detail.defaultFirstRepaymentDate);
      if (detail?.defaultAutoDebitFirstDate) setAutoDebitFirstDate(detail.defaultAutoDebitFirstDate);
      else if (detail?.defaultFirstRepaymentDate) setAutoDebitFirstDate(detail.defaultFirstRepaymentDate);
      if (detail?.defaultFixedAssetAccountId) setFixedAssetAccountId(detail.defaultFixedAssetAccountId);
      if (detail?.defaultFixedAssetAssetId) setFixedAssetAssetId(detail.defaultFixedAssetAssetId);
      if (detail?.defaultFixedAssetAccountId || detail?.defaultFixedAssetAssetId) setFixedAssetLinked(true);
      if (detail?.defaultLoanRateAdjustments && detail.defaultLoanRateAdjustments.length > 0) {
        setHistoricalRateRows(detail.defaultLoanRateAdjustments.map((item) =>
          createHistoricalRateRow(item.effectiveDate, formatRateInput(item.annualRate)),
        ));
        setShowHistoricalRates(true);
      }
      if (detail?.mode === "repay_out" || detail?.mode === "prepay_out") {
        setRepaymentLprCheck({
          mortgageLprDiscount: detail.defaultMortgageLprDiscount ?? null,
          currentAnnualRate: detail.defaultCurrentAnnualRate ?? null,
          loanRateAdjustments: detail.defaultLoanRateAdjustments ?? [],
        });
      }
      setOpen(true);
    }
    const createEventName = isLoanDialog ? "mmh:loan:create" : "mmh:settlement:create";
    window.addEventListener(createEventName, onCreate as EventListener);
    return () => window.removeEventListener(createEventName, onCreate as EventListener);
  }, [defaultCashAccountId, defaultLiabilityAccountId, expenseCategories, isLoanDialog, localLiabilityAccounts, localNestedFieldData, nestedFieldData, resetDraft, today]);
  useCloseOnNavigation(open, () => {
    setOpen(false);
    resetDraft();
  });

  const prepayComputedTotal = useMemo(() => {
    if (mode !== "prepay_out") return "";
    if (!principal.trim() && !penalty.trim() && !interest.trim()) return "";
    return roundMoneyValue(parseAbsMoneyText(principal) + parseMoneyText(interest) + parseMoneyText(penalty)).toFixed(2);
  }, [mode, interest, penalty, principal]);

  useEffect(() => {
    if (mode !== "prepay_out" || prepayTotalManual) return;
    setPrepayTotal(prepayComputedTotal);
  }, [mode, prepayComputedTotal, prepayTotalManual]);

  const findLiabilityAccountForObject = useCallback((objectValue: string, direction: "payable" | "receivable") => {
    if (!isLiabilityObjectRef(objectValue)) return null;
    const rawId = rawLiabilityObjectId(objectValue);
    const matchedAccounts = localLiabilityAccounts.filter((account) => {
      if (objectValue.startsWith("counterparty:")) return account.counterpartyId === rawId;
      return account.institutionId === rawId;
    });
    return matchedAccounts.find((account) => account.liabilityDirection === direction) ?? matchedAccounts[0] ?? null;
  }, [localLiabilityAccounts]);

  useEffect(() => {
    if (!!editingEntryId || mode === "prepay_out" || !liabilityInstitutionId.startsWith("counterparty:")) return;
    const existingAccount = findLiabilityAccountForObject(liabilityInstitutionId, liabilityDirectionForMode(mode));
    setLiabilityAccountId(existingAccount?.id ?? "");
  }, [liabilityInstitutionId, editingEntryId, findLiabilityAccountForObject, mode]);

  function applyPrepayTotalDraft(options?: { alertOnInvalid?: boolean }) {
    if (mode !== "prepay_out" || !prepayTotal.trim()) return penalty;
    const total = roundMoneyValue(parseMoneyText(prepayTotal));
    const principalAmount = roundMoneyValue(parseAbsMoneyText(principal));
    const interestAmount = roundMoneyValue(showPrepayInterest ? parseMoneyText(interest) : 0);
    if (total + 0.005 < principalAmount + interestAmount) {
      if (options?.alertOnInvalid) window.alert(t("liabilityTx.alert.expenseTotalTooSmall"));
      setPrepayTotal(prepayComputedTotal);
      setPrepayTotalManual(false);
      return penalty;
    }
    const nextPenalty = roundMoneyValue(total - principalAmount - interestAmount).toFixed(2);
    setPenalty(nextPenalty);
    setPrepayTotal(total.toFixed(2));
    setPrepayTotalManual(false);
    return nextPenalty;
  }

  function handlePrincipalChange(value: string) {
    setPrincipal(value);
    if (mode === "prepay_out") {
      setPrepayTotalManual(false);
      if (prepayStrategy === "settle") settlePrincipalManualRef.current = true;
    }
  }

  function handlePrepayStrategyChange(value: PrepayStrategy) {
    setPrepayStrategy(value);
    settlePrincipalManualRef.current = false;
  }

  function handlePenaltyChange(value: string) {
    setPenalty(value);
    if (mode === "prepay_out") setPrepayTotalManual(false);
  }

  function handlePrepayInterestChange(value: string) {
    setInterest(value);
    setPrepayInterestManual(true);
    if (mode === "prepay_out") setPrepayTotalManual(false);
  }

  function handlePrepayTotalChange(value: string) {
    setPrepayTotal(value);
    setPrepayTotalManual(true);
  }

  function liabilityObjectValueForAccount(account: AccountOption | undefined) {
    if (!account) return "";
    if (account.counterpartyId) return `counterparty:${account.counterpartyId}`;
    if (account.institutionId) return `institution:${account.institutionId}`;
    return "";
  }

  function applyScheduledLoanRepaymentDraft(id: string) {
    if (!id) return;
    const row = repayableLoanAccountRows.find((item) => item.accountId === id);
    const scheduledPrincipal = row?.currentPrincipal;
    const scheduledInterest = row?.currentInterest;
    if (
      row &&
      !row.currentPeriodPaid &&
      scheduledPrincipal != null &&
      scheduledInterest != null &&
      scheduledPrincipal + scheduledInterest > 0
    ) {
      // 日期自动填到该期预定还款日（用户手动改过日期后不再覆盖）。
      if (row.currentDueDate && scheduledDateManualRef.current !== true) {
        setDate(row.currentDueDate);
      }
      // 还款账户带出还款表的扣款账户（自动扣款计划）；仅当该账户在支出账户
      // 下拉里可见时才预填，避免选中一个列表里不存在的账户。
      const repaymentAccountId = row.repaymentAccountId;
      if (
        repaymentAccountId &&
        [...(cashAccountSSOptions ?? []), ...cashAccounts, ...localCashAccountList].some(
          (option) => option.id === repaymentAccountId,
        )
      ) {
        setCashAccountId(repaymentAccountId);
      }
      setPrincipal(String(Math.round(scheduledPrincipal * 100) / 100));
      // 还款模式的利息来自还款表期次拆分，与借款表单的还款方式状态无关
      //（repay 模式下 repaymentMethod 恒为 FREE，旧判据会拦掉利息带出）。
      if (showInterest) {
        setInterest(Number.isFinite(scheduledInterest)
          ? String(Math.round(scheduledInterest * 100) / 100)
          : "");
      }
    } else if (row?.currentPeriodPaid) {
      setPrincipal("");
      setInterest("");
    }
  }

  function handleLiabilityAccountChange(id: string) {
    setLiabilityAccountId(id);
    setLiabilityItemName("");
    if (!id) return;
    const account = localLiabilityAccounts.find((item) => item.id === id);
    const objectValue = liabilityObjectValueForAccount(account);
    if (objectValue) setLiabilityInstitutionId(objectValue);
    // Selecting a loan is a source-field change, so replace any prior account's defaults.
    if (mode === "repay_out" && !editingEntryId) {
      applyScheduledLoanRepaymentDraft(id);
    }
  }

  function handleLiabilityItemOrObjectChange(id: string) {
    if (id && !isLiabilityObjectRef(id)) {
      handleLiabilityAccountChange(id);
      return;
    }
    const existingAccount = id.startsWith("counterparty:") ? findLiabilityAccountForObject(id, liabilityDirectionForMode(mode)) : null;
    setLiabilityInstitutionId(id);
    setLiabilityAccountId(existingAccount?.id ?? "");
    setLiabilityItemName("");
  }

  function handleModeSelect(nextMode: LiabilityMode) {
    if (editingEntryId && !canSwitchLiabilityEditMode(mode, nextMode)) return;
    setMode(nextMode);
    if (!allowsLiabilityInterest(nextMode)) setInterest("");
    if (principal.trim()) setPrincipal(String(parseAbsMoneyText(principal)));
    if (isLoanDialog && (nextMode === "repay_out" || nextMode === "prepay_out")) {
      setActiveLoanTab("repay_out");
      if (nextMode === "repay_out") {
        applyScheduledLoanRepaymentDraft(liabilityAccountId);
      } else {
        setInterest("");
        setPrepayTotalManual(false);
        setPrepayInterestManual(false);
        setPrepayTotal("");
      }
      return;
    }
    if (nextMode === "prepay_out") {
      setLiabilityInstitutionId("");
      setLiabilityAccountId("");
      setLiabilityItemName("");
      return;
    }
    if (!isLiabilityObjectRef(liabilityInstitutionId)) return;
    if (liabilityInstitutionId.startsWith("counterparty:")) {
      const existingAccount = findLiabilityAccountForObject(liabilityInstitutionId, liabilityDirectionForMode(nextMode));
      setLiabilityAccountId(existingAccount?.id ?? "");
      return;
    }
    const currentLiabilityAccount = localLiabilityAccounts.find((item) => item.id === liabilityAccountId);
    if (
      currentLiabilityAccount?.institutionId &&
      currentLiabilityAccount.liabilityDirection &&
      currentLiabilityAccount.liabilityDirection !== liabilityDirectionForMode(nextMode)
    ) {
      setLiabilityAccountId("");
    }
  }

  function handleLoanTabSelect(tab: LoanTab) {
    setActiveLoanTab(tab);
    setLoanPurposeCategoryId("");
    setFixedAssetLinked(false);
    setFixedAssetAccountId("");
    setFixedAssetAssetId("");
    setSelectedTagIds([]);
    setLiabilityAccountId("");
    setLiabilityInstitutionId("");
    setLiabilityItemName("");
    setPrincipal("");
    setAnnualRate("");
    setAnnualRateManuallyEdited(false);
    setMortgageLprDiscount("");
    setShowHistoricalRates(false);
    setHistoricalRateRows([]);
    if (tab === "repay_out") {
      setMode("repay_out");
      setLoanType(null);
      setLoanFundingMode("cash_disbursement");
      return;
    }
    setMode("borrow_in");
    setLoanType(tab);
    if (tab === "consumer") {
      setLoanFundingMode("financed_purchase");
      setRepaymentMethod(EQUAL_PAYMENT_REPAYMENT_METHOD);
      setLoanTotalRuns("12");
      setAutoDebit(false);
      setAutoDebitFirstDate(firstRepaymentDate || addMonthsInput(today, 1));
    } else if (tab === "mortgage") {
      setLoanFundingMode("cash_disbursement");
      setRepaymentMethod(EQUAL_PAYMENT_REPAYMENT_METHOD);
      setLoanTotalRuns("300");
      setAutoDebit(false);
      setAutoDebitFirstDate(firstRepaymentDate || addMonthsInput(today, 1));
    } else {
      setLoanFundingMode("financed_purchase");
      setRepaymentMethod(EQUAL_PAYMENT_REPAYMENT_METHOD);
      setLoanTotalRuns("300");
      setAutoDebit(tab === "home");
      setAutoDebitFirstDate(firstRepaymentDate || addMonthsInput(today, 1));
    }
  }

  function handleLoanPurposeChange(id: string) {
    setLoanPurposeCategoryId(id);
  }

  function handleFixedAssetToggle() {
    setFixedAssetLinked((current) => {
      const next = !current;
      if (!next) {
        setFixedAssetAccountId("");
        setFixedAssetAssetId("");
      }
      return next;
    });
  }

  function handleCollateralFixedAssetChange(id: string) {
    setFixedAssetAssetId(id);
    const asset = fixedAssetAssets.find((item) => item.id === id);
    setFixedAssetAccountId(asset?.accountId ?? "");
    if (asset?.accountId) recordRecentAccount(asset.accountId);
  }

  function getPendingRepaymentLprAdjustment() {
    if (mode !== "repay_out" || editingEntryId || !repaymentLprCheck) return null;
    const discount = repaymentLprCheck.mortgageLprDiscount;
    if (discount == null || !Number.isFinite(discount) || discount <= 0 || !isValidDateInput(date)) return null;
    const lpr = getLatestFiveYearLpr(date);
    if (!lpr) return null;
    const annualRate = calcMortgageAnnualRateFromLprDiscount({ discount, lprRate: lpr.fiveYearRate });
    const currentAnnualRate = getEffectiveLoanAnnualRate({
      baseAnnualRate: repaymentLprCheck.currentAnnualRate,
      adjustments: repaymentLprCheck.loanRateAdjustments,
      date,
    });
    if (currentAnnualRate != null && Math.abs(annualRate - currentAnnualRate) < 0.0005) return null;
    return {
      effectiveDate: date,
      annualRate,
      lprRate: lpr.fiveYearRate,
      currentAnnualRate,
    };
  }

  function getLiabilityActionErrorMessage(error: string) {
    if (error === "REPAYMENT_REQUIRES_EXISTING_LOAN_ACCOUNT") return t("liabilityTx.alert.selectRepayableLoanAccount");
    if (error === "LOAN_ACCOUNT_HAS_NO_PAYABLE_BALANCE") return t("liabilityTx.alert.noPayableLoanAccountOnDate");
    if (error === "COLLATERAL_ASSET_REQUIRED" || error === "COLLATERAL_ASSET_NOT_FOUND" || error === "COLLATERAL_ASSET_NOT_AVAILABLE") return t("liabilityTx.alert.selectFixedAsset");
    if (error === "COLLATERAL_ASSET_ALREADY_MORTGAGED") return t("liabilityTx.alert.fixedAssetAlreadyMortgaged");
    if (error === "INVALID_TAG_IDS") return t("liabilityTx.alert.invalidTags");
    if (error === "Invalid repayment account" || error === "Auto-debit requires a debit account") return t("liabilityTx.alert.autoDebitAccountRequired");
    return error;
  }

  async function saveLiabilityTransaction(keepAdding: boolean, options?: { skipHistoryPrompt?: boolean }) {
    if (submitting) return;
    if (isLoanRepaymentMode && !liabilityAccountId) {
      window.alert(t("liabilityTx.alert.selectRepayableLoanAccount"));
      return;
    }
    if (isLoanDialog && activeLoanTab === "consumer" && mode === "borrow_in" && !loanPurposeCategoryId) {
      window.alert(t("liabilityTx.alert.selectLoanPurpose"));
      return;
    }
    const requiresFixedAssetSelection = isCollateralLoanBorrow || isHomeLoanBorrow || fixedAssetLinked;
    // 只有抵押贷强制要求固定资产；房贷的资产关联改为可选（不选则不提交关联）。
    const requiresFixedAssetLink = isCollateralLoanBorrow;
    if (requiresFixedAssetLink && !fixedAssetAssetId) {
      window.alert(t("liabilityTx.alert.selectFixedAsset"));
      return;
    }
    if (requiresFixedAssetLink && !fixedAssetAccountId) {
      window.alert(t("liabilityTx.alert.selectFixedAsset"));
      return;
    }
    if (isLoanDialog && mode === "borrow_in" && fixedAssetLinked && !fixedAssetAccountId) {
      window.alert(t("txForm.selectFixedAssetAccount"));
      return;
    }
    if (isCollateralLoanBorrow && !cashAccountId) {
      window.alert(t("liabilityTx.alert.selectLoanDisbursementAccount"));
      return;
    }
    // 其他贷款放宽（2026-09-19）：利率可 0；总期数 0 = 无固定还款计划，
    // 不生成计划任务，期数/首次还款日/扣款字段全部可空。
    const isOtherLoanBorrow = isLoanDialog && activeLoanTab === "other";
    const otherLoanRuns = isOtherLoanBorrow ? Number.parseInt(loanTotalRuns || "0", 10) : Number.NaN;
    const isPlanlessOtherLoanBorrow = isOtherLoanBorrow && otherLoanRuns === 0;
    // 其他贷款现金放款：必须选择入账资金账户（贷款资金要进资金账户）。
    if (isOtherLoanBorrow && !cashAccountId) {
      window.alert(t("liabilityTx.alert.selectLoanDisbursementAccount"));
      return;
    }
    // 编辑借入记录不再校验/提交贷款账户名称：名称属于账户，编辑记录不重命名账户。
    // 其他贷款（2026-09-19 定版）：现金放款，借款资金进入账资金账户（与表单字段一致）；
    // 消费贷为代购/融资购买（资金侧不过账）；抵押贷现金放款；房贷保持现金放款口径。
    const submittedLoanFundingMode =
      isLoanDialog && mode === "borrow_in"
        ? isOtherLoanBorrow || isCollateralLoanBorrow || isHomeLoanBorrow
          ? "cash_disbursement"
          : "financed_purchase"
        : editingEntryId && loanFundingMode === "financed_purchase"
          ? "financed_purchase"
          : "cash_disbursement";
    const requiresLoanScheduleFields = showBorrowPlan && isFixedRepaymentMethodValue(repaymentMethod);
    if (requiresLoanScheduleFields) {
      const usesAutoDebit = isHomeLoanBorrow || autoDebit;
      const selectedAutoDebitCashAccountId = isCollateralLoanBorrow ? autoDebitCashAccountId : cashAccountId;
      const allowZeroAnnualRate = allowsZeroAnnualRateRepaymentMethod(repaymentMethod) || isOtherLoanBorrow;
      const parsedAnnualRate = annualRate.trim()
        ? allowZeroAnnualRate
          ? parseNonNegativeNumberText(annualRate)
          : parsePositiveNumberText(annualRate)
        : allowZeroAnnualRate
          ? 0
          : null;
      if (parsedAnnualRate == null) {
        window.alert(t("liabilityTx.alert.annualRateRequired"));
        return;
      }
      if (!isPlanlessOtherLoanBorrow && !parsePositiveNumberText(loanTotalRuns)) {
        window.alert(t("liabilityTx.alert.totalRunsRequired"));
        return;
      }
      if (isPlanlessOtherLoanBorrow) {
        // 期数 0：跳过计划字段校验，直接走保存（服务端同样按无计划处理）。
      } else if (!usesAutoDebit && (!firstBillDate || !isValidDateInput(firstBillDate))) {
        window.alert(t("liabilityTx.alert.firstBillDateRequired"));
        return;
      } else if (!usesAutoDebit && (!firstRepaymentDate || !isValidDateInput(firstRepaymentDate))) {
        window.alert(t("liabilityTx.alert.firstRepaymentDateRequired"));
        return;
      } else if (usesAutoDebit) {
        if (!selectedAutoDebitCashAccountId) {
          window.alert(t("liabilityTx.alert.autoDebitAccountRequired"));
          return;
        }
        if (!autoDebitFirstDate || !isValidDateInput(autoDebitFirstDate)) {
          window.alert(t("liabilityTx.alert.autoDebitDateRequired"));
          return;
        }
      }
    }
    if (
      !options?.skipHistoryPrompt &&
      showBorrowPlan &&
      !isPlanlessOtherLoanBorrow &&
      submittedLoanFundingMode !== "financed_purchase" &&
      shouldPromptHistoricalRepayments({
        mode,
        isFixedRepaymentMethod,
        firstRepaymentDate: isHomeLoanBorrow || autoDebit ? autoDebitFirstDate : firstRepaymentDate,
        today,
        repaymentIntervalMonths,
      })
    ) {
      setPendingKeepAdding(keepAdding);
      setCreateHistoricalRepaymentRecords(false);
      setShowHistoricalRates(false);
      setHistoricalRateRows([]);
      setHistoricalRatesOpen(false);
      setHistoryConfirmOpen(true);
      return;
    }
    let generatedMortgageRateRows: HistoricalRateRow[] = [];
    if (!showHistoricalRates && showHomeLoanLprFields && mortgageLprDiscount.trim()) {
      const generated = buildCurrentMortgageLprGeneration({ alertOnInvalid: true });
      if (!generated) return;
      generatedMortgageRateRows = generated.rows;
    }
    const historicalRates = showHistoricalRates
      ? serializeHistoricalRateRows(historicalRateRows, t)
      : generatedMortgageRateRows.length > 0
        ? serializeHistoricalRateRows(generatedMortgageRateRows, t)
        : { ok: true as const, text: "" };
    if (!historicalRates.ok) {
      window.alert(historicalRates.error);
      setHistoricalRatesOpen(true);
      return;
    }
    const pendingLprAdjustment = getPendingRepaymentLprAdjustment();
    let acceptedLprAdjustment: typeof pendingLprAdjustment = null;
    if (pendingLprAdjustment) {
      const accepted = await showConfirmDialog({
        title: t("liabilityTx.lprAdjust.title"),
        message: [
          t("liabilityTx.lprAdjust.foundLpr", {
            date: pendingLprAdjustment.effectiveDate,
            rate: pendingLprAdjustment.lprRate.toFixed(3).replace(/\.?0+$/, ""),
          }),
          t("liabilityTx.lprAdjust.newRate", {
            rate: pendingLprAdjustment.annualRate.toFixed(3).replace(/\.?0+$/, ""),
          }),
          pendingLprAdjustment.currentAnnualRate == null
            ? t("liabilityTx.lprAdjust.noComparableRate")
            : t("liabilityTx.lprAdjust.currentRate", {
                rate: pendingLprAdjustment.currentAnnualRate.toFixed(3).replace(/\.?0+$/, ""),
              }),
          t("liabilityTx.lprAdjust.acceptPrompt"),
        ].join("\n"),
      });
      acceptedLprAdjustment = accepted ? pendingLprAdjustment : null;
    }
    const shouldPromptPrincipalRecalculation =
      !!editingEntryId &&
      mode === "repay_out" &&
      !!liabilityAccountId &&
      !!editRecalculateStartDate &&
      Math.abs(roundMoneyValue(parseAbsMoneyText(principal)) - roundMoneyValue(parseAbsMoneyText(originalPrincipalForEdit))) > 0.005;
    const penaltyForSubmit = mode === "prepay_out" ? applyPrepayTotalDraft({ alertOnInvalid: true }) : penalty;
    const prepayInterestForSubmit = mode === "prepay_out" && selectedRepayableLoanRow?.prepayInterest != null;
    if (mode === "prepay_out" && prepayTotal.trim() && parseMoneyText(prepayTotal) + 0.005 < parseAbsMoneyText(principal) + (prepayInterestForSubmit ? parseMoneyText(interest) : 0)) {
      return;
    }

    const submittedAutoDebit = isHomeLoanBorrow || autoDebit;
    const submittedFirstRepaymentDate = submittedAutoDebit ? autoDebitFirstDate : firstRepaymentDate;
    const submittedAutoDebitCashAccountId = isCollateralLoanBorrow ? autoDebitCashAccountId : cashAccountId;
    const submittedCashAccountId = isLoanBorrow
      ? submittedLoanFundingMode === "cash_disbursement"
        ? cashAccountId
        : submittedAutoDebit
          ? cashAccountId
          : ""
      : cashAccountId;
    const formData = new FormData();
    formData.set("editEntryId", editingEntryId);
    formData.set("mode", mode);
    formData.set("loanFundingMode", submittedLoanFundingMode);
    formData.set("date", date);
    const canResolveLiabilityObjectWithoutSelectedAccount = canCreateLiabilityItem || liabilityInstitutionId.startsWith("counterparty:");
    const shouldUseLiabilityObject = !editingEntryId && canSelectLiabilityObject && canResolveLiabilityObjectWithoutSelectedAccount && !!liabilityInstitutionId && !liabilityAccountId;
    formData.set("liabilityAccountId", shouldUseLiabilityObject ? "" : liabilityAccountId);
    if (mode === "repay_out" && selectedRepayableLoanRow?.currentPlanId && selectedRepayableLoanRow.currentUnpaidPeriod) {
      formData.set("loanRepaymentPlanId", selectedRepayableLoanRow.currentPlanId);
      formData.set("loanRepaymentPeriod", String(selectedRepayableLoanRow.currentUnpaidPeriod));
    }
    formData.set("liabilityObjectId", shouldUseLiabilityObject ? liabilityInstitutionId : "");
    formData.set("liabilityInstitutionId", shouldUseLiabilityObject ? rawLiabilityObjectId(liabilityInstitutionId) : "");
    // 编辑贷款借入记录不回写账户名；新建时 liabilityItemName 也空（账户名由新建账户链路决定）。
    formData.set("liabilityItemName", isLoanDialog && !editingEntryId ? liabilityItemName : "");
    formData.set("loanType", isLoanDialog && activeLoanTab !== "repay_out" ? activeLoanTab : "");
    // 2026-10-07：贷款类别与口径一起提交，服务端以类别为准派生 loanType。
    formData.set("loanCategoryId", isLoanDialog && activeLoanTab !== "repay_out" ? loanCategoryId : "");
    formData.set("cashAccountId", submittedCashAccountId);
    formData.set("autoDebitCashAccountId", submittedAutoDebit ? submittedAutoDebitCashAccountId : "");
    formData.set("principal", String(parseAbsMoneyText(principal)));
    formData.set("interest", showInterest || prepayInterestForSubmit ? interest : "0");
    formData.set("penalty", showPrepayment ? penaltyForSubmit : "0");
    formData.set("prepayStrategy", prepayStrategy);
    const allowZeroAnnualRateForSubmit = allowsZeroAnnualRateRepaymentMethod(repaymentMethod);
    formData.set("annualRate", !annualRate.trim() && allowZeroAnnualRateForSubmit ? "0" : annualRate);
    formData.set("mortgageLprDiscount", showHomeLoanLprFields ? mortgageLprDiscount : "");
    formData.set("repaymentMethod", normalizeLoanRepaymentMethod(repaymentMethod));
    formData.set("repaymentIntervalMonths", repaymentIntervalMonths);
    formData.set("loanTotalRuns", loanTotalRuns);
    formData.set("firstBillDate", isHomeLoanBorrow ? "" : firstBillDate);
    formData.set("firstRepaymentDate", submittedFirstRepaymentDate);
    formData.set("createRepaymentPlan", showBorrowPlan && isFixedRepaymentMethod && !isPlanlessOtherLoanBorrow ? "true" : "false");
    formData.set("autoDebit", submittedAutoDebit ? "true" : "false");
    formData.set("autoDebitFirstDate", submittedAutoDebit ? autoDebitFirstDate : "");
    formData.set(
      "createHistoricalRepaymentRecords",
      submittedLoanFundingMode === "financed_purchase" ? "false" : createHistoricalRepaymentRecords ? "true" : "false",
    );
    formData.set("historicalLoanRates", historicalRates.text);
    if (acceptedLprAdjustment) {
      formData.set("acceptedLprRateEffectiveDate", acceptedLprAdjustment.effectiveDate);
      formData.set("acceptedLprAnnualRate", String(acceptedLprAdjustment.annualRate));
    }
    formData.set("note", note);
    if (isLoanDialog && mode === "borrow_in") {
      formData.set("loanPurposeCategoryId", loanPurposeCategoryId);
      // 显式提交固定资产开关态：编辑时关掉开关 = 服务端删除已有资产关联。
      // 房贷无开关：选了资产才视为已关联（可选），清空下拉 = 删除关联。
      formData.set("fixedAssetLinked", (fixedAssetLinked || (isHomeLoanBorrow && !!fixedAssetAccountId)) ? "true" : "false");
      if (requiresFixedAssetSelection && fixedAssetAccountId) {
        formData.set("fixedAssetAccountId", fixedAssetAccountId);
        if (fixedAssetAssetId) formData.set("fixedAssetAssetId", fixedAssetAssetId);
      }
      if (isCollateralLoanBorrow) {
        formData.set("tagIds", JSON.stringify(selectedTagIds));
      }
    }

    setSubmitting(true);
    try {
      const res = await action(formData);
      if (!res.ok) {
        window.alert(getLiabilityActionErrorMessage(res.error));
        return;
      }
      if (res.warning) {
        window.alert(res.warning);
      }
      if (res.recalculateAfterSave) {
        const recalcResponse = await fetch("/api/v1/loan-repayment/recalculate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(res.recalculateAfterSave),
        });
        const recalcData = await recalcResponse.json().catch(() => null);
        if (!recalcResponse.ok || !recalcData?.ok) {
          window.alert(recalcData?.error || t("liabilityTx.alert.recalcFailedPrepay"));
        } else {
          window.alert(formatLoanRecalculateSuccessMessage(recalcData.data));
        }
      }
      if (shouldPromptPrincipalRecalculation) {
        const accepted = await showConfirmDialog({
          title: t("liabilityTx.principalEdit.title"),
          message: [
            t("liabilityTx.principalEdit.message1"),
            t("liabilityTx.principalEdit.message2", { date: editRecalculateStartDate }),
            t("liabilityTx.principalEdit.message3"),
          ].join("\n"),
        });
        if (accepted) {
          const recalcResponse = await fetch("/api/v1/loan-repayment/recalculate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              accountId: liabilityAccountId,
              startDate: editRecalculateStartDate,
            }),
          });
          const recalcData = await recalcResponse.json().catch(() => null);
          if (!recalcResponse.ok || !recalcData?.ok) {
            window.alert(recalcData?.error || t("liabilityTx.alert.recalcFailedPrincipal"));
          } else {
            window.alert(formatLoanRecalculateSuccessMessage(recalcData.data));
          }
        }
      }
      dispatchFinanceDataChanged({ reason: "liability-save" });
      if (keepAdding) {
        setPrincipal("");
        setInterest("");
        setPenalty("");
        setPrepayTotal("");
        setPrepayTotalManual(false);
        setPrepayStrategy(DEFAULT_LOAN_PREPAY_STRATEGY);
        setAnnualRate("");
        setMortgageLprDiscount("");
        setRepaymentMethod(FREE_REPAYMENT_METHOD);
        setAutoDebitCashAccountId(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
        setRepaymentIntervalMonths("1");
        setLoanTotalRuns("300");
        setFirstRepaymentDate(addMonthsInput(today, 1));
        setCreateHistoricalRepaymentRecords(false);
        setShowHistoricalRates(false);
        setHistoricalRateRows([]);
        setHistoricalRatesOpen(false);
        setLiabilityItemName("");
        setNote("");
        setSelectedTagIds([]);
        setLoanPurposeCategoryId("");
        setFixedAssetLinked(false);
        setFixedAssetAccountId("");
        setFixedAssetAssetId("");
      } else {
        setOpen(false);
        setHistoryConfirmOpen(false);
        resetDraft();
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("liabilityTx.alert.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveLiabilityTransaction(false);
  }

  async function confirmHistoricalPrompt() {
    setHistoryConfirmOpen(false);
    await saveLiabilityTransaction(pendingKeepAdding, { skipHistoryPrompt: true });
  }

  const selectedLiabilityAccount = localLiabilityAccounts.find((account) => account.id === liabilityAccountId);
  const selectedLiabilityObjectIsCounterparty = liabilityInstitutionId.startsWith("counterparty:") || !!selectedLiabilityAccount?.counterpartyId;
  const selectedLiabilityInstitutionType = selectedLiabilityAccount?.institutionType
    ?? (liabilityInstitutionId.startsWith("institution:")
      ? localNestedFieldData?.institutionId?.find((item) => item.id === rawLiabilityObjectId(liabilityInstitutionId))?.type
      : undefined)
    ?? null;
  const selectedLiabilityAccountIsBankLoan = !!selectedLiabilityAccount?.institutionId && selectedLiabilityAccount.institutionType === "bank";
  const selectedLiabilityAccountIsConsumerLoan = selectedLiabilityAccount?.isConsumerLoan === true;
  // 还回/还出才显示利息；借入/借出没有利息（提交时强制 0）。
  const showInterest = allowsLiabilityInterest(mode) && mode !== "prepay_out";
  const showPrepayment = mode === "prepay_out";
  const isLoanRepaymentMode = isLoanDialog && (mode === "repay_out" || mode === "prepay_out");
  const canCreateLiabilityItem = canCreateLiabilityItemForMode(mode);
  const canSelectLiabilityObject = !isLoanRepaymentMode && (!!editingEntryId || mode !== "prepay_out");
  // 往来款单界面：负债账户在流出侧 = 借入/收回，在流入侧 = 借出/还款。
  // 「流出账户 / 流入账户」两个槽位复用原有的资金账户与往来款账户选择器，
  // 方向由负债账户落在哪一侧决定，交换按钮即等价于在两槽间任意摆放。
  const liabilitySideIsOut = mode === "borrow_in" || mode === "collect_in";
  // 往来款单界面（非贷款弹窗）启用「流出/流入 + 三者互推」的新交互
  const isFlowLiability = !isLoanDialog;
  function resolveFlowMode(hasInterest: boolean): LiabilityMode {
    if (liabilitySideIsOut) return hasInterest ? "collect_in" : "borrow_in";
    return hasInterest ? "repay_out" : "lend_out";
  }
  const flowTab = mode === "repay_out" || mode === "collect_in" ? "repay" : "borrow";
  /**
   * 交换「流出/流入」：只翻资金流方向，保留本金往来 vs 还本付息。
   * 借入↔借出、还回↔还出；不能靠利息有无改语义。
   */
  function swapLiabilityDirection() {
    setMode(swapLiabilityFlowDirection(mode));
  }
  // 三者互推：改本金或利息 → 总额随派生值走；直接改总额 → 反推本金（利息不变）。
  function handleFlowPrincipalChange(next: string) {
    setPrincipal(next);
    if (flowTotalManual) setFlowTotalManual(false);
  }
  function handleFlowInterestChange(next: string) {
    setInterest(next);
    if (flowTotalManual) setFlowTotalManual(false);
  }
  function handleFlowTotalChange(next: string) {
    setFlowTotalDraft(next);
    setFlowTotalManual(true);
    if (!next.trim()) {
      setPrincipal("");
      return;
    }
    const diff = parseMoneyText(next) - parseMoneyText(interest);
    setPrincipal(diff > 0 ? diff.toFixed(2) : "0");
  }
  const isLoanBorrow = isLoanDialog && mode === "borrow_in";
  // 「新增账户」要建哪种 kind：由**入口窗口**决定，不看往来对象属性（2026-09-13 用户定版）。
  // 贷款窗口里建的账户一律是贷款账户（哪怕对象是往来款对象）；往来款窗口建的才是往来款账户。
  const accountCreateKind: "loan" | "settlement" = isLoanDialog ? "loan" : "settlement";
  const isConsumerLoanBorrow = isLoanBorrow && activeLoanTab === "consumer";
  const isHomeLoanBorrow = isLoanBorrow && activeLoanTab === "home";
  const isCollateralLoanBorrow = isLoanBorrow && activeLoanTab === "mortgage";
  // 编辑贷款借入记录：只允许改还款资金账户，其它字段只读回填。
  const isLoanBorrowEditLocked = isLoanBorrow && !!editingEntryId;
  const showHomeLoanLprFields = isHomeLoanBorrow && selectedLiabilityInstitutionType !== "provident_fund";
  // Status of the selected repayable loan account's current scheduled period.
  const selectedRepayableLoanRow = useMemo(
    () => (isLoanRepaymentMode ? repayableLoanAccountRows.find((item) => item.accountId === liabilityAccountId) : undefined),
    [liabilityAccountId, isLoanRepaymentMode, repayableLoanAccountRows],
  );
  const selectedRepaymentCurrentPeriodPaid = selectedRepayableLoanRow?.currentPeriodPaid === true;
  const selectedRepaymentUnpaidPeriod = selectedRepayableLoanRow?.currentUnpaidPeriod ?? null;
  // Prepayment interest appears only when the server can preview accrued interest for the selected loan.
  const showPrepayInterest = isLoanRepaymentMode && mode === "prepay_out" && selectedRepayableLoanRow?.prepayInterest != null;
  // Keep the field blank until a prepayment principal is entered, then scale the preview by principal.
  const prepayAutoInterest = useMemo(() => {
    if (mode !== "prepay_out" || !principal.trim()) return "";
    const previewInterest = selectedRepayableLoanRow?.prepayInterest;
    const outstandingPrincipal = Math.abs(selectedRepayableLoanRow?.balance ?? 0);
    const prepayPrincipal = parseAbsMoneyText(principal);
    if (
      previewInterest == null ||
      previewInterest <= 0 ||
      outstandingPrincipal <= 0.005 ||
      prepayPrincipal <= 0.005
    ) {
      return "";
    }
    const cappedPrincipal = Math.min(prepayPrincipal, outstandingPrincipal);
    const proportionalInterest = roundMoneyValue(previewInterest * cappedPrincipal / outstandingPrincipal);
    return proportionalInterest > 0 ? String(proportionalInterest) : "";
  }, [mode, principal, selectedRepayableLoanRow?.balance, selectedRepayableLoanRow?.prepayInterest]);
  useEffect(() => {
    if (!open || mode !== "prepay_out" || editingEntryId || prepayInterestManual) return;
    setInterest(prepayAutoInterest);
  }, [open, mode, editingEntryId, prepayAutoInterest, prepayInterestManual]);
  useEffect(() => {
    setPrepayInterestManual(false);
  }, [liabilityAccountId, date]);
  // 结清：本金自动填入截至还款日的剩余本金（利息自动、手续费手填；本金手改后不再覆盖）。
  useEffect(() => {
    if (!open || mode !== "prepay_out" || editingEntryId) return;
    if (prepayStrategy !== "settle" || settlePrincipalManualRef.current) return;
    const balance = selectedRepayableLoanRow?.balance;
    if (balance == null || !Number.isFinite(balance) || Math.abs(balance) <= 0.005) return;
    const outstanding = Math.round(Math.abs(balance) * 100) / 100;
    setPrincipal((current) => (Math.abs(parseAbsMoneyText(current) - outstanding) > 0.005 ? String(outstanding) : current));
    setPrepayTotalManual(false);
  }, [open, mode, editingEntryId, prepayStrategy, selectedRepayableLoanRow]);
  const showLoanPurpose = isLoanBorrow && activeLoanTab === "consumer";
  const showLoanRateAdjustmentFields = isLoanBorrow && (isConsumerLoanBorrow || isHomeLoanBorrow);
  const showLoanFixedAssetFields = isLoanBorrow && (activeLoanTab === "consumer" || activeLoanTab === "home");
  const showLoanBorrowOptions = isHomeLoanBorrow && !selectedLiabilityObjectIsCounterparty && (selectedLiabilityAccountIsBankLoan || selectedLiabilityAccountIsConsumerLoan);
  const showBorrowPlan = isLoanDialog && mode === "borrow_in";
  const loanPurposeOptions = useMemo(
    () => buildCategoryTreeOptions((expenseCategories ?? []) as CategorySource[], t),
    [expenseCategories, t],
  );

  // Editing a loan borrow record opened outside the liability module (e.g. from an
  // account detail view) carries no schedule defaults. Fetch the loan's existing
  // repayment plan and prefill the schedule fields so saving the edit does not
  // rewrite the plan with create-form defaults. Mirrors what liability-view-data
  // passes as default* props when editing from the liability side.
  useEffect(() => {
    if (!open || !isLoanBorrow || !editingEntryId || !liabilityAccountId) return;
    if (planDefaultsFromEventRef.current) return;
    let cancelled = false;
    const controller = new AbortController();
    fetch(`/api/v1/regular-invest?accountId=${encodeURIComponent(liabilityAccountId)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (cancelled || !payload?.ok || !Array.isArray(payload.plans)) return;
        const loanPlans = (payload.plans as Array<{
          memo?: string | null;
          status?: string | null;
          nextRunDate?: string | Date | null;
          startDate?: string | Date | null;
          cashAccountId?: string | null;
        }>).filter((plan) => decodeScheduledTaskMemo(plan.memo).type === "loan_repayment");
        if (loanPlans.length === 0) return;
        let primaryPlan: (typeof loanPlans)[number] | null = null;
        let autoDebitPlan: (typeof loanPlans)[number] | null = null;
        for (const plan of loanPlans) {
          if (shouldPreferLoanScheduledPlan(plan, primaryPlan)) primaryPlan = plan;
          if (shouldPreferLoanAutoDebitPlan(plan, autoDebitPlan)) autoDebitPlan = plan;
        }
        if (!primaryPlan) return;
        const memo = decodeScheduledTaskMemo(primaryPlan.memo);
        const planStart = String(primaryPlan.startDate ?? "").slice(0, 10);
        if (memo.repaymentMethod) setRepaymentMethod(memo.repaymentMethod);
        if (memo.annualRate != null) setAnnualRate(formatRateInput(memo.annualRate));
        setAnnualRateManuallyEdited(false);
        if (isHomeLoanType(activeLoanTab) && memo.mortgageLprDiscount != null) {
          setMortgageLprDiscount(formatRateInput(memo.mortgageLprDiscount));
        }
        if (memo.repaymentIntervalMonths != null) setRepaymentIntervalMonths(String(memo.repaymentIntervalMonths));
        if (memo.originalTotalRuns != null) setLoanTotalRuns(String(memo.originalTotalRuns));
        const nextFirstBillDate = memo.firstBillDate ?? planStart;
        const nextFirstRepaymentDate = memo.firstRepaymentDate ?? planStart;
        if (nextFirstBillDate) setFirstBillDate(nextFirstBillDate);
        if (nextFirstRepaymentDate) setFirstRepaymentDate(nextFirstRepaymentDate);
        setAutoDebit(getLoanScheduledPlanRole(decodeScheduledTaskMemo(autoDebitPlan?.memo)) === "auto_debit");
        const nextAutoDebitFirstDate = autoDebitPlan?.startDate
          ? String(autoDebitPlan.startDate).slice(0, 10)
          : nextFirstRepaymentDate;
        if (nextAutoDebitFirstDate) setAutoDebitFirstDate(nextAutoDebitFirstDate);
        if (autoDebitPlan?.cashAccountId) {
          setAutoDebitCashAccountId(autoDebitPlan.cashAccountId);
          // Financed-purchase borrow records have no cash side of their own; the
          // debit account is submitted through cashAccountId (same as the liability side).
          if (loanFundingMode === "financed_purchase") setCashAccountId(autoDebitPlan.cashAccountId);
        }
        if (memo.loanRateAdjustments && memo.loanRateAdjustments.length > 0) {
          setHistoricalRateRows(memo.loanRateAdjustments.map((item) =>
            createHistoricalRateRow(item.effectiveDate, formatRateInput(item.annualRate)),
          ));
          setShowHistoricalRates(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeLoanTab, liabilityAccountId, editingEntryId, isLoanBorrow, loanFundingMode, open]);

  // Editing a loan borrow record: restore the linked fixed asset (toggle + account
  // + asset). Direct-purchase loans (consumer/home/other) only have a
  // PropertyTransaction link on the borrow record itself; collateral loans have
  // the asset marked with mortgageLoanAccountId (same source the liability side uses).
  // Strictly after the prefill data arrives — never from an empty first pass.
  useEffect(() => {
    if (!open || !isLoanBorrow || !editingEntryId) return;
    if (fixedAssetLinkPrefilledRef.current) return;
    if (fixedAssetLinkedTx === undefined) return;
    fixedAssetLinkPrefilledRef.current = true;
    if (fixedAssetLinked || fixedAssetAccountId || fixedAssetAssetId) return;
    if (fixedAssetLinkedTx && fixedAssetLinkedTx.accountId) {
      setFixedAssetLinked(true);
      setFixedAssetAccountId(fixedAssetLinkedTx.accountId);
      if (fixedAssetLinkedTx.propertyAssetId) setFixedAssetAssetId(fixedAssetLinkedTx.propertyAssetId);
      return;
    }
    const mortgagedAsset = fixedAssetAssets.find((asset) => asset.mortgageLoanAccountId === liabilityAccountId);
    if (mortgagedAsset) {
      setFixedAssetLinked(true);
      setFixedAssetAccountId(mortgagedAsset.accountId);
      setFixedAssetAssetId(mortgagedAsset.id);
    }
  }, [
    liabilityAccountId,
    editingEntryId,
    fixedAssetAccountId,
    fixedAssetAssetId,
    fixedAssetAssets,
    fixedAssetLinked,
    fixedAssetLinkedTx,
    isLoanBorrow,
    open,
  ]);
  const {
    filteredOptions: fixedAssetFiltered,
    visibleOptionIds: fixedAssetVisibleOptionIds,
  } = useAccountSSFilter(localFixedAssetAccountSSOpts);
  const fixedAssetAccountOptions = useMemo(() => {
    let base = mergeSmartSelectOptions(fixedAssetFiltered, fixedAssetAccountList);
    const selected = fixedAssetAccountList.find((option) => option.id === fixedAssetAccountId);
    if (fixedAssetVisibleOptionIds) {
      base = base.filter((option) => fixedAssetVisibleOptionIds.has(option.id));
    }
    if (selected && !base.some((option) => option.id === selected.id)) base.push(selected);
    return sortByAccountUsage(base, accountUsage);
  }, [accountUsage, fixedAssetAccountId, fixedAssetAccountList, fixedAssetFiltered, fixedAssetVisibleOptionIds]);
  const fixedAssetAccountLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of mergeSmartSelectOptions(fixedAssetAccountList, localFixedAssetAccountSSOpts)) {
      if (!option.isHeader && !option.isGroup) map.set(option.id, option.label);
    }
    return map;
  }, [fixedAssetAccountList, localFixedAssetAccountSSOpts]);
  const fixedAssetAssetOptions = useMemo<SmartSelectOption[]>(() => {
    // 房贷只能关联房产型固定资产（车辆/设备等固定资产不进下拉）；抵押贷维持全类型可选。
    const propertyOnly = isHomeLoanBorrow;
    return fixedAssetAssets
      .filter((asset) => {
        if (propertyOnly && asset.assetType != null && asset.assetType !== "property") return false;
        if (asset.id === fixedAssetAssetId) return true;
        if (asset.status === "sold" || asset.status === "disposed" || asset.status === "deleted") return false;
        return !asset.mortgageLoanAccountId || asset.mortgageLoanAccountId === liabilityAccountId;
      })
      .map((asset) => ({
        id: asset.id,
        label: asset.name,
        subLabel: [
          fixedAssetAccountLabelById.get(asset.accountId),
          asset.status === "mortgaged" ? t("fixedAssetEdit.status.mortgaged") : "",
        ].filter(Boolean).join(" · ") || undefined,
      }));
  }, [liabilityAccountId, fixedAssetAccountLabelById, fixedAssetAssetId, fixedAssetAssets, isHomeLoanBorrow, t]);

  useEffect(() => {
    if (!isCollateralLoanBorrow || fixedAssetAssetsLoading || !fixedAssetAssetId) return;
    if (!fixedAssetAssetOptions.some((option) => option.id === fixedAssetAssetId)) {
      setFixedAssetAssetId("");
      setFixedAssetAccountId("");
    }
  }, [fixedAssetAssetId, fixedAssetAssetOptions, fixedAssetAssetsLoading, isCollateralLoanBorrow]);

  useEffect(() => {
    if (!isCollateralLoanBorrow || !fixedAssetAssetId || fixedAssetAccountId) return;
    const asset = fixedAssetAssets.find((item) => item.id === fixedAssetAssetId);
    if (asset?.accountId) setFixedAssetAccountId(asset.accountId);
  }, [fixedAssetAccountId, fixedAssetAssetId, fixedAssetAssets, isCollateralLoanBorrow]);

  useEffect(() => {
    if (selectedLiabilityObjectIsCounterparty && mode === "prepay_out") {
      setMode("repay_out");
    }
  }, [mode, selectedLiabilityObjectIsCounterparty]);
  useEffect(() => {
    if (isLoanBorrow) {
      // 其他贷款默认现金放款（入账资金账户）；房贷/抵押贷为现金放款；消费贷为代购。
      const expectedFundingMode = activeLoanTab === "consumer" ? "financed_purchase" : "cash_disbursement";
      if (loanFundingMode !== expectedFundingMode) setLoanFundingMode(expectedFundingMode);
      return;
    }
    if (!isLoanBorrow && !editingEntryId && loanFundingMode !== "cash_disbursement") {
      setLoanFundingMode("cash_disbursement");
    }
  }, [activeLoanTab, editingEntryId, isLoanBorrow, loanFundingMode]);
  useEffect(() => {
    if (isHomeLoanType(activeLoanTab) && !autoDebit) setAutoDebit(true);
  }, [activeLoanTab, autoDebit]);
  // 2026-10-07 贷款类别下拉：打开贷款弹窗时拉取本账簿类别（四个内置类别由服务端保证存在）。
  useEffect(() => {
    if (!open || !isLoanDialog) return;
    let cancelled = false;
    void (async () => {
      const response = await fetch("/api/v1/loan-categories", { cache: "no-store" }).catch(() => null);
      const data = (await response?.json().catch(() => null)) as
        | { ok?: boolean; categories?: Array<{ id: string; name: string; baseType: string; isSystem: boolean }> }
        | null;
      if (cancelled || !data?.ok || !Array.isArray(data.categories)) return;
      setLoanCategoryOptions(
        data.categories.map((category) => ({
          id: category.id,
          name: category.name,
          baseType: category.baseType as LoanTypeValue,
          isSystem: category.isSystem,
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isLoanDialog]);
  // 口径（activeLoanTab）变化时，把下拉对齐到该口径的内置类别；编辑态保持账户上的类别。
  useEffect(() => {
    if (loanCategoryOptions.length === 0 || activeLoanTab === "repay_out") return;
    const matched = loanCategoryOptions.find((category) => category.baseType === activeLoanTab);
    if (matched && matched.id !== loanCategoryId) setLoanCategoryId(matched.id);
  }, [activeLoanTab, loanCategoryId, loanCategoryOptions]);
  useEffect(() => {
    if (showHomeLoanLprFields) return;
    if (mortgageLprDiscount) setMortgageLprDiscount("");
  }, [mortgageLprDiscount, showHomeLoanLprFields]);
  useEffect(() => {
    if (!open || !isLoanRepaymentMode || !isValidDateInput(date)) {
      repayableFetchSettledRef.current = true;
      setRepayableLoanAccountRows([]);
      setRepayableLoanAccountsLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const params = new URLSearchParams({ date });
    if (editingEntryId) params.set("excludeEntryId", editingEntryId);
    setRepayableLoanAccountsLoading(true);
    repayableFetchSettledRef.current = false;
    fetch(`/api/v1/liability/repayable-loan-accounts?${params.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (cancelled) return;
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        setRepayableLoanAccountRows(rows.flatMap((row: { accountId?: unknown; balance?: unknown; currentPlanId?: unknown; currentDueDate?: unknown; currentPrincipal?: unknown; currentInterest?: unknown; currentPayment?: unknown; currentPaidAmount?: unknown; currentUnpaidPeriod?: unknown; currentPeriodPaid?: unknown; repaymentAccountId?: unknown; prepayInterest?: unknown; prepayInterestFromDate?: unknown; prepayInterestDays?: unknown; prepayAnnualRate?: unknown }) => {
          const accountId = typeof row.accountId === "string" ? row.accountId : "";
          const balance = Number(row.balance);
          if (!accountId || !Number.isFinite(balance)) return [];
          const item: RepayableLoanAccountRow = { accountId, balance };
          if (typeof row.currentPlanId === "string") item.currentPlanId = row.currentPlanId;
          if (typeof row.currentDueDate === "string") item.currentDueDate = row.currentDueDate;
          if (typeof row.repaymentAccountId === "string" && row.repaymentAccountId) item.repaymentAccountId = row.repaymentAccountId;
          const currentPrincipal = Number(row.currentPrincipal);
          const currentInterest = Number(row.currentInterest);
          if (Number.isFinite(currentPrincipal) && currentPrincipal >= 0) item.currentPrincipal = currentPrincipal;
          if (Number.isFinite(currentInterest) && currentInterest >= 0) item.currentInterest = currentInterest;
          const currentPayment = Number(row.currentPayment);
          const currentPaidAmount = Number(row.currentPaidAmount);
          if (Number.isFinite(currentPayment) && currentPayment >= 0) item.currentPayment = currentPayment;
          if (Number.isFinite(currentPaidAmount) && currentPaidAmount >= 0) item.currentPaidAmount = currentPaidAmount;
          const currentUnpaidPeriod = Number(row.currentUnpaidPeriod);
          if (Number.isFinite(currentUnpaidPeriod) && currentUnpaidPeriod > 0) item.currentUnpaidPeriod = currentUnpaidPeriod;
          if (typeof row.currentPeriodPaid === "boolean") item.currentPeriodPaid = row.currentPeriodPaid;
          const prepayInterest = Number(row.prepayInterest);
          if (Number.isFinite(prepayInterest) && prepayInterest >= 0) {
            item.prepayInterest = prepayInterest;
            if (typeof row.prepayInterestFromDate === "string") item.prepayInterestFromDate = row.prepayInterestFromDate;
            const prepayInterestDays = Number(row.prepayInterestDays);
            if (Number.isFinite(prepayInterestDays) && prepayInterestDays >= 0) item.prepayInterestDays = prepayInterestDays;
            const prepayAnnualRate = Number(row.prepayAnnualRate);
            if (Number.isFinite(prepayAnnualRate) && prepayAnnualRate >= 0) item.prepayAnnualRate = prepayAnnualRate;
          }
          return [item];
        }));
      })
      .catch(() => {
        if (!cancelled) setRepayableLoanAccountRows([]);
      })
      .finally(() => {
        repayableFetchSettledRef.current = true;
        if (!cancelled) setRepayableLoanAccountsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [date, editingEntryId, isLoanRepaymentMode, open]);
  // 打开还款表单（账户已预选）或切到还款模式后，按还款表最近一次未还期次
  // 自动带出日期/本金/利息/还款账户——不依赖用户再手动点一次贷款下拉。
  useEffect(() => {
    if (!open || editingEntryId || !isLoanDialog || mode !== "repay_out") return;
    if (repayableLoanAccountsLoading || scheduledDraftAutoAppliedRef.current) return;
    if (!liabilityAccountId) return;
    const row = repayableLoanAccountRows.find((item) => item.accountId === liabilityAccountId);
    // 无还款计划的贷款（自由还款）没有"还款表最近一次"可带出，保持现状。
    if (!row?.currentPlanId) return;
    scheduledDraftAutoAppliedRef.current = true;
    applyScheduledLoanRepaymentDraft(liabilityAccountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 与下方既有 effect 同风格：applyScheduledLoanRepaymentDraft 为组件内函数
  }, [liabilityAccountId, editingEntryId, isLoanDialog, mode, open, repayableLoanAccountRows, repayableLoanAccountsLoading]);
  const repaymentTotal = useMemo(() => {
    if (!principal.trim() && !interest.trim() && !penalty.trim()) return "";
    return (parseMoneyText(principal) + (showInterest ? parseMoneyText(interest) : 0) + (showPrepayment ? parseMoneyText(penalty) : 0)).toFixed(2);
  }, [interest, penalty, principal, showInterest, showPrepayment]);
  const cashAccountLabel = mode === "borrow_in"
    ? (isLoanBorrow ? t("liabilityTx.accountLabel.repaymentAccount") : t("liabilityTx.accountLabel.postingAccount"))
    : mode === "repay_out" || mode === "prepay_out"
      ? t("liabilityTx.accountLabel.expenseAccount")
      : mode === "collect_in"
        ? t("liabilityTx.accountLabel.incomeAccount")
        : t("liabilityTx.accountLabel.expenseAccount");
  const liabilityAccountOptions: SmartSelectOption[] = useMemo(
    () => restrictAccountsByType(localLiabilityAccounts, (account) => {
        if (account.counterpartyId) return true;
        if (mode === "borrow_in") return account.liabilityDirection === "payable";
        if (mode === "repay_out" || mode === "prepay_out") return account.liabilityDirection === "payable";
        if (mode === "collect_in") return account.liabilityDirection === "receivable";
        if (mode === "lend_out") return account.liabilityDirection === "receivable";
        return true;
      })
      .filter((account) => {
        if (loanType) return accountMatchesLoanType(account, loanType);
        return true;
      })
      .map((account) => ({ id: account.id, label: account.label, subLabel: account.subLabel })),
    [localLiabilityAccounts, mode, loanType],
  );
  const repayableLoanAccountOptions: SmartSelectOption[] = useMemo(
    () => repayableLoanAccountRows.flatMap((row) => {
      const account = localLiabilityAccounts.find((item) => item.id === row.accountId);
      // The API already restricts rows to loan accounts. Some callers build
      // AccountOption without kind, so checking it here would silently empty the list.
      // 其他贷款（2026-09-19）：可能挂往来对象而非机构（此时 loanType 未透出），
      // API 行本身即"该日期仍有欠款的贷款账户"，kind=loan 即可放行。
      if (!account || account.kind !== "loan") return [];
      const balance = Math.abs(row.balance);
        return {
          id: account.id,
          label: account.label,
          subLabel: [
            account.subLabel,
            t("liabilityTx.repayableBalanceSubLabel", { date, amount: formatMoneyPreview(balance, language) }),
          ].filter(Boolean).join(" · "),
        };
    }),
    [date, language, localLiabilityAccounts, repayableLoanAccountRows, t],
  );
  useEffect(() => {
    if (!isLoanRepaymentMode || editingEntryId || repayableLoanAccountsLoading || !liabilityAccountId) return;
    // 首帧竞态防护：请求未落地前不判定（此时 rows 还是空的旧值，会误清预选账户）。
    if (!repayableFetchSettledRef.current) return;
    if (!repayableLoanAccountOptions.some((option) => option.id === liabilityAccountId)) {
      setLiabilityAccountId("");
      setLiabilityInstitutionId("");
    }
  }, [liabilityAccountId, editingEntryId, isLoanRepaymentMode, repayableLoanAccountOptions, repayableLoanAccountsLoading]);
  const liabilityObjectAccountOptions: SmartSelectOption[] = useMemo(
    () => localLiabilityAccounts
      .filter((account) => {
        if (!canSelectLiabilityObject) return liabilityAccountOptions.some((option) => option.id === account.id);
        if (!isLiabilityObjectRef(liabilityInstitutionId)) return false;
        const rawId = rawLiabilityObjectId(liabilityInstitutionId);
        if (!isLoanDialog) return account.counterpartyId === rawId;
        if (liabilityInstitutionId.startsWith("counterparty:")) return account.counterpartyId === rawId;
        if (account.institutionId !== rawId) return false;
        const expectedDirection = liabilityDirectionForMode(mode);
        return !account.liabilityDirection || account.liabilityDirection === expectedDirection;
      })
      .map((account) => {
        // 往来款账户不显示借入/借出属性：方向是每笔往来的语义（四类流转），不是账户属性。
        // 只有机构贷款账户才用方向区分「贷款 / 出借给机构」。
        const directionLabel = account.isInstitutionLoan
          ? account.liabilityDirection === "payable"
            ? t(MODE_LABELS.borrow_in)
            : account.liabilityDirection === "receivable"
              ? t(MODE_LABELS.lend_out)
              : t("liabilityTx.direction.unspecified")
          : "";
        return {
          id: account.id,
          label: account.label,
          subLabel: [directionLabel, account.subLabel].filter(Boolean).join(" · "),
        };
      }),
    [canSelectLiabilityObject, liabilityAccountOptions, liabilityInstitutionId, isLoanDialog, localLiabilityAccounts, mode, t],
  );
  const disabled = !isLoanDialog && cashAccounts.length === 0;
  const isFixedRepaymentMethod = isFixedRepaymentMethodValue(repaymentMethod);
  const loanSchedulePreview = useMemo(() => {
    if (!showBorrowPlan || !isFixedRepaymentMethod) return null;
    const firstRunDate = dateInputToUtcDate(isHomeLoanBorrow || autoDebit ? autoDebitFirstDate : firstRepaymentDate);
    const principalAmount = parseAbsMoneyText(principal);
    const totalRuns = Number.parseInt(loanTotalRuns || "0", 10);
    const intervalMonths = Number.parseInt(repaymentIntervalMonths || "1", 10);
    const allowZeroAnnualRate = allowsZeroAnnualRateRepaymentMethod(repaymentMethod) || activeLoanTab === "other";
    const baseAnnualRate = annualRate.trim() ? Number(annualRate) : allowZeroAnnualRate ? 0 : NaN;
    if (
      !firstRunDate ||
      principalAmount <= 0 ||
      !Number.isFinite(totalRuns) ||
      totalRuns <= 0 ||
      (allowZeroAnnualRate
        ? (!Number.isFinite(baseAnnualRate) || baseAnnualRate < 0)
        : (!Number.isFinite(baseAnnualRate) || baseAnnualRate <= 0))
    ) {
      return null;
    }
    const adjustments = showHistoricalRates
      ? normalizeLoanRateAdjustments(historicalRateRows.map((row) => ({
          effectiveDate: row.effectiveDate,
          annualRate: Number(row.annualRate),
        })))
      : [];
    const rows = buildLoanRepaymentSchedulePreview({
      principal: principalAmount,
      repaymentMethod,
      baseAnnualRate,
      adjustments,
      intervalMonths,
      totalRuns,
      firstRunDate,
      maxRows: totalRuns,
    });
    if (rows.length === 0) return null;
    return {
      rows,
      repaymentDay: firstRunDate.getUTCDate(),
      intervalMonths,
      totalPrincipal: roundMoneyValue(rows.reduce((sum, row) => sum + row.principal, 0)),
      totalInterest: roundMoneyValue(rows.reduce((sum, row) => sum + row.interest, 0)),
      totalPayment: roundMoneyValue(rows.reduce((sum, row) => sum + row.payment, 0)),
      hasRateAdjustments: adjustments.length > 0,
    };
  }, [
    activeLoanTab,
    annualRate,
    autoDebit,
    autoDebitFirstDate,
    firstRepaymentDate,
    historicalRateRows,
    isFixedRepaymentMethod,
    isHomeLoanBorrow,
    loanTotalRuns,
    principal,
    repaymentIntervalMonths,
    repaymentMethod,
    showBorrowPlan,
    showHistoricalRates,
  ]);
  const formatRateInput = (value: number) => value.toFixed(3).replace(/\.?0+$/, "");
  function buildMortgageLprHistoricalRateRows(discount: number, loanDate: string) {
    return buildMortgageLprRateAdjustments({
      discount,
      throughDate: today,
      fromDate: loanDate,
    }).map((item) => createHistoricalRateRow(
      item.effectiveDate,
      formatRateInput(item.annualRate),
    ));
  }

  function buildCurrentMortgageLprGeneration(options?: { alertOnInvalid?: boolean; fillDefaultDiscount?: boolean }) {
    const rawDiscount = mortgageLprDiscount.trim();
    const discount = rawDiscount ? Number(rawDiscount) : 1;
    if (!Number.isFinite(discount) || discount <= 0) {
      if (options?.alertOnInvalid) window.alert(t("liabilityTx.alert.lprDiscountInvalid"));
      return null;
    }
    const loanDate = isValidDateInput(date) ? date : today;
    if (!rawDiscount && options?.fillDefaultDiscount) setMortgageLprDiscount(formatRateInput(discount));
    return {
      discount,
      loanDate,
      rows: buildMortgageLprHistoricalRateRows(discount, loanDate),
    };
  }

  function applyMortgageLprDiscount(options?: { silent?: boolean }) {
    const generated = buildCurrentMortgageLprGeneration({
      alertOnInvalid: !options?.silent,
      fillDefaultDiscount: !options?.silent,
    });
    if (!generated) return;

    const quote = getMortgageBankExecutionRate(generated.loanDate);
    const fetchedAnnualRate = quote ? quote.rate * generated.discount : null;
    if (fetchedAnnualRate != null && (!annualRateManuallyEdited || !options?.silent || !annualRate.trim())) {
      setAnnualRate(formatRateInput(fetchedAnnualRate));
    }
    if (generated.rows.length > 0) {
      setHistoricalRateRows(generated.rows);
      setShowHistoricalRates(true);
    }
  }

  function handleMortgageLprDiscountBlur() {
    if (!mortgageLprDiscount.trim()) return;
    applyMortgageLprDiscount({ silent: true });
  }

  const renderDateField = () => (
    <div className="space-y-1">
      <div className="form-label">{isLoanRepaymentMode ? t("liabilityTx.date.repayment") : isLoanBorrow ? t("liabilityTx.date.occurred") : t("detail.column.date")}</div>
      <DateStepper
        name="date"
        value={date}
        disabled={isLoanBorrowEditLocked}
        onChange={(value) => {
          if (isLoanBorrowEditLocked) return;
          scheduledDateManualRef.current = isLoanRepaymentMode;
          setDate(value);
        }}
      />
    </div>
  );

  const renderCashAccountField = (options?: { label?: string; value?: string; onChange?: (id: string) => void; locked?: boolean }) => {
    const locked = options?.locked === true;
    return (
    <div className={`space-y-1 ${locked ? "pointer-events-none opacity-70" : ""}`}>
      <div className="form-label">{options?.label ?? cashAccountLabel}</div>
      <SmartSelect
        mode="single"
        value={options?.value ?? cashAccountId}
        onChange={locked ? () => {} : (options?.onChange ?? setCashAccountId)}
        options={visibleCashOptions}
        placeholder={t("txForm.selectPlaceholder")}
        onCreateClick={locked ? undefined : () => setCashAccountNestedOpen(true)}
        createLabel={t("settings.accounts.add")}
        behavior={{
          hierarchy: "auto",
          search: "auto",
          clearable: false,
          headerExtra: locked ? undefined : cashOwnerCycleButton,
        }}
      />
    </div>
    );
  };

  function handleFirstRepaymentDateChange(value: string) {
    setFirstRepaymentDate(value);
  }

  const renderLiabilityObjectField = () => canSelectLiabilityObject ? (
    <div className="space-y-1">
      <div className="form-label">{isLoanDialog ? t("liabilityTx.loanInstitution") : t("txForm.counterparty")}</div>
      <SmartSelect
        mode="single"
        value={liabilityInstitutionId}
        onChange={handleLiabilityItemOrObjectChange}
        options={visibleLiabilityObjectOptions}
        placeholder={isLoanDialog ? t("liabilityTx.placeholder.selectLoanInstitution") : t("liabilityTx.placeholder.selectCounterparty")}
        onCreateClick={() => { void openLiabilityObjectCreate(); }}
        createLabel={isLoanDialog ? t("liabilityTx.addLoanInstitution") : t("txForm.addCounterparty")}
        behavior={{
          hierarchy: false,
          search: true,
          clearable: false,
          minDropdownWidth: 320,
        }}
      />
    </div>
  ) : null;

  const renderRepayableLoanAccountField = () => (
    <div className="space-y-1">
      <div className="form-label">{t("liabilityTx.loanAccount")} <span className="text-red-500">*</span></div>
      <SmartSelect
        mode="single"
        value={liabilityAccountId}
        onChange={handleLiabilityAccountChange}
        options={repayableLoanAccountOptions}
        placeholder={repayableLoanAccountsLoading ? t("liabilityTx.placeholder.loadingRepayableLoanAccounts") : t("liabilityTx.placeholder.selectRepayableLoanAccount")}
        behavior={{
          hierarchy: false,
          search: true,
          clearable: false,
          minDropdownWidth: 420,
        }}
      />
      <div className="text-[11px] text-slate-500">
        {!repayableLoanAccountsLoading && repayableLoanAccountOptions.length === 0
          ? t("liabilityTx.noRepayableLoanAccountsForDate")
          : t("liabilityTx.repayableLoanAccountHint")}
      </div>
    </div>
  );

  const renderLiabilityAccountField = (options?: { label?: string }) => isLoanBorrow && editingEntryId ? (() => {
    // 编辑借入记录时贷款账户已存在，名称属于账户本身：只读展示、不允许修改，
    // 提交时不再回写账户名（liabilityItemName 留空 → 服务端沿用账户现名）。
    const editLoanAccountName = (liabilityAccountId ? localLiabilityAccounts.find((account) => account.id === liabilityAccountId)?.label : "")
      || liabilityItemName
      || t("liabilityTx.loanAccountNameMissing");
    return (
      <div className="space-y-1">
        <div className="form-label">{t("liabilityTx.loanName")}</div>
        <input
          value={editLoanAccountName}
          readOnly
          disabled
          className="form-input cursor-not-allowed bg-slate-50 text-slate-700"
        />
      </div>
    );
  })() : canSelectLiabilityObject ? (
    <div className="space-y-1">
      <div className="form-label">{options?.label ?? (isLoanDialog ? t("liabilityTx.loanAccount") : t("liabilityTx.counterpartyAccount"))}</div>
      <SmartSelect
        mode="single"
        value={liabilityAccountId}
        onChange={handleLiabilityAccountChange}
        options={liabilityObjectAccountOptions}
        placeholder={liabilityInstitutionId ? t("liabilityTx.placeholder.autoReuseOrCreate") : t(isLoanDialog ? "liabilityTx.placeholder.selectLoanInstitutionFirst" : "liabilityTx.placeholder.selectObjectFirst")}
        onCreateClick={canCreateLiabilityItem && isLiabilityObjectRef(liabilityInstitutionId) ? () => { void openLiabilityAccountCreate(); } : undefined}
        createLabel={isLoanDialog ? t("liabilityTx.addLoanAccount") : t("liabilityTx.addAccount")}
        behavior={{
          hierarchy: false,
          search: true,
          clearable: true,
          minDropdownWidth: 360,
        }}
      />
    </div>
  ) : showPrepayment ? (
    <div className="col-span-2 space-y-1">
      <div className="form-label">{t("liabilityTx.borrowItem")}</div>
      <SmartSelect
        mode="single"
        value={liabilityAccountId}
        onChange={setLiabilityAccountId}
        options={liabilityAccountOptions}
        placeholder={t("liabilityTx.placeholder.selectExistingBorrowing")}
        behavior={{
          hierarchy: false,
          search: true,
          clearable: false,
          minDropdownWidth: 360,
        }}
      />
    </div>
  ) : (
    <div className="col-span-2 space-y-1">
      <div className="form-label">{mode === "repay_out" ? t("liabilityTx.borrowItem") : t("liabilityTx.lendItem")}</div>
      <SmartSelect
        mode="single"
        value={liabilityAccountId}
        onChange={setLiabilityAccountId}
        options={liabilityAccountOptions}
        placeholder={mode === "repay_out" ? t("liabilityTx.placeholder.selectExistingBorrowing") : t("liabilityTx.placeholder.selectExistingLending")}
        behavior={{
          hierarchy: false,
          search: true,
          clearable: false,
          minDropdownWidth: 360,
        }}
      />
    </div>
  );

  const renderLoanTotalField = () => (
    <div className="space-y-1">
      <div className="form-label">{t("liabilityTx.totalBorrowing")}</div>
      <CalcInput
        value={principal}
        onChange={isLoanBorrowEditLocked ? () => {} : setPrincipal}
        disabled={isLoanBorrowEditLocked}
        placeholder={t("liabilityTx.placeholder.exampleAmount")}
        label={t("liabilityTx.totalBorrowing")}
        precision={2}
      />
    </div>
  );

  const renderFixedAssetAccountSelect = () => (
    <div className={isLoanBorrowEditLocked ? "pointer-events-none opacity-70" : undefined}>
      <SmartSelect
        mode="single"
        value={fixedAssetAccountId}
        onChange={isLoanBorrowEditLocked ? () => {} : (id: string) => {
          setFixedAssetAccountId(id);
          setFixedAssetAssetId("");
          recordRecentAccount(id);
        }}
        options={fixedAssetAccountOptions}
        placeholder={t("txForm.selectFixedAssetAccount")}
        onCreateClick={isLoanBorrowEditLocked ? undefined : () => setFixedAssetAccountNestedOpen(true)}
        createLabel={t("txForm.createFixedAssetAccount")}
        behavior={{
          hierarchy: "auto",
          search: "auto",
          clearable: false,
          minDropdownWidth: 360,
        }}
      />
    </div>
  );

  const renderLoanFixedAssetField = (options?: { accountSelect?: "inline" | "separate" }) => showLoanFixedAssetFields ? (
    <div className="space-y-1">
      <div className="form-label">{t("txForm.fixedAssetToggle")}</div>
      <div className="flex h-8 items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={fixedAssetLinked}
          aria-label={t("txForm.fixedAssetToggle")}
          onClick={handleFixedAssetToggle}
          className={[
            "flex h-8 w-12 items-center justify-center rounded-full border px-1.5 text-xs font-medium transition",
            fixedAssetLinked
              ? "border-blue-300 bg-blue-50 text-blue-700"
              : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
          ].join(" ")}
        >
          <span
            className={[
              "relative h-4 w-7 shrink-0 rounded-full transition",
              fixedAssetLinked ? "bg-blue-600" : "bg-slate-300",
            ].join(" ")}
          >
            <span
              className={[
                "absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition",
                fixedAssetLinked ? "left-3.5" : "left-0.5",
              ].join(" ")}
            />
          </span>
        </button>
      </div>
      {fixedAssetLinked && options?.accountSelect !== "separate" ? renderFixedAssetAccountSelect() : null}
    </div>
  ) : null;

  // 固定资产 SS：抵押贷（抵押物，必选、全类型）与房贷（购入房产，可选、仅房产型）共用，
  // 选中资产后自动带出其固定资产账户。
  const renderRequiredFixedAssetField = (options?: { required?: boolean; clearable?: boolean; optionalHint?: boolean }) => {
    const isRequired = options?.required ?? true;
    return (
    <div className="space-y-1">
      <div className="form-label">
        {t("txForm.fixedAssetToggle")}
        {isRequired ? <span className="text-red-500"> *</span> : options?.optionalHint ? <span className="text-slate-400"> {t("stockFee.optional")}</span> : null}
      </div>
      <SmartSelect
        mode="single"
        value={fixedAssetAssetId}
        onChange={handleCollateralFixedAssetChange}
        options={fixedAssetAssetOptions}
        placeholder={fixedAssetAssetsLoading ? t("common.loading") : t("liabilityTx.fixedAssetPlaceholder")}
        onCreateClick={() => {
          setFixedAssetCreateAccountId(
            fixedAssetAccountId || (fixedAssetAccountOptions.find((option) => !option.isHeader && !option.isGroup)?.id ?? ""),
          );
          setFixedAssetCreateName("");
          setFixedAssetCreateDate(today);
          setFixedAssetCreateAmount("");
          setFixedAssetAssetNestedOpen(true);
        }}
        createLabel={t("txForm.createFixedAsset")}
        behavior={{
          hierarchy: false,
          search: true,
          clearable: options?.clearable ?? false,
          minDropdownWidth: 360,
        }}
      />
    </div>
    );
  };

  const renderFixedAssetAccountCreateForm = () => (
    <EntityCreateForm
      mode="compact"
      entityType="account"
      open={fixedAssetAccountNestedOpen}
      onClose={() => setFixedAssetAccountNestedOpen(false)}
      title={t("txForm.createFixedAssetAccount")}
      nameLabel={t("txForm.fixedAssetAccountName")}
      namePlaceholder={t("txForm.fixedAssetAccountPlaceholder")}
      defaultType="investment"
      nestedFieldData={localNestedFieldData ?? nestedFieldData}
      hiddenFields={[
        "kind",
        "investProductType",
        "institutionId",
        "fundUnitsDecimals",
        "tradingCalendar",
        "costBasisMethod",
      ]}
      extraFields={{ kind: "investment", investProductType: "property" }}
      onCreated={(id, name, extra) => {
        // 显示口径与既有账户下拉一致：所有人 · 投资（不再单独显示「固定资产账户」），
        // 并归入对应所有人分组，选中态标题用统一的 hover 口径。
        const groupId = extra?.groupId?.trim() ?? "";
        const groupName = extra?.groupName?.trim() ?? "";
        const kindText = t("account.kind.investment");
        const option: SmartSelectOption = {
          id,
          label: name,
          subLabel: [groupName, kindText].filter(Boolean).join(" · "),
          title: formatAccountHoverTitle({ groupName, label: name, subLabel: kindText }),
          parentId: groupId ? `group:${groupId}` : undefined,
        };
        setFixedAssetAccountList((prev) => (prev.some((item) => item.id === id) ? prev : [...prev, option]));
        setLocalFixedAssetAccountSSOpts((prev) => {
          const next = mergeSmartSelectOptions(prev, [option]);
          if (groupId && groupName && !next.some((item) => item.id === `group:${groupId}`)) {
            next.push({ id: `group:${groupId}`, label: groupName, isHeader: true });
          }
          return next;
        });
        setFixedAssetLinked(true);
        setFixedAssetAccountId(id);
        setFixedAssetCreateAccountId(id);
        setFixedAssetAssetId("");
        setFixedAssetAccountNestedOpen(false);
      }}
    />
  );

  async function submitFixedAssetCreate() {
    if (fixedAssetCreateSubmitting) return;
    const accountId = fixedAssetCreateAccountId.trim();
    const name = fixedAssetCreateName.trim();
    if (!accountId) {
      window.alert(t("txForm.alert.selectFixedAssetAccount"));
      return;
    }
    // 资产名称可选：留空时沿用账户名称（与支出链路 linkExpenseToFixedAsset 的
    // 「propertyName || propertyAccount.name」口径一致）；购入金额可选：留空按 0 记
    // （仅登记资产、不生成现金流）。
    const assetName = name || fixedAssetAccountLabelById.get(accountId) || "";
    const tradeDate = fixedAssetCreateDate.trim() || today;
    setFixedAssetCreateSubmitting(true);
    try {
      const res = await fetch("/api/v1/properties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          name: assetName,
          tradeDate,
          amount: fixedAssetCreateAmount,
          action: "purchase",
        }),
      });
      const data = await res.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        data?: { transaction?: { propertyAssetId?: string; accountId?: string; propertyName?: string | null } | null };
      } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("txForm.alert.createFixedAssetFailed"));
      const created = data.data?.transaction;
      if (created?.propertyAssetId) {
        const option: FixedAssetAssetOption = {
          id: created.propertyAssetId,
          accountId: created.accountId ?? accountId,
          name: created.propertyName ?? assetName,
          mortgageLoanAccountId: null,
          status: "active",
        };
        setFixedAssetAssets((prev) => (prev.some((item) => item.id === option.id) ? prev : [option, ...prev]));
        setFixedAssetAccountId(option.accountId);
        setFixedAssetAssetId(option.id);
      }
      setFixedAssetAssetNestedOpen(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("txForm.alert.createFixedAssetFailed"));
    } finally {
      setFixedAssetCreateSubmitting(false);
    }
  }

  const renderRepaymentMethodField = () => (
    <div className="space-y-1">
      <div className="form-label">{t("liabilityTx.repaymentMethod")}</div>
      <select
        value={repaymentMethod}
        disabled={isLoanBorrowEditLocked}
        onChange={(event) => {
          if (isLoanBorrowEditLocked) return;
          const method = event.target.value;
          setRepaymentMethod(method);
          if (isInstallmentRepaymentMethod(method) && parseNonNegativeNumberText(annualRate) == null) {
            setAnnualRate("0");
            setAnnualRateManuallyEdited(false);
          }
        }}
        className={isConsumerLoanBorrow ? "form-input rounded-[8px] px-2 text-xs disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500" : "form-input disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"}
        style={isConsumerLoanBorrow ? { height: 32, minHeight: 32 } : undefined}
      >
        <option value={EQUAL_PAYMENT_REPAYMENT_METHOD}>{t("liabilityTx.method.equalInstallment")}</option>
        <option value={EQUAL_PRINCIPAL_REPAYMENT_METHOD}>{t("liabilityTx.method.equalPrincipal")}</option>
        <option value={INSTALLMENT_REPAYMENT_METHOD}>{t("liabilityTx.method.interestFreeInstallment")}</option>
        <option value={FREE_REPAYMENT_METHOD}>{t("liabilityTx.method.freeRepayment")}</option>
        <option value={INTEREST_FIRST_REPAYMENT_METHOD}>{t("liabilityTx.method.interestFirstThenPrincipal")}</option>
      </select>
    </div>
  );

  const renderFirstRepaymentDateField = () => (
    <div className="space-y-1">
      <div className="form-label">{t("liabilityTx.firstRepaymentDate")} <span className="text-red-500">*</span></div>
      <DateStepper value={firstRepaymentDate} disabled={isLoanBorrowEditLocked} onChange={isLoanBorrowEditLocked ? () => {} : handleFirstRepaymentDateChange} />
    </div>
  );

  const renderFirstBillDateField = () => (
    <div className="space-y-1">
      <div className="form-label">{t("liabilityTx.firstBillDate")} <span className="text-red-500">*</span></div>
      <DateStepper value={firstBillDate} disabled={isLoanBorrowEditLocked} onChange={isLoanBorrowEditLocked ? () => {} : setFirstBillDate} />
    </div>
  );

  const renderAutoDebitDateField = () => (
    <div className="space-y-1">
      <div className="form-label">{t("liabilityTx.autoDebitDate")} <span className="text-red-500">*</span></div>
      <DateStepper value={autoDebitFirstDate} disabled={isLoanBorrowEditLocked} onChange={isLoanBorrowEditLocked ? () => {} : setAutoDebitFirstDate} />
    </div>
  );

  const renderAutoDebitCashAccountField = () => renderCashAccountField({
    label: t("liabilityTx.autoDebitAccount"),
    value: isCollateralLoanBorrow ? autoDebitCashAccountId : cashAccountId,
    onChange: isCollateralLoanBorrow ? setAutoDebitCashAccountId : setCashAccountId,
  });

  const renderLoanTotalRunsField = () => (
    <div className="space-y-1">
      <div className="form-label">
        {t("liabilityTx.totalRuns")}
        {isLoanBorrow && activeLoanTab === "other"
          ? <span className="text-slate-400"> {t("liabilityTx.totalRuns.optionalZeroHint")}</span>
          : <span className="text-red-500"> *</span>}
      </div>
      <input
        type="number"
        min={isLoanBorrow && activeLoanTab === "other" ? 0 : 1}
        max={600}
        value={loanTotalRuns}
        disabled={isLoanBorrowEditLocked}
        onChange={(event) => {
          if (isLoanBorrowEditLocked) return;
          setLoanTotalRuns(event.target.value);
        }}
        className="form-input disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"
      />
    </div>
  );

  const renderAnnualRateField = () => (
    <div className="space-y-1">
      <div className="form-label">
        {t("liabilityShell.rateAdjust.annualRateLabel")}
        {allowsZeroAnnualRateRepaymentMethod(repaymentMethod) || (isLoanBorrow && activeLoanTab === "other") ? (
          <span className="text-slate-400"> {t("stockFee.optional")}</span>
        ) : (
          <span className="text-red-500"> *</span>
        )}
      </div>
      <input
        value={annualRate}
        onChange={(event) => {
          setAnnualRateManuallyEdited(true);
          setAnnualRate(event.target.value);
        }}
        placeholder={allowsZeroAnnualRateRepaymentMethod(repaymentMethod) || (isLoanBorrow && activeLoanTab === "other") ? "0" : t("liabilityTx.placeholder.exampleAnnualRate")}
        inputMode="decimal"
        className="form-input"
      />
    </div>
  );

  return (
    <ModalLayerProvider value={modalZIndex}>
      {showTriggerButton ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            resetDraft();
          }}
          disabled={disabled}
          className="primary-button h-8 gap-1 px-3 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          {editingEntryId ? t("liabilityTx.editRepayment") : triggerLabel ?? (isLoanDialog ? t("liabilityTx.loanTitle") : t("liabilityTx.borrowRepay"))}
          <ChevronDown className="w-4 h-4 opacity-90" />
        </button>
      ) : null}

      {open
        ? createPortal(
            <div className="app-modal-backdrop" style={{ zIndex: modalZIndex }}>
              <div className="app-modal-panel max-w-xl">
                  <div className="modal-header shrink-0">
                    <div className="text-sm font-semibold text-slate-800">
                      {editingEntryId
                        ? (isLoanDialog ? t("liabilityTx.editLoan") : t("liabilityTx.editRepayment"))
                        : isLoanDialog ? t("liabilityTx.loanTitle") : t("liabilityTx.title")}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          resetDraft();
                        }}
                        className="secondary-button h-8 px-2"
                      >
                        {t("table.close")}
                      </button>
                    </div>
                  </div>

                  <form className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" onSubmit={onSubmit}>
                    {isLoanDialog ? (
                      activeLoanTab === "repay_out" ? (
                        <div className="text-sm font-semibold text-slate-700">{t("liabilityTx.loanMode.repayment")}</div>
                      ) : (
                        <label className="block space-y-1">
                          <div className="form-label">{t("settings.accounts.loanCategory")}</div>
                          <select
                            value={loanCategoryId}
                            disabled={isLoanBorrowEditLocked}
                            onChange={(event) => {
                              const nextId = event.target.value;
                              const option = loanCategoryOptions.find((item) => item.id === nextId);
                              setLoanCategoryId(nextId);
                              if (option) handleLoanTabSelect(option.baseType);
                            }}
                            className="form-input"
                          >
                            <option value="">{t("txForm.selectPlaceholder")}</option>
                            {loanCategoryOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.isSystem ? t(`loan.type.${option.baseType}`) : option.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      )
                    ) : null}

                    {isLoanBorrow ? (
                      <>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {renderDateField()}
                          {renderLiabilityObjectField()}
                        </div>
                        {isCollateralLoanBorrow ? (
                          <>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                              {renderLiabilityAccountField()}
                              {renderCashAccountField({ label: t("liabilityTx.accountLabel.postingAccount"), locked: isLoanBorrowEditLocked })}
                            </div>
                            {renderRequiredFixedAssetField()}
                            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
                              {renderLoanTotalField()}
                              <div className={isLoanBorrowEditLocked ? "pointer-events-none opacity-70" : undefined}>
                                <EntryTagsField value={selectedTagIds} onChange={isLoanBorrowEditLocked ? () => {} : setSelectedTagIds} />
                              </div>
                            </div>
                          </>
                        ) : (
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {renderLiabilityAccountField()}
                            {renderLoanTotalField()}
                          </div>
                        )}
                      </>
                    ) : isLoanRepaymentMode ? (
                      <>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {renderDateField()}
                          {renderCashAccountField()}
                        </div>
                        {renderRepayableLoanAccountField()}
                        <div className="grid grid-cols-2 gap-2">
                          {(["repay_out", "prepay_out"] as const).map((item) => (
                            <button
                              key={item}
                              type="button"
                              onClick={() => handleModeSelect(item)}
                              disabled={!!editingEntryId && !canSwitchLiabilityEditMode(mode, item)}
                              className={`segment-button h-9 ${mode === item ? "segment-button-active" : ""}`}
                            >
                              {t(MODE_LABELS[item])}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => handleModeSelect(resolveFlowMode(false))}
                            disabled={!!editingEntryId && !canSwitchLiabilityEditMode(mode, resolveFlowMode(false))}
                            className={`segment-button h-9 ${flowTab === "borrow" ? "segment-button-active" : ""}`}
                          >
                            {t("liabilityTx.flow.borrow")}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleModeSelect(resolveFlowMode(true))}
                            disabled={!!editingEntryId && !canSwitchLiabilityEditMode(mode, resolveFlowMode(true))}
                            className={`segment-button h-9 ${flowTab === "repay" ? "segment-button-active" : ""}`}
                          >
                            {t("liabilityTx.flow.repay")}
                          </button>
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {renderLiabilityObjectField()}
                          {renderDateField()}
                        </div>
                        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
                          <div>
                            {liabilitySideIsOut
                              ? renderLiabilityAccountField({ label: t("liabilityTx.flow.outAccount") })
                              : renderCashAccountField({ label: t("liabilityTx.flow.outAccount") })}
                          </div>
                          <div className="flex flex-col items-center pb-0.5">
                            <div className="mb-1 flex h-6 items-center justify-center text-slate-400">
                              <ArrowRight className="h-4 w-4" />
                            </div>
                            <button
                              type="button"
                              onClick={swapLiabilityDirection}
                              disabled={!liabilityAccountId && !cashAccountId}
                              title={t("liabilityTx.flow.swap")}
                              className="secondary-button h-9 w-9 px-0 text-slate-700"
                            >
                              <ArrowLeftRight className="h-4 w-4" />
                            </button>
                          </div>
                          <div>
                            {liabilitySideIsOut
                              ? renderCashAccountField({ label: t("liabilityTx.flow.inAccount") })
                              : renderLiabilityAccountField({ label: t("liabilityTx.flow.inAccount") })}
                          </div>
                        </div>
                      </>
                    )}
                    {!!liabilityAccountId && isLoanRepaymentMode && !showPrepayment ? (
                      selectedRepaymentCurrentPeriodPaid ? (
                        <div className="flex items-start justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
                          <div className="flex items-start gap-2">
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                            <div className="text-xs leading-5 text-emerald-800">
                              <span className="font-medium">{t("liabilityTx.currentPeriodPaidLabel")}</span>
                              {selectedRepaymentUnpaidPeriod != null ? (
                                <span className="block text-[11px] text-emerald-600">
                                  {t("liabilityTx.currentPeriodPaidHint", { period: selectedRepaymentUnpaidPeriod })}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleModeSelect("prepay_out")}
                            className="shrink-0 self-center rounded-full border border-emerald-300 bg-white px-3 py-1 text-xs font-medium text-emerald-700 transition hover:bg-emerald-50"
                          >
                            {t("liabilityTx.prepaySwitch")}
                          </button>
                        </div>
                      ) : selectedRepayableLoanRow?.currentPrincipal != null ? (
                        <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2">
                          <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                          <div className="text-xs leading-5 text-blue-800">
                            <span className="font-medium">{t("liabilityTx.currentUnpaidPeriodLabel", { due: selectedRepayableLoanRow?.currentDueDate ?? "" })}</span>
                            <span className="block text-[11px] text-blue-600">
                              {t("liabilityTx.currentUnpaidPeriodHint", { period: selectedRepaymentUnpaidPeriod ?? 0, due: selectedRepayableLoanRow?.currentDueDate ?? "", amount: formatMoneyPreview((selectedRepayableLoanRow?.currentPrincipal ?? 0) + (selectedRepayableLoanRow?.currentInterest ?? 0), language) })}
                            </span>
                          </div>
                        </div>
                      ) : null
                    ) : null}

                    {!showPrepayment && !showBorrowPlan ? (
                    <div className={`grid gap-3 ${showInterest ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1"}`}>
                      <div className="space-y-1">
                        <div className="form-label">{isFlowLiability ? t("liabilityShell.colPrincipal") : mode === "borrow_in" ? t("liabilityTx.totalBorrowing") : mode === "repay_out" || mode === "collect_in" || mode === "lend_out" ? t("liabilityShell.colPrincipal") : t("txForm.amount")}</div>
                        <CalcInput value={principal} onChange={isFlowLiability ? handleFlowPrincipalChange : setPrincipal} placeholder={t("liabilityTx.placeholder.exampleAmount")} label={t("txForm.amount")} precision={2} />
                      </div>
                      {showInterest ? (
                        <div className="space-y-1">
                          <div className="form-label">{t("liabilityShell.colInterest")}</div>
                          <CalcInput value={interest} onChange={isFlowLiability ? handleFlowInterestChange : setInterest} placeholder={t("liabilityTx.placeholder.exampleInterest")} label={t("liabilityShell.colInterest")} precision={2} />
                        </div>
                      ) : null}
                      {showInterest && !showPrepayment ? (
                        <div className="space-y-1">
                            <div className="form-label">{t("liabilityTx.principalInterestTotal")}</div>
                          {isFlowLiability ? (
                            <CalcInput
                              value={flowTotalManual ? flowTotalDraft : repaymentTotal}
                              onChange={handleFlowTotalChange}
                              placeholder={t("liabilityShell.lpr.autoCalculated")}
                              label={t("liabilityTx.principalInterestTotal")}
                              precision={2}
                            />
                          ) : (
                          <input
                            value={repaymentTotal}
                            readOnly
                            placeholder={t("liabilityShell.lpr.autoCalculated")}
                            className="form-input bg-slate-50 text-right font-mono text-slate-700"
                          />
                          )}
                        </div>
                      ) : null}
                    </div>
                    ) : null}

                    {showPrepayment ? (
                      <>
                        <div className={`grid grid-cols-1 gap-3 ${showPrepayInterest ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
                          <div className="space-y-1">
                            <div className="form-label">{t("liabilityTx.prepayPrincipal")}</div>
                            <CalcInput value={principal} onChange={handlePrincipalChange} placeholder={t("liabilityTx.placeholder.exampleAmount")} label={t("liabilityTx.prepayPrincipal")} precision={2} />
                          </div>
                          {showPrepayInterest ? (
                            <div className="space-y-1">
                              <div className="form-label">{t("liabilityTx.prepayInterest")}</div>
                              <CalcInput value={interest} onChange={handlePrepayInterestChange} placeholder={t("liabilityTx.placeholder.autoOrManual")} label={t("liabilityTx.prepayInterest")} precision={2} />
                            </div>
                          ) : null}
                          <div className="space-y-1">
                            <div className="form-label">{t("liabilityTx.feePenalty")}</div>
                            <CalcInput value={penalty} onChange={handlePenaltyChange} placeholder={t("stockFee.optional")} label={t("txForm.fee")} precision={2} />
                          </div>
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <div className="form-label">{t("liabilityTx.handleFollowUpPlan")}</div>
                            <select
                              value={prepayStrategy}
                              onChange={(event) => handlePrepayStrategyChange(event.target.value as PrepayStrategy)}
                              className="form-input"
                            >
                              {(Object.keys(PREPAY_STRATEGY_LABELS) as PrepayStrategy[]).map((item) => (
                                <option key={item} value={item}>{t(PREPAY_STRATEGY_LABELS[item])}</option>
                              ))}
                            </select>
                          </div>
                          <div className="space-y-1">
                            <div className="form-label">{t("liabilityTx.expenseTotal")}</div>
                            <CalcInput
                              value={prepayTotal}
                              onChange={handlePrepayTotalChange}
                              onBlur={() => applyPrepayTotalDraft()}
                              placeholder={t("liabilityTx.placeholder.autoOrManual")}
                              label={t("liabilityTx.expenseTotal")}
                              precision={2}
                            />
                          </div>
                        </div>
                        {showPrepayInterest ? (
                          <p className="text-xs leading-5 text-slate-500">
                            {selectedRepayableLoanRow?.prepayAnnualRate != null && selectedRepayableLoanRow.prepayAnnualRate > 0
                              ? t("liabilityTx.prepayInterestHint", {
                                  from: selectedRepayableLoanRow.prepayInterestFromDate ?? "",
                                  days: selectedRepayableLoanRow.prepayInterestDays ?? 0,
                                  rate: formatRateInput(selectedRepayableLoanRow.prepayAnnualRate),
                                })
                              : selectedRepayableLoanRow?.prepayAnnualRate != null && selectedRepayableLoanRow.prepayAnnualRate <= 0
                                ? t("liabilityTx.prepayInterestHintZeroRate")
                                : t("liabilityTx.prepayInterestHintNoRate")}
                          </p>
                        ) : null}
                      </>
                    ) : null}

                    {showBorrowPlan ? (
                      <>
                        {isCollateralLoanBorrow ? (
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                            {renderRepaymentMethodField()}
                            {renderLoanTotalRunsField()}
                            {renderAnnualRateField()}
                          </div>
                        ) : isConsumerLoanBorrow ? (
                          <>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                              {showLoanPurpose ? (
                                <div className={`space-y-1 ${isLoanBorrowEditLocked ? "pointer-events-none opacity-70" : ""}`}>
                                  <div className="form-label">{t("liabilityTx.loanPurpose")} <span className="text-red-500">*</span></div>
                                  <SmartSelect
                                    mode="single"
                                    value={loanPurposeCategoryId}
                                    onChange={isLoanBorrowEditLocked ? () => {} : handleLoanPurposeChange}
                                    options={loanPurposeOptions}
                                    placeholder={t("liabilityTx.loanPurposePlaceholder")}
                                    behavior={{
                                      hierarchy: true,
                                      search: true,
                                      initialCollapsedAll: true,
                                      accordionGroups: true,
                                      selectableGroups: true,
                                      groupSelectOnDoubleClick: false,
                                      minDropdownWidth: 560,
                                      dropdownMaxHeight: 420,
                                      density: "compact",
                                      expandedGroupColumns: 4,
                                    }}
                                  />
                                </div>
                              ) : null}
                              {renderLoanFixedAssetField({ accountSelect: "separate" })}
                              {renderRepaymentMethodField()}
                            </div>
                            {fixedAssetLinked ? (
                              <div className="space-y-1">
                                <div className="form-label">{t("txForm.fixedAssetAccount")}</div>
                                {renderFixedAssetAccountSelect()}
                              </div>
                            ) : null}
                          </>
                        ) : isHomeLoanBorrow ? (
                          // 房贷关联固定资产为可选（仅房产型）：SS 可清空，不选则不提交关联。
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {renderRequiredFixedAssetField({ required: false, clearable: true, optionalHint: true })}
                            {renderRepaymentMethodField()}
                          </div>
                        ) : (
                          // 其他贷款：固定资产开关独占一行；入账资金账户 + 还款方式同行（资金账户在前）。
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="sm:col-span-2">{renderLoanFixedAssetField()}</div>
                            {renderCashAccountField({ label: t("liabilityTx.otherLoan.disbursementAccount") })}
                            {renderRepaymentMethodField()}
                          </div>
                        )}

                        {isFixedRepaymentMethod ? (
                          <>
                            {isConsumerLoanBorrow ? (
                              autoDebit ? (
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                  {renderLoanTotalRunsField()}
                                  {renderAnnualRateField()}
                                </div>
                              ) : (
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                  {renderFirstBillDateField()}
                                  {renderFirstRepaymentDateField()}
                                  {renderLoanTotalRunsField()}
                                  {renderAnnualRateField()}
                                </div>
                              )
                            ) : isCollateralLoanBorrow ? null : (
                              <>
                                <div className={`grid grid-cols-1 gap-3 ${showHomeLoanLprFields ? "sm:grid-cols-4" : "sm:grid-cols-2"}`}>
                                  {renderLoanTotalRunsField()}
                                  {renderAnnualRateField()}
                                  {showHomeLoanLprFields ? (
                                    <div className="flex items-end">
                                      <button
                                        type="button"
                                        className="secondary-button h-9 shrink-0 gap-1.5 whitespace-nowrap px-3 disabled:cursor-not-allowed disabled:opacity-50"
                                        disabled={isLoanBorrowEditLocked}
                                        onClick={() => { if (!isLoanBorrowEditLocked) void applyMortgageLprDiscount(); }}
                                        title={t("liabilityTx.fetchLprRate")}
                                        aria-label={t("liabilityTx.fetchLprRate")}
                                      >
                                        <RefreshCw size={14} />
                                        {t("liabilityTx.fetchLprRate")}
                                      </button>
                                    </div>
                                  ) : null}
                                  {showHomeLoanLprFields ? (
                                    <div className="space-y-1">
                                      <div className="form-label">{t("liabilityShell.lpr.discountLabel")} <span className="text-slate-400">{t("stockFee.optional")}</span></div>
                                      <input
                                        value={mortgageLprDiscount}
                                        disabled={isLoanBorrowEditLocked}
                                        onChange={(event) => {
                                          if (isLoanBorrowEditLocked) return;
                                          setMortgageLprDiscount(event.target.value);
                                        }}
                                        onBlur={isLoanBorrowEditLocked ? undefined : handleMortgageLprDiscountBlur}
                                        placeholder={t("liabilityShell.lpr.discountPlaceholder")}
                                        inputMode="decimal"
                                        className="form-input disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"
                                      />
                                    </div>
                                  ) : null}
                                </div>
                              </>
                            )}

                            {isHomeLoanBorrow ? (
                              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                  {renderAutoDebitDateField()}
                                  {renderAutoDebitCashAccountField()}
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                                <label className={`flex select-none items-start gap-2 text-xs text-slate-600 ${isLoanBorrowEditLocked ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}>
                                  <input
                                    type="checkbox"
                                    checked={autoDebit}
                                    disabled={isLoanBorrowEditLocked}
                                    onChange={(event) => {
                                      if (isLoanBorrowEditLocked) return;
                                      const checked = event.target.checked;
                                      setAutoDebit(checked);
                                      if (checked) {
                                        setAutoDebitFirstDate(firstRepaymentDate || addMonthsInput(today, 1));
                                      } else {
                                        setFirstBillDate(firstBillDate || autoDebitFirstDate);
                                        setFirstRepaymentDate(firstRepaymentDate || autoDebitFirstDate);
                                      }
                                    }}
                                    className="mt-0.5 h-3.5 w-3.5 accent-blue-600"
                                  />
                                  <span>
                                    {t("liabilityTx.autoDebitLabel")}
                                    <span className="block text-[11px] text-slate-400">{t("liabilityTx.autoDebitHint")}</span>
                                  </span>
                                </label>
                                {autoDebit ? (
                                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    {renderFirstBillDateField()}
                                    {renderAutoDebitDateField()}
                                    {renderAutoDebitCashAccountField()}
                                  </div>
                                ) : null}
                              </div>
                            )}

                            {showLoanRateAdjustmentFields ? (
                              <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                                <div>
                                  <div className="text-xs font-medium text-slate-700">{t("liabilityShell.rateAdjustment")}</div>
                                  <div className="mt-0.5 text-[11px] text-slate-500">
                                    {showHistoricalRates && historicalRateRows.some((row) => row.effectiveDate.trim() || row.annualRate.trim())
                                      ? t("liabilityTx.rateAdjustFilledHint", { count: historicalRateRows.filter((row) => row.effectiveDate.trim() || row.annualRate.trim()).length })
                                      : showHomeLoanLprFields
                                        ? t("liabilityTx.rateAdjustDefaultHint")
                                        : t("liabilityTx.rateAdjustSimpleHint")}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="secondary-button h-8 shrink-0 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                                  disabled={isLoanBorrowEditLocked}
                                  onClick={() => {
                                    if (isLoanBorrowEditLocked) return;
                                    // 只有挂 LPR 的商贷房贷才按 LPR 自动生成历次调整；
                                    // 公积金贷款（机构=公积金中心）利率不跟 LPR，与消费贷一样手动录入历次行。
                                    if (showHomeLoanLprFields) {
                                      const generated = buildCurrentMortgageLprGeneration({
                                        alertOnInvalid: true,
                                        fillDefaultDiscount: true,
                                      });
                                      if (!generated) return;
                                      setShowHistoricalRates(true);
                                      setHistoricalRateRows((prev) => prev.length > 0
                                        ? prev
                                        : generated.rows.length > 0
                                          ? generated.rows
                                          : [createHistoricalRateRow(firstRepaymentDate, annualRate)]);
                                      setHistoricalRatesOpen(true);
                                      return;
                                    }
                                    setShowHistoricalRates(true);
                                    setHistoricalRateRows((prev) => prev.length > 0
                                      ? prev
                                      : [createHistoricalRateRow((autoDebit ? autoDebitFirstDate : firstRepaymentDate) || date, annualRate)]);
                                    setHistoricalRatesOpen(true);
                                  }}
                                >
                                  {t("liabilityShell.rateAdjustment")}
                                </button>
                              </div>
                            ) : null}

                            {loanSchedulePreview ? (
                              <div className="rounded-md border border-slate-200">
                                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                                  <span className="font-medium text-slate-700">
                                    {t("liabilityTx.schedulePreviewTitle", {
                                      count: loanSchedulePreview.rows.length,
                                      interval: loanSchedulePreview.intervalMonths === 1 ? t("liabilityTx.everyMonth") : t("liabilityTx.everyNMonths", { n: loanSchedulePreview.intervalMonths }),
                                      day: loanSchedulePreview.repaymentDay,
                                    })}
                                  </span>
                                  <span className="tabular-nums">
                                    {t("liabilityTx.scheduleSummary", {
                                      principal: formatMoneyPreview(loanSchedulePreview.totalPrincipal, language),
                                      interest: formatMoneyPreview(loanSchedulePreview.totalInterest, language),
                                      total: formatMoneyPreview(loanSchedulePreview.totalPayment, language),
                                    })}
                                  </span>
                                </div>
                                <div className="max-h-56 overflow-auto">
                                  <table className="min-w-full text-xs tabular-nums">
                                    <thead className="sticky top-0 bg-white text-slate-500 shadow-[0_1px_0_0_#e2e8f0]">
                                      <tr>
                                        <th className="px-2 py-1 text-left font-medium">{t("txForm.periods")}</th>
                                        <th className="px-2 py-1 text-left font-medium">{t("liabilityTx.colBillingDate")}</th>
                                        <th className="px-2 py-1 text-left font-medium">
                                          {autoDebit || isHomeLoanBorrow ? t("liabilityTx.autoDebitDate") : t("liabilityTx.colRepaymentDate")}
                                        </th>
                                        <th className="px-2 py-1 text-right font-medium">{t("liabilityShell.colPrincipal")}</th>
                                        <th className="px-2 py-1 text-right font-medium">{t("liabilityShell.colInterest")}</th>
                                        <th className="px-2 py-1 text-right font-medium">{t("txForm.dueAmount")}</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {loanSchedulePreview.rows.map((row) => (
                                        <tr key={`${row.period}-${row.date}`} className="border-t border-slate-100">
                                          <td className="px-2 py-1 text-slate-600">{row.period}/{loanTotalRuns}</td>
                                          <td className="px-2 py-1 text-slate-600">
                                            {!isHomeLoanBorrow && isValidDateInput(firstBillDate)
                                              ? addMonthsInput(firstBillDate, (row.period - 1) * loanSchedulePreview.intervalMonths)
                                              : row.date}
                                          </td>
                                          <td className="px-2 py-1 text-slate-600">{row.date}</td>
                                          <td className="px-2 py-1 text-right text-slate-700">{formatMoneyPreview(row.principal, language)}</td>
                                          <td className="px-2 py-1 text-right text-slate-700">{formatMoneyPreview(row.interest, language)}</td>
                                          <td className="px-2 py-1 text-right font-medium text-slate-800">{formatMoneyPreview(row.payment, language)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                            {t("liabilityTx.freeRepaymentHint")}
                          </div>
                        )}

                        <div className="space-y-1">
                          <div className="form-label">{t("detail.column.remark")}</div>
                          <ClearableNoteField
                            name="note"
                            placeholder={t("stockFee.optional")}
                            value={note}
                            disabled={isLoanBorrowEditLocked}
                            readOnly={isLoanBorrowEditLocked}
                            onValueChange={isLoanBorrowEditLocked ? () => {} : setNote}
                            className="form-input"
                          />
                        </div>

                      </>
                    ) : null}

                    {!showBorrowPlan ? (
                      <>
                        <div className="space-y-1">
                          <div className="form-label">{t("detail.column.remark")}</div>
                          <ClearableNoteField
                            name="note"
                            placeholder={t("stockFee.optional")}
                            value={note}
                            disabled={isLoanBorrowEditLocked}
                            readOnly={isLoanBorrowEditLocked}
                            onValueChange={isLoanBorrowEditLocked ? () => {} : setNote}
                            className="form-input"
                          />
                        </div>

                        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                          {mode === "repay_out"
                            ? t("liabilityTx.hint.repayOut")
                            : mode === "prepay_out"
                              ? t("liabilityTx.hint.prepayOut")
                            : mode === "lend_out"
                              ? t("liabilityTx.hint.lendOut")
                              : t("liabilityTx.hint.collectIn")}
                        </div>
                      </>
                    ) : null}

                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button type="button" className="secondary-button h-9 px-3" disabled={submitting} onClick={() => saveLiabilityTransaction(true)}>
                        {submitting ? t("txForm.saving") : t("txForm.saveAndRepeat")}
                      </button>
                      <button type="submit" className="primary-button h-9 px-3" disabled={submitting}>
                        {submitting ? t("txForm.saving") : t("common.save")}
                      </button>
                    </div>
                  </form>
              </div>
            </div>,
            document.body,
          )
        : null}
      {open && historyConfirmOpen
        ? createPortal(
            <div className="app-modal-backdrop" style={{ zIndex: confirmModalZIndex }}>
              <div className="app-modal-panel max-w-lg">
                <div className="modal-header shrink-0">
                  <div className="text-sm font-semibold text-slate-800">{t("liabilityTx.historyConfirmTitle")}</div>
                  <button
                    type="button"
                    onClick={() => setHistoryConfirmOpen(false)}
                    className="secondary-button h-8 px-2"
                    disabled={submitting}
                  >
                    {t("liabilityTx.back")}
                  </button>
                </div>
                <div className="space-y-3 p-4 text-sm text-slate-700">
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                    {t("liabilityTx.historyPrompt.warning", { date: firstRepaymentDate || "-" })}
                  </div>

                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <input
                      type="checkbox"
                      checked={createHistoricalRepaymentRecords}
                      onChange={(event) => setCreateHistoricalRepaymentRecords(event.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-blue-600"
                    />
                    <span>
                      <span className="block font-medium text-slate-800">{t("liabilityTx.historyPrompt.generateLabel")}</span>
                      <span className="block text-xs text-slate-500">{t("liabilityTx.historyPrompt.generateHint")}</span>
                    </span>
                  </label>

                  {showLoanBorrowOptions ? (
                    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                      <input
                        type="checkbox"
                        checked={showHistoricalRates}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          if (checked) {
                            const generated = buildCurrentMortgageLprGeneration({
                              alertOnInvalid: true,
                              fillDefaultDiscount: true,
                            });
                            if (!generated) return;
                            setShowHistoricalRates(true);
                            setHistoricalRateRows((prev) => prev.length > 0
                              ? prev
                              : generated.rows.length > 0
                                ? generated.rows
                                : [createHistoricalRateRow()]);
                            setHistoricalRatesOpen(true);
                          } else {
                            setShowHistoricalRates(false);
                            setHistoricalRateRows([]);
                            setHistoricalRatesOpen(false);
                          }
                        }}
                        className="mt-0.5 h-4 w-4 accent-blue-600"
                      />
                      <span>
                        <span className="block font-medium text-slate-800">{t("liabilityTx.historyPrompt.hasRateAdjustments")}</span>
                        <span className="block text-xs text-slate-500">{t("liabilityTx.historyPrompt.rateAdjustmentsHint")}</span>
                      </span>
                    </label>
                  ) : null}

                  {showLoanBorrowOptions && showHistoricalRates ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <div>
                        <div className="text-xs font-medium text-slate-700">
                          {t("liabilityTx.historyRateFilled", { count: historicalRateRows.filter((row) => row.effectiveDate.trim() || row.annualRate.trim()).length })}
                        </div>
                        <div className="text-[11px] text-slate-500">{t("liabilityTx.historyRateValidateHint")}</div>
                      </div>
                      <button
                        type="button"
                        className="secondary-button h-8 px-3 text-xs"
                        onClick={() => {
                          const generated = buildCurrentMortgageLprGeneration({
                            alertOnInvalid: true,
                            fillDefaultDiscount: true,
                          });
                          if (!generated) return;
                          setHistoricalRateRows((prev) => prev.length > 0
                            ? prev
                            : generated.rows.length > 0
                              ? generated.rows
                              : [createHistoricalRateRow()]);
                          setHistoricalRatesOpen(true);
                        }}
                      >
                        {t("liabilityShell.rateAdjustment")}
                      </button>
                    </div>
                  ) : null}

                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      className="secondary-button h-9 px-3"
                      disabled={submitting}
                      onClick={() => setHistoryConfirmOpen(false)}
                    >
                      {t("liabilityTx.backToEdit")}
                    </button>
                    <button
                      type="button"
                      className="primary-button h-9 px-3"
                      disabled={submitting}
                      onClick={() => { void confirmHistoricalPrompt(); }}
                    >
                      {submitting ? t("txForm.saving") : t("liabilityTx.confirmSave")}
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      {open && historicalRatesOpen
        ? createPortal(
            <div className="app-modal-backdrop" style={{ zIndex: rateModalZIndex }}>
              <div className="app-modal-panel max-w-xl">
                <div className="modal-header shrink-0">
                  <div className="text-sm font-semibold text-slate-800">{t("liabilityShell.rateAdjustment")}</div>
                  <button
                    type="button"
                    onClick={() => setHistoricalRatesOpen(false)}
                    className="secondary-button h-8 px-2"
                  >
                    {t("table.close")}
                  </button>
                </div>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm text-slate-700">
                  <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
                    {t("liabilityTx.rateModal.hint")}
                  </div>

                  <div className="space-y-2">
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2 px-1 text-xs font-medium text-slate-500">
                      <div>{t("liabilityShell.rateAdjust.effectiveDate")}</div>
                      <div>{t("liabilityShell.rateAdjust.annualRateLabel")}</div>
                      <div className="text-right">{t("detail.column.actions")}</div>
                    </div>
                    <div className="max-h-[230px] space-y-2 overflow-y-auto pr-1">
                      {historicalRateRows.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-5 text-center text-sm text-slate-500">
                          {t("liabilityShell.rateAdjust.empty")}
                        </div>
                      ) : historicalRateRows.map((row) => (
                        <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2">
                          <DateStepper
                            value={row.effectiveDate}
                            onChange={(value) => {
                              setHistoricalRateRows((prev) => prev.map((item) => (
                                item.key === row.key ? { ...item, effectiveDate: value } : item
                              )));
                            }}
                          />
                          <input
                            value={row.annualRate}
                            onChange={(event) => {
                              setHistoricalRateRows((prev) => prev.map((item) => (
                                item.key === row.key ? { ...item, annualRate: event.target.value } : item
                              )));
                            }}
                            inputMode="decimal"
                            placeholder={t("liabilityShell.rateAdjust.annualRatePlaceholder")}
                            className="form-input"
                          />
                          <button
                            type="button"
                            className="secondary-button h-9 px-2 text-rose-600 hover:bg-rose-50"
                            onClick={() => {
                              setHistoricalRateRows((prev) => prev.filter((item) => item.key !== row.key));
                            }}
                          >
                            {t("common.delete")}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
                    <button
                      type="button"
                      className="secondary-button h-9 px-3"
                      onClick={() => setHistoricalRateRows((prev) => [...prev, createHistoricalRateRow()])}
                    >
                      {t("liabilityTx.addRow")}
                    </button>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="secondary-button h-9 px-3 text-slate-500"
                        onClick={() => {
                          setHistoricalRateRows([]);
                          setShowHistoricalRates(false);
                          setHistoricalRatesOpen(false);
                        }}
                      >
                        {t("table.clear")}
                      </button>
                      <button
                        type="button"
                        className="primary-button h-9 px-3"
                        onClick={() => {
                          if (historicalRateRows.length === 0) {
                            setShowHistoricalRates(false);
                            setHistoricalRatesOpen(false);
                            return;
                          }
                          const result = serializeHistoricalRateRows(historicalRateRows, t);
                          if (!result.ok) {
                            window.alert(result.error);
                            return;
                          }
                          setHistoricalRatesOpen(false);
                        }}
                      >
                        {t("table.confirm")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      {open && liabilityObjectNestedOpen
        ? createPortal(
            <EntityCreateForm
              mode="compact"
              entityType={isLoanDialog ? "institution" : "counterparty"}
              allowedCounterpartyTypes={isLoanDialog ? undefined : ["person", "organization"]}
              open={liabilityObjectNestedOpen}
              onClose={() => setLiabilityObjectNestedOpen(false)}
              title={isLoanDialog ? t("liabilityTx.addLoanInstitution") : t("txForm.addCounterparty")}
              nameLabel={isLoanDialog ? t("liabilityTx.loanInstitutionName") : t("liabilityTx.objectName")}
              namePlaceholder={isLoanDialog ? t("liabilityTx.loanInstitutionNamePlaceholder") : t("liabilityTx.objectNamePlaceholder")}
              defaultType={isLoanDialog ? "bank" : "person"}
              allowedInstitutionTypes={isLoanDialog ? [...LOAN_DIALOG_INSTITUTION_TYPE_VALUES] : undefined}
              onCreated={(id, name, extra) => {
                const type = extra?.type ?? (isLoanDialog ? "bank" : "person");
                const option = { id: liabilityObjectOptionId(id, type), label: name, subLabel: institutionTypeLabel(type, t) };
                const fieldKey = isLoanDialog ? "institutionId" : "counterpartyId";
                setLocalNestedFieldData((prev) => ({
                  ...(prev ?? nestedFieldData ?? {}),
                  [fieldKey]: [...((prev ?? nestedFieldData)?.[fieldKey] ?? []), { id, name, type }],
                }));
                setLocalLiabilityObjectOptions((prev) => mergeSmartSelectOptions(prev ?? liabilityObjectOptions, [option]));
                setLiabilityInstitutionId(option.id);
                setLiabilityAccountId("");
                setLiabilityObjectNestedOpen(false);
              }}
            />,
            document.body,
          )
        : null}
      {open && cashAccountNestedOpen
        ? createPortal(
            <EntityCreateForm
              mode="compact"
              entityType="account"
              open={cashAccountNestedOpen}
              onClose={() => setCashAccountNestedOpen(false)}
              title={t("settings.accounts.add")}
              nestedFieldData={localNestedFieldData ?? nestedFieldData}
              onCreated={(id, name, extra) => {
                const institution = extra?.institutionShortName?.trim() || extra?.institutionName;
                setLocalCashAccountList((prev) =>
                  prev.some((item) => item.id === id)
                    ? prev
                    : [
                        ...prev,
                        {
                          id,
                          label: institution ? `${institution}·${name}` : name,
                          subLabel: extra?.kind ? t(`account.kind.${extra.kind}`) : undefined,
                          kind: extra?.kind,
                        },
                      ],
                );
                setCashAccountId(id);
                setCashAccountNestedOpen(false);
              }}
            />,
            document.body,
          )
        : null}
      {open && liabilityAccountNestedOpen
        ? createPortal(
            <EntityCreateForm
              mode="compact"
              entityType="account"
              open={liabilityAccountNestedOpen}
              onClose={() => setLiabilityAccountNestedOpen(false)}
              title={accountCreateKind === "loan" ? t("liabilityTx.addLoanAccount") : t("liabilityTx.addCounterpartyAccount")}
              nameLabel={accountCreateKind === "loan" ? t("liabilityTx.loanAccountName") : t("liabilityTx.counterpartyAccountName")}
              namePlaceholder={accountCreateKind === "loan" ? t("liabilityTx.loanAccountNamePlaceholder") : t("liabilityTx.counterpartyAccountNamePlaceholder")}
              defaultType={accountCreateKind}
              nestedFieldData={localNestedFieldData ?? nestedFieldData}
              hiddenFields={[
                "kind",
                "groupId",
                "institutionId",
                "currency",
                "billingDay",
                "repaymentDay",
                "creditLimit",
                "creditBillMode",
                "numberMasked",
                "investProductType",
                "fundUnitsDecimals",
                "tradingCalendar",
                "costBasisMethod",
                "defaultFundQueryApiId",
              ]}
              extraFields={{
                kind: accountCreateKind,
                ...(accountCreateKind === "loan" && activeLoanTab !== "repay_out" ? { loanType: activeLoanTab } : {}),
                ...(liabilityInstitutionId.startsWith("institution:")
                  ? { institutionId: rawLiabilityObjectId(liabilityInstitutionId) }
                  : { counterpartyId: rawLiabilityObjectId(liabilityInstitutionId) }),
                liabilityDirection: liabilityDirectionForMode(mode),
              }}
              onCreated={(id, name, extra) => {
                const ownerName = extra?.counterpartyName ?? extra?.institutionShortName ?? extra?.institutionName;
                const nextKind = extra?.kind ?? accountCreateKind;
                const nextCounterpartyId = extra?.counterpartyId ?? (liabilityInstitutionId.startsWith("counterparty:") ? rawLiabilityObjectId(liabilityInstitutionId) : null);
                const nextInstitutionId = extra?.institutionId ?? (liabilityInstitutionId.startsWith("institution:") ? rawLiabilityObjectId(liabilityInstitutionId) : null);
                const nextLoanType = nextKind === "loan" ? resolveLoanTypeValue(extra?.loanType, extra?.isConsumerLoan) : null;
                const nextOption: AccountOption = {
                  id,
                  label: name,
                  // 口径（2026-09-13）：挂在往来对象上的贷款账户不再显示「往来款」，
                  // 前缀「贷款 · 对象名」区分于往来款账户。
                  subLabel: nextKind === "loan"
                    ? (ownerName ? t("liabilityTx.subLabel.counterpartyLoan", { name: ownerName }) : t("account.kind.loan"))
                    : ownerName ? t("liabilityTx.subLabel.settlement", { name: ownerName }) : t("liabilityTx.subLabel.settlementPlain"),
                  kind: nextKind,
                  counterpartyId: nextCounterpartyId,
                  institutionId: nextInstitutionId,
                  isInstitutionLoan: nextKind === "loan" && !!nextInstitutionId && !nextCounterpartyId,
                  isConsumerLoan: nextLoanType === "consumer",
                  loanType: nextLoanType,
                  liabilityDirection: extra?.liabilityDirection ?? liabilityDirectionForMode(mode),
                };
                setLocalLiabilityAccounts((prev) => (prev.some((item) => item.id === id) ? prev : [...prev, nextOption]));
                setLiabilityAccountId(id);
                setLiabilityAccountNestedOpen(false);
              }}
            />,
            document.body,
          )
        : null}
      {open && fixedAssetAccountNestedOpen && !fixedAssetAssetNestedOpen
        ? createPortal(renderFixedAssetAccountCreateForm(), document.body)
        : null}
      {open && fixedAssetAssetNestedOpen ? (
        <FixedAssetCreateDialog
          open={fixedAssetAssetNestedOpen}
          onClose={() => setFixedAssetAssetNestedOpen(false)}
          accountOptions={fixedAssetAccountOptions}
          accountValue={fixedAssetCreateAccountId}
          onAccountChange={setFixedAssetCreateAccountId}
          onAccountCreateClick={() => setFixedAssetAccountNestedOpen(true)}
          accountCreateForm={open && fixedAssetAccountNestedOpen ? renderFixedAssetAccountCreateForm() : undefined}
          name={fixedAssetCreateName}
          onNameChange={setFixedAssetCreateName}
          purchaseDate={fixedAssetCreateDate}
          onPurchaseDateChange={setFixedAssetCreateDate}
          amount={fixedAssetCreateAmount}
          onAmountChange={setFixedAssetCreateAmount}
          submitting={fixedAssetCreateSubmitting}
          onSubmit={() => { void submitFixedAssetCreate(); }}
        />
      ) : null}
    </ModalLayerProvider>
  );
}
