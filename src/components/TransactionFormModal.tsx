"use client";

import { ArrowLeftRight, ArrowRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { EntityCreateForm, NestedAddModal } from "./EntityCreateForm";
import { SmartSelect, SmartSelectOption } from "./SmartSelect";
import { UnifiedEntryLauncher } from "./UnifiedEntryLauncher";
import { useAccountSSFilter } from "./accountSSFilter";
import { kindLabel } from "@/lib/account-kinds";
import { getCashTargetOperation } from "@/lib/account-kind-utils";
import { recordRecentAccount, sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import {
  buildCreditCardInstallmentSchedule,
  summarizeCreditCardInstallments,
  type CreditCardInstallmentRateType,
} from "@/lib/credit/installment";
import { filterIncomeExpenseInstitutions } from "@/lib/institution-rules";

type TxType = "expense" | "income" | "advance" | "transfer" | "investment";
type DebtTransferMode = "borrow_in" | "repay_out" | "lend_out" | "collect_in";

type AccountOption = {
  id: string;
  label: string;
  icon?: string;
  subLabel?: string;
  kind?: string | null;
  investProductType?: string | null;
  debtDirection?: string | null;
  institutionId?: string | null;
  currency?: string | null;
  isHeader?: boolean;
  isGroup?: boolean;
  parentId?: string;
};

type CategoryOption = {
  id: string;
  label: string;
  parentId: string | null;
  type: string;
};

type AiPrefillItem = {
  rawText?: string;
  type?: "expense" | "income" | "transfer" | "investment";
  date?: string;
  amount?: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  category?: string;
  remark?: string;
  counterparty?: string;
};

type OpenFromAiDetail = {
  requestId: string;
  item: AiPrefillItem;
  source?: "launcher";
};

function normalizeYmd(value: string | undefined) {
  const s = (value ?? "").trim();
  if (!s) return "";
  const d = new Date(s.replace(/[年/.]/g, "-").replace(/[月]/g, "-").replace(/[日]/g, ""));
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toDateInputValue(value: string | null | undefined) {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(?:[\sT]+\d{1,2}[:：]\d{2})?/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const normalized = raw
    .replace(/[/.]/g, "-")
    .replace("年", "-")
    .replace("月", "-")
    .replace("日", "")
    .replace(" ", "T");
  const ymd = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymd) {
    return `${ymd[1]}-${String(Number(ymd[2])).padStart(2, "0")}-${String(Number(ymd[3])).padStart(2, "0")}`;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

function inferDebtTransferMode(
  sourceAccount: AccountOption | SmartSelectOption | undefined,
  targetAccount: AccountOption | SmartSelectOption | undefined,
): DebtTransferMode | null {
  const source = sourceAccount as AccountOption | undefined;
  const target = targetAccount as AccountOption | undefined;
  if (source?.kind === "loan") {
    return source.debtDirection === "receivable" ? "collect_in" : "borrow_in";
  }
  if (target?.kind === "loan") {
    return target.debtDirection === "receivable" ? "lend_out" : "repay_out";
  }
  return null;
}

function findAccountIdByLabel(input: string | undefined, options: AccountOption[]) {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  const exact = options.find((o) => o.label === raw);
  if (exact) return exact.id;
  const bySuffix = options.find((o) => o.label.endsWith(`·${raw}`));
  if (bySuffix) return bySuffix.id;
  const lower = raw.toLowerCase();
  const fuzzy = options.find((o) => o.label.toLowerCase().includes(lower) || lower.includes(o.label.toLowerCase()));
  return fuzzy?.id ?? "";
}

function makeRequestId(prefix: string) {
  return prefix + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function findCategoryIdByLabel(input: string | undefined, options: CategoryOption[]) {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  const exact = options.find((o) => o.label === raw);
  if (exact) return exact.id;
  const suffix = options.find((o) => o.label.endsWith(`.${raw}`) || o.label.endsWith(raw));
  if (suffix) return suffix.id;
  const lower = raw.toLowerCase();
  const fuzzy = options.find((o) => o.label.toLowerCase().includes(lower) || lower.includes(o.label.toLowerCase()));
  return fuzzy?.id ?? "";
}

function getCategoryLeafName(label: string) {
  return label.includes(".") ? label.split(".").pop() ?? label : label;
}

type TagOption = {
  id: string;
  name: string;
  color?: string | null;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;
type SubmitMode = "close" | "repeat";
const COUNTERPARTY_TYPES = new Set(["person", "organization"]);

export function TransactionFormModal({
  accounts,
  transferAccounts,
  expenseCategories,
  incomeCategories,
  advanceCategories,
  defaultAccountId,
  lastRepayToAccountId,
  lastRepayFromAccountId,
  isCreditCardAccount,
  showInvestment,
  action,
  editAction,
  allTags,
  accountSSOptions,
  transferAccountSSOptions,
  nestedFieldData,
  hideTrigger = false,
}: {
  accounts: AccountOption[];
  transferAccounts: AccountOption[];
  expenseCategories: CategoryOption[];
  incomeCategories: CategoryOption[];
  advanceCategories?: CategoryOption[];
  defaultAccountId?: string;
  lastRepayToAccountId?: string;
  lastRepayFromAccountId?: string;
  isCreditCardAccount?: boolean;
  showInvestment?: boolean;
  action: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  editAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  allTags?: TagOption[];
  /** Hierarchical SmartSelect options for spending account dropdown (grouped by AccountGroup) */
  accountSSOptions?: SmartSelectOption[];
  /** Hierarchical SmartSelect options for transfer account dropdown (grouped by AccountGroup) */
  transferAccountSSOptions?: SmartSelectOption[];
  /** Groups & institutions data for NestedAddModal compact account creation */
  nestedFieldData?: NestedFieldData;
  hideTrigger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [txType, setTxType] = useState<TxType>("expense");
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const [editEntryOriginalType, setEditEntryOriginalType] = useState<TxType | null>(null);
  const [editEntryHasFundDetail, setEditEntryHasFundDetail] = useState(false);
  const [editOriginalTransferAccounts, setEditOriginalTransferAccounts] = useState<{ fromAccountId: string; toAccountId: string } | null>(null);
  const [fromAccountIdEdited, setFromAccountIdEdited] = useState(false);
  const [categoryList, setCategoryList] = useState(expenseCategories);
  const [categoryNestedOpen, setCategoryNestedOpen] = useState(false);
  const [accountNestedOpen, setAccountNestedOpen] = useState(false);
  const [counterpartyNestedOpen, setCounterpartyNestedOpen] = useState(false);
  const [institutionNestedOpen, setInstitutionNestedOpen] = useState(false);
  const [accountCreateTarget, setAccountCreateTarget] = useState<"account" | "from" | "to">("account");
  const [tagList, setTagList] = useState(allTags ?? []);
  const [accountList, setAccountList] = useState(accounts);
  const [transferAccountList, setTransferAccountList] = useState(transferAccounts);
  const [localAccountSSOpts, setLocalAccountSSOpts] = useState(accountSSOptions);
  const [localTransferAccountSSOpts, setLocalTransferAccountSSOpts] = useState(transferAccountSSOptions);
  const [localNestedFieldData, setLocalNestedFieldData] = useState<NestedFieldData | undefined>(nestedFieldData);
  const formRef = useRef<HTMLFormElement>(null);
  const submitModeRef = useRef<SubmitMode>("close");

  function mergeSmartSelectOptions(base?: SmartSelectOption[], extra?: SmartSelectOption[]) {
    const merged = [...(base ?? [])];
    const seen = new Set(merged.map((opt) => opt.id));
    for (const opt of extra ?? []) {
      if (!seen.has(opt.id)) merged.push(opt);
    }
    return merged;
  }

  function appendAccountOptionWithGroup(
    base: SmartSelectOption[] | undefined,
    option: SmartSelectOption,
    groupId?: string,
    groupName?: string,
  ) {
    const next = [...(base ?? [])];
    const headerId = groupId ? `group:${groupId}` : "";
    if (headerId && groupName?.trim() && !next.some((item) => item.id === headerId)) {
      next.push({ id: headerId, label: groupName.trim(), isHeader: true });
    }
    if (!next.some((item) => item.id === option.id)) {
      next.push({
        ...option,
        parentId: headerId || undefined,
      });
    }
    return next;
  }

  async function openAccountCreate(target: "account" | "from" | "to") {
    setAccountCreateTarget(target);
    setAccountNestedOpen(true);
    void (async () => {
      const res = await fetch("/api/v1/accounts/internal?balances=false", { cache: "no-store" }).catch(() => null);
      if (res?.ok) {
        const data = await res.json().catch(() => null);
        if (data?.ok) {
          setLocalNestedFieldData({
            groupId: (data.groups ?? []).filter((group: { name: string }) => group.name !== "未指定").map((group: { id: string; name: string }) => ({ id: group.id, name: group.name })),
            institutionId: (data.institutions ?? []).map((institution: { id: string; name: string; shortName?: string | null; type?: string | null }) => ({
              id: institution.id,
              name: institution.shortName?.trim() || institution.name,
              type: institution.type ?? "",
            })),
            counterpartyId: (data.institutions ?? [])
              .filter((institution: { type?: string | null }) => COUNTERPARTY_TYPES.has(institution.type ?? "other"))
              .map((institution: { id: string; name: string; shortName?: string | null; type?: string | null }) => ({
                id: institution.id,
                name: institution.shortName?.trim() || institution.name,
                type: institution.type ?? "other",
              })),
          });
        }
      }
    })();
  }

  useEffect(() => {
    setLocalNestedFieldData(nestedFieldData);
  }, [nestedFieldData]);

  useEffect(() => {
    if (accountSSOptions) {
      setLocalAccountSSOpts((prev) => mergeSmartSelectOptions(accountSSOptions, prev));
    }
  }, [accountSSOptions]);

  useEffect(() => {
    if (transferAccountSSOptions) {
      setLocalTransferAccountSSOpts((prev) => mergeSmartSelectOptions(transferAccountSSOptions, prev));
    }
  }, [transferAccountSSOptions]);

  const currentCategoryType = useMemo(() =>
    txType === "income" ? "income" :
    txType === "advance" ? "advance" :
    txType === "investment" ? "investment" : "expense",
  [txType]);

  /** Build parent category options with hierarchical display.
   * In transaction entry, new categories are created under an existing category,
   * so every existing category, including top-level categories, can be selected
   * as the parent.
   */
  const categoryParentOptions = useMemo(() => {
    // Build a parent-id → children map for all categories of current type
    const byParentId = new Map<string | null, CategoryOption[]>();
    for (const c of categoryList) {
      const list = byParentId.get(c.parentId) ?? [];
      list.push(c);
      byParentId.set(c.parentId, list);
    }

    const options: Array<{ id: string; name: string; label: string; type: string; depth: number; parentId?: string; isGroup?: boolean }> = [];

    // Recursively walk the tree, building indented options
    function walk(parentId: string | null, depth: number, pathPrefix: string) {
      const children = byParentId.get(parentId) ?? [];
      for (const child of children) {
        const shortName = child.label.includes(".") ? child.label.split(".").pop() ?? child.label : child.label;
        const fullLabel = pathPrefix ? `${pathPrefix}.${shortName}` : shortName;
        options.push({
          id: child.id,
          name: shortName,
          label: fullLabel,
          type: currentCategoryType,
          depth,
          parentId: child.parentId ?? undefined,
          isGroup: (byParentId.get(child.id) ?? []).length > 0,
        });
        walk(child.id, depth + 1, fullLabel);
      }
    }

    // Start from root (parentId=null)
    walk(null, 0, "");

    return options;
  }, [categoryList, currentCategoryType]);

  /** Build hierarchical SmartSelect options for category dropdown.
   * All real categories are selectable. Categories with children are collapsible
   * groups, and their caret toggles expansion without taking away selection.
   */
  const categorySSOptions = useMemo(() => {
    const byParentId = new Map<string | null, CategoryOption[]>();
    for (const c of categoryList) {
      const list = byParentId.get(c.parentId) ?? [];
      list.push(c);
      byParentId.set(c.parentId, list);
    }

    const opts: SmartSelectOption[] = [];
    const INDENT = "　";

    /** Walk the tree recursively.
     *  currentGroupId tracks the nearest isHeader or isGroup ancestor for parentId linkage. */
    function walk(parentId: string | null, level: number, currentGroupId?: string) {
      const children = byParentId.get(parentId) ?? [];
      for (const child of children) {
        const shortName = child.label.includes(".") ? child.label.split(".").pop() ?? child.label : child.label;
        const grandChildren = byParentId.get(child.id) ?? [];

        if (grandChildren.length > 0) {
          // Category with children -> collapsible group and selectable category.
          opts.push({
            id: child.id,
            label: `${INDENT.repeat(level)}${shortName}`,
            isGroup: true,
            parentId: currentGroupId,
          });
          walk(child.id, level + 1, child.id);
        } else {
          // Leaf → regular selectable item
          opts.push({
            id: child.id,
            label: `${INDENT.repeat(level)}${shortName}`,
            parentId: currentGroupId,
          });
          // No deeper walk needed for leaf
        }
      }
    }

    walk(null, 0);
    return opts;
  }, [categoryList]);

  useEffect(() => {
    const nextCategoryList = txType === "income" ? incomeCategories : txType === "advance" ? (advanceCategories ?? []) : expenseCategories;
    setCategoryList(nextCategoryList);
    setCategoryId((current) => current && nextCategoryList.some((c) => c.id === current) ? current : "");
  }, [txType, incomeCategories, advanceCategories, expenseCategories]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const [date, setDate] = useState(today);
  const [postedAt, setPostedAt] = useState(() => toDateInputValue(today));
  const [postedAtEdited, setPostedAtEdited] = useState(false);
  const [amount, setAmount] = useState("");
  const [createInstallment, setCreateInstallment] = useState(false);
  const [installmentAmount, setInstallmentAmount] = useState("");
  const [installmentAmountEdited, setInstallmentAmountEdited] = useState(false);
  const [installmentTotal, setInstallmentTotal] = useState("12");
  const [installmentRateType, setInstallmentRateType] = useState<CreditCardInstallmentRateType>("period_fee");
  const [installmentRate, setInstallmentRate] = useState("0");
  const [accountId, setAccountId] = useState(defaultAccountId ?? "");
  const [fromAccountId, setFromAccountId] = useState(isCreditCardAccount ? (lastRepayFromAccountId ?? defaultAccountId ?? "") : "");
  const [toAccountId, setToAccountId] = useState(isCreditCardAccount ? (defaultAccountId ?? "") : "");
  const [categoryId, setCategoryId] = useState("");
  const [counterpartyInstitutionId, setCounterpartyInstitutionId] = useState("");
  const [note, setNote] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [isFromButton, setIsFromButton] = useState(false);

  const {
    ownerFilter,
    ownerFilterLabel,
    cycleOwnerFilter,
    filteredOptions: accountSSOptionsFiltered,
    visibleOptionIds: accountVisibleOptionIds,
  } = useAccountSSFilter(localAccountSSOpts);
  const {
    filteredOptions: transferFiltered,
    visibleOptionIds: transferVisibleOptionIds,
  } = useAccountSSFilter(localTransferAccountSSOpts, ownerFilter);

  const recentAccountIds = useRecentAccountIds();
  const displayTransferOptions = useMemo(() => {
    const source = (transferFiltered?.length ? transferFiltered : localTransferAccountSSOpts) ?? [];
    const filtered = source.filter((option) => !option.isHeader);
    let merged = mergeSmartSelectOptions(filtered, transferAccountList);
    if (transferVisibleOptionIds) {
      merged = merged.filter((option) => transferVisibleOptionIds.has(option.id));
    }
    return sortOptionsByRecent(merged, recentAccountIds);
  }, [localTransferAccountSSOpts, transferAccountList, transferFiltered, transferVisibleOptionIds, recentAccountIds]);

  const displayAccountOptions = useMemo(() => {
    let base = mergeSmartSelectOptions(accountSSOptionsFiltered, accountList);
    if (accountVisibleOptionIds) {
      base = base.filter((option) => accountVisibleOptionIds.has(option.id));
    }
    return sortOptionsByRecent(base, recentAccountIds);
  }, [accountSSOptionsFiltered, accountList, accountVisibleOptionIds, recentAccountIds]);
  const incomeExpenseInstitutionOptions = useMemo(
    () => filterIncomeExpenseInstitutions(localNestedFieldData?.institutionId ?? nestedFieldData?.institutionId ?? []),
    [localNestedFieldData, nestedFieldData],
  );
  const compactAccountSelectBehavior = useMemo(() => ({
    density: "compact" as const,
    dropdownMaxHeight: 320,
  }), []);

  const accountMetaById = useMemo(() => {
    const map = new Map<string, AccountOption>();
    const add = (option: AccountOption | SmartSelectOption | undefined) => {
      if (!option?.id || option.isHeader || option.isGroup) return;
      const current = map.get(option.id);
      const next = option as AccountOption;
      if (!current || (!current.kind && next.kind)) {
        map.set(option.id, next);
      }
    };
    [...transferAccountList, ...accountList].forEach(add);
    (localTransferAccountSSOpts ?? []).forEach(add);
    (localAccountSSOpts ?? []).forEach(add);
    return map;
  }, [accountList, localAccountSSOpts, localTransferAccountSSOpts, transferAccountList]);
  const selectedAccountIsCreditCard = accountMetaById.get(accountId)?.kind === "bank_credit"
    || (isCreditCardAccount && accountId === (defaultAccountId ?? accountId));
  const installmentPreview = useMemo(() => {
    if (!createInstallment) return null;
    try {
      const rows = buildCreditCardInstallmentSchedule({
        principal: Number(installmentAmount),
        totalRuns: Number(installmentTotal),
        rateType: installmentRateType,
        rate: Number(installmentRate),
        firstStatementMonth: "2026-01",
        firstDate: new Date("2026-01-01T00:00:00.000Z"),
      });
      return summarizeCreditCardInstallments(rows);
    } catch {
      return null;
    }
  }, [createInstallment, installmentAmount, installmentRate, installmentRateType, installmentTotal]);

  function openSpecialTransferTargetIfNeeded() {
    if (txType !== "transfer") return false;
    const sourceAccount = accountMetaById.get(fromAccountId);
    const targetAccount = accountMetaById.get(toAccountId);
    const debtMode = inferDebtTransferMode(sourceAccount, targetAccount);
    const operation = debtMode ? "debt" : getCashTargetOperation(targetAccount);
    if (operation === "transfer") return false;

    if (editEntryId) {
      window.alert("这类目标账户需要用对应的专用记账窗口编辑，不能保存为普通转账。");
      return true;
    }
    const isDebtSourceFlow = debtMode === "borrow_in" || debtMode === "collect_in";
    const cashAccountId = isDebtSourceFlow ? toAccountId : fromAccountId;
    const debtAccountId = isDebtSourceFlow ? fromAccountId : toAccountId;
    if (!cashAccountId) {
      window.alert(isDebtSourceFlow ? "请选择资金到账账户" : "请选择资金来源账户");
      return true;
    }
    const amountNumber = Number(amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      window.alert("金额不正确");
      return true;
    }

    const nextRequestId = requestId ?? makeRequestId(operation);
    const baseDetail = {
      requestId: nextRequestId,
      defaultCashAccountId: cashAccountId,
      defaultDate: date,
      defaultAmount: amountNumber,
    };

    if (operation === "investment") {
      const productType = targetAccount?.investProductType === "metal"
        ? "metal"
        : targetAccount?.investProductType === "money"
          ? "money"
          : "fund";
      window.dispatchEvent(new CustomEvent("mmh:investment:create", {
        detail: {
          ...baseDetail,
          defaultAccountId: toAccountId,
          defaultProductType: productType,
        },
      }));
    } else if (operation === "wealth") {
      window.dispatchEvent(new CustomEvent("mmh:wealth:create", {
        detail: {
          ...baseDetail,
          defaultWealthAccountId: toAccountId,
        },
      }));
    } else if (operation === "deposit") {
      window.dispatchEvent(new CustomEvent("mmh:deposit:create", {
        detail: {
          ...baseDetail,
          defaultDepositAccountId: toAccountId,
          defaultSubtype: "buy",
        },
      }));
    } else if (operation === "debt") {
      window.dispatchEvent(new CustomEvent("mmh:debt:create", {
        detail: {
          requestId: nextRequestId,
          mode: debtMode ?? (targetAccount?.debtDirection === "receivable" ? "lend_out" : "repay_out"),
          defaultDebtAccountId: debtAccountId,
          defaultCashAccountId: cashAccountId,
          defaultDate: date,
          defaultPrincipal: amountNumber,
        },
      }));
    }

    setOpen(false);
    resetDraft();
    return true;
  }
  useEffect(() => {
    if (!open || txType === "transfer" || !accountId) return;
    setLocalAccountSSOpts((prev) => {
      const currentOptions = prev ?? accountSSOptions ?? [];
      if (currentOptions.some((opt) => opt.id === accountId)) return prev;
      const fallback = accountList.find((opt) => opt.id === accountId);
      if (!fallback) return prev;
      return [...currentOptions, fallback];
    });
  }, [open, txType, accountId, accountList, accountSSOptions]);

  function resetDraft() {
    setTxType("expense");
    setDate(today);
    setPostedAt(toDateInputValue(today));
    setPostedAtEdited(false);
    setAmount("");
    setCreateInstallment(false);
    setInstallmentAmount("");
    setInstallmentAmountEdited(false);
    setInstallmentTotal("12");
    setInstallmentRateType("period_fee");
    setInstallmentRate("0");
    setAccountId(defaultAccountId ?? "");
    if (isCreditCardAccount) {
      setFromAccountId(lastRepayFromAccountId ?? defaultAccountId ?? "");
      setToAccountId(defaultAccountId ?? "");
    } else {
      setFromAccountId("");
      setToAccountId("");
    }
    setCategoryId("");
    setCounterpartyInstitutionId("");
    setNote("");
    setSelectedTagIds([]);
    setRequestId(null);
    setEditEntryId(null);
    setEditEntryOriginalType(null);
    setEditEntryHasFundDetail(false);
    setEditOriginalTransferAccounts(null);
    setFromAccountIdEdited(false);
  }
  useCloseOnNavigation(open, () => {
    setOpen(false);
    resetDraft();
  });

  function repeatDraft() {
    setAmount("");
    setCreateInstallment(false);
    setInstallmentAmount("");
    setInstallmentAmountEdited(false);
    setRequestId(null);
    setEditEntryId(null);
    setEditEntryOriginalType(null);
    setEditEntryHasFundDetail(false);
    setEditOriginalTransferAccounts(null);
    if (txType === "transfer" && !isCreditCardAccount && !fromAccountId && defaultAccountId) {
      setFromAccountId(defaultAccountId);
    }
  }

  function swapTransferAccounts() {
    const prevFrom = fromAccountId;
    const prevTo = toAccountId;
    setFromAccountId(prevTo);
    setToAccountId(prevFrom);
  }

  function switchType(nextType: TxType) {
    const currentType = txType;
    if (nextType === "transfer" && currentType !== "transfer") {
      const currentAccountId = accountId || defaultAccountId || "";
      if (currentType === "income") {
        setToAccountId(currentAccountId);
        if (fromAccountId === currentAccountId) setFromAccountId("");
        setFromAccountIdEdited(false);
      } else {
        setFromAccountId(currentAccountId);
        if (toAccountId === currentAccountId) setToAccountId("");
        setFromAccountIdEdited(true);
      }
      setCategoryId("");
    } else if (currentType === "transfer" && nextType !== "transfer") {
      const transferFromAccountId = fromAccountId || editOriginalTransferAccounts?.fromAccountId || "";
      const transferToAccountId = toAccountId || editOriginalTransferAccounts?.toAccountId || "";
      const nextAccountId = nextType === "income"
        ? transferToAccountId || transferFromAccountId || defaultAccountId || ""
        : transferFromAccountId || transferToAccountId || defaultAccountId || "";
      setAccountId(nextAccountId);
      setFromAccountIdEdited(false);
    }
    setTxType(nextType);
  }

  useEffect(() => {
    function onOpenFromAi(ev: Event) {
      const detail = (ev as CustomEvent<OpenFromAiDetail>).detail;
      if (!detail?.requestId || !detail.item) return;

      const item = detail.item;
      const mappedType: TxType =
        item.type === "income"
          ? "income"
          : item.type === "transfer"
            ? "transfer"
            : item.type === "investment"
              ? "investment"
              : "expense";

      setRequestId(detail.requestId);
      setOpen(true);
      setIsFromButton(detail.source === "launcher");
      setTxType(mappedType);

      const dateStr = normalizeYmd(item.date) || today;
      setDate(dateStr);
      setPostedAt(toDateInputValue(dateStr));
      setPostedAtEdited(false);

      const num = typeof item.amount === "number" && Number.isFinite(item.amount) ? item.amount : 0;
      setAmount(num > 0 ? String(num) : "");

      const noteText = (item.remark ?? "").trim() || (item.counterparty ?? "").trim() || (item.rawText ?? "").trim();
      setNote(noteText);

      if (mappedType === "transfer") {
        setFromAccountId(findAccountIdByLabel(item.fromAccount, transferAccounts) || (defaultAccountId ?? ""));
        setToAccountId(findAccountIdByLabel(item.toAccount ?? item.account, transferAccounts));
        setCategoryId("");
        setAccountId("");
      } else {
        setAccountId(findAccountIdByLabel(item.account, accounts) || (defaultAccountId ?? ""));

        const rawCat = (item.category ?? "").trim();
        const withTypePrefix = rawCat ? `支出.${rawCat}` : "";
        const nextCatId = findCategoryIdByLabel(withTypePrefix, expenseCategories)
          || findCategoryIdByLabel(rawCat, expenseCategories);
        setCategoryId(nextCatId);

        setFromAccountId(defaultAccountId ?? "");
        setToAccountId("");
      }
    }

    window.addEventListener("mmh:create-transaction:open", onOpenFromAi as EventListener);
    return () => window.removeEventListener("mmh:create-transaction:open", onOpenFromAi as EventListener);
  }, [accounts, defaultAccountId, expenseCategories, incomeCategories, lastRepayFromAccountId, lastRepayToAccountId, today, transferAccounts]);

  useEffect(() => {
    function onOpenEdit(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId: string;
        entryId: string;
        type: TxType;
        date: string;
        postedAt?: string | null;
        amount: number;
        note: string;
        toNote?: string;
        accountId?: string;
        accountLabel?: string;
        categoryId?: string;
        counterpartyInstitutionId?: string;
        fromAccountId?: string;
        toAccountId?: string;
        fundSubtype?: string;
        hasFundDetail?: boolean;
        cashAccountId?: string;
        fundCode?: string;
        fundName?: string;
        fundUnits?: number;
        fundNav?: number;
        fundFee?: number;
        fundProductType?: string;
        tagIds?: string[];
      }>).detail;
      if (!detail?.requestId || !detail.entryId) return;
      setRequestId(detail.requestId);
      setEditEntryId(detail.entryId);
      setEditEntryOriginalType(detail.type);
      setEditEntryHasFundDetail(detail.hasFundDetail ?? false);
      setCreateInstallment(false);
      setOpen(true);
      setTxType(detail.type);
      setDate(detail.date || today);
      setPostedAt(toDateInputValue(detail.postedAt || detail.date || today));
      setPostedAtEdited(Boolean(detail.postedAt));
      const numericAmount = Number(detail.amount);
      setAmount(
        Number.isFinite(numericAmount) && numericAmount !== 0
          ? detail.type === "expense" && numericAmount > 0
            ? `-${Math.abs(numericAmount)}`
            : String(Math.abs(numericAmount))
          : "",
      );
      setNote(detail.note ?? "");
      setCounterpartyInstitutionId(detail.counterpartyInstitutionId ?? "");
      setSelectedTagIds(detail.tagIds ?? []);
      if (detail.type === "transfer") {
        const nextToAccountId = detail.toAccountId ?? "";
        const nextFromAccountId = detail.fromAccountId && detail.fromAccountId !== nextToAccountId
          ? detail.fromAccountId
          : detail.accountId ?? "";
        setLocalTransferAccountSSOpts((prev) => {
          const extras = transferAccountList.filter((opt) => opt.id === nextFromAccountId || opt.id === nextToAccountId);
          return mergeSmartSelectOptions(prev ?? transferAccountSSOptions, extras);
        });
        setAccountId("");
        setCategoryId("");
        setFromAccountId(nextFromAccountId);
        setToAccountId(nextToAccountId);
        setEditOriginalTransferAccounts({ fromAccountId: nextFromAccountId, toAccountId: nextToAccountId });
        setFromAccountIdEdited(true);
      } else {
        const nextAccountId = detail.accountId ?? (defaultAccountId ?? "");
        setLocalAccountSSOpts((prev) => {
          const extra = accountList.find((opt) => opt.id === nextAccountId);
          if (extra) {
            return mergeSmartSelectOptions(prev ?? accountSSOptions, [extra]);
          }
          if (nextAccountId && detail.accountLabel) {
            return mergeSmartSelectOptions(prev ?? accountSSOptions, [{ id: nextAccountId, label: detail.accountLabel }]);
          }
          return prev ?? accountSSOptions;
        });
        setAccountId(nextAccountId);
        setCategoryId(detail.categoryId ?? "");
        setFromAccountId("");
        setToAccountId(detail.toAccountId ?? "");
        setEditOriginalTransferAccounts(null);
        setFromAccountIdEdited(false);
      }
    }

    window.addEventListener("mmh:transaction:edit", onOpenEdit as EventListener);
    return () => window.removeEventListener("mmh:transaction:edit", onOpenEdit as EventListener);
  }, [
    accountList,
    accountSSOptions,
    defaultAccountId,
    today,
    transferAccountList,
    transferAccountSSOptions,
  ]);

  useEffect(() => {
    if (!open || txType !== "expense" || postedAtEdited) return;
    setPostedAt(toDateInputValue(date || today));
  }, [date, open, postedAtEdited, today, txType]);

  useEffect(() => {
    if (!open || !isCreditCardAccount || txType !== "transfer") return;
    if (fromAccountIdEdited || !toAccountId) return;
    if (accountMetaById.get(toAccountId)?.kind !== "bank_credit") return;
    fetch(`/api/v1/fund/last-repay-account?accountId=${encodeURIComponent(toAccountId)}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.repayAccountId) setFromAccountId(d.repayAccountId);
      })
      .catch(() => {});
  }, [accountMetaById, open, isCreditCardAccount, txType, toAccountId, fromAccountIdEdited]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    if (openSpecialTransferTargetIfNeeded()) return;

    if (editEntryId && editEntryOriginalType === "investment" && txType !== "investment" && editEntryHasFundDetail) {
      const confirmed = window.confirm("这条投资记录有对应的基金明细。\n\n选择「确定」将删除基金明细记录。\n选择「取消」将保留基金明细但清空资金来源关联。\n\n请选择：");
      if (!confirmed) {
        const formData = new FormData(e.currentTarget);
        formData.set("type", txType);
        formData.set("date", date);
        if (txType === "expense") formData.set("postedAt", postedAt);
        formData.set("amount", amount);
        formData.set("note", note);
        formData.set("toNote", txType === "transfer" ? note : "");
        formData.set("entryId", editEntryId);
        formData.set("keepFundDetail", "true");
        setSubmitting(true);
        try {
          const res = await (editAction ?? action)(formData);
          if (!res.ok) {
            window.alert(res.error);
            return;
          }
          requestAnimationFrame(() => {
            dispatchFinanceDataChanged({ reason: "transaction-save" });
          });
          resetDraft();
        } catch (err) {
          window.alert(String(err));
        } finally {
          setSubmitting(false);
        }
        return;
      }
    }
    
    let formData: FormData;
    if (txType === "investment") {
      formData = new FormData(e.currentTarget);
      formData.set("type", "investment");
      formData.set("date", date);
      formData.set("amount", amount);
      formData.set("note", note);
      formData.set("toNote", "");
      formData.set("counterpartyInstitutionId", counterpartyInstitutionId);
      if (editEntryId) formData.set("entryId", editEntryId);
    } else {
      formData = new FormData();
      formData.set("type", txType);
      formData.set("date", date);
      if (txType === "expense") formData.set("postedAt", postedAt);
      formData.set("amount", amount);
      formData.set("note", note);
      formData.set("toNote", txType === "transfer" ? note : "");
      formData.set("counterpartyInstitutionId", counterpartyInstitutionId);
      if (editEntryId) formData.set("entryId", editEntryId);
      if (txType === "transfer") {
        formData.set("fromAccountId", fromAccountId);
        formData.set("toAccountId", toAccountId);
        } else if (txType === "income") {
          formData.set("accountId", accountId);
          formData.set("categoryId", categoryId);
          if (toAccountId) formData.set("toAccountId", toAccountId);
        } else if (txType === "advance") {
          formData.set("accountId", accountId);
          formData.set("categoryId", categoryId);
          formData.set("counterpartyInstitutionId", counterpartyInstitutionId);
        } else {
          formData.set("accountId", accountId);
          formData.set("categoryId", categoryId);
      }
      formData.set("tagIds", JSON.stringify(selectedTagIds));
      if (txType === "expense" && createInstallment && !editEntryId) {
        formData.set("createInstallment", "true");
        formData.set("installmentAmount", installmentAmount);
        formData.set("installmentTotal", installmentTotal);
        formData.set("installmentRateType", installmentRateType);
        formData.set("installmentRate", installmentRate);
      }
    }
    setSubmitting(true);
    try {
      const res = editEntryId ? await (editAction ?? action)(formData) : await action(formData);
      if (!res.ok) {
        window.alert(res.error);
        return;
      }
      if (requestId) {
        window.dispatchEvent(
          new CustomEvent(editEntryId ? "mmh:transaction:edit:success" : "mmh:create-transaction:success", { detail: { requestId } }),
        );
      }
      requestAnimationFrame(() => {
        dispatchFinanceDataChanged({ reason: "transaction-save" });
      });
      if (submitModeRef.current === "repeat" && !editEntryId) {
        repeatDraft();
      } else {
        setOpen(false);
        resetDraft();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "记账失败";
      window.alert(msg);
    } finally {
      submitModeRef.current = "close";
      setSubmitting(false);
    }
  }

  return (
    <>
      {!hideTrigger ? (
        <UnifiedEntryLauncher
          defaultAction="transaction"
          actions={[
            { key: "transaction", label: "记账" },
            { key: "investment", label: "开放式基金 / 货币基金 / 贵金属", disabled: !showInvestment },
            { key: "wealth", label: "银行理财" },
            { key: "deposit-buy", label: "存款存入" },
            { key: "insurance", label: "保险" },
          ]}
          context={{
            defaultAccountId: defaultAccountId ?? "",
            defaultCashAccountId: defaultAccountId ?? "",
            defaultDepositAccountId: defaultAccountId ?? "",
            defaultInsuranceAccountId: defaultAccountId ?? "",
          }}
        />
      ) : null}

      {open ? createPortal(
        <div className="app-modal-backdrop z-50">
          <div className="app-modal-panel max-w-xl">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">{editEntryId ? "编辑记录" : "记一笔"}</div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  resetDraft();
                }}
                className="secondary-button h-8 px-2"
              >
                关闭
              </button>
            </div>

            <form ref={formRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" onSubmit={onSubmit}>
              <div className="flex justify-center gap-2">
                {isCreditCardAccount ? (
                  <>
                    <button
                      type="button"
                      onClick={() => switchType("expense")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "expense"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      支出
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("income")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "income"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      收入
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("advance")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "advance"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      代付
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("transfer")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "transfer"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      转账
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => switchType("expense")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "expense"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      支出
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("income")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "income"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      收入
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("advance")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "advance"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      代付
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("transfer")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "transfer"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      转账
                    </button>
                  </>
                )}
              </div>

              {txType === "investment" && (
                <div className="space-y-2 pt-1">
                  <div className="text-xs font-medium text-slate-500 mb-1">选择投资类型：</div>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:investment:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultAccountId, defaultCashAccountId: accountId, defaultDate: date, defaultAmount: Number(amount) || undefined },
                      }));
                    }}
                    className="segment-button segment-button-active h-10 w-full"
                  >
                    开放式基金 / 货币基金
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:investment:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultCashAccountId: accountId, defaultProductType: "metal" },
                      }));
                    }}
                    className="h-10 w-full rounded-[10px] border border-yellow-200 bg-yellow-50 text-sm text-yellow-700 transition-colors hover:bg-yellow-100"
                  >
                    贵金属
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:wealth:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultCashAccountId: accountId },
                      }));
                    }}
                    className="h-10 w-full rounded-[10px] border border-amber-200 bg-amber-50 text-sm text-amber-700 transition-colors hover:bg-amber-100"
                  >
                    银行理财
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:deposit:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultCashAccountId: accountId },
                      }));
                    }}
                    className="h-10 w-full rounded-[10px] border border-emerald-200 bg-emerald-50 text-sm text-emerald-700 transition-colors hover:bg-emerald-100"
                  >
                    活期 / 定期存款
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:insurance:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultCashAccountId: accountId },
                      }));
                    }}
                    className="h-10 w-full rounded-[10px] border border-sky-200 bg-sky-50 text-sm text-sky-700 transition-colors hover:bg-sky-100"
                  >
                    保险
                  </button>
                </div>
              )}

              {(txType === "expense" || txType === "income" || txType === "advance") && (
                <div className="space-y-3">
                  {/* 第一行：日期 | 账户 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">日期</div>
                      <DateStepper name="date" value={date} onChange={setDate} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">
                        {isCreditCardAccount ? "记账账户" : (txType === "income" ? "收款账户" : "资金账户")}
                      </div>
                      <SmartSelect mode="single" value={accountId}
                        onChange={(id: string) => { setAccountId(id); recordRecentAccount(id); }}
                        options={displayAccountOptions} placeholder="请选择"
                        onCreateClick={() => { void openAccountCreate("account"); }}
                        onCycleOwnerFilter={cycleOwnerFilter}
                        ownerFilterLabel={ownerFilterLabel}
                        behavior={compactAccountSelectBehavior} />
                    </div>
                  </div>

                  {/* 第二行：类别 | 标签 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">类别</div>
                      <SmartSelect mode="single" value={categoryId} onChange={setCategoryId}
                        options={categorySSOptions} placeholder="未分类"
                        onCreateClick={() => setCategoryNestedOpen(true)}
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
                    <div className="space-y-1">
                      <div className="form-label">标签</div>
                      <SmartSelect mode="multi" value={selectedTagIds}
                        onChange={(ids) => setSelectedTagIds(ids)}
                        options={tagList.map(t => ({ id: t.id, label: t.name, color: t.color }))} placeholder="选择标签"
                        onInlineCreate={async (name, color) => {
                          const res = await fetch("/api/v1/tags", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ name, color }),
                          });
                          const data = await res.json();
                          if (!data.ok || !data.tag) throw new Error(data.error ?? "创建失败");
                          return { id: data.tag.id, label: data.tag.name, color: data.tag.color };
                        }}
                        onCreated={(tag) => {
                          setTagList(prev => [...prev, { id: tag.id, name: tag.label, color: tag.color }]);
                          setSelectedTagIds(prev => [...prev, tag.id]);
                        }}
                      />
                    </div>
                  </div>

                  {/* 第三行：金额 | 入账日期 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">金额</div>
                      <CalcInput value={amount} onChange={(value) => {
                        setAmount(value);
                        if (createInstallment && !installmentAmountEdited) {
                          const numeric = Math.abs(Number(value));
                          setInstallmentAmount(Number.isFinite(numeric) && numeric > 0 ? String(numeric) : "");
                        }
                      }} placeholder="例如：88.50" label="金额" precision={2} />
                    </div>
                    {txType === "expense" ? (
                      <div className="space-y-1">
                        <div className="form-label">入账日期</div>
                        <DateStepper
                          value={postedAt}
                          onChange={(value) => {
                            setPostedAt(toDateInputValue(value));
                            setPostedAtEdited(true);
                          }}
                          className="form-input"
                        />
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="form-label">{txType === "advance" ? "往来对象" : "收支机构"}</div>
                        <SmartSelect
                          mode="single"
                          value={counterpartyInstitutionId}
                          onChange={setCounterpartyInstitutionId}
                          options={(txType === "advance"
                            ? ((localNestedFieldData ?? nestedFieldData)?.counterpartyId ?? [])
                            : incomeExpenseInstitutionOptions)
                            .filter((item) => txType !== "advance" || COUNTERPARTY_TYPES.has(item.type ?? "other"))
                            .map((item) => ({ id: item.id, label: item.name }))}
                          placeholder={txType === "advance" ? "请选择" : "可选"}
                          onCreateClick={txType === "advance" ? () => setCounterpartyNestedOpen(true) : undefined}
                          createLabel="新增往来对象"
                          searchable
                        />
                      </div>
                    )}
                  </div>

                  {txType === "expense" && selectedAccountIsCreditCard && !editEntryId ? (
                    <div className="border-y border-slate-200 py-3 space-y-3">
                      <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                        <input
                          type="checkbox"
                          checked={createInstallment}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setCreateInstallment(checked);
                            if (checked && !installmentAmountEdited) {
                              const numeric = Math.abs(Number(amount));
                              setInstallmentAmount(Number.isFinite(numeric) && numeric > 0 ? String(numeric) : "");
                            }
                          }}
                          className="h-4 w-4 accent-slate-800"
                        />
                        消费分期
                      </label>
                      {createInstallment ? (
                        <>
                          <div className="grid grid-cols-3 gap-3">
                            <div className="space-y-1">
                              <div className="form-label">分期金额</div>
                              <CalcInput value={installmentAmount} onChange={(value) => {
                                setInstallmentAmount(value);
                                setInstallmentAmountEdited(true);
                              }} placeholder="默认全部金额" label="分期金额" precision={2} />
                            </div>
                            <div className="space-y-1">
                              <div className="form-label">期数</div>
                              <input
                                type="number"
                                min={2}
                                max={120}
                                step={1}
                                value={installmentTotal}
                                onChange={(event) => setInstallmentTotal(event.target.value)}
                                className="form-input"
                              />
                            </div>
                            <div className="space-y-1">
                              <div className="form-label">{installmentRateType === "annual_interest" ? "年利率 (%)" : "每期费率 (%)"}</div>
                              <input
                                type="number"
                                min={0}
                                max={100}
                                step="0.0001"
                                value={installmentRate}
                                onChange={(event) => setInstallmentRate(event.target.value)}
                                className="form-input"
                              />
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <div className="inline-flex h-8 overflow-hidden rounded border border-slate-200 bg-white">
                              <button type="button" onClick={() => setInstallmentRateType("period_fee")}
                                className={`px-3 text-xs ${installmentRateType === "period_fee" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                                每期手续费
                              </button>
                              <button type="button" onClick={() => setInstallmentRateType("annual_interest")}
                                className={`border-l border-slate-200 px-3 text-xs ${installmentRateType === "annual_interest" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                                年利率
                              </button>
                            </div>
                            {installmentPreview ? (
                              <div className="text-xs tabular-nums text-slate-500">
                                首期 {installmentPreview.firstPayment.toFixed(2)} · 费用 {installmentPreview.totalInterest.toFixed(2)} · 合计 {installmentPreview.totalPayment.toFixed(2)}
                              </div>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}

                  {/* 第四行：收支机构 */}
                  {txType === "expense" ? (
                    <div className="space-y-1">
                      <div className="form-label">收支机构</div>
                      <SmartSelect
                        mode="single"
                        value={counterpartyInstitutionId}
                        onChange={setCounterpartyInstitutionId}
                        options={incomeExpenseInstitutionOptions.map((item) => ({ id: item.id, label: item.name }))}
                        placeholder="可选"
                        createLabel="新增往来对象"
                        searchable
                      />
                    </div>
                  ) : null}

                  {/* 第五行：备注 */}
                  <div className="space-y-1">
                    <div className="form-label">备注</div>
                    <input
                      name="note"
                      placeholder="可选"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="form-input"
                    />
                  </div>
                </div>
              )}

              {txType === "transfer" && (
                <div className="space-y-3">
                  {/* 第一行：日期 | 收支机构 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">日期</div>
                      <DateStepper name="date" value={date} onChange={setDate} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">收支机构</div>
                      <SmartSelect
                        mode="single"
                        value={counterpartyInstitutionId}
                        onChange={setCounterpartyInstitutionId}
                        options={incomeExpenseInstitutionOptions.map((item) => ({ id: item.id, label: item.name }))}
                        placeholder="可选"
                        onCreateClick={() => setInstitutionNestedOpen(true)}
                        createLabel="新增收支机构"
                        searchable
                      />
                    </div>
                  </div>

                  {/* 第二行：转出账户 | 互换 | 转入账户 */}
                  {isCreditCardAccount ? (
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                      <div className="space-y-1">
                        <div className="form-label">转出账户</div>
                        <SmartSelect mode="single" value={fromAccountId} onChange={v => { setFromAccountId(v); setFromAccountIdEdited(true); recordRecentAccount(v); }}
                          options={displayTransferOptions} placeholder="请选择"
                          onCreateClick={() => { void openAccountCreate("from"); }} createLabel="新增账户"
                          onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                          behavior={compactAccountSelectBehavior} />
                      </div>
                      <div className="flex flex-col items-center pb-0.5">
                        <div className="h-6 flex items-center justify-center text-emerald-600 mb-1"><ArrowRight className="w-4 h-4" /></div>
                        <button type="button" className="secondary-button h-9 w-9 px-0 text-slate-700"
                          onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title="互换账户"><ArrowLeftRight className="w-4 h-4" /></button>
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">转入账户</div>
                        <SmartSelect mode="single" value={toAccountId} onChange={(v) => { setToAccountId(v); recordRecentAccount(v); }}
                          options={displayTransferOptions} placeholder="请选择"
                          onCreateClick={() => { void openAccountCreate("to"); }} createLabel="新增账户"
                          onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                          behavior={compactAccountSelectBehavior} />
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                      <div className="space-y-1">
                        <div className="form-label">转出账户</div>
                        <SmartSelect mode="single" value={fromAccountId} onChange={(v) => { setFromAccountId(v); recordRecentAccount(v); }}
                          options={displayTransferOptions} placeholder="请选择"
                          onCreateClick={() => { void openAccountCreate("from"); }} createLabel="新增账户"
                          onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                          behavior={compactAccountSelectBehavior} />
                      </div>
                      <div className="flex items-center justify-center pb-0.5">
                        <button type="button" className="secondary-button h-9 w-9 px-0 text-slate-700"
                          onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title="互换转出/转入账户"><ArrowLeftRight className="w-4 h-4" /></button>
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">转入账户</div>
                        <SmartSelect mode="single" value={toAccountId} onChange={(v) => { setToAccountId(v); recordRecentAccount(v); }}
                          options={displayTransferOptions} placeholder="请选择"
                          onCreateClick={() => { void openAccountCreate("to"); }} createLabel="新增账户"
                          onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                          behavior={compactAccountSelectBehavior} />
                      </div>
                    </div>
                  )}

                  {/* 第三行：金额 */}
                  <div className="space-y-1">
                    <div className="form-label">金额</div>
                    <CalcInput value={amount} onChange={setAmount} placeholder="例如：88.50" label="金额" precision={2} />
                  </div>

                  {/* 第四行：备注 */}
                  <div className="space-y-1">
                    <div className="form-label">备注</div>
                    <input
                      name="note"
                      placeholder="可选"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="form-input"
                    />
                  </div>
                </div>
              )}

              <input type="hidden" name="type" value={txType} />

              <div className="flex items-center justify-end gap-2 pt-1">
                {isFromButton && !editEntryId ? (
                  <button
                    type="button"
                    className="secondary-button h-9 px-3 border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                    onClick={() => {
                      submitModeRef.current = "repeat";
                      formRef.current?.requestSubmit();
                    }}
                    disabled={submitting}
                  >
                    保存并再记一笔
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="primary-button h-9 px-3"
                  onClick={() => { submitModeRef.current = "close"; }}
                  disabled={submitting}
                >
                  {submitting ? "保存中…" : editEntryId ? "保存修改" : "保存"}
                </button>
              </div>
            </form>
          </div>
        </div>
      , document.body) : null}
    {open && categoryNestedOpen && createPortal(
      <NestedAddModal
        mode="compact"
        key={currentCategoryType}
        entityType="category"
        open={categoryNestedOpen}
        onClose={() => setCategoryNestedOpen(false)}
        defaultType={currentCategoryType}
        hiddenFields={["type"]}
        parentCategories={categoryParentOptions}
        existingNames={categoryList.map((category) => getCategoryLeafName(category.label))}
        onCreated={(id, name, extra) => {
          const parentId = extra?.parentId;
          const type = extra?.type ?? currentCategoryType;
          if (parentId) {
            const parent = categoryList.find(c => c.id === parentId);
            const fullLabel = parent ? `${parent.label}.${name}` : name;
            setCategoryList(prev => [...prev, { id, label: fullLabel, parentId, type }]);
          } else {
            // Should not happen — parentId is always required in this context
            const typePrefix = currentCategoryType === "expense" ? "支出" : currentCategoryType === "income" ? "收入" : currentCategoryType;
            setCategoryList(prev => [...prev, { id, label: `${typePrefix}.${name}`, parentId: null, type }]);
          }
          setCategoryId(id);
        }}
      />,
      document.body,
    )}
    {open && accountNestedOpen && createPortal(
      <NestedAddModal
        mode="compact"
        entityType="account"
        open={accountNestedOpen}
        onClose={() => setAccountNestedOpen(false)}
        onCreated={(id, name, extra) => {
          const kind = extra?.kind || "bank_debit";
          const institutionLabel = extra?.institutionShortName?.trim() || extra?.institutionName;
          const groupId = extra?.groupId?.trim();
          const groupName = extra?.groupName?.trim();
          const label = institutionLabel ? `${institutionLabel}·${name}` : name;
          const subLabel = kindLabel(kind);
          const option = { id, label, subLabel };
          setAccountList(prev => [...prev, option]);
          setTransferAccountList(prev => [...prev, option]);
          setLocalAccountSSOpts(prev => appendAccountOptionWithGroup(prev, option, groupId, groupName));
          setLocalTransferAccountSSOpts(prev => appendAccountOptionWithGroup(prev, option, groupId, groupName));
          if (accountCreateTarget === "from") setFromAccountId(id);
          else if (accountCreateTarget === "to") setToAccountId(id);
          else setAccountId(id);
          setAccountNestedOpen(false);
          setAccountCreateTarget("account");
        }}
        nestedFieldData={localNestedFieldData ?? nestedFieldData}
      />,
      document.body,
    )}
    {open && counterpartyNestedOpen && createPortal(
      <EntityCreateForm
        mode="full"
        layout="modal"
        entityType="institution"
        open={counterpartyNestedOpen}
        onClose={() => setCounterpartyNestedOpen(false)}
        defaultType="person"
        allowedInstitutionTypes={["person", "organization"]}
        existingNames={(localNestedFieldData?.counterpartyId ?? nestedFieldData?.counterpartyId ?? []).map((item) => item.name)}
        onCreated={(id, name, extra) => {
          const next = { id, name, type: extra?.type ?? "person" };
          setLocalNestedFieldData((prev) => ({
            ...(prev ?? nestedFieldData ?? {}),
            counterpartyId: [...((prev ?? nestedFieldData)?.counterpartyId ?? []), next],
          }));
          setCounterpartyInstitutionId(id);
          setCounterpartyNestedOpen(false);
        }}
      />,
      document.body,
    )}
    {open && institutionNestedOpen && createPortal(
      <NestedAddModal
        mode="compact"
        entityType="institution"
        open={institutionNestedOpen}
        onClose={() => setInstitutionNestedOpen(false)}
        defaultType="payment"
        title="新增收支机构"
        nameLabel="机构名称"
        namePlaceholder="例如：支付宝、微信支付、工商银行"
        allowedInstitutionTypes={["bank", "payment", "ewallet"]}
        existingNames={incomeExpenseInstitutionOptions.map((item) => item.name)}
        onCreated={(id, name, extra) => {
          const next = { id, name, type: extra?.type ?? "payment" };
          setLocalNestedFieldData((prev) => {
            const base = prev ?? nestedFieldData ?? {};
            return {
              ...base,
              institutionId: [...(base.institutionId ?? []), next],
              counterpartyId: base.counterpartyId ?? [],
            };
          });
          setCounterpartyInstitutionId(id);
          setInstitutionNestedOpen(false);
        }}
      />,
      document.body,
    )}
    </>
  );
}
