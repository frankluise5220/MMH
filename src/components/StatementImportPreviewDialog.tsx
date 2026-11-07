"use client";
import { ModalLayer } from "@/components/ModalLayer";

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig, type BatchReplaceOption } from "@/components/BatchReplacePopoverButton";
import { ImportPreviewHeader } from "@/components/ImportPreviewHeader";
import { evaluateCalcInputExpression } from "@/components/CalcInput";
import { DateStepper } from "@/components/DateStepper";
import { SmartSelect, type SmartSelectOption } from "@/components/SmartSelect";
import { CATEGORY_SMART_SELECT_BEHAVIOR, buildCategorySmartSelectOptions } from "@/components/categorySmartSelect";
import { useAccountSSFilter } from "@/components/accountSSFilter";
import {
  buildAccountDisplayOption,
  buildGroupedAccountOptions,
  formatAccountTableLabel,
  formatAccountTableTitle,
  type AccountDisplayOption,
  type AccountRenderSettings,
} from "@/lib/account-display";
import {
  createImportAccountMatcher,
  encodeImportAccountId,
  importCounterKindFromCategory,
  normalizeImportAccountMatchKey,
  ownerNamesFromAccountGroup,
  parseSettlementAccountName,
  parseSettlementCounterpartyFromText,
  parseImportAccountId,
  parseImportBarePersonName,
  parseImportOwnedMoneyAccountCandidate,
  parseImportPersonAttributedCandidate,
  type ImportCounterAccountKind,
} from "@/lib/account-import-match";
import {
  getColorSchemeFromCookie,
  importPreviewFlowAmountColorFor,
  importPreviewFlowAmountTextFor,
} from "@/lib/client/colors";
import {
  fetchSettingsBootstrap,
  type SettingsAccountGroup,
  type SettingsCategory,
  type SettingsCounterparty,
} from "@/lib/client/settingsCache";
import { statementPreviewCategorySyncKey } from "@/lib/statement/preview-category-sync";
import { resolveWechatTransferGuard, wechatTransferBlockMessage } from "@/lib/statement/wechat-transfer-guard";
import { suggestTransferCounterAccountName } from "@/lib/statement/transfer-counter-account";
import { uniqueStatementInfoTexts } from "@/lib/statement/preview-meta";
import { systemCategoryLabel } from "@/lib/system-category-labels";
import { useI18n } from "@/lib/i18n";
import { readAccountDisplaySettings, useAccountDisplaySettings } from "@/lib/client/account-display-settings";

type BookAccount = {
  id: string;
  name: string;
  kind: string;
  isActive?: boolean;
  numberMasked?: string | null;
  groupId?: string | null;
  investProductType?: string | null;
  label?: string | null;
  selectorLabel?: string | null;
  selectorCoreLabel?: string | null;
  fullLabel?: string | null;
  hoverTitle?: string | null;
  displaySubLabel?: string | null;
  Institution?: { id?: string | null; name?: string | null; shortName?: string | null; type?: string | null } | null;
  AccountGroup?: {
    id: string;
    name?: string | null;
    /** 配对到的家庭成员：姓名与简称都算「所有人」的写法。 */
    Institution?: { name?: string | null; shortName?: string | null } | null;
  } | null;
  AccountAlias?: Array<{ alias: string }> | null;
  /** 结算/贷款账户挂的往来对象：泛名「往来款」账户靠它区分「X的往来款」属于谁。 */
  Counterparty?: { id?: string | null; name?: string | null; shortName?: string | null } | null;
};

type BookCategory = SettingsCategory;
type BookCounterparty = SettingsCounterparty;
type BookAccountGroup = SettingsAccountGroup;

type PreviewAccountLookup = {
  accountById: Map<string, BookAccount>;
  resolveAccount: (accountName: string | undefined) => BookAccount | null;
  matchAccount: (accountName: string | undefined) => { account: BookAccount | null; ambiguousAccounts: BookAccount[] };
  hasCounterparty: (name: string | undefined) => boolean;
  ownerNames: string[];
};

export type StatementImportPreviewItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  amount: number;
  inflow?: number;
  outflow?: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  transferDirection?: "in" | "out";
  category?: string;
  categoryUserEdited?: boolean;
  remark?: string;
  tags?: string;
  counterparty?: string;
  /**
   * 微信账单原文「交易类型」（转账 / 商户消费 / 红包…）。只有微信账单有值：
   * 用户把「收支大类」改成转账时靠它判断是「真转账」还是商户消费（见 wechat-transfer-guard）。
   */
  statementTransactionType?: string;
  /** 微信账单原文「交易对方」：改成转账时按「<交易对方>的往来款」填对向账户。 */
  statementCounterparty?: string;
  /** 该行来自微信账单（归一化行带「原交易类型」列）。 */
  wechatStatement?: boolean;
  /** 原文「对向账户 / 对方账户」列的原始值：非转账行不参与导入，改成转账时用它回填对向账户。 */
  rawCounterAccount?: string;
  institution?: string;
  institutionUserEdited?: boolean;
  postedDate?: string;
  currency?: string;
  originalCurrency?: string;
  originalAmount?: number;
  _meta?: {
    institutionName?: string;
    ownerName?: string;
    cardNumberMasked?: string;
    statementCurrency?: string;
    minimumPayment?: number;
    creditLimit?: number;
    billingDay?: number;
    repaymentDay?: number;
    statementAmount?: number;
    statementPeriodStart?: string;
    statementPeriodEnd?: string;
    statementDueDate?: string;
  };
};

type PreviewEditField =
  | "date"
  | "postedDate"
  | "type"
  | "account"
  | "counterAccount"
  | "category"
  | "institution"
  | "inflow"
  | "outflow"
  | "amount"
  | "remark"
  | "tags";

type ImportPreviewRow = {
  key: string;
  /** 原始序号（items 里的下标）：预览表格第一列显示用，与基金预览的序号对齐。 */
  idx: number;
  item: StatementImportPreviewItem;
  ready: boolean;
  missingFields: string[];
};

type StatementImportPreviewDialogProps = {
  /** 财智余额调整行：确认导入时作为余额校准（指定日期校正账户余额为目标值） */
  balanceAdjustments?: Array<{ date?: string; balance: number }>;
  open: boolean;
  title: string;
  description?: string;
  items: StatementImportPreviewItem[];
  defaultAccountName: string;
  /** 发起导入的账户（视图已指定账户）：用它带出的所有人给同名账户消歧。 */
  sourceAccountId?: string | null;
  /** 导入来源直接指定的所有人（优先于账户与文件名推断）。 */
  sourceOwnerName?: string | null;
  /** 被解析的流水文件名：可据此推断所有人。 */
  sourceFileName?: string | null;
  busy?: boolean;
  /** 分批导入进度：宿主分批提交时传入，弹窗底部显示进度条 */
  importProgress?: { imported: number; total: number } | null;
  /** 顶部页签条（同一张账单的「资金收支 / 基金买卖」切换）：由宿主渲染，弹窗只负责摆位置。 */
  tabs?: ReactNode;
  /**
   * 页签已切走：窗口**保留挂载**，只是不显示。
   * 卸载再挂载会重新拉账本、重建表格（表格先空一拍），切页签时看着整页闪一下。
   */
  hidden?: boolean;
  onClose: () => void;
  onConfirm: (
    items: StatementImportPreviewItem[],
    options?: { createLiabilityAccounts?: boolean; forceCreateOwnedMoneyAccounts?: boolean },
  ) => void | Promise<void>;
};

type PreviewCreationOptions = {
  createLiabilityAccounts: boolean;
  forceCreateOwnedMoneyAccounts: boolean;
};

const PREVIEW_TYPE_OPTIONS: Array<{ value: StatementImportPreviewItem["type"]; labelKey: string }> = [
  { value: "expense", labelKey: "transaction.type.expense" },
  { value: "income", labelKey: "transaction.type.income" },
  { value: "transfer", labelKey: "transaction.type.transfer" },
  { value: "investment", labelKey: "transaction.type.investment" },
];

const IMPORT_PREVIEW_FIELD_LABEL_KEYS: Record<PreviewEditField, string> = {
  date: "statementImportPreview.colDate",
  postedDate: "detail.column.postedAt",
  type: "batchImport.field.type",
  account: "batchImport.field.account",
  counterAccount: "batchImport.field.counterAccount",
  category: "detail.column.category",
  institution: "detail.column.counterparty",
  inflow: "detail.column.inflow",
  outflow: "detail.column.outflow",
  amount: "txForm.amount",
  remark: "detail.column.remark",
  tags: "detail.column.tags",
};

const MISSING_FIELD_LABEL_KEYS: Record<string, string> = {
  date: "detail.column.date",
  amount: "txForm.amount",
  account: "batchImport.field.account",
  counterAccount: "batchImport.field.counterAccount",
};

function isPlaceholderText(value?: string | null) {
  const text = String(value ?? "").trim();
  return !text || /^[-—–]+$/.test(text) || text === "?";
}

function cleanText(value?: string | null) {
  const text = String(value ?? "").trim();
  return isPlaceholderText(text) ? "" : text;
}

function displayPreviewValue(value?: string | null) {
  const text = String(value ?? "");
  return text.trim() === "-" ? "" : text;
}

function normalizeDateOnlyText(value?: string | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const match = raw.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?/);
  if (!match) return raw.slice(0, 10);
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function typeLabel(t: (key: string) => string, type: StatementImportPreviewItem["type"]) {
  if (type === "income") return t("transaction.type.income");
  if (type === "transfer") return t("transaction.type.transfer");
  if (type === "investment") return t("transaction.type.investment");
  return t("transaction.type.expense");
}

function previewTransferDirection(item: StatementImportPreviewItem): "in" | "out" {
  const inflow = Math.abs(Number(item.inflow ?? 0)) || 0;
  const outflow = Math.abs(Number(item.outflow ?? 0)) || 0;
  const text = [item.rawText, item.remark, item.fromAccount, item.toAccount].filter(Boolean).join(" ");
  if (
    item.type === "transfer" &&
    outflow <= 0 &&
    /银联入账|银联转账|还款|自动扣款|自动还款|repayment|payment|autopay/i.test(text)
  ) {
    return "in";
  }
  if (item.transferDirection === "in" || item.transferDirection === "out") return item.transferDirection;
  return inflow > 0 && outflow <= 0 ? "in" : "out";
}

function normalizeTransferFlow(item: StatementImportPreviewItem): StatementImportPreviewItem {
  if (item.type !== "transfer") return item;
  const inflow = Math.abs(Number(item.inflow ?? 0)) || 0;
  const outflow = Math.abs(Number(item.outflow ?? 0)) || 0;
  const amount = Math.abs(Number(item.amount ?? 0)) || inflow || outflow;
  const direction = previewTransferDirection(item);
  return {
    ...item,
    amount,
    transferDirection: direction,
    inflow: direction === "in" ? inflow || amount || undefined : undefined,
    outflow: direction === "out" ? outflow || amount || undefined : undefined,
  };
}

function amountPatchForItem(item: StatementImportPreviewItem, nextAmount: number): Partial<StatementImportPreviewItem> {
  const amount = Math.abs(Number(nextAmount) || 0);
  if (item.type === "transfer") {
    return previewTransferDirection(item) === "in"
      ? { amount, inflow: amount, outflow: undefined, transferDirection: "in" }
      : { amount, inflow: undefined, outflow: amount, transferDirection: "out" };
  }
  const isAccountInflow = item.type === "income" || (Number(item.inflow ?? 0) > 0 && Number(item.outflow ?? 0) <= 0);
  return isAccountInflow
    ? { amount, inflow: amount, outflow: undefined }
    : { amount, inflow: undefined, outflow: amount };
}

