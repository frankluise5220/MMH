"use client";

import { ArrowLeftRight, ArrowRight, ChevronDown, Paperclip, Plus, Repeat } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useCallback, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { CalcInput } from "./CalcInput";
import { NestedAddModal } from "./EntityCreateForm";
import { SmartSelect, SmartSelectOption } from "./SmartSelect";
import { kindLabel } from "@/lib/account-kinds";
import { recordRecentAccount, sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";

/** Shared hook: owner-filter logic for account SS dropdowns */
export function useAccountSSFilter(accountSSOptions?: SmartSelectOption[], controlledOwnerFilter?: string) {
  const [internalOwnerFilter, setInternalOwnerFilter] = useState("");
  const ownerFilter = controlledOwnerFilter ?? internalOwnerFilter;
  const setOwnerFilter = useCallback((next: string) => {
    if (controlledOwnerFilter === undefined) setInternalOwnerFilter(next);
  }, [controlledOwnerFilter]);
  const ownerFilterLabel = useMemo(() => ownerFilter || "全部", [ownerFilter]);
  const ownerNames = useMemo(() => {
    const names = new Set<string>();
    for (const option of accountSSOptions ?? []) {
      if (option.isHeader && option.label && option.label !== "未指定") names.add(option.label);
    }
    return Array.from(names);
  }, [accountSSOptions]);

  const cycleOwnerFilter = useCallback(() => {
    const owners = ownerNames;
    if (owners.length === 0) return;
    const current = ownerFilter;
    const idx = owners.indexOf(current);
    const next = idx < 0 ? owners[0] : owners[(idx + 1) % owners.length];
    if (next === owners[0] && current === owners[owners.length - 1]) {
      setOwnerFilter("");
    } else {
      setOwnerFilter(next);
    }
  }, [ownerFilter, ownerNames]);

  const filteredOptions = useMemo(() => {
    if (!accountSSOptions) return undefined;
    const options = accountSSOptions;
    const nonHeaderOptions = options.filter((option) => !option.isHeader);
    if (!ownerFilter) return nonHeaderOptions;
    const headerId = options.find((option) => option.isHeader && option.label === ownerFilter)?.id;
    if (!headerId) return nonHeaderOptions;
    return nonHeaderOptions.filter((option) => option.parentId === headerId);
  }, [accountSSOptions, ownerFilter]);

  const visibleOptionIds = useMemo(
    () => (filteredOptions ? new Set(filteredOptions.map((option) => option.id)) : undefined),
    [filteredOptions],
  );

  return { ownerFilter, setOwnerFilter, ownerFilterLabel, cycleOwnerFilter, filteredOptions, visibleOptionIds, ownerNames };
}

type TxType = "expense" | "income" | "advance" | "transfer" | "investment";

type AccountOption = {
  id: string;
  label: string;
  icon?: string;
  subLabel?: string;
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
};

function normalizeYmd(value: string | undefined) {
  const s = (value ?? "").trim();
  if (!s) return "";
  const d = new Date(s.replace(/[年/.]/g, "-").replace(/[月]/g, "-").replace(/[日]/g, ""));
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

type TagOption = {
  id: string;
  name: string;
  color?: string | null;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;
type SubmitMode = "close" | "repeat";
const COUNTERPARTY_TYPES = new Set(["family_member", "person", "debt", "other"]);

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
  const [fromAccountIdEdited, setFromAccountIdEdited] = useState(false);
  const [categoryList, setCategoryList] = useState(expenseCategories);
  const [categoryNestedOpen, setCategoryNestedOpen] = useState(false);
  const [accountNestedOpen, setAccountNestedOpen] = useState(false);
  const [counterpartyNestedOpen, setCounterpartyNestedOpen] = useState(false);
  const [accountCreateTarget, setAccountCreateTarget] = useState<"account" | "from" | "to">("account");
  const [tagList, setTagList] = useState(allTags ?? []);
  const [accountList, setAccountList] = useState(accounts);
  const [transferAccountList, setTransferAccountList] = useState(transferAccounts);
  const [localAccountSSOpts, setLocalAccountSSOpts] = useState(accountSSOptions);
  const [localTransferAccountSSOpts, setLocalTransferAccountSSOpts] = useState(transferAccountSSOptions);
  const [localNestedFieldData, setLocalNestedFieldData] = useState<NestedFieldData | undefined>(nestedFieldData);
  const [entryMenuOpen, setEntryMenuOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const triggerWrapRef = useRef<HTMLDivElement>(null);
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
    if (!entryMenuOpen) return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerWrapRef.current?.contains(target)) return;
      setEntryMenuOpen(false);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setEntryMenuOpen(false);
    }
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [entryMenuOpen]);

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

  /** Build parent category options with hierarchical (indented) display.
   *  In the expense/income context from TransactionFormModal, users can only
   *  add sub-categories under an existing category — never create a new
   *  root-level category directly. The "无（根分类）" option is excluded.
   */
  const categoryParentOptions = useMemo(() => {
    // Build a parent-id → children map for all categories of current type
    const byParentId = new Map<string | null, CategoryOption[]>();
    for (const c of categoryList) {
      const list = byParentId.get(c.parentId) ?? [];
      list.push(c);
      byParentId.set(c.parentId, list);
    }

    const options: Array<{ id: string; name: string; label: string; type: string; depth: number; parentId?: string }> = [];

    // Recursively walk the tree, building indented options
    // currentHeaderId tracks the nearest root ancestor (depth 0) for parentId linkage
    function walk(parentId: string | null, depth: number, pathPrefix: string, currentHeaderId?: string) {
      const children = byParentId.get(parentId) ?? [];
      for (const child of children) {
        const shortName = child.label.includes(".") ? child.label.split(".").pop() ?? child.label : child.label;
        const fullLabel = pathPrefix ? `${pathPrefix}.${shortName}` : shortName;
        // depth 0 items are root headers; depth > 0 items link to their nearest header ancestor
        const headerId = depth === 0 ? child.id : currentHeaderId;
        options.push({ id: child.id, name: shortName, label: fullLabel, type: currentCategoryType, depth, parentId: depth > 0 ? headerId : undefined });
        walk(child.id, depth + 1, fullLabel, headerId);
      }
    }

    // Start from root (parentId=null)
    walk(null, 0, "");

    return options;
  }, [categoryList, currentCategoryType]);

  /** Build hierarchical SmartSelect options for category dropdown.
   *  Root categories (level 0) appear as group headers (isHeader=true, non-selectable).
   *  Level-1 categories with children appear as collapsible groups (isGroup=true, selectable).
   *  Level-1 categories without children are regular selectable items.
   *  Level-2+ categories are regular selectable items with parentId linking to their
   *  nearest group ancestor (isHeader or isGroup).
   *  Indentation: Level 1 = one indent (　), Level 2 = two (　　), etc. */
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

        if (level === 0) {
          // Root → group header (non-selectable)
          opts.push({ id: child.id, label: shortName, isHeader: true });
          walk(child.id, level + 1, child.id);
        } else if (grandChildren.length > 0) {
          // Level 1+ with children → collapsible group (selectable + has sub-items)
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
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState(defaultAccountId ?? "");
  const [fromAccountId, setFromAccountId] = useState(isCreditCardAccount ? (lastRepayFromAccountId ?? defaultAccountId ?? "") : "");
  const [toAccountId, setToAccountId] = useState(isCreditCardAccount ? (defaultAccountId ?? "") : "");
  const [categoryId, setCategoryId] = useState("");
  const [counterpartyInstitutionId, setCounterpartyInstitutionId] = useState("");
  const [note, setNote] = useState("");
  const [toNote, setToNote] = useState("");
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

  const mergedAccountSelectOptions = useMemo(
    () => mergeSmartSelectOptions(localAccountSSOpts, accountList),
    [localAccountSSOpts, accountList],
  );
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
  const isEditingTransfer = !!editEntryId && txType === "transfer";
  const readonlyFromAccountLabel =
    displayTransferOptions.find((option) => option.id === fromAccountId)?.label
    ?? transferAccountList.find((option) => option.id === fromAccountId)?.label
    ?? "未选择";

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
    setAmount("");
    setAccountId(defaultAccountId ?? "");
    if (isCreditCardAccount) {
      setFromAccountId(lastRepayFromAccountId ?? defaultAccountId ?? "");
      setToAccountId(defaultAccountId ?? "");
    } else {
      setFromAccountId("");
      setToAccountId("");
    }
    setCategoryId("");
    setNote("");
    setToNote("");
    setSelectedTagIds([]);
    setRequestId(null);
    setEditEntryId(null);
    setEditEntryOriginalType(null);
    setEditEntryHasFundDetail(false);
    setFromAccountIdEdited(false);
  }
  useCloseOnNavigation(open, () => {
    setOpen(false);
    resetDraft();
  });

  function repeatDraft() {
    setAmount("");
    setRequestId(null);
    setEditEntryId(null);
    setEditEntryOriginalType(null);
    setEditEntryHasFundDetail(false);
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
      setTxType(mappedType);

      const dateStr = normalizeYmd(item.date) || today;
      setDate(dateStr);

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
      setOpen(true);
      setTxType(detail.type);
      setDate(detail.date || today);
      const numericAmount = Number(detail.amount);
      setAmount(Number.isFinite(numericAmount) && numericAmount !== 0 ? String(Math.abs(numericAmount)) : "");
      setNote(detail.note ?? "");
      setToNote(detail.toNote ?? "");
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
    if (!open || !isCreditCardAccount || txType !== "transfer") return;
    if (fromAccountIdEdited || !toAccountId) return;
    fetch(`/api/v1/fund/last-repay-account?accountId=${encodeURIComponent(toAccountId)}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.repayAccountId) setFromAccountId(d.repayAccountId);
      })
      .catch(() => {});
  }, [open, isCreditCardAccount, txType, toAccountId, fromAccountIdEdited]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    if (editEntryId && editEntryOriginalType === "investment" && txType !== "investment" && editEntryHasFundDetail) {
      const confirmed = window.confirm("这条投资记录有对应的基金明细。\n\n选择「确定」将删除基金明细记录。\n选择「取消」将保留基金明细但清空资金来源关联。\n\n请选择：");
      if (!confirmed) {
        const formData = new FormData(e.currentTarget);
        formData.set("type", txType);
        formData.set("date", date);
        formData.set("amount", amount);
        formData.set("note", note);
        formData.set("toNote", toNote);
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
            window.dispatchEvent(new Event("mmh:fund:refresh"));
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
      formData.set("toNote", toNote);
      formData.set("counterpartyInstitutionId", counterpartyInstitutionId);
      if (editEntryId) formData.set("entryId", editEntryId);
    } else {
      formData = new FormData();
      formData.set("type", txType);
      formData.set("date", date);
      formData.set("amount", amount);
      formData.set("note", note);
      formData.set("toNote", toNote);
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
        window.dispatchEvent(new Event("mmh:fund:refresh"));
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
        <div ref={triggerWrapRef} className="relative inline-flex">
          <div className="inline-flex h-8 items-stretch overflow-hidden rounded-full bg-blue-600 text-white shadow-sm ring-1 ring-blue-600/90">
            <button
              type="button"
              onClick={() => {
                setEntryMenuOpen(false);
                setOpen(true);
                setIsFromButton(true);
                resetDraft();
              }}
              className="inline-flex items-center gap-1.5 bg-transparent px-3 text-sm font-medium hover:bg-white/10"
            >
              <Plus className="w-4 h-4" />
              记账
            </button>
            <div className="my-1 w-px shrink-0 bg-white/35" aria-hidden="true" />
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={entryMenuOpen}
              onClick={() => setEntryMenuOpen((prev) => !prev)}
              className="inline-flex items-center justify-center bg-transparent px-2.5 hover:bg-white/10"
              title="更多记账入口"
            >
              <ChevronDown className="w-4 h-4 opacity-90" />
            </button>
          </div>
          {entryMenuOpen ? (
            <div className="absolute right-0 top-9 z-20 min-w-[180px] overflow-hidden rounded-[12px] border border-slate-200 bg-white py-1 shadow-[0_12px_32px_rgba(15,23,42,0.16)]">
              <button
                type="button"
                onClick={() => {
                  setEntryMenuOpen(false);
                  window.dispatchEvent(new CustomEvent("mmh:investment:create", {
                    detail: { requestId: `create-${Date.now()}`, defaultAccountId, defaultCashAccountId: defaultAccountId ?? "" },
                  }));
                }}
                className="flex w-full items-center px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              >
                开放式基金 / 货币基金
              </button>
              <button
                type="button"
                onClick={() => {
                  setEntryMenuOpen(false);
                  window.dispatchEvent(new CustomEvent("mmh:wealth:create", {
                    detail: { requestId: `create-${Date.now()}`, defaultCashAccountId: defaultAccountId ?? "" },
                  }));
                }}
                className="flex w-full items-center px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              >
                银行理财
              </button>
              <button
                type="button"
                onClick={() => {
                  setEntryMenuOpen(false);
                  window.dispatchEvent(new CustomEvent("mmh:deposit:create", {
                    detail: { requestId: `create-${Date.now()}`, defaultCashAccountId: defaultAccountId ?? "" },
                  }));
                }}
                className="flex w-full items-center px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              >
                活期 / 定期存款
              </button>
              <button
                type="button"
                onClick={() => {
                  setEntryMenuOpen(false);
                  window.dispatchEvent(new CustomEvent("mmh:insurance:create", {
                    detail: {
                      requestId: `create-${Date.now()}`,
                      defaultCashAccountId: defaultAccountId ?? "",
                      defaultOwnerGroupId: "",
                    },
                  }));
                }}
                className="flex w-full items-center px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              >
                保险
              </button>
            </div>
          ) : null}
        </div>
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
                      onClick={() => setTxType("expense")}
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
                      onClick={() => {
                        setTxType("transfer");
                        if (isCreditCardAccount) {
                          setFromAccountIdEdited(false);
                          setFromAccountId(lastRepayFromAccountId ?? defaultAccountId ?? "");
                          setToAccountId(defaultAccountId ?? "");
                        }
                      }}
                      className={`segment-button h-9 flex-1 ${
                        txType === "transfer"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      还款
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setTxType("expense")}
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
                      onClick={() => setTxType("income")}
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
                      onClick={() => setTxType("advance")}
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
                      onClick={() => {
                        setTxType("transfer");
                        setFromAccountId(defaultAccountId ?? "");
                        setToAccountId("");
                        setFromAccountIdEdited(false);
                      }}
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
                      <input name="date" type="date" value={date} onChange={(e) => setDate(e.target.value)}
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
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
                        ownerFilterLabel={ownerFilterLabel} />
                    </div>
                  </div>

                  {/* 第二行：类别 | 标签 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">类别</div>
                      <SmartSelect mode="single" value={categoryId} onChange={setCategoryId}
                        options={categorySSOptions} placeholder="未分类"
                        onCreateClick={() => setCategoryNestedOpen(true)} />
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

                  {/* 第三行：金额 | 附件 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">金额</div>
                      <CalcInput value={amount} onChange={setAmount} placeholder="例如：88.50" label="金额" precision={2} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{txType === "advance" ? "往来对象" : "收支机构"}</div>
                      <SmartSelect
                        mode="single"
                        value={counterpartyInstitutionId}
                        onChange={setCounterpartyInstitutionId}
                        options={((txType === "advance" ? localNestedFieldData?.counterpartyId : localNestedFieldData?.institutionId) ?? [])
                          .filter((item) => txType !== "advance" || COUNTERPARTY_TYPES.has(item.type ?? "other"))
                          .map((item) => ({ id: item.id, label: item.name }))}
                        placeholder={txType === "advance" ? "请选择" : "可选"}
                        onCreateClick={txType === "advance" ? () => setCounterpartyNestedOpen(true) : undefined}
                        createLabel="新增往来对象"
                        searchable
                      />
                    </div>
                  </div>

                  {/* 第四行：备注 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">转出备注</div>
                      <input
                        name="note"
                        placeholder="可选"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        className="form-input"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">转入备注</div>
                      <input
                        name="toNote"
                        placeholder="可选"
                        value={toNote}
                        onChange={(e) => setToNote(e.target.value)}
                        className="form-input"
                      />
                    </div>
                  </div>
                </div>
              )}

              {txType === "transfer" && (
                <div className="space-y-3">
                  {/* 第一行：日期 */}
                  <div className="space-y-1">
                    <div className="form-label">日期</div>
                    <input name="date" type="date" value={date} onChange={(e) => setDate(e.target.value)}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                  </div>

                  {/* 第二行：转出账户 | 互换 | 转入账户 */}
                  {isCreditCardAccount ? (
                    <div className={`grid gap-3 items-end ${isEditingTransfer ? "grid-cols-2" : "grid-cols-[1fr_auto_1fr]"}`}>
                      <div className="space-y-1">
                        <div className="form-label">转出账户</div>
                        {isEditingTransfer ? (
                          <div className="form-input flex items-center bg-slate-50 text-slate-600">{readonlyFromAccountLabel}</div>
                        ) : (
                          <SmartSelect mode="single" value={fromAccountId} onChange={v => { setFromAccountId(v); setFromAccountIdEdited(true); }}
                            options={displayTransferOptions} placeholder="请选择"
                            onCreateClick={() => { void openAccountCreate("from"); }} createLabel="新增账户"
                            onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel} />
                        )}
                      </div>
                      {!isEditingTransfer ? (
                        <div className="flex flex-col items-center pb-0.5">
                          <div className="h-6 flex items-center justify-center text-emerald-600 mb-1"><ArrowRight className="w-4 h-4" /></div>
                          <button type="button" className="secondary-button h-9 w-9 px-0 text-slate-700"
                            onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title="互换账户"><ArrowLeftRight className="w-4 h-4" /></button>
                        </div>
                      ) : null}
                      <div className="space-y-1">
                        <div className="form-label">转入账户</div>
                        <SmartSelect mode="single" value={toAccountId} onChange={setToAccountId}
                          options={displayTransferOptions} placeholder="请选择"
                          onCreateClick={() => { void openAccountCreate("to"); }} createLabel="新增账户"
                          onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel} />
                      </div>
                    </div>
                  ) : (
                    <div className={`grid gap-3 items-end ${isEditingTransfer ? "grid-cols-2" : "grid-cols-[1fr_auto_1fr]"}`}>
                      <div className="space-y-1">
                        <div className="form-label">转出账户</div>
                        {isEditingTransfer ? (
                          <div className="form-input flex items-center bg-slate-50 text-slate-600">{readonlyFromAccountLabel}</div>
                        ) : (
                          <SmartSelect mode="single" value={fromAccountId} onChange={setFromAccountId}
                            options={displayTransferOptions} placeholder="请选择"
                            onCreateClick={() => { void openAccountCreate("from"); }} createLabel="新增账户"
                            onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel} />
                        )}
                      </div>
                      {!isEditingTransfer ? (
                        <div className="flex items-center justify-center pb-0.5">
                          <button type="button" className="secondary-button h-9 w-9 px-0 text-slate-700"
                            onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title="互换转出/转入账户"><ArrowLeftRight className="w-4 h-4" /></button>
                        </div>
                      ) : null}
                      <div className="space-y-1">
                        <div className="form-label">转入账户</div>
                        <SmartSelect mode="single" value={toAccountId} onChange={setToAccountId}
                          options={displayTransferOptions} placeholder="请选择"
                          onCreateClick={() => { void openAccountCreate("to"); }} createLabel="新增账户"
                          onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel} />
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
      <NestedAddModal
        mode="compact"
        entityType="institution"
        open={counterpartyNestedOpen}
        onClose={() => setCounterpartyNestedOpen(false)}
        defaultType="person"
        extraFields={{ type: "person" }}
        hiddenFields={["type"]}
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
    </>
  );
}
