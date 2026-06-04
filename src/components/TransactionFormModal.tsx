"use client";

import { ArrowLeftRight, ArrowRight, ChevronDown, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { NestedAddModal } from "./NestedAddModal";

type TxType = "expense" | "income" | "transfer" | "investment";

type AccountOption = {
  id: string;
  label: string;
};

type CategoryOption = {
  id: string;
  label: string;
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
  action,
  editAction,
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
  action: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  editAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [txType, setTxType] = useState<TxType>("expense");
  const [productType, setProductType] = useState<"fund" | "money" | "wealth">("fund");
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const [editEntryOriginalType, setEditEntryOriginalType] = useState<TxType | null>(null);
  const [editEntryHasFundDetail, setEditEntryHasFundDetail] = useState(false);
  const [editCashAccountId, setEditCashAccountId] = useState<string | undefined>();
  const [editFundCode, setEditFundCode] = useState<string | undefined>();
  const [fromAccountIdEdited, setFromAccountIdEdited] = useState(false);
  const [categoryList, setCategoryList] = useState(expenseCategories);
  const [categoryNestedOpen, setCategoryNestedOpen] = useState(false);

  const currentCategoryType = useMemo(() =>
    txType === "income" ? "income" :
    txType === "investment" ? "investment" : "expense",
  [txType]);

  useEffect(() => {
    setCategoryList(txType === "income" ? incomeCategories : expenseCategories);
    setCategoryId("");
  }, [txType, incomeCategories, expenseCategories]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState(defaultAccountId ?? "");
  const [fromAccountId, setFromAccountId] = useState(isCreditCardAccount ? (lastRepayFromAccountId ?? defaultAccountId ?? "") : "");
  const [toAccountId, setToAccountId] = useState(isCreditCardAccount ? (defaultAccountId ?? "") : "");
  const [categoryId, setCategoryId] = useState("");
  const [note, setNote] = useState("");
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

    window.addEventListener("wiseme:create-transaction:open", onOpenFromAi as EventListener);
    return () => window.removeEventListener("wiseme:create-transaction:open", onOpenFromAi as EventListener);
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
      }>).detail;
      if (!detail?.requestId || !detail.entryId) return;
      setRequestId(detail.requestId);
      setEditEntryId(detail.entryId);
      setEditEntryOriginalType(detail.type);
      setEditEntryHasFundDetail(detail.hasFundDetail ?? false);
      setEditCashAccountId(detail.cashAccountId);
      setEditFundCode(detail.fundCode);
      setOpen(true);
      setTxType(detail.type);
      setDate(detail.date || today);
      setAmount(detail.amount > 0 ? String(detail.amount) : "");
      setNote(detail.note ?? "");
      setAccountId(detail.accountId ?? (defaultAccountId ?? ""));
      setCategoryId(detail.categoryId ?? "");
      setFromAccountId(detail.fromAccountId ?? (defaultAccountId ?? ""));
      setToAccountId(detail.toAccountId ?? "");
      if (detail.type === "investment") {
        setProductType(detail.fundSubtype === "money" ? "money" : detail.fundSubtype === "wealth" ? "wealth" : "fund");
      }
    }

    window.addEventListener("wiseme:transaction:edit", onOpenEdit as EventListener);
    return () => window.removeEventListener("wiseme:transaction:edit", onOpenEdit as EventListener);
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
          await new Promise(resolve => setTimeout(resolve, 100));
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
          new CustomEvent(editEntryId ? "wiseme:transaction:edit:success" : "wiseme:create-transaction:success", { detail: { requestId } }),
        );
      }
      setOpen(false);
      resetDraft();
      await new Promise(resolve => setTimeout(resolve, 100));
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

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-xl rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
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

            <form className="p-4 space-y-4" onSubmit={onSubmit}>
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
                  </>
                )}
              </div>

              {txType === "investment" && (
                <InvestmentFormFields
                  accounts={investmentAccounts}
                  cashAccounts={accounts}
                  productType={productType}
                  setProductType={setProductType}
                  date={date}
                  setDate={setDate}
                  amount={amount}
                  setAmount={setAmount}
                  note={note}
                  setNote={setNote}
                  defaultAccountId={accountId}
                  defaultCashAccountId={editCashAccountId}
                  defaultFundCode={editFundCode}
                />
              )}

              {(txType === "expense" || txType === "income" || txType === "transfer") && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">日期</div>
                      <input name="date" type="date" value={date} onChange={(e) => setDate(e.target.value)}
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">金额</div>
                      <input name="amount" inputMode="decimal" placeholder="例如：88.50" value={amount} onChange={(e) => setAmount(e.target.value)}
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                    </div>
                  </div>

                  {txType === "transfer" ? (
                    isCreditCardAccount ? (
                      <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-slate-600">转出账户</div>
                          <select name="fromAccountId" value={fromAccountId} onChange={(e) => { setFromAccountId(e.target.value); setFromAccountIdEdited(true); }}
                            className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                            <option value="">请选择</option>
                            {transferAccounts.map((a) => (<option key={a.id} value={a.id}>{a.label}</option>))}
                          </select>
                        </div>
                        <div className="flex flex-col items-center pb-0.5">
                          <div className="h-6 flex items-center justify-center text-emerald-600 mb-1"><ArrowRight className="w-4 h-4" /></div>
                          <button type="button" className="h-9 w-9 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 flex items-center justify-center"
                            onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title="互换账户"><ArrowLeftRight className="w-4 h-4" /></button>
                        </div>
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-slate-600">转入账户</div>
                          <select name="toAccountId" value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}
                            className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                            <option value="">请选择</option>
                            {accounts.map((a) => (<option key={a.id} value={a.id}>{a.label}</option>))}
                          </select>
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-slate-600">转出账户</div>
                          <select name="fromAccountId" value={fromAccountId} onChange={(e) => setFromAccountId(e.target.value)}
                            className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                            <option value="">请选择</option>
                            {transferAccounts.map((a) => (<option key={a.id} value={a.id}>{a.label}</option>))}
                          </select>
                        </div>
                        <div className="flex items-center justify-center pb-0.5">
                          <button type="button" className="h-9 w-9 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 flex items-center justify-center"
                            onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title="互换转出/转入账户"><ArrowLeftRight className="w-4 h-4" /></button>
                        </div>
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-slate-600">转入账户</div>
                          <select name="toAccountId" value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}
                            className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                            <option value="">请选择</option>
                            {transferAccounts.map((a) => (<option key={a.id} value={a.id}>{a.label}</option>))}
                          </select>
                        </div>
                      </div>
                    )
                  ) : txType === "income" ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">收款账户</div>
                        <select name="accountId" value={accountId} onChange={(e) => setAccountId(e.target.value)}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                          <option value="">请选择</option>
                          {accounts.map((a) => (<option key={a.id} value={a.id}>{a.label}</option>))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <div className="text-xs font-medium text-slate-600">类别</div>
                          <button type="button" onClick={() => setCategoryNestedOpen(true)}
                            className="flex items-center gap-0.5 h-5 px-1 rounded text-[10px] text-blue-600 hover:bg-blue-50 border border-transparent hover:border-blue-200">
                            <Plus className="w-3 h-3" />新增
                          </button>
                        </div>
                        <select name="categoryId" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                          <option value="">未分类</option>
                          {categoryList.map((c) => (<option key={c.id} value={c.id}>{c.label}</option>))}
                        </select>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">账户</div>
                        <select name="accountId" value={accountId} onChange={(e) => setAccountId(e.target.value)}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                          <option value="">请选择</option>
                          {accounts.map((a) => (<option key={a.id} value={a.id}>{a.label}</option>))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <div className="text-xs font-medium text-slate-600">类别</div>
                          <button type="button" onClick={() => setCategoryNestedOpen(true)}
                            className="flex items-center gap-0.5 h-5 px-1 rounded text-[10px] text-blue-600 hover:bg-blue-50 border border-transparent hover:border-blue-200">
                            <Plus className="w-3 h-3" />新增
                          </button>
                        </div>
                        <select name="categoryId" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
                          <option value="">未分类</option>
                          {categoryList.map((c) => (<option key={c.id} value={c.id}>{c.label}</option>))}
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              )}

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
      ) : null}
    <NestedAddModal
       key={currentCategoryType}
       entityType="category"
       open={categoryNestedOpen}
       onClose={() => setCategoryNestedOpen(false)}
       defaultType={currentCategoryType}
       onCreated={(id, name) => {
         setCategoryList(prev => [...prev, { id, label: name }]);
         setCategoryId(id);
       }}
     />
    </>
  );
}