function flowAmountPatchForItem(item: StatementImportPreviewItem, side: "inflow" | "outflow", nextAmount: number): Partial<StatementImportPreviewItem> {
  const amount = Math.abs(Number(nextAmount) || 0);
  if (item.type === "transfer") {
    return side === "inflow"
      ? { amount, inflow: amount, outflow: undefined, transferDirection: "in" }
      : { amount, inflow: undefined, outflow: amount, transferDirection: "out" };
  }
  return side === "inflow"
    ? { type: "income", amount, inflow: amount, outflow: undefined }
    : { type: "expense", amount, inflow: undefined, outflow: amount };
}

function buildBookAccountDisplayOption(
  account: BookAccount,
  settings: AccountRenderSettings = readAccountDisplaySettings(),
): AccountDisplayOption {
  return buildAccountDisplayOption({
    ...account,
    Institution: account.Institution
      ? {
          name: account.Institution.name ?? null,
          shortName: account.Institution.shortName ?? null,
        }
      : null,
    AccountGroup: account.AccountGroup
      ? {
          id: account.AccountGroup.id,
          name: account.AccountGroup.name ?? null,
        }
      : null,
  }, undefined, settings);
}

/** 「所有人」= 家庭成员 = AccountGroup；这些是占位分组，不参与所有人推断。 */
const PLACEHOLDER_OWNER_NAMES = new Set(["未指定", "未分组", "默认", "无", "无分组"]);

/**
 * 还没匹配到台账账户时的占位显示：仍然走「账户显示格式」，用流水自带的
 * 机构 / 所有人 / 币种兜底。之前这类行直接显示识别原文，于是账户列看起来
 * 只有机构名，悬浮也补不出所有人。
 */
function buildUnmatchedAccountDisplay(
  text: string,
  meta: StatementImportPreviewItem["_meta"],
  settings: AccountRenderSettings,
): AccountDisplayOption {
  const institutionName = cleanText(meta?.institutionName);
  const ownerName = cleanText(meta?.ownerName);
  return buildAccountDisplayOption({
    id: `unmatched:${text}`,
    name: text,
    kind: "",
    currency: meta?.statementCurrency ?? null,
    Institution: institutionName ? { name: institutionName, shortName: institutionName } : null,
    AccountGroup: ownerName ? { id: "", name: ownerName } : null,
  }, undefined, settings);
}

function isTransferOut(item: StatementImportPreviewItem) {
  return previewTransferDirection(item) === "out";
}

function metaAccountCandidate(meta?: StatementImportPreviewItem["_meta"]) {
  return creditAccountCandidates("", meta)[0] || cleanText(meta?.institutionName) || "";
}

function primaryAccountValue(item: StatementImportPreviewItem, defaultAccountName: string) {
  if (item.type !== "transfer") return cleanText(item.account) || cleanText(defaultAccountName) || metaAccountCandidate(item._meta);
  return isTransferOut(item)
    ? cleanText(item.fromAccount) || cleanText(item.account) || cleanText(defaultAccountName) || metaAccountCandidate(item._meta)
    : cleanText(item.toAccount) || cleanText(item.account) || cleanText(defaultAccountName) || metaAccountCandidate(item._meta);
}

function counterAccountValue(item: StatementImportPreviewItem) {
  if (item.type !== "transfer") return "";
  return isTransferOut(item) ? cleanText(item.toAccount) : cleanText(item.fromAccount);
}

function liabilityCounterpartyNameFromAccount(value?: string | null) {
  // 口径与导入匹配器一致：往来对象名限 5 字以内；超长前缀只在能对上既有账户对象名时才用。
  const text = cleanText(value) || "";
  return parseSettlementCounterpartyFromText(text) ?? parseSettlementAccountName(text) ?? "";
}

function isCreatableLiabilityAccount(
  value: string | undefined | null,
  lookup: PreviewAccountLookup | null,
  options: PreviewCreationOptions,
  allowBarePersonName = false,
) {
  if (!options.createLiabilityAccounts || !lookup) return false;
  const counterpartyName = liabilityCounterpartyNameFromAccount(value);
  if (counterpartyName) return true;
  // 非所有人「XX的YYY」→ 归属为往来对象 XX 的往来款账户
  if (parseImportPersonAttributedCandidate(value, lookup.ownerNames)) return true;
  // 银行流水里**转账对向**常直接写人名，勾选后同样按往来对象建账户。
  // 主账户不适用：服务端只在转账两侧开启这条路径。
  return allowBarePersonName && Boolean(parseImportBarePersonName(value, lookup.ownerNames));
}

function isCreatableOwnedMoneyAccount(value: string | undefined | null, lookup: PreviewAccountLookup | null, options: PreviewCreationOptions) {
  if (!options.forceCreateOwnedMoneyAccounts || !lookup) return false;
  return Boolean(parseImportOwnedMoneyAccountCandidate(value, lookup.ownerNames));
}

function importAccountLast4(value?: string | null) {
  const matches = Array.from(String(value ?? "").matchAll(/\d{4}(?!\d)/g));
  return matches.length > 0 ? matches[matches.length - 1]?.[0] ?? "" : "";
}

function creditAccountCandidates(value: string, meta?: StatementImportPreviewItem["_meta"]) {
  const raw = cleanText(value);
  const institutionName = cleanText(meta?.institutionName);
  const last4 = cleanText(meta?.cardNumberMasked) || importAccountLast4(raw);
  const hasCreditHint = Boolean(institutionName || meta?.cardNumberMasked || /信用卡|贷记卡/.test(raw));
  const candidates = new Set<string>();
  if (raw) candidates.add(raw);
  if (last4 && hasCreditHint) {
    candidates.add(`信用卡(${last4})`);
    candidates.add(`信用卡${last4}`);
    if (institutionName) {
      candidates.add(`${institutionName}信用卡(${last4})`);
      candidates.add(`${institutionName}信用卡${last4}`);
      candidates.add(`${institutionName}贷记卡(${last4})`);
      candidates.add(`${institutionName}贷记卡${last4}`);
    }
  }
  if (institutionName && !last4) candidates.add(`${institutionName}信用卡`);
  return Array.from(candidates).filter(Boolean);
}

function findPreviewAccount(
  value: string | undefined | null,
  lookup: PreviewAccountLookup | null,
  meta?: StatementImportPreviewItem["_meta"],
) {
  const raw = cleanText(value);
  if (!raw || !lookup) return null;
  const directAccountId = parseImportAccountId(raw);
  if (directAccountId) return lookup.accountById.get(directAccountId) ?? null;

  for (const candidate of creditAccountCandidates(raw, meta)) {
    const matched = lookup.resolveAccount(candidate);
    if (matched) return matched;
  }
  // 财智变体（XX的普通应付款/普通应收款）→ 复用既有「XX的往来款」账户，避免误判缺失
  const liabilityCounterparty = parseSettlementAccountName(raw);
  if (liabilityCounterparty) {
    const matched = lookup.resolveAccount(`${liabilityCounterparty}的往来款`);
    if (matched) return matched;
  }
  return null;
}

function canonicalizePreviewAccountValue(
  value: string | undefined | null,
  lookup: PreviewAccountLookup | null,
  meta?: StatementImportPreviewItem["_meta"],
) {
  const raw = cleanText(value);
  if (!raw || !lookup) return raw || undefined;
  const matched = findPreviewAccount(raw, lookup, meta);
  return matched?.id ? encodeImportAccountId(matched.id) : raw;
}

function isPreviewAccountResolvable(
  value: string | undefined | null,
  lookup: PreviewAccountLookup | null,
  options: PreviewCreationOptions,
  meta?: StatementImportPreviewItem["_meta"],
  counterKindHint?: ImportCounterAccountKind | null,
  allowBarePersonName = false,
) {
  return Boolean(
    findPreviewAccount(value, lookup, meta) ||
    isCreatableLiabilityAccount(value, lookup, options, allowBarePersonName) ||
    isCreatableOwnedMoneyAccount(value, lookup, options) ||
    // 财智活动类型提示的对向账户（信用卡还款→信用卡、网贷收回→贷款）：勾选"创建往来款账户"后由程序按类型创建
    (counterKindHint && options.createLiabilityAccounts && lookup)
  );
}

function canonicalizePreviewItemAccounts(
  item: StatementImportPreviewItem,
  defaultAccountName: string,
  lookup: PreviewAccountLookup | null,
) {
  if (!lookup) return item;
  if (item.type !== "transfer") {
    return {
      ...item,
      account: canonicalizePreviewAccountValue(primaryAccountValue(item, defaultAccountName), lookup, item._meta),
    };
  }

  const transferOut = isTransferOut(item);
  const primaryValue = primaryAccountValue(item, defaultAccountName);
  const counterValue = counterAccountValue(item);
  const primaryAccount = canonicalizePreviewAccountValue(primaryValue, lookup, item._meta);
  const counterAccount = canonicalizePreviewAccountValue(counterValue, lookup);
  return transferOut
    ? {
        ...item,
        account: primaryAccount,
        fromAccount: primaryAccount,
        toAccount: counterAccount,
      }
    : {
        ...item,
        account: primaryAccount,
        fromAccount: counterAccount,
        toAccount: primaryAccount,
      };
}

function statementImportMissingFields(
  item: StatementImportPreviewItem,
  defaultAccountName: string,
  lookup: PreviewAccountLookup | null = null,
  creationOptions: PreviewCreationOptions = { createLiabilityAccounts: false, forceCreateOwnedMoneyAccounts: false },
) {
  const missing: string[] = [];
  if (!cleanText(item.date)) missing.push("date");
  if (!(Number(item.amount) > 0)) missing.push("amount");
  if (item.type === "transfer") {
    const primaryAccount = primaryAccountValue(item, defaultAccountName);
    const counterAccount = counterAccountValue(item);
    const counterKindHint = importCounterKindFromCategory(item.category);
    if (!primaryAccount || (lookup && !isPreviewAccountResolvable(primaryAccount, lookup, creationOptions, item._meta))) missing.push("account");
    if (!counterAccount || (lookup && !isPreviewAccountResolvable(counterAccount, lookup, creationOptions, undefined, counterKindHint, true))) missing.push("counterAccount");
  } else {
    const primaryAccount = cleanText(item.account) || cleanText(defaultAccountName) || cleanText(item._meta?.institutionName);
    if (!primaryAccount || (lookup && !isPreviewAccountResolvable(primaryAccount, lookup, creationOptions, item._meta))) {
      missing.push("account");
    }
  }
  return Array.from(new Set(missing));
}


function buildCategoryOptions(categories: BookCategory[], txType: StatementImportPreviewItem["type"] | undefined, t: (key: string) => string): BatchReplaceOption[] {
  const options: BatchReplaceOption[] = [{ value: "", label: t("statementImportPreview.clearCategory") }];
  const typeLabels: Record<string, string> = { expense: t("stats.expenseCategories"), income: t("statementImportPreview.incomeCategories") };
  const types = txType ? [txType === "income" ? "income" : "expense"] : ["expense", "income"];
  const scopedToOneType = Boolean(txType);
  return options.concat(buildCategorySmartSelectOptions({
    categories,
    types,
    typeLabels,
    typeHeaderPrefix: "preview-category-type",
    includeTypeHeaders: !scopedToOneType,
    t,
  }).map((option) => ({ ...option, value: option.id })));
}

