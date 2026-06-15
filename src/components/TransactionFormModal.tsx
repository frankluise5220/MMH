"use client";

import { ArrowLeftRight, ArrowRight, ChevronDown, Paperclip, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { CalcInput } from "./CalcInput";
import { NestedAddModal } from "./EntityCreateForm";
import { SmartSelect, SmartSelectOption } from "./SmartSelect";
import { kindLabel } from "@/lib/account-kinds";

type TxType = "expense" | "income" | "transfer" | "investment";

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

export function TransactionFormModal({
  accounts,
  transferAccounts,
  investmentAccounts,
  expenseCategories,
  incomeCategories,
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
}: {
  accounts: AccountOption[];
  transferAccounts: AccountOption[];
  investmentAccounts: AccountOption[];
  expenseCategories: CategoryOption[];
  incomeCategories: CategoryOption[];
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
}) {
  const router = useRouter();
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
  const [tagList, setTagList] = useState(allTags ?? []);
  const [accountList, setAccountList] = useState(accounts);
  const [localAccountSSOpts, setLocalAccountSSOpts] = useState(accountSSOptions);

  const currentCategoryType = useMemo(() =>
    txType === "income" ? "income" :
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
    const nextCategoryList = txType === "income" ? incomeCategories : expenseCategories;
    setCategoryList(nextCategoryList);
    setCategoryId((current) => current && nextCategoryList.some((c) => c.id === current) ? current : "");
  }, [txType, incomeCategories, expenseCategories]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState(defaultAccountId ?? "");
  const [fromAccountId, setFromAccountId] = useState(isCreditCardAccount ? (lastRepayFromAccountId ?? defaultAccountId ?? "") : "");
  const [toAccountId, setToAccountId] = useState(isCreditCardAccount ? (defaultAccountId ?? "") : "");
  const [categoryId, setCategoryId] = useState("");
  const [note, setNote] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [isFromButton, setIsFromButton] = useState(false);

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
    setSelectedTagIds([]);
    setRequestId(null);
    setEditEntryId(null);
    setFromAccountIdEdited(false);
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
        accountId?: string;
        categoryId?: string;
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
      setSelectedTagIds(detail.tagIds ?? []);
      if (detail.type === "transfer") {
        const nextToAccountId = detail.toAccountId ?? "";
        const nextFromAccountId = detail.fromAccountId && detail.fromAccountId !== nextToAccountId
          ? detail.fromAccountId
          : detail.accountId ?? "";
        setAccountId("");
        setCategoryId("");
        setFromAccountId(nextFromAccountId);
        setToAccountId(nextToAccountId);
        setFromAccountIdEdited(true);
      } else {
        setAccountId(detail.accountId ?? (defaultAccountId ?? ""));
        setCategoryId(detail.categoryId ?? "");
        setFromAccountId("");
        setToAccountId(detail.toAccountId ?? "");
        setFromAccountIdEdited(false);
      }
    }

    window.addEventListener("mmh:transaction:edit", onOpenEdit as EventListener);
    return () => window.removeEventListener("mmh:transaction:edit", onOpenEdit as EventListener);
  }, [defaultAccountId, today]);

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
        formData.set("entryId", editEntryId);
        formData.set("keepFundDetail", "true");
        setSubmitting(true);
        try {
          await (editAction ?? action)(formData);
          await new Promise(resolve => setTimeout(resolve, 300));
          router.refresh();
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
      if (editEntryId) formData.set("entryId", editEntryId);
    } else {
      formData = new FormData();
      formData.set("type", txType);
      formData.set("date", date);
      formData.set("amount", amount);
      formData.set("note", note);
      if (editEntryId) formData.set("entryId", editEntryId);
      if (txType === "transfer") {
        formData.set("fromAccountId", fromAccountId);
        formData.set("toAccountId", toAccountId);
      } else if (txType === "income") {
        formData.set("accountId", accountId);
        formData.set("categoryId", categoryId);
        if (toAccountId) formData.set("toAccountId", toAccountId);
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
      setOpen(false);
      resetDraft();
      await new Promise(resolve => setTimeout(resolve, 300));
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "记账失败";
      window.alert(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setIsFromButton(true);
          resetDraft();
        }}
        className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 flex items-center gap-1 shadow-sm"
      >
        <Plus className="w-4 h-4" />
        记账
        <ChevronDown className="w-4 h-4 opacity-90" />
      </button>

      {open ? createPortal(
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/35">
          <div className="flex min-h-full items-start justify-center p-4 py-8">
          <div className="w-full max-w-xl max-h-[90vh] flex flex-col rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
              <div className="text-sm font-semibold text-slate-800">{editEntryId ? "编辑记录" : "记一笔"}</div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  resetDraft();
                }}
                className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
              >
                关闭
              </button>
            </div>

            <form className="p-4 space-y-4 overflow-y-auto" onSubmit={onSubmit}>
              <div className="flex justify-center gap-2">
                {isCreditCardAccount ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setTxType("expense")}
                      className={`h-9 flex-1 rounded-md border text-sm ${
                        txType === "expense"
                          ? "bg-blue-50 text-blue-700 border-blue-200"
                          : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
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
                      className={`h-9 flex-1 rounded-md border text-sm ${
                        txType === "transfer"
                          ? "bg-blue-50 text-blue-700 border-blue-200"
                          : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
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
                      className={`h-9 flex-1 rounded-md border text-sm ${
                        txType === "expense"
                          ? "bg-blue-50 text-blue-700 border-blue-200"
                          : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      支出
                    </button>
                    <button
                      type="button"
                      onClick={() => setTxType("income")}
                      className={`h-9 flex-1 rounded-md border text-sm ${
                        txType === "income"
                          ? "bg-blue-50 text-blue-700 border-blue-200"
                          : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      收入
                    </button>
                    <button
                      type="button"
                      onClick={() => setTxType("transfer")}
                      className={`h-9 flex-1 rounded-md border text-sm ${
                        txType === "transfer"
                          ? "bg-blue-50 text-blue-700 border-blue-200"
                          : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      转账
                    </button>
                    {showInvestment && (
                    <button
                      type="button"
                      onClick={() => setTxType("investment")}
                      className={`h-9 flex-1 rounded-md border text-sm ${
                        txType === "investment"
                          ? "bg-blue-50 text-blue-700 border-blue-200"
                          : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      投资
                    </button>
                    )}
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
                      window.dispatchEvent(new CustomEvent("mmh:create-transaction:open", {
                        detail: { requestId: `create-${Date.now()}`, item: { type: "investment", date, amount: Number(amount) || undefined }, defaultAccountId, defaultCashAccountId: accountId },
                      }));
                    }}
                    className="w-full h-10 rounded-md border border-blue-200 bg-blue-50 text-blue-700 text-sm hover:bg-blue-100"
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
                    className="w-full h-10 rounded-md border border-amber-200 bg-amber-50 text-amber-700 text-sm hover:bg-amber-100"
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
                    className="w-full h-10 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm hover:bg-emerald-100"
                  >
                    活期 / 存款
                  </button>
                </div>
              )}

              {(txType === "expense" || txType === "income") && (
                <div className="space-y-3">
                  {/* 第一行：日期 | 资金账户 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">日期</div>
                      <input name="date" type="date" value={date} onChange={(e) => setDate(e.target.value)}
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{txType === "income" ? "收款账户" : "资金账户"}</div>
                      <SmartSelect mode="single" value={accountId} onChange={setAccountId}
                        options={localAccountSSOpts ?? accountList} placeholder="请选择"
                        onCreateClick={() => setAccountNestedOpen(true)} />
                    </div>
                  </div>

                  {/* 第二行：类别 | 标签 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">类别</div>
                      <SmartSelect mode="single" value={categoryId} onChange={setCategoryId}
                        options={categorySSOptions} placeholder="未分类"
                        onCreateClick={() => setCategoryNestedOpen(true)} />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">标签</div>
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
                      <div className="text-xs font-medium text-slate-600">金额</div>
                      <CalcInput value={amount} onChange={setAmount} placeholder="例如：88.50" label="金额" />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">附件</div>
                      <button type="button" className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-400 hover:bg-slate-50 flex items-center gap-1.5">
                        <Paperclip className="w-3.5 h-3.5" />
                        添加票据附件
                      </button>
                    </div>
                  </div>

                  {/* 第四行：备注 */}
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">备注</div>
                    <input
                      name="note"
                      placeholder="可选"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    />
                  </div>
                </div>
              )}

              {txType === "transfer" && (
                <div className="space-y-3">
                  {/* 第一行：日期 */}
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">日期</div>
                    <input name="date" type="date" value={date} onChange={(e) => setDate(e.target.value)}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                  </div>

                  {/* 第二行：转出账户 | 互换 | 转入账户 */}
                  {isCreditCardAccount ? (
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">转出账户</div>
                        <SmartSelect mode="single" value={fromAccountId} onChange={v => { setFromAccountId(v); setFromAccountIdEdited(true); }}
                          options={transferAccountSSOptions ?? transferAccounts} placeholder="请选择" />
                      </div>
                      <div className="flex flex-col items-center pb-0.5">
                        <div className="h-6 flex items-center justify-center text-emerald-600 mb-1"><ArrowRight className="w-4 h-4" /></div>
                        <button type="button" className="h-9 w-9 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 flex items-center justify-center"
                          onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title="互换账户"><ArrowLeftRight className="w-4 h-4" /></button>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">转入账户</div>
                        <SmartSelect mode="single" value={toAccountId} onChange={setToAccountId}
                          options={accounts} placeholder="请选择" />
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">转出账户</div>
                        <SmartSelect mode="single" value={fromAccountId} onChange={setFromAccountId}
                          options={transferAccountSSOptions ?? transferAccounts} placeholder="请选择" />
                      </div>
                      <div className="flex items-center justify-center pb-0.5">
                        <button type="button" className="h-9 w-9 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 flex items-center justify-center"
                          onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title="互换转出/转入账户"><ArrowLeftRight className="w-4 h-4" /></button>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">转入账户</div>
                        <SmartSelect mode="single" value={toAccountId} onChange={setToAccountId}
                          options={transferAccountSSOptions ?? transferAccounts} placeholder="请选择" />
                      </div>
                    </div>
                  )}

                  {/* 第三行：金额 */}
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">金额</div>
                    <CalcInput value={amount} onChange={setAmount} placeholder="例如：88.50" label="金额" />
                  </div>

                  {/* 第四行：备注 */}
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">备注</div>
                    <input
                      name="note"
                      placeholder="可选"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    />
                  </div>
                </div>
              )}

              <input type="hidden" name="type" value={txType} />

              <div className="flex items-center justify-end gap-2 pt-1">
                {isFromButton && !editEntryId ? (
                  <button
                    type="button"
                    className="h-9 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700"
                    onClick={resetDraft}
                    disabled={submitting}
                  >
                    再记一笔
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="h-9 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                  disabled={submitting}
                >
                  {submitting ? "保存中…" : editEntryId ? "保存修改" : "保存"}
                </button>
              </div>
            </form>
          </div>
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
          setAccountList(prev => [...prev, { id, label: name, subLabel: kindLabel(kind) }]);
          setLocalAccountSSOpts(prev => prev ? [...prev, { id, label: name, subLabel: kindLabel(kind) }] : prev);
          setAccountId(id);
          setAccountNestedOpen(false);
        }}
        nestedFieldData={nestedFieldData}
      />,
      document.body,
    )}
    </>
  );
}