function InvestmentFormFields({
  accounts,
  cashAccounts,
  productType,
  setProductType,
  date,
  setDate,
  amount,
  setAmount,
  note,
  setNote,
  defaultAccountId,
  defaultCashAccountId,
  defaultFundCode,
}: {
  accounts: AccountOption[];
  cashAccounts: AccountOption[];
  productType: "fund" | "money" | "wealth";
  setProductType: (v: "fund" | "money" | "wealth") => void;
  date: string;
  setDate: (v: string) => void;
  amount: string;
  setAmount: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
  defaultAccountId?: string;
  defaultCashAccountId?: string;
  defaultFundCode?: string;
}) {
  const [investAccountId, setInvestAccountId] = useState("");
  const [cashAccountId, setCashAccountId] = useState(defaultCashAccountId ?? "");
  const [fundCode, setFundCode] = useState(defaultFundCode ?? "");
  const [fundName, setFundName] = useState("");
  const [productName, setProductName] = useState("");
  const [annualRate, setAnnualRate] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [termDays, setTermDays] = useState("");
  const [nameLoading, setNameLoading] = useState(false);

  useEffect(() => {
    if (defaultCashAccountId) setCashAccountId(defaultCashAccountId);
    if (defaultFundCode) setFundCode(defaultFundCode);
  }, [defaultCashAccountId, defaultFundCode]);

  // 基金代码变化时自动获取名称
  useEffect(() => {
    const code = fundCode.trim();
    if (!code) {
      setFundName("");
      return;
    }
    const timer = setTimeout(() => {
      setNameLoading(true);
      // 调用新的API：先从本地数据库查询，再从API获取
      fetch(`/api/v1/fund/name?code=${encodeURIComponent(code)}`)
        .then(r => r.json())
        .then(d => {
          if (d.ok && d.name) setFundName(d.name);
          else window.alert(d.error ?? "获取基金名称失败");
        })
        .catch(() => window.alert("获取失败"))
        .finally(() => setNameLoading(false));
    }, 800);
    return () => clearTimeout(timer);
  }, [fundCode]);

  const investAccounts = accounts;
  const allCashAccounts = cashAccounts;

  const isDefaultInvestAccount = defaultAccountId && investAccounts.some((a) => a.id === defaultAccountId);

  const findMatchingInvestAccount = () => {
    if (productType === "fund") {
      return investAccounts.find((a) => a.label.includes("开放式基金"))?.id ||
        investAccounts.find((a) => a.label.includes("基金"))?.id ||
        (investAccounts.length > 0 ? investAccounts[0].id : "");
    }
    if (productType === "money") {
      return investAccounts.find((a) => a.label.includes("货币基金"))?.id ||
        investAccounts.find((a) => a.label.includes("货币"))?.id ||
        investAccounts.find((a) => a.label.includes("基金"))?.id ||
        (investAccounts.length > 0 ? investAccounts[0].id : "");
    }
    if (productType === "wealth") {
      return investAccounts.find((a) => a.label.includes("理财"))?.id ||
        investAccounts.find((a) => a.label.includes("投资"))?.id ||
        (investAccounts.length > 0 ? investAccounts[0].id : "");
    }
    return investAccounts.length > 0 ? investAccounts[0].id : "";
  };

  const defaultInvestAccountId = isDefaultInvestAccount ? defaultAccountId : findMatchingInvestAccount();
  const computedDefaultCashAccountId = isDefaultInvestAccount
    ? ""
    : defaultAccountId && allCashAccounts.some((a) => a.id === defaultAccountId)
      ? defaultAccountId
      : allCashAccounts.length > 0 ? allCashAccounts[0].id : "";

  const effectiveInvestAccountId = investAccountId || defaultInvestAccountId;
  const effectiveCashAccountId = cashAccountId || computedDefaultCashAccountId;

  return (
    <>
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={() => setProductType("fund")}
          className={`flex-1 h-8 rounded-md border text-xs ${productType === "fund" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"}`}>
          开放式基金
        </button>
        <button type="button" onClick={() => setProductType("money")}
          className={`flex-1 h-8 rounded-md border text-xs ${productType === "money" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"}`}>
          货币基金
        </button>
        <button type="button" onClick={() => setProductType("wealth")}
          className={`flex-1 h-8 rounded-md border text-xs ${productType === "wealth" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"}`}>
          普通理财
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-600">日期</div>
          <input name="date" type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
        </div>
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-600">金额</div>
          <input name="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00"
            className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-600">资金账户</div>
          <select name="cashAccountId" value={effectiveCashAccountId} onChange={(e) => setCashAccountId(e.target.value)}
            className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
            <option value="">请选择</option>
            {allCashAccounts.map((a) => (<option key={a.id} value={a.id}>{a.label}</option>))}
          </select>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-600">投资账户</div>
          <select name="accountId" value={effectiveInvestAccountId} onChange={(e) => setInvestAccountId(e.target.value)}
            className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none">
            <option value="">请选择</option>
            {(investAccounts.length > 0 ? investAccounts : accounts).map((a) => (<option key={a.id} value={a.id}>{a.label}</option>))}
          </select>
        </div>
      </div>

      {productType === "fund" && (
        <div className="grid grid-cols-[1fr_2fr] gap-2 items-end">
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">基金代码</div>
            <input name="fundCode" value={fundCode} onChange={(e) => setFundCode(e.target.value)} placeholder="6位代码"
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">
              基金名称{nameLoading && <span className="ml-1 text-slate-400 font-normal">获取中…</span>}
            </div>
            <input name="fundName" value={fundName} readOnly placeholder="根据基金代码自动获取"
              className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none text-slate-600 cursor-not-allowed" />
          </div>
        </div>
      )}

      {productType === "money" && (
        <div className="grid grid-cols-[1fr_2fr] gap-2 items-end">
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">基金代码</div>
            <input name="fundCode" value={fundCode} onChange={(e) => setFundCode(e.target.value)} placeholder="6位代码"
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">
              基金名称{nameLoading && <span className="ml-1 text-slate-400 font-normal">获取中…</span>}
            </div>
            <input name="fundName" value={fundName} readOnly placeholder="根据基金代码自动获取"
              className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none text-slate-600 cursor-not-allowed" />
          </div>
        </div>
      )}

      {productType === "wealth" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">产品名称</div>
            <input name="fundName" value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="输入产品名称"
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">年化收益（%）</div>
            <input name="nav" value={annualRate} onChange={(e) => setAnnualRate(e.target.value)} placeholder="如：3.5"
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
          </div>
        </div>
      )}

      <input type="hidden" name="fundSubtype" value="buy" />
      <input type="hidden" name="productType" value={productType} />
    </>
  );
}