function buildPreviewRows(
  items: StatementImportPreviewItem[],
  defaultAccountName: string,
  lookup: PreviewAccountLookup | null = null,
  creationOptions: PreviewCreationOptions = { createLiabilityAccounts: false, forceCreateOwnedMoneyAccounts: false },
): ImportPreviewRow[] {
  return items.map((item, index) => {
    const itemWithAccounts = canonicalizePreviewItemAccounts(item, defaultAccountName, lookup);
    const normalizedItem = normalizeTransferFlow({
      ...itemWithAccounts,
      date: normalizeDateOnlyText(itemWithAccounts.date) || undefined,
      postedDate: normalizeDateOnlyText(itemWithAccounts.postedDate) || normalizeDateOnlyText(itemWithAccounts.date) || undefined,
    });
    const missingFields = statementImportMissingFields(normalizedItem, defaultAccountName, lookup, creationOptions);
    return {
      key: `statement-${index}-${normalizedItem.date ?? ""}-${normalizedItem.amount ?? 0}-${normalizedItem.rawText ?? ""}`,
      idx: index,
      item: normalizedItem,
      missingFields,
      ready: missingFields.length === 0,
    };
  });
}

function missingAccountCandidateValuesForRow(row: ImportPreviewRow, defaultAccountName: string) {
  const candidates: string[] = [];
  if (row.item.type === "transfer") {
    if (row.missingFields.includes("account")) candidates.push(primaryAccountValue(row.item, defaultAccountName));
    if (row.missingFields.includes("counterAccount")) candidates.push(counterAccountValue(row.item));
  } else if (row.missingFields.includes("account")) {
    candidates.push(primaryAccountValue(row.item, defaultAccountName));
  }
  return Array.from(new Set(candidates.map(cleanText).filter(Boolean)));
}

// 预览表格高度完全交给 flex：弹窗固定 82vh，卡片 `ft-card-surface-fill` 撑满正文，
// 表格用 `fillHeight` 填满卡片剩余空间、内部滚动。
// 早前按「行数 × 30 + 固定 chrome」算高度，再减去估算的弹窗外占位（132），
// 一旦工具栏 / 表头 / 账单信息行的真实高度与常量不符，容器就会比可用空间高，
// 底部的一行半被卡片裁掉且滚不到 —— 估算是不可靠的，布局交给 CSS。
export function StatementImportPreviewDialog({
  open,
  title,
  description,
  items,
  balanceAdjustments = [],
  defaultAccountName,
  sourceAccountId = null,
  sourceOwnerName = null,
  sourceFileName = null,
  busy = false,
  importProgress = null,
  tabs = null,
  hidden = false,
  onClose,
  onConfirm,
}: StatementImportPreviewDialogProps) {
  const [rows, setRows] = useState<ImportPreviewRow[]>([]);
  /** 已经构建成 rows 的那份 items：同一份数据不重复构建，否则会覆盖用户的手工修改。 */
  const builtFromRef = useRef<StatementImportPreviewItem[] | null>(null);
  /** 上次构建时用的创建选项：勾选「创建往来款账户」等开关后要重算缺失字段，但不能重建行。 */
  const builtOptionsRef = useRef<PreviewCreationOptions | null>(null);
  /** 最新预览行的镜像：构建 effect 里要读当前行，但不能把 `rows` 放进依赖（否则每次 setRows 都自激）。 */
  const rowsRef = useRef<ImportPreviewRow[]>([]);
  rowsRef.current = rows;
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [editingPreviewCell, setEditingPreviewCell] = useState<{ rowKey: string; field: PreviewEditField } | null>(null);
  const [bookAccounts, setBookAccounts] = useState<BookAccount[]>([]);
  const [bookCategories, setBookCategories] = useState<BookCategory[]>([]);
  const [bookCounterparties, setBookCounterparties] = useState<BookCounterparty[]>([]);
  const [bookAccountGroups, setBookAccountGroups] = useState<BookAccountGroup[]>([]);
  const [settingsBootstrapLoaded, setSettingsBootstrapLoaded] = useState(false);
  const [createLiabilityAccounts, setCreateLiabilityAccounts] = useState(false);
  const [forceCreateOwnedMoneyAccounts, setForceCreateOwnedMoneyAccounts] = useState(false);
  const [categorySyncMessage, setCategorySyncMessage] = useState("");
  /** 「收支大类 → 转账」守卫的即时提示（微信账单：能否改转账、将新建哪个往来款账户）。 */
  const [typeGuardNotice, setTypeGuardNotice] = useState<{ text: string; tone: "info" | "warn" } | null>(null);
  const { t, language } = useI18n();
  const accountDisplaySettings = useAccountDisplaySettings();
  const colorScheme = useMemo(
    () => getColorSchemeFromCookie(typeof document === "undefined" ? null : document.cookie),
    [],
  );

  // 匹配与选择只针对启用账户：停用账户不该进入导入候选（与 batch-import 页口径一致），
  // 否则会虚增"账户中有N个"的 ambiguous 数量。
  const activeBookAccounts = useMemo(
    () => bookAccounts.filter((account) => account.isActive !== false),
    [bookAccounts],
  );
  const accountDisplayOptions = useMemo(
    () => activeBookAccounts
      .map((account) => buildBookAccountDisplayOption(account, accountDisplaySettings))
      .sort((a, b) => a.selectorLabel.localeCompare(b.selectorLabel, "zh-Hans-CN")),
    [accountDisplaySettings, activeBookAccounts],
  );
  const accountDisplayById = useMemo(
    () => new Map(accountDisplayOptions.map((account) => [account.id, account])),
    [accountDisplayOptions],
  );
  // 「同名不同所有人」的账户（如两个「朝朝宝」）不应该让用户逐行去选：导入来源本身
  // 往往已经说明了所有人——发起导入的账户视图，或流水文件名。
  const contextOwnerName = useMemo(() => {
    const explicit = sourceOwnerName?.trim() ?? "";
    if (explicit) return explicit;
    const accountOwner = sourceAccountId
      ? bookAccounts.find((account) => account.id === sourceAccountId)?.AccountGroup?.name?.trim() ?? ""
      : "";
    if (accountOwner) return accountOwner;
    const fileName = sourceFileName?.trim() ?? "";
    if (!fileName) return "";
    // 所有人 = 家庭成员 = 账户分组（AccountGroup），家庭成员的简称同样算数
    // （「墨的交易流水」与「墨斗鱼的交易流水」都指向同一个所有人）。
    // 「未指定」这类占位分组不是人，参与文件名匹配只会误命中。
    const owners = Array.from(
      new Set([
        ...bookAccountGroups.map((group) => group.name?.trim() ?? ""),
        ...activeBookAccounts.flatMap((account) => ownerNamesFromAccountGroup(account.AccountGroup)),
      ]),
    )
      .filter((name) => Boolean(name) && !PLACEHOLDER_OWNER_NAMES.has(name))
      .sort((a, b) => b.length - a.length);
    const ownerInFileName = owners.find((owner) => fileName.includes(owner));
    if (ownerInFileName) return ownerInFileName;
    // 文件名只写了账户名（「朝朝宝交易流水.xlsx」）时，用账户反推所有人；
    // 只有该账户名在账本里唯一属于一个人时才采信，否则仍是歧义。
    const ownersByAccountName = new Map<string, Set<string>>();
    for (const account of activeBookAccounts) {
      const name = account.name?.trim() ?? "";
      const owner = account.AccountGroup?.name?.trim() ?? "";
      if (!name || !owner || PLACEHOLDER_OWNER_NAMES.has(owner)) continue;
      const set = ownersByAccountName.get(name) ?? new Set<string>();
      set.add(owner);
      ownersByAccountName.set(name, set);
    }
    const byAccountName = [...ownersByAccountName.entries()].sort((a, b) => b[0].length - a[0].length);
    const hit = byAccountName.find(([name]) => fileName.includes(name));
    if (hit && hit[1].size === 1) return [...hit[1]][0];
    return "";
  }, [activeBookAccounts, bookAccountGroups, bookAccounts, sourceAccountId, sourceFileName, sourceOwnerName]);
  const accountLookup = useMemo<PreviewAccountLookup | null>(
    () => {
      if (!settingsBootstrapLoaded) return null;
      const matchAccount = createImportAccountMatcher(activeBookAccounts, { ownerName: contextOwnerName });
      // 「所有人」的写法 = 分组名 + 配对家庭成员的姓名与简称（2026-11-05 用户口径）。
      // 「墨的零钱」要和「墨斗鱼的零钱」解析出同一个所有人，否则会被当成新账户。
      const ownerNames = Array.from(
        new Set([
          ...bookAccountGroups.map((group) => group.name).filter(Boolean),
          ...activeBookAccounts.flatMap((account) => ownerNamesFromAccountGroup(account.AccountGroup)),
        ]),
      );
      return {
        accountById: new Map(activeBookAccounts.map((account) => [account.id, account])),
        resolveAccount: (accountName) => matchAccount(accountName).account,
        matchAccount,
        ownerNames,
        hasCounterparty: (name) => {
          const key = normalizeImportAccountMatchKey(name);
          if (!key) return false;
          return bookCounterparties.some((counterparty) =>
            normalizeImportAccountMatchKey(counterparty.name) === key ||
            normalizeImportAccountMatchKey(counterparty.shortName) === key,
          );
        },
      };
    },
    [bookAccountGroups, activeBookAccounts, bookCounterparties, contextOwnerName, settingsBootstrapLoaded],
  );
  const accountResolveCacheRef = useRef(new Map<string, string>());
  useEffect(() => {
    accountResolveCacheRef.current.clear();
  }, [accountLookup]);
  const creationOptions = useMemo<PreviewCreationOptions>(
    () => ({ createLiabilityAccounts, forceCreateOwnedMoneyAccounts }),
    [createLiabilityAccounts, forceCreateOwnedMoneyAccounts],
  );
  const accountSmartSelectOptions = useMemo(
    () => buildGroupedAccountOptions(accountDisplayOptions),
    [accountDisplayOptions],
  );
  const {
    ownerFilterLabel,
    cycleOwnerFilter,
    typeFilter,
    visibleOptionIds,
  } = useAccountSSFilter(accountSmartSelectOptions);
  // 账户下拉必须保留「所有人」分组表头：useAccountSSFilter 返回的 filteredOptions 会把
  // isHeader 全部剔除（它的用途是平铺列表），直接拿来渲染层级下拉就会丢掉分组标题。
  const displayAccountOptions = useMemo(() => {
    if (!typeFilter) return accountSmartSelectOptions;
    const allowedIds = visibleOptionIds ?? new Set<string>();
    const keptHeaderIds = new Set<string>();
    for (const option of accountSmartSelectOptions) {
      if (option.isHeader || !option.parentId) continue;
      if (allowedIds.has(option.id)) keptHeaderIds.add(option.parentId);
    }
    return accountSmartSelectOptions.filter((option) =>
      option.isHeader ? keptHeaderIds.has(option.id) : allowedIds.has(option.id),
    );
  }, [accountSmartSelectOptions, typeFilter, visibleOptionIds]);
  const categoryById = useMemo(
    () => new Map(bookCategories.map((category) => [category.id, category])),
    [bookCategories],
  );
  const previewCategoryReplaceOptions = useMemo(
    () => buildCategoryOptions(bookCategories, undefined, t),
    [bookCategories, t],
  );
  const statementInfoTexts = useMemo(
    () => uniqueStatementInfoTexts(rows.map((row) => row.item)),
    [rows],
  );
  const statementInfoText = useMemo(
    () => (statementInfoTexts.length > 0
      ? t("statementImportPreview.statementInfo", { texts: statementInfoTexts.join(" / ") })
      : ""),
    [statementInfoTexts, t],
  );

  useEffect(() => {
    if (!open) return;
    if (!settingsBootstrapLoaded || !accountLookup) {
      builtFromRef.current = null;
      builtOptionsRef.current = null;
      // 幂等清空：值本来就空时必须原样返回，否则每次 setState 都产生新数组/新 Set，
      // 触发下一轮渲染又跑回这里，形成 "Maximum update depth exceeded" 的死循环。
      setRows((prev) => (prev.length === 0 ? prev : []));
      setSelectedKeys((prev) => (prev.size === 0 ? prev : new Set()));
      setEditingPreviewCell((prev) => (prev === null ? prev : null));
      setCategorySyncMessage((prev) => (prev === "" ? prev : ""));
      setTypeGuardNotice((prev) => (prev === null ? prev : null));
      return;
    }
    // 同一份导入数据只构建一次：用户在预览里改过的行存在 `rows` 里，
    // 而 `items` 还是原始数据 —— 切页签（open 变化）再重新 build 会把修改全冲掉。
    const itemsChanged = builtFromRef.current !== items;
    // 勾选/取消「创建往来款账户」「创建所有人账户」会改变「缺不缺账户」的判定，
    // 此时 items 没变也必须重算 ready，否则勾了选项行还停在「缺对向账户」。
    const optionsChanged = builtOptionsRef.current !== creationOptions;
    if (!itemsChanged && !optionsChanged) return;
    builtFromRef.current = items;
    builtOptionsRef.current = creationOptions;
    if (itemsChanged) {
      const nextRows = buildPreviewRows(items, defaultAccountName, accountLookup, creationOptions);
      setRows(nextRows);
      setSelectedKeys(new Set(nextRows.filter((row) => row.ready).map((row) => row.key)));
      setEditingPreviewCell(null);
      setCategorySyncMessage("");
      setTypeGuardNotice(null);
      return;
    }
    // 仅创建选项变化：保留用户已改过的行内容，只重算缺失字段与就绪状态。
    // 读 rowsRef 而不是依赖 rows —— rows 是这里 setState 的结果，放进依赖会自激。
    const recomputedRows = rowsRef.current.map((row) => {
      const missingFields = statementImportMissingFields(row.item, defaultAccountName, accountLookup, creationOptions);
      const ready = missingFields.length === 0;
      return { ...row, missingFields, ready };
    });
    setRows(recomputedRows);
    setSelectedKeys((prevSelected) => {
      const nextSelected = new Set(prevSelected);
      for (const row of recomputedRows) {
        if (row.ready) nextSelected.add(row.key);
        else nextSelected.delete(row.key);
      }
      return nextSelected;
    });
  }, [accountLookup, createLiabilityAccounts, creationOptions, defaultAccountName, items, open, settingsBootstrapLoaded]);

  useEffect(() => {
    if (!open) return;
    setCreateLiabilityAccounts(false);
    setForceCreateOwnedMoneyAccounts(false);
    // 账本数据已经加载过（例如从「基金买卖」页签切回「收支明细」）：保留现有预览行，
    // 不要再清空重拉 —— 重拉期间 rows 是空的，用户会以为「数据全没了」。
    if (settingsBootstrapLoaded) return;
    let cancelled = false;
    setRows([]);
    setSelectedKeys(new Set());
    fetchSettingsBootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        setBookAccounts(Array.isArray(bootstrap.accounts) ? bootstrap.accounts as BookAccount[] : []);
        setBookCategories(Array.isArray(bootstrap.categories) ? bootstrap.categories : []);
        setBookCounterparties(Array.isArray(bootstrap.counterparties) ? bootstrap.counterparties : []);
        setBookAccountGroups(Array.isArray(bootstrap.groups) ? bootstrap.groups : []);
        setSettingsBootstrapLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setBookAccounts([]);
        setBookCategories([]);
        setBookCounterparties([]);
        setBookAccountGroups([]);
        setSettingsBootstrapLoaded(true);
      });
    return () => { cancelled = true; };
  }, [open, settingsBootstrapLoaded]);

  function closeDialog() {
    builtFromRef.current = null;
    builtOptionsRef.current = null;
    setRows([]);
    setSelectedKeys(new Set());
    setEditingPreviewCell(null);
    setSettingsBootstrapLoaded(false);
    setCreateLiabilityAccounts(false);
    setForceCreateOwnedMoneyAccounts(false);
    setCategorySyncMessage("");
    setTypeGuardNotice(null);
    onClose();
  }

  function findPreviewAccountId(value?: string | null, meta?: StatementImportPreviewItem["_meta"]) {
    const raw = cleanText(value);
    if (!raw || !accountLookup) return "";
    const cacheKey = [
      raw,
      meta?.institutionName ?? "",
      meta?.ownerName ?? "",
      meta?.cardNumberMasked ?? "",
    ].join("\u001F");
    const accountResolveCache = accountResolveCacheRef.current;
    const cached = accountResolveCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const matchedId = findPreviewAccount(raw, accountLookup, meta)?.id ?? "";
    accountResolveCache.set(cacheKey, matchedId);
    return matchedId;
  }

  // 同一段识别文本常在多行/多次渲染里重复出现，缓存以避免每格都重建显示对象。
  const unmatchedDisplayCache = useMemo(() => {
    const cache = new Map<string, AccountDisplayOption>();
    return (text: string, meta?: StatementImportPreviewItem["_meta"]) => {
      const key = [text, meta?.institutionName ?? "", meta?.ownerName ?? "", meta?.statementCurrency ?? ""].join("\u001f");
      const cached = cache.get(key);
      if (cached) return cached;
      const display = buildUnmatchedAccountDisplay(text, meta, accountDisplaySettings);
      cache.set(key, display);
      return display;
    };
  }, [accountDisplaySettings]);

  function previewAccountSelectValue(value: string | undefined, meta?: StatementImportPreviewItem["_meta"]) {
    const text = cleanText(value);
    if (!text) return "";
    const matchedId = findPreviewAccountId(value, meta);
    return matchedId || `unmatched:${text}`;
  }

  function previewAccountOptionsFor(value: string | undefined, meta?: StatementImportPreviewItem["_meta"]) {
    const text = cleanText(value);
    const matchedId = findPreviewAccountId(text, meta);
    if (!text || matchedId) return displayAccountOptions;
    return [{
      id: `unmatched:${text}`,
      label: t("statementImportPreview.unmatchedValue", { value: text }),
      subLabel: t("statementImportPreview.originalRecognizedValue"),
    }, ...displayAccountOptions];
  }

  function previewAccountValueFromSelect(selectedId: string) {
    if (!selectedId) return "";
    if (selectedId.startsWith("unmatched:")) return selectedId.slice("unmatched:".length);
    return encodeImportAccountId(selectedId);
  }

  function previewAccountDisplayText(value: string | undefined, meta?: StatementImportPreviewItem["_meta"]) {
    const text = cleanText(value);
    if (!text) return "";
    const matchedId = findPreviewAccountId(text, meta);
    const display = matchedId ? accountDisplayById.get(matchedId) : undefined;
    return formatAccountTableLabel(display ?? unmatchedDisplayCache(text, meta), text, accountDisplaySettings);
  }

  function previewAccountDisplayTitle(value: string | undefined, meta?: StatementImportPreviewItem["_meta"]) {
    const text = cleanText(value);
    if (!text) return t("statementImportPreview.doubleClickEdit", { field: t("batchImport.field.account") });
    const matchedId = findPreviewAccountId(text, meta);
    const display = matchedId ? accountDisplayById.get(matchedId) : undefined;
    return formatAccountTableTitle(display ?? unmatchedDisplayCache(text, meta), text, accountDisplaySettings);
  }

  function previewCategorySelectValue(categoryName: string | undefined, txType: StatementImportPreviewItem["type"]) {
    const name = cleanText(categoryName);
    if (!name) return "";
    const categoryType = txType === "income" ? "income" : "expense";
    const matched = bookCategories.find((category) => category.name === name && category.type === categoryType)
      ?? bookCategories.find((category) => category.name === name);
    return matched?.id ?? "";
  }

  function missingAccountCandidateValues(row: ImportPreviewRow) {
    return missingAccountCandidateValuesForRow(row, defaultAccountName);
  }

  function missingLiabilityAccountNames(row: ImportPreviewRow) {
    // 往来归属候选（含非所有人「XX的YYY」）：返回将创建的账户原名，用于自动勾选与提示。
    return missingAccountCandidateValues(row)
      .map((value) => {
        const text = cleanText(value);
        if (!text) return "";
        if (parseSettlementAccountName(text)) return text;
        if (accountLookup && parseImportPersonAttributedCandidate(text, accountLookup.ownerNames)) return text;
        return "";
      })
      .filter(Boolean);
  }

  function missingOwnedMoneyAccountNames(row: ImportPreviewRow) {
    const names = missingAccountCandidateValues(row)
      .map((value) => parseImportOwnedMoneyAccountCandidate(value, accountLookup?.ownerNames ?? [])?.originalName ?? "")
      .filter(Boolean);
    return Array.from(new Set(names));
  }

  function ownedAccountTypeLabel(kind: string, investProductType?: string) {
    if (kind === "investment") {
      if (investProductType === "wealth" || investProductType === "advisor") return t("statementImportPreview.accountType.wealth");
      if (investProductType === "bond") return t("entry.kind.bond");
      if (investProductType === "money") return t("statementImportPreview.accountType.moneyFund");
      return t("statementImportPreview.accountType.fund");
    }
    if (kind === "bank_debit") return t("statementImportPreview.accountType.bankDebit");
    if (kind === "ewallet") return t("statementImportPreview.accountType.ewallet");
    if (kind === "cash") return t("statementImportPreview.accountType.cash");
    return t("batchImport.field.account");
  }

  function ownedAccountDisplayName(value: string) {
    const candidate = parseImportOwnedMoneyAccountCandidate(value, accountLookup?.ownerNames ?? []);
    if (!candidate) return "";
    const parts = [candidate.ownerName, candidate.institutionDisplayName ?? candidate.institutionName, candidate.accountName]
      .map(cleanText)
      .filter(Boolean);
    // 渠道账户（云闪付/微信/支付宝）的机构名与账户名相同，别显示成「墨斗鱼·云闪付·云闪付」
    return parts.filter((part, index) => index === 0 || part !== parts[index - 1]).join("·");
  }

  function forcedOwnedAccountCreationLabels(row: ImportPreviewRow) {
    if (!forceCreateOwnedMoneyAccounts || !accountLookup) return [];
    const accountValues = row.item.type === "transfer"
      ? [
          { value: primaryAccountValue(row.item, defaultAccountName), meta: row.item._meta },
          { value: counterAccountValue(row.item), meta: undefined },
        ]
      : [{ value: primaryAccountValue(row.item, defaultAccountName), meta: row.item._meta }];
    const labels = accountValues
      .filter(({ value, meta }) => cleanText(value) && !findPreviewAccount(value, accountLookup, meta))
      .map(({ value }) => {
        const candidate = parseImportOwnedMoneyAccountCandidate(value, accountLookup.ownerNames);
        if (!candidate) return "";
        return `${ownedAccountTypeLabel(candidate.kind, candidate.investProductType)}：${ownedAccountDisplayName(value)}`;
      })
      .filter(Boolean);
    return Array.from(new Set(labels));
  }

  function liabilityAccountCreationLabels(row: ImportPreviewRow) {
    if (!createLiabilityAccounts || !accountLookup) return [];
    const accountValues = row.item.type === "transfer"
      ? [
          { value: primaryAccountValue(row.item, defaultAccountName), meta: row.item._meta, allowBarePersonName: false },
          { value: counterAccountValue(row.item), meta: undefined, allowBarePersonName: true },
        ]
      : [{ value: primaryAccountValue(row.item, defaultAccountName), meta: row.item._meta, allowBarePersonName: false }];
    // 保留原名口径：标签直接展示将创建的账户原名（类型=往来款）。
    const names = accountValues
      .filter(({ value, meta }) => cleanText(value) && !findPreviewAccount(value, accountLookup, meta))
      .filter(({ value, allowBarePersonName }) => isCreatableLiabilityAccount(value, accountLookup, { createLiabilityAccounts: true, forceCreateOwnedMoneyAccounts: false }, allowBarePersonName))
      .map(({ value }) => cleanText(value))
      .filter(Boolean);
    return Array.from(new Set(names));
  }

  function counterKindCreationLabels(row: ImportPreviewRow) {
    if (!createLiabilityAccounts || !accountLookup) return null;
    const hint = importCounterKindFromCategory(row.item.category);
    if (!hint) return null;
    const value = counterAccountValue(row.item);
    if (!cleanText(value) || findPreviewAccount(value, accountLookup, row.item._meta)) return null;
    const key = hint === "credit"
      ? "statementImportPreview.willCreateCreditAccount"
      : "statementImportPreview.willCreateLoanAccount";
    return { kind: hint, text: t(key, { value: cleanText(value) }) };
  }

  function previewCreationStatus(row: ImportPreviewRow) {
    const liabilityLabels = liabilityAccountCreationLabels(row);
    if (liabilityLabels.length > 0) {
      return {
        kind: "settlement" as const,
        text: t("statementImportPreview.willCreateLiabilityAccounts", { value: liabilityLabels.join(" / ") }),
      };
    }
    const counterKindStatus = counterKindCreationLabels(row);
    if (counterKindStatus) return counterKindStatus;
    const ownedLabels = forcedOwnedAccountCreationLabels(row);
    if (ownedLabels.length > 0) {
      return {
        kind: "owned" as const,
        text: t("statementImportPreview.willCreateOwnedMoneyAccounts", { value: ownedLabels.join(" / ") }),
      };
    }
    return null;
  }

  function ambiguousAccountMatchLabels(row: ImportPreviewRow) {
    if (!accountLookup) return [];
    const labels = missingAccountCandidateValues(row)
      .filter(Boolean)
      .map((value) => {
        const match = accountLookup.matchAccount(value);
        if (match.account || match.ambiguousAccounts.length < 2) return "";
        // 文本带"所有人·机构·类型"语义时，给出维度化的说明
        // 和"勾选创建所有人账户"的出路；纯类型词（如"信用卡"）解析不出所有人，保持原文案。
        const ownedCandidate = parseImportOwnedMoneyAccountCandidate(value, accountLookup.ownerNames);
        if (ownedCandidate) {
          const dimension = ownedAccountDisplayName(value) || cleanText(value);
          return t("statementImportPreview.ambiguousAccountMatchesOwned", {
            count: language === "zh-CN" && match.ambiguousAccounts.length === 2 ? t("statementImportPreview.ambiguousAccountCount.two") : String(match.ambiguousAccounts.length),
            name: dimension,
          });
        }
        return t("statementImportPreview.ambiguousAccountMatches", {
          count: language === "zh-CN" && match.ambiguousAccounts.length === 2 ? t("statementImportPreview.ambiguousAccountCount.two") : String(match.ambiguousAccounts.length),
          name: cleanText(value),
        });
      })
      .filter(Boolean);
    return Array.from(new Set(labels));
  }

  function previewStatusText(row: ImportPreviewRow) {
    const ambiguousLabels = ambiguousAccountMatchLabels(row);
    if (ambiguousLabels.length > 0) return ambiguousLabels.join(" / ");
    if (row.ready) {
      const creationStatus = previewCreationStatus(row);
      if (creationStatus) return creationStatus.text;
      return t("statementImportPreview.importable");
    }
    const liabilityAccountNames = missingLiabilityAccountNames(row);
    if (liabilityAccountNames.length > 0 && !createLiabilityAccounts) {
      return t("statementImportPreview.enableCreateLiabilityAccounts", { name: liabilityAccountNames.join(" / ") });
    }
    const ownedMoneyAccountNames = missingOwnedMoneyAccountNames(row);
    if (ownedMoneyAccountNames.length > 0 && !forceCreateOwnedMoneyAccounts) {
      return t("statementImportPreview.enableForceCreateOwnedMoneyAccounts", { name: ownedMoneyAccountNames.join(" / ") });
    }
    return t("statementImportPreview.missingFields", {
      fields: row.missingFields.map((field) => t(MISSING_FIELD_LABEL_KEYS[field] ?? field)).join("、") || t("statementImportPreview.field"),
    });
  }

  function previewCategoryNameById(categoryId: string) {
    if (!categoryId) return "";
    return categoryById.get(categoryId)?.name ?? "";
  }

  function previewCategorySmartSelectOptionsFor(txType: StatementImportPreviewItem["type"]): SmartSelectOption[] {
    const categoryType = txType === "income" ? "income" : "expense";
    return buildCategoryOptions(bookCategories, txType, t)
      .filter((option) => {
        if (!option.value) return true;
        if (option.isHeader) return option.value === `preview-category-type:${categoryType}`;
        return categoryById.get(option.value)?.type === categoryType;
      })
      .map((option) => ({
        id: option.value,
        label: option.label,
        isHeader: option.isHeader,
        isGroup: option.isGroup,
        parentId: option.parentId,
      }));
  }

  function primaryAccountPatch(item: StatementImportPreviewItem, value: string): Partial<StatementImportPreviewItem> {
    if (item.type !== "transfer") return { account: value || undefined };
    return isTransferOut(item)
      ? { account: value || undefined, fromAccount: value || undefined }
      : { account: value || undefined, toAccount: value || undefined };
  }

  function counterAccountPatch(item: StatementImportPreviewItem, value: string): Partial<StatementImportPreviewItem> {
    if (item.type !== "transfer") return {};
    return isTransferOut(item)
      ? { toAccount: value || undefined }
      : { fromAccount: value || undefined };
  }

  function typePatchForItem(item: StatementImportPreviewItem, type: StatementImportPreviewItem["type"]): Partial<StatementImportPreviewItem> {
    const amount = Math.abs(Number(item.amount || item.inflow || item.outflow || 0));
    const account = cleanText(item.account) || cleanText(item.toAccount) || cleanText(defaultAccountName);
    if (type === "transfer") {
      const transferDirection: "in" | "out" = item.transferDirection ?? (Number(item.outflow ?? 0) > 0 ? "out" : "in");
      return transferDirection === "out"
        ? {
            type,
            amount,
            account,
            fromAccount: cleanText(item.fromAccount) || account,
            toAccount: cleanText(item.toAccount),
            transferDirection,
            inflow: undefined,
            outflow: amount,
          }
        : {
            type,
            amount,
            account,
            toAccount: cleanText(item.toAccount) || account,
            fromAccount: cleanText(item.fromAccount),
            transferDirection,
            inflow: amount,
            outflow: undefined,
          };
    }
    if (type === "income") {
      return {
        type,
        amount,
        account,
        fromAccount: undefined,
        toAccount: undefined,
        transferDirection: undefined,
        inflow: amount,
        outflow: undefined,
      };
    }
    return {
      type,
      amount,
      account,
      fromAccount: undefined,
      toAccount: undefined,
      transferDirection: undefined,
      inflow: undefined,
      outflow: amount,
    };
  }

  /**
   * 「收支大类 → 转账」守卫（微信账单专用，其它账单原样放行）：
   * - 微信原文「交易类型」不含转账（商户消费 / 红包 / 二维码收款 / 空值）→ 不准改成转账；
   * - 微信原文是转账但没有「交易对象」→ 也不准改成转账（没有对向账户）；
   * - 原文是转账且有交易对象 → 按「<交易对象>的往来款」填对向账户，并提示将新建该往来款账户。
   */
  function typeChangeForItem(
    item: StatementImportPreviewItem,
    type: StatementImportPreviewItem["type"],
  ):
    | { blocked: { text: string; tone: "warn" } }
    | { patch: Partial<StatementImportPreviewItem>; notice: { text: string; tone: "info" | "warn" } | null } {
    const patch = typePatchForItem(item, type);
    if (type !== "transfer") return { patch, notice: null };
    const guard = resolveWechatTransferGuard(item);
    const blockedMessage = wechatTransferBlockMessage(guard);
    if (blockedMessage) {
      return { blocked: { text: t(blockedMessage.key, blockedMessage.params), tone: "warn" } };
    }
    if (guard.kind === "transfer") {
      return {
        patch: {
          ...patch,
          ...(patch.transferDirection === "out"
            ? { toAccount: guard.counterAccountName }
            : { fromAccount: guard.counterAccountName }),
        },
        notice: {
          text: t(
            createLiabilityAccounts
              ? "statementImportPreview.wechatTransferFilledCounterAccount"
              : "statementImportPreview.wechatTransferFilledCounterAccountNeedsOption",
            { name: guard.counterparty, account: guard.counterAccountName },
          ),
          tone: "info",
        },
      };
    }
    // 非微信账单（MMH 标准模板 / 银行流水 / 财智等）没有「原交易类型」列，走不了上面的守卫，
    // 但原文「对向账户 / 对方账户」列往往写着交易对象——只是非转账行不参与导入被丢掉了。
    // 改成转账时按往来款口径回填，否则状态只会停在「缺对向账户」。
    const rawCounterAccount = cleanText(item.rawCounterAccount);
    const suggestedCounterAccount = suggestTransferCounterAccountName(rawCounterAccount);
    if (suggestedCounterAccount) {
      if (patch.transferDirection === "out") {
        if (!cleanText(patch.toAccount)) {
          return {
            patch: { ...patch, toAccount: suggestedCounterAccount },
            notice: {
              text: t(
                createLiabilityAccounts
                  ? "statementImportPreview.transferFilledCounterAccount"
                  : "statementImportPreview.transferFilledCounterAccountNeedsOption",
                { name: rawCounterAccount, account: suggestedCounterAccount },
              ),
              tone: "info",
            },
          };
        }
      } else if (!cleanText(patch.fromAccount)) {
        return {
          patch: { ...patch, fromAccount: suggestedCounterAccount },
          notice: {
            text: t(
              createLiabilityAccounts
                ? "statementImportPreview.transferFilledCounterAccount"
                : "statementImportPreview.transferFilledCounterAccountNeedsOption",
              { name: rawCounterAccount, account: suggestedCounterAccount },
            ),
            tone: "info",
          },
        };
      }
    }
    return { patch, notice: null };
  }

  function recomputeRow(row: ImportPreviewRow, patch: Partial<StatementImportPreviewItem>): ImportPreviewRow {
    let item: StatementImportPreviewItem = { ...row.item, ...patch };
    if ("date" in patch) {
      const nextDate = normalizeDateOnlyText(patch.date);
      const previousDate = normalizeDateOnlyText(row.item.date);
      const previousPostedDate = normalizeDateOnlyText(row.item.postedDate);
      item.date = nextDate || undefined;
      if (!previousPostedDate || previousPostedDate === previousDate) item.postedDate = nextDate || undefined;
    }
    if ("postedDate" in patch) item.postedDate = normalizeDateOnlyText(patch.postedDate) || undefined;
    item = normalizeTransferFlow(item);
    const missingFields = statementImportMissingFields(item, defaultAccountName, accountLookup, creationOptions);
    return {
      ...row,
      item,
      missingFields,
      ready: missingFields.length === 0,
    };
  }

  function recomputeState(nextRows: ImportPreviewRow[]) {
    const rowKeys = new Set(nextRows.map((row) => row.key));
    setRows(nextRows);
    setSelectedKeys((current) => new Set(Array.from(current).filter((key) => rowKeys.has(key))));
  }

  function updatePreviewRow(rowKey: string, patch: Partial<StatementImportPreviewItem>) {
    const nextRows = rows.map((row) => row.key === rowKey ? recomputeRow(row, patch) : row);
    recomputeState(nextRows);
  }

  function updatePreviewCategoryForMatchingRemarks(rowKey: string, categoryId: string) {
    const sourceRows = rows;
    const sourceIndex = sourceRows.findIndex((row) => row.key === rowKey);
    if (sourceIndex < 0) return;

    const category = previewCategoryNameById(categoryId);
    const sourceKey = statementPreviewCategorySyncKey(sourceRows[sourceIndex].item);
    let propagatedCount = 0;
    const nextRows = sourceRows.map((row, index) => {
      const isSource = index === sourceIndex;
      const isMatchingRemark = Boolean(sourceKey && statementPreviewCategorySyncKey(row.item) === sourceKey);
      if (!isSource && !isMatchingRemark) return row;
      if (!isSource && cleanText(row.item.category) === category) return row;
      if (!isSource) propagatedCount += 1;
      return recomputeRow(row, {
        category: category || undefined,
        categoryUserEdited: true,
      });
    });
    recomputeState(nextRows);
    setCategorySyncMessage(
      propagatedCount > 0
        ? t("statementImportPreview.sameRemarkCategoryApplied", { count: propagatedCount })
        : "",
    );
  }

  function applyPreviewReplace(field: PreviewEditField, value: string) {
    if (!settingsBootstrapLoaded) throw new Error(t("batchImport.processingDataTitle"));
    const sourceRows = rows;
    const effectiveSelectedKeys = selectedKeys;
    const selectedRowKeys = Array.from(effectiveSelectedKeys);
    if (selectedRowKeys.length === 0) throw new Error(t("statementImportPreview.selectRowsFirst"));
    let changed = 0;
    let invalid = 0;
    const nextRows = sourceRows.map((row) => {
      if (!effectiveSelectedKeys.has(row.key)) return row;
      if (field === "amount" || field === "inflow" || field === "outflow") {
        const currentValue = field === "amount"
          ? row.item.amount
          : Number(row.item[field] ?? 0) || 0;
        const computed = evaluateCalcInputExpression(value, currentValue);
        if (computed == null) {
          invalid++;
          return row;
        }
        changed++;
        return field === "amount"
          ? recomputeRow(row, amountPatchForItem(row.item, computed))
          : recomputeRow(row, flowAmountPatchForItem(row.item, field, computed));
      }
      if (field === "type") {
        // 微信账单里「没有交易对象」的行不能批量改成转账（同单行编辑口径），直接计入跳过。
        const next = typeChangeForItem(row.item, value as StatementImportPreviewItem["type"]);
        if ("blocked" in next) {
          invalid++;
          return row;
        }
        changed++;
        return recomputeRow(row, next.patch);
      }
      changed++;
      if (field === "account") return recomputeRow(row, primaryAccountPatch(row.item, value ? encodeImportAccountId(value) : ""));
      if (field === "counterAccount") return recomputeRow(row, counterAccountPatch(row.item, value ? encodeImportAccountId(value) : ""));
      if (field === "category") return recomputeRow(row, { category: previewCategoryNameById(value) || undefined, categoryUserEdited: true });
      if (field === "institution") return recomputeRow(row, { institution: value || undefined, institutionUserEdited: true });
      return recomputeRow(row, { [field]: value || undefined } as Partial<StatementImportPreviewItem>);
    });
    recomputeState(nextRows);
    const invalidSuffix = invalid > 0
      ? t(field === "type" ? "statementImportPreview.invalidTypeSkipped" : "statementImportPreview.invalidAmountSkipped", { count: invalid })
      : "";
    return t("statementImportPreview.batchReplaceResult", { count: changed, field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS[field]), invalidSuffix });
  }

  function previewItemForImport(item: StatementImportPreviewItem): StatementImportPreviewItem {
    if (item.type !== "transfer") {
      return cleanText(item.account) ? item : { ...item, account: cleanText(defaultAccountName) || undefined };
    }
    const primaryAccount = primaryAccountValue(item, defaultAccountName);
    const counterAccount = counterAccountValue(item);
    return isTransferOut(item)
      ? {
          ...item,
          account: primaryAccount || undefined,
          fromAccount: primaryAccount || undefined,
          toAccount: counterAccount || undefined,
        }
      : {
          ...item,
          account: primaryAccount || undefined,
          fromAccount: counterAccount || undefined,
          toAccount: primaryAccount || undefined,
        };
  }

  async function confirmSelected() {
    if (busy || !settingsBootstrapLoaded) return;
    const sourceRows = rows;
    const effectiveSelectedKeys = selectedKeys;
    // 未匹配/未就绪行允许勾选与批量修改，但最终只导入已就绪的勾选行
    const selectedRows = sourceRows.filter((row) => effectiveSelectedKeys.has(row.key) && row.ready);
    if (selectedRows.length === 0) return;
    const selectedItems = selectedRows.map((row) => previewItemForImport(row.item));
    if (selectedItems.length === 0) return;
    await onConfirm(selectedItems, {
      createLiabilityAccounts,
      forceCreateOwnedMoneyAccounts,
    });
  }

  const previewAccountReplaceOptions = useMemo<BatchReplaceOption[]>(
    () => [
      { value: "", label: t("batchImport.unselected") },
      ...accountDisplayOptions.map((account) => ({
        value: account.id,
        label: formatAccountTableLabel(account, "", accountDisplaySettings),
        title: formatAccountTableTitle(account, "", accountDisplaySettings),
      })),
    ],
    [accountDisplayOptions, accountDisplaySettings, t],
  );

  const previewReplaceFields = useMemo<BatchReplaceFieldConfig<PreviewEditField>[]>(
    () => [
      { value: "date", label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.date), kind: "text", placeholder: t("statementImportPreview.datePlaceholder") },
      { value: "postedDate", label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.postedDate), kind: "date", placeholder: t("statementImportPreview.postedDatePlaceholder") },
      {
        value: "type",
        label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.type),
        kind: "select",
        options: [{ value: "", label: t("batchImport.selectType") }, ...PREVIEW_TYPE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))],
        placeholder: t("batchImport.selectType"),
      },
      {
        value: "account",
        label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.account),
        kind: "smartSelect",
        options: previewAccountReplaceOptions,
        placeholder: t("statementImportPreview.selectAccount"),
        allowEmpty: true,
        smartSelectBehavior: { search: true, hierarchy: true, minDropdownWidth: 252, fitContent: true, dropdownMaxHeight: 220, density: "micro", resizableDropdown: true },
      },
      {
        value: "counterAccount",
        label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.counterAccount),
        kind: "smartSelect",
        options: previewAccountReplaceOptions,
        placeholder: t("statementImportPreview.selectCounterAccount"),
        allowEmpty: true,
        smartSelectBehavior: { search: true, hierarchy: true, minDropdownWidth: 252, fitContent: true, dropdownMaxHeight: 220, density: "micro", resizableDropdown: true },
      },
      {
        value: "category",
        label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.category),
        kind: "smartSelect",
        options: previewCategoryReplaceOptions,
        placeholder: t("statementImportPreview.selectCategory"),
        allowEmpty: true,
        smartSelectBehavior: CATEGORY_SMART_SELECT_BEHAVIOR,
      },
      { value: "institution", label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.institution), kind: "text", placeholder: t("statementImportPreview.institutionPlaceholder") },
      { value: "outflow", label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.outflow), kind: "number", placeholder: t("statementImportPreview.amountExpressionPlaceholder") },
      { value: "inflow", label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.inflow), kind: "number", placeholder: t("statementImportPreview.amountExpressionPlaceholder") },
      { value: "amount", label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.amount), kind: "number", placeholder: t("statementImportPreview.amountExpressionPlaceholder") },
    ],
    [previewAccountReplaceOptions, previewCategoryReplaceOptions, t],
  );

  function stopPreviewCellEvent(event: ReactMouseEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function editableCellProps(rowKey: string, field: PreviewEditField) {
    return {
      "data-row-double-click-ignore": true,
      onMouseDown: stopPreviewCellEvent,
      onClick: stopPreviewCellEvent,
      onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
        event.stopPropagation();
        setEditingPreviewCell({ rowKey, field });
      },
    };
  }

  function amountEditorSide(item: StatementImportPreviewItem): "inflow" | "outflow" {
    const inflow = Math.abs(Number(item.inflow ?? 0)) || 0;
    const outflow = Math.abs(Number(item.outflow ?? 0)) || 0;
    if (inflow > 0 && outflow <= 0) return "inflow";
    if (item.type === "income") return "inflow";
    return "outflow";
  }

  function renderAmountInput(row: ImportPreviewRow) {
    return (
      <input
        data-row-double-click-ignore
        type="number"
        value={Number(row.item.amount || 0) || ""}
        autoFocus
        step="0.01"
        onMouseDown={stopPreviewCellEvent}
        onClick={stopPreviewCellEvent}
        onDoubleClick={stopPreviewCellEvent}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => updatePreviewRow(row.key, amountPatchForItem(row.item, Number(event.target.value) || 0))}
        onBlur={() => setEditingPreviewCell(null)}
        className="h-8 w-24 rounded-md border border-blue-200 bg-white px-2 text-right text-xs tabular-nums outline-none"
      />
    );
  }

  function renderTextEditCell(row: ImportPreviewRow, field: PreviewEditField, value: string, titleText: string) {
    if (editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === field) {
      return (
        <input
          data-row-double-click-ignore
          type="text"
          value={value}
          autoFocus
          onMouseDown={stopPreviewCellEvent}
          onClick={stopPreviewCellEvent}
          onDoubleClick={stopPreviewCellEvent}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => updatePreviewRow(row.key, {
            [field]: event.target.value || undefined,
            ...(field === "institution" ? { institutionUserEdited: true } : {}),
          } as Partial<StatementImportPreviewItem>)}
          onBlur={() => setEditingPreviewCell(null)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") setEditingPreviewCell(null);
          }}
          className="h-8 w-full rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
        />
      );
    }
    return (
      <span
        data-row-double-click-ignore
        className="block min-h-5 w-full truncate cursor-pointer rounded px-1 py-0.5 text-slate-700 hover:bg-slate-100"
        title={titleText}
        onMouseDown={stopPreviewCellEvent}
        onClick={stopPreviewCellEvent}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setEditingPreviewCell({ rowKey: row.key, field });
        }}
      >
        {displayPreviewValue(value)}
      </span>
    );
  }

  const columns = useMemo<AdvancedDataTableColumn<ImportPreviewRow>[]>(() => [
    {
      // 序号列：与基金预览第一列同款（用户 2026-10-30：「基金买卖导入预览有序号，
      // 收支明细也要有」）。注意导入时按勾选行提交，序号只是预览里的行号定位。
      key: "index",
      label: "#",
      width: 42,
      minWidth: 36,
      align: "center",
      filterText: () => "",
      render: (row) => <span className="text-[11px] text-slate-400">{row.idx + 1}</span>,
    },
    {
      key: "date",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.date),
      width: 100,
      minWidth: 84,
      filterKind: "dateRange",
      filterText: (row) => row.item.date?.trim() || t("batchImport.emptyValue"),
      sortValue: (row) => row.item.date || "",
      render: (row) => (
        <div className="whitespace-nowrap tabular-nums text-slate-700" {...editableCellProps(row.key, "date")}>
          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "date" ? (
            <DateStepper
              autoFocus
              className="h-8 rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
              value={normalizeDateOnlyText(row.item.date)}
              onBlur={() => setEditingPreviewCell(null)}
              onChange={(value) => {
                updatePreviewRow(row.key, { date: value || undefined });
                setEditingPreviewCell(null);
              }}
            />
          ) : (
            <span className="block min-h-5 w-full cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.date) })}>{displayPreviewValue(normalizeDateOnlyText(row.item.date))}</span>
          )}
        </div>
      ),
    },
    {
      key: "postedDate",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.postedDate),
      width: 110,
      minWidth: 96,
      hideable: true,
      filterKind: "dateRange",
      filterText: (row) => normalizeDateOnlyText(row.item.postedDate) || t("batchImport.emptyValue"),
      sortValue: (row) => normalizeDateOnlyText(row.item.postedDate) || "",
      render: (row) => (
        <div className="whitespace-nowrap tabular-nums text-slate-500" {...editableCellProps(row.key, "postedDate")}>
          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "postedDate" ? (
            <DateStepper
              autoFocus
              className="h-8 rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
              value={normalizeDateOnlyText(row.item.postedDate)}
              onBlur={() => setEditingPreviewCell(null)}
              onChange={(value) => {
                updatePreviewRow(row.key, { postedDate: value || undefined });
                setEditingPreviewCell(null);
              }}
            />
          ) : (
            <span className="block min-h-5 w-full cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.postedDate) })}>{displayPreviewValue(normalizeDateOnlyText(row.item.postedDate))}</span>
          )}
        </div>
      ),
    },
    {
      key: "type",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.type),
      width: 72,
      minWidth: 60,
      filterText: (row) => typeLabel(t, row.item.type),
      render: (row) => (
        <div className="whitespace-nowrap text-slate-700" {...editableCellProps(row.key, "type")}>
          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "type" ? (
            <select
              data-row-double-click-ignore
              autoFocus
              className="h-8 rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
              value={row.item.type}
              onMouseDown={stopPreviewCellEvent}
              onClick={stopPreviewCellEvent}
              onDoubleClick={stopPreviewCellEvent}
              onBlur={() => setEditingPreviewCell(null)}
              onChange={(event) => {
                const next = typeChangeForItem(row.item, event.target.value as StatementImportPreviewItem["type"]);
                if ("blocked" in next) {
                  setTypeGuardNotice(next.blocked);
                  setEditingPreviewCell(null);
                  return;
                }
                updatePreviewRow(row.key, next.patch);
                setTypeGuardNotice(next.notice);
                setEditingPreviewCell(null);
              }}
            >
              {PREVIEW_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
              ))}
            </select>
          ) : (
            <span className="cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.type) })}>{typeLabel(t, row.item.type)}</span>
          )}
        </div>
      ),
    },
    {
      key: "account",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.account),
      width: 190,
      minWidth: 140,
      filterText: (row) => previewAccountDisplayText(primaryAccountValue(row.item, defaultAccountName), row.item._meta) || t("batchImport.emptyValue"),
      render: (row) => {
        const accountValue = primaryAccountValue(row.item, defaultAccountName);
        return (
          <div className="min-w-[180px] text-slate-700" {...editableCellProps(row.key, "account")}>
            {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "account" ? (
              <SmartSelect
                mode="single"
                value={previewAccountSelectValue(accountValue, row.item._meta)}
                onChange={(selectedId) => {
                  updatePreviewRow(row.key, primaryAccountPatch(row.item, previewAccountValueFromSelect(selectedId)));
                  setEditingPreviewCell(null);
                }}
                options={previewAccountOptionsFor(accountValue, row.item._meta)}
                placeholder={t("statementImportPreview.selectAccount")}
                onCycleOwnerFilter={cycleOwnerFilter}
                ownerFilterLabel={ownerFilterLabel}
                behavior={{ search: true, hierarchy: true, clearable: true, cycleSelectionWithArrowKeys: true, minDropdownWidth: 216, fitContent: true, dropdownMaxHeight: 180, density: "micro", resizableDropdown: true, autoOpen: true, onDropdownClose: () => setEditingPreviewCell(null) }}
              />
            ) : (
              <span className="block min-h-5 w-full truncate cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={previewAccountDisplayTitle(accountValue, row.item._meta)}>
                {displayPreviewValue(previewAccountDisplayText(accountValue, row.item._meta))}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "counterAccount",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.counterAccount),
      width: 170,
      minWidth: 120,
      hideable: true,
      filterText: (row) => previewAccountDisplayText(counterAccountValue(row.item)) || t("batchImport.emptyValue"),
      render: (row) => {
        if (row.item.type !== "transfer") return <span className="text-slate-400">-</span>;
        const accountValue = counterAccountValue(row.item);
        return (
          <div className="min-w-[170px] text-slate-700" {...editableCellProps(row.key, "counterAccount")}>
            {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "counterAccount" ? (
              <SmartSelect
                mode="single"
                value={previewAccountSelectValue(accountValue)}
                onChange={(selectedId) => {
                  updatePreviewRow(row.key, counterAccountPatch(row.item, previewAccountValueFromSelect(selectedId)));
                  setEditingPreviewCell(null);
                }}
                options={previewAccountOptionsFor(accountValue)}
                placeholder={t("statementImportPreview.selectCounterAccount")}
                onCycleOwnerFilter={cycleOwnerFilter}
                ownerFilterLabel={ownerFilterLabel}
                behavior={{ search: true, hierarchy: true, clearable: true, cycleSelectionWithArrowKeys: true, minDropdownWidth: 216, fitContent: true, dropdownMaxHeight: 180, density: "micro", resizableDropdown: true, autoOpen: true, onDropdownClose: () => setEditingPreviewCell(null) }}
              />
            ) : (
              <span className="block min-h-5 w-full truncate cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={previewAccountDisplayTitle(accountValue)}>
                {displayPreviewValue(previewAccountDisplayText(accountValue))}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "category",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.category),
      width: 110,
      minWidth: 88,
      filterText: (row) => systemCategoryLabel(row.item.category, t) || t("batchImport.emptyValue"),
      render: (row) => (
        <div className="w-full min-w-0 truncate whitespace-nowrap text-slate-700" {...editableCellProps(row.key, "category")}>
          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "category" ? (
            <div className="w-full min-w-0">
              <SmartSelect
                mode="single"
                value={previewCategorySelectValue(row.item.category, row.item.type)}
                onChange={(categoryId) => {
                  updatePreviewCategoryForMatchingRemarks(row.key, categoryId);
                  setEditingPreviewCell(null);
                }}
                options={previewCategorySmartSelectOptionsFor(row.item.type)}
                placeholder={t("statementImportPreview.selectCategory")}
                searchable
                behavior={{ ...CATEGORY_SMART_SELECT_BEHAVIOR, autoOpen: true, showGroupCounts: false, onDropdownClose: () => setEditingPreviewCell(null) }}
              />
            </div>
          ) : (
            <span className="block min-h-5 w-full cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.category) })}>{displayPreviewValue(systemCategoryLabel(row.item.category, t))}</span>
          )}
        </div>
      ),
    },
    {
      key: "institution",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.institution),
      width: 118,
      minWidth: 90,
      hideable: true,
      filterText: (row) => cleanText(row.item.institution || row.item.counterparty) || t("batchImport.emptyValue"),
      render: (row) => renderTextEditCell(row, "institution", cleanText(row.item.institution || row.item.counterparty), t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.institution) })),
    },
    {
      key: "inflow",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.inflow),
      width: 88,
      minWidth: 74,
      truncate: true,
      align: "right",
      filterKind: "numberRange",
      filterText: (row) => importPreviewFlowAmountTextFor(row.item, "inflow"),
      filterNumber: (row) => row.item.inflow ?? (row.item.type === "income" ? row.item.amount : 0),
      sortValue: (row) => row.item.inflow ?? (row.item.type === "income" ? row.item.amount : 0),
      render: (row) => (
        <div className="text-right" {...editableCellProps(row.key, "amount")}>
          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "amount" && amountEditorSide(row.item) === "inflow" ? (
            renderAmountInput(row)
          ) : (
            <span className={`block min-h-5 w-full cursor-pointer whitespace-nowrap rounded px-1 py-0.5 tabular-nums hover:bg-slate-100 ${importPreviewFlowAmountColorFor(row.item, "inflow", colorScheme)}`} title={t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.amount) })}>
              {displayPreviewValue(importPreviewFlowAmountTextFor(row.item, "inflow"))}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "outflow",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.outflow),
      width: 88,
      minWidth: 74,
      truncate: true,
      align: "right",
      filterKind: "numberRange",
      filterText: (row) => importPreviewFlowAmountTextFor(row.item, "outflow"),
      filterNumber: (row) => row.item.outflow ?? (row.item.type === "expense" && !row.item.inflow ? row.item.amount : 0),
      sortValue: (row) => row.item.outflow ?? (row.item.type === "expense" && !row.item.inflow ? row.item.amount : 0),
      render: (row) => (
        <div className="text-right" {...editableCellProps(row.key, "amount")}>
          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "amount" && amountEditorSide(row.item) === "outflow" ? (
            renderAmountInput(row)
          ) : (
            <span className={`block min-h-5 w-full cursor-pointer whitespace-nowrap rounded px-1 py-0.5 tabular-nums hover:bg-slate-100 ${importPreviewFlowAmountColorFor(row.item, "outflow", colorScheme)}`} title={t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.amount) })}>
              {displayPreviewValue(importPreviewFlowAmountTextFor(row.item, "outflow"))}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "remark",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.remark),
      width: 230,
      minWidth: 160,
      filterText: (row) => (row.item.remark || row.item.rawText || "").trim() || t("batchImport.emptyValue"),
      render: (row) => renderTextEditCell(row, "remark", row.item.remark || row.item.rawText || "", t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.remark) })),
    },
    {
      // 标签列（2026-11-04 用户）：账单 CSV 的「标签」列，双击可改，随行提交、
      // 服务端按名找/建后挂 EntryTag。空值显示占位符，可筛选。
      key: "tags",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.tags),
      width: 120,
      minWidth: 90,
      hideable: true,
      filterText: (row) => cleanText(row.item.tags) || t("batchImport.emptyValue"),
      render: (row) => renderTextEditCell(row, "tags", cleanText(row.item.tags), t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.tags) })),
    },
    {
      key: "status",
      label: t("statementImportPreview.status"),
      width: 180,
      minWidth: 140,
      filterText: previewStatusText,
      render: (row) => {
        const statusText = previewStatusText(row);
        const creationStatus = row.ready ? previewCreationStatus(row) : null;
        if (creationStatus) {
          const className = creationStatus.kind === "owned"
            ? "rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700"
            : "rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700";
          return <span className={className} title={statusText}>{statusText}</span>;
        }
        return row.ready ? (
          <span className="text-[11px] text-slate-400">-</span>
        ) : (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700" title={statusText}>
            {statusText}
          </span>
        );
      },
    },
  ], [
    accountLookup,
    accountDisplayById,
    bookCategories,
    categoryById,
    colorScheme,
    createLiabilityAccounts,
    cycleOwnerFilter,
    defaultAccountName,
    displayAccountOptions,
    editingPreviewCell,
    forceCreateOwnedMoneyAccounts,
    language,
    ownerFilterLabel,
    rows,
    t,
    updatePreviewCategoryForMatchingRemarks,
  ]);

  const fallbackRows = rows;
  const fallbackSelectedKeys = selectedKeys;
  const previewReady = settingsBootstrapLoaded && rows.length > 0;
  const importReadySelectedCount = useMemo(
    () => fallbackRows.reduce((count, row) => count + (fallbackSelectedKeys.has(row.key) && row.ready ? 1 : 0), 0),
    [fallbackRows, fallbackSelectedKeys],
  );

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <ModalLayer
      className="fixed inset-0 flex items-center justify-center bg-slate-900/40 px-4 py-6"
      style={hidden ? { display: "none" } : undefined}
    >
      <div data-batch-popover-boundary data-smart-select-boundary className="flex h-[82vh] min-h-[420px] w-[80rem] min-w-[720px] max-w-[calc(100vw-2rem)] resize flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
        {/* 窗口标题栏在卡片**外面**：外框只有这一个，切换页签时窗口尺寸不变。
            标题栏与基金预览共用 `ImportPreviewHeader`：字号 / 行高 / 高度完全一致，
            两个窗口互相切换时页签条不会上下跳。账单信息（账单金额 + 账期 + 还款日 +
            币种 + 额度）不再放标题栏第三行 —— 那会让基金侧空一行、账单侧高一行，
            切换时页签条又跳 —— 挪进下面卡片内部顶部，只在账单侧出现。 */}
        <ImportPreviewHeader
          title={title}
          description={description}
          onClose={closeDialog}
          closeDisabled={busy}
          closeLabel={t("table.close")}
        />
        {/* FT 卡片：页签条流内撑出卡片顶边，活动页签的 -mb-px 压在卡片 1px 上边框上
            （几何同 FolderTabsCard；弹窗是固定高度，故用 ft-card-surface-fill）。 */}
        <div className="relative flex min-h-0 flex-1 flex-col p-3">
          <div className="relative flex min-h-0 flex-1 flex-col">
            {tabs}
            <div className="ft-card-surface ft-card-surface-fill">
              <div className="flex min-h-0 flex-1 flex-col">
                {/* 账单信息（账单金额 + 账期 + 还款日 + 币种 + 额度）：从标题栏挪进卡片
                    顶部，只在账单侧出现；标题栏两边保持同样的两行，切换页签不会跳。 */}
                {statementInfoText ? (
                  <div className="shrink-0 truncate border-b border-slate-100 px-4 py-2 text-xs leading-4 text-slate-500" title={statementInfoText}>
                    {statementInfoText}
                  </div>
                ) : null}

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {!settingsBootstrapLoaded ? (
            <div role="status" aria-live="polite" className="flex min-h-[320px] items-center justify-center bg-white px-4">
              <div className="flex items-start gap-3 rounded-lg border border-blue-100 bg-blue-50/60 px-4 py-3 text-sm text-slate-700">
                <div className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />
                <div className="min-w-0">
                  <div className="font-medium text-slate-800">{t("batchImport.processingDataTitle")}</div>
                  <div className="mt-1 text-xs text-slate-500">{t("batchImport.processingDataHint")}</div>
                </div>
              </div>
            </div>
          ) : (
            // 表格绝对定位铺满宿主：高度由 inset-0 直接给到（不依赖百分比能否解析），
            // 且不参与父级高度计算，不会因为「表格变高 → 宿主变高」形成循环。
            // fillHeight 的表格自己在表体内部滚动，行多也不会把最后一行裁掉。
            <div className="absolute inset-0">
              <AdvancedDataTable
                storageKey="mmh_statement_import_preview_table_v2"
                columns={columns}
                rows={fallbackRows}
                rowKey={(row) => row.key}
                emptyText={t("batchImport.noRecordsForFilter")}
                minTableWidth={1180}
                // 用户手动拖宽某一列时只把整表变宽（超出就横向滚动），
                // 不去压缩其它列——预览里每列内容长短差别大，被挤窄就看不见了。
                resizeGrowsTable
                selectable
                selectAllScope="renderedRows"
                selectAllPreferred={(row) => row.ready}
                selectedKeys={fallbackSelectedKeys}
                onSelectionChange={(keys) => {
                  if (busy || !previewReady) return;
                  // 未匹配行也允许勾选，便于筛选后批量改账户/分类再导入
                  const rowKeys = new Set(fallbackRows.map((row) => row.key));
                  setSelectedKeys(new Set(Array.from(keys).filter((key) => rowKeys.has(key))));
                }}
                batchActionSlot={(
                  <BatchReplacePopoverButton
                    fields={previewReplaceFields}
                    targetCount={previewReady ? fallbackSelectedKeys.size : 0}
                    targetLabel={t("stockPanel.selected")}
                    panelAlign="left"
                    disabledTitle={t("statementImportPreview.selectRowsFirst")}
                    buttonTitle={t("statementImportPreview.batchEditSelected", { count: fallbackSelectedKeys.size })}
                    messageClassName="sr-only"
                    onApply={applyPreviewReplace}
                  />
                )}
                toolbarRightContent={(
                  <div className="flex items-center justify-end gap-x-3 whitespace-nowrap text-xs text-slate-500">
                    <label className="inline-flex shrink-0 items-center gap-1.5 text-slate-600">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600"
                        checked={createLiabilityAccounts}
                        disabled={busy || !settingsBootstrapLoaded}
                        onChange={(event) => setCreateLiabilityAccounts(event.target.checked)}
                      />
                      <span>{t("statementImportPreview.createLiabilityAccounts")}</span>
                    </label>
                    <label className="inline-flex shrink-0 items-center gap-1.5 text-slate-600">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600"
                        checked={forceCreateOwnedMoneyAccounts}
                        disabled={busy || !settingsBootstrapLoaded}
                        onChange={(event) => setForceCreateOwnedMoneyAccounts(event.target.checked)}
                      />
                      <span>{t("statementImportPreview.forceCreateOwnedMoneyAccounts")}</span>
                    </label>
                    <span>{t("batchImport.totalCount", { total: fallbackRows.length })}</span>
                    <span>{t("statementImportPreview.willImport", { count: importReadySelectedCount })}</span>
                    {fallbackSelectedKeys.size > importReadySelectedCount ? (
                      <span className="text-amber-700">
                        {t("statementImportPreview.selectedNotReady", { count: fallbackSelectedKeys.size - importReadySelectedCount })}
                      </span>
                    ) : null}
                  </div>
                )}
                rowClassName={(row) => {
                  const creationStatus = previewCreationStatus(row);
                  if (creationStatus?.kind === "owned") return "bg-emerald-50/70";
                  if (creationStatus) return "bg-violet-50/70";
                  return fallbackSelectedKeys.has(row.key) ? "bg-blue-50/40" : row.ready ? "bg-white" : "bg-amber-50/40";
                }}
                fillHeight
                compactRows
                resetDisplayStateOnMount
              />
            </div>
          )}
        </div>

        {importProgress && importProgress.total > 0 ? (
          <div className="shrink-0 border-b border-blue-100 bg-blue-50 px-4 py-2">
            <div className="flex h-2 overflow-hidden rounded-full bg-blue-100">
              <div
                className="h-full bg-blue-600 transition-all duration-200"
                style={{ width: `${Math.max(2, Math.round((importProgress.imported / importProgress.total) * 100))}%` }}
              />
            </div>
            <div className="mt-1 text-xs text-blue-700">
              {t("batchImport.statementImportingProgress", { imported: importProgress.imported, total: importProgress.total })}
            </div>
          </div>
        ) : null}
              </div>
            </div>
          </div>
        </div>
        {/* 「确认导入」底栏在 FT 卡片**外面**（2026-11-04 用户裁定，与批量导入页两个
            预览弹窗同构）：原先是卡片内 flex-col 的最后一个孩子，与表格抢同一块正文
            高度；提到弹窗级后卡片独占正文高度，底栏贴窗口下沿、与标题栏同宽。 */}
        {/* 确认按钮右/下等距：pr-3（12px）= py-3 底距（2026-11-04 用户：等距即同心，不变形）。 */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 pl-4 pr-3 py-3">
          <div className="flex min-w-0 items-center gap-3 text-xs">
            {/* 「将导入 N 条」不再显示：与右侧「确认导入 N 条」按钮文字重复（2026-11-04 用户）。 */}
            {fallbackSelectedKeys.size > importReadySelectedCount ? (
              <span className="shrink-0 text-amber-700">
                {t("statementImportPreview.selectedNotReady", { count: fallbackSelectedKeys.size - importReadySelectedCount })}
              </span>
            ) : null}
            {balanceAdjustments.length > 0 ? (
              <span className="truncate text-violet-700" title={balanceAdjustments.map((row) => `${row.date ?? ""} → ${row.balance}`).join("；")}>
                {t("statementImportPreview.balanceAdjustNotice", {
                  count: balanceAdjustments.length,
                  value: balanceAdjustments.map((row) => `${row.date ?? ""} ¥${row.balance}`).join("、"),
                })}
              </span>
            ) : null}
            {categorySyncMessage ? <span className="truncate text-blue-600" title={categorySyncMessage}>{categorySyncMessage}</span> : null}
            {typeGuardNotice ? (
              <span
                className={`truncate ${typeGuardNotice.tone === "warn" ? "text-amber-700" : "text-blue-600"}`}
                title={typeGuardNotice.text}
              >
                {typeGuardNotice.text}
              </span>
            ) : null}
          </div>
          <div className="flex items-center justify-end">
            <button
              type="button"
              className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void confirmSelected()}
              disabled={busy || !previewReady || importReadySelectedCount === 0}
            >
              {busy ? t("batchImport.importing") : t("batchImport.confirmImport", { count: importReadySelectedCount })}
            </button>
          </div>
        </div>
      </div>
    </ModalLayer>,
    document.body,
  );
}
