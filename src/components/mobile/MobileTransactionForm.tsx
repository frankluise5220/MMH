"use client";
import { ModalLayer } from "@/components/ModalLayer";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, X } from "lucide-react";
import { buildGroupedAccountOptions, buildAccountDisplayOption, type AccountDisplaySource } from "@/lib/account-display";
import { isCashLedgerAccount, isDepositAccount, isDepositPostingCategoryAllowed, isIncomeExpensePostingOrDepositAccount, isTransferDropdownAccount } from "@/lib/account-kind-utils";
import { SmartSelect } from "@/components/SmartSelect";
import { ClearableNoteField } from "@/components/ClearableNoteField";
import { CalcInput } from "@/components/CalcInput";
import { DateStepper } from "@/components/DateStepper";
import { EntryAttachmentButton, uploadEntryAttachmentFiles } from "@/components/EntryAttachmentPanel";
import { buildCategoryTreeOptions } from "@/components/categorySmartSelect";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { REQUIRED_FIELD_CLASS } from "@/lib/client/required-field";
import { useI18n } from "@/lib/i18n";
import { readAccountDisplaySettings } from "@/lib/client/account-display-settings";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { formatAmountDraft } from "@/lib/format";

type AccountOption = AccountDisplaySource;
type CategoryOption = { id: string; name: string; type: string; sortOrder?: number; isSystem?: boolean };
type TransactionDraft = {
  id?: string;
  date: string;
  amount: string;
  type: "expense" | "income" | "transfer";
  accountId: string;
  toAccountId: string;
  categoryId: string;
  note: string;
};

type Props = {
  accounts: AccountOption[];
  categories: CategoryOption[];
  defaultAccountId?: string;
};

const EMPTY_DRAFT: TransactionDraft = {
  // 打开表单时再填本地日期（见 openCreate）；模块级 toISOString 会在
  // 北京时间 00:00–08:00 得到「昨天」，且模块只加载一次、跨天不会更新。
  date: "",
  amount: "",
  type: "expense",
  accountId: "",
  toAccountId: "",
  categoryId: "",
  note: "",
};

export function MobileTransactionForm({ accounts, categories, defaultAccountId = "" }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TransactionDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [pendingAttachmentFiles, setPendingAttachmentFiles] = useState<File[]>([]);
  const scrollYRef = useRef(0);
  const { t } = useI18n();

  const availableCategories = useMemo(
    () => categories.filter((category) => category.type === draft.type),
    [categories, draft.type],
  );
  // Deposit accounts are also valid posting accounts (2026-09-18);
  // category submission validates against the allowlist.
  const postingAccountOptions = useMemo(
    () => buildGroupedAccountOptions(
      accounts
        .filter((account) => isIncomeExpensePostingOrDepositAccount(account))
        .map((account) => buildAccountDisplayOption(account, undefined, readAccountDisplaySettings())),
    ),
    [accounts],
  );
  const accountOptions = useMemo(
    () => (draft.type === "transfer"
      ? buildGroupedAccountOptions(
          accounts
            .filter((account) => isTransferDropdownAccount(account))
            .map((account) => buildAccountDisplayOption(account, undefined, readAccountDisplaySettings())),
        )
      : postingAccountOptions),
    [accounts, draft.type, postingAccountOptions],
  );
  /**
   * 快捷记账的预填账户：优先当前账户（列表页 / 明细页），否则落到第一个「可记账」
   * 账户。不能用 accounts[0] —— 传入的账户列表含汇总账户/投资账户，它们不在
   * 下拉选项里，直接提交会被服务端拒绝（表现为「记一笔失败」）。
   */
  const quickEntryAccountId = useMemo(() => {
    const selectable = postingAccountOptions.filter((option) => !option.isHeader);
    const selectableIds = new Set(selectable.map((option) => option.id));
    if (defaultAccountId && selectableIds.has(defaultAccountId)) return defaultAccountId;
    // 无默认账户（全部收支记录）时优先资金账户：按名称排序的第一个可记账账户
    // 往往是往来款，静默落到那儿会记错账。信用卡排在借记卡/现金之后。
    const selectableAccounts = accounts.filter((account) => selectableIds.has(account.id));
    const firstCashAccount = selectableAccounts.find(
      (account) => isCashLedgerAccount(account) && account.kind !== "bank_credit",
    ) ?? selectableAccounts.find((account) => isCashLedgerAccount(account));
    return firstCashAccount?.id ?? selectable[0]?.id ?? "";
  }, [accounts, defaultAccountId, postingAccountOptions]);
  const transferAccountOptions = useMemo(
    () => accountOptions.filter((option) => option.isHeader || option.id !== draft.accountId),
    [accountOptions, draft.accountId],
  );
  const categoryOptions = useMemo(
    () => [
      { id: "", label: t("mobileTxForm.uncategorized") },
      ...buildCategoryTreeOptions(availableCategories, t),
    ],
    [availableCategories, t],
  );

  useEffect(() => {
    if (!open) return;
    scrollYRef.current = window.scrollY;
    const previousOverflow = document.body.style.overflow;
    const previousOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscroll;
      window.requestAnimationFrame(() => window.scrollTo({ top: scrollYRef.current, left: 0 }));
    };
  }, [open]);

  const openCreate = useCallback(() => {
    setDraft({ ...EMPTY_DRAFT, date: todayDateLocalYmd(), accountId: quickEntryAccountId });
    setPendingAttachmentFiles([]);
    setError("");
    setOpen(true);
  }, [quickEntryAccountId]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("quickEntry") !== "1") return;
    openCreate();
    url.searchParams.delete("quickEntry");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [openCreate]);

  useEffect(() => {
    const openEdit = async (event: Event) => {
      const entryId = (event as CustomEvent<{ entryId?: string }>).detail?.entryId?.trim();
      if (!entryId) return;
      setPendingAttachmentFiles([]);
      setError("");
      try {
        const response = await fetch(`/api/v1/transactions/detail?id=${encodeURIComponent(entryId)}`);
        const result = await response.json().catch(() => null);
        const entry = result?.data;
        if (!response.ok || !result?.ok || !entry) throw new Error(result?.error ?? t("mobileTxForm.loadFailed"));
        if (entry.type !== "expense" && entry.type !== "income" && entry.type !== "transfer") {
          throw new Error(t("mobileTxForm.editOtherPageHint"));
        }
        const storedAmount = Number(entry.amount) || 0;
        setDraft({
          id: entry.id,
          date: String(entry.date ?? "").slice(0, 10),
          // Dialog sign mirrors desktop storedAmountToDialogAmount: expense
          // shows positive for outflow / negative for refund; income keeps
          // its stored sign; transfer is direction-less so show magnitude.
          amount: formatAmountDraft(
            entry.type === "expense"
              ? -storedAmount
              : entry.type === "income"
                ? storedAmount
                : Math.abs(storedAmount),
          ),
          type: entry.type,
          accountId: entry.accountId ?? "",
          toAccountId: entry.toAccountId ?? "",
          categoryId: entry.categoryId ?? "",
          note: entry.note ?? "",
        });
        setOpen(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("mobileTxForm.loadFailed"));
      }
    };
    // 手机端底部「记一笔」走独立事件：`mmh:create-transaction:open` 由桌面
    // TransactionFormModal 处理（它还带银证转账 / 固定资产等专业模式），根路由
    // 两套表单同时挂载时不能对同一个事件各开一个弹窗。
    window.addEventListener("mmh:mobile-transaction:open", openCreate);
    window.addEventListener("mmh:mobile-transaction:edit", openEdit);
    return () => {
      window.removeEventListener("mmh:mobile-transaction:open", openCreate);
      window.removeEventListener("mmh:mobile-transaction:edit", openEdit);
    };
  }, [openCreate, t]);

  function close() {
    if (saving) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setOpen(false);
  }

  function update<K extends keyof TransactionDraft>(key: K, value: TransactionDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function swapTransferAccounts() {
    setDraft((current) => ({ ...current, accountId: current.toAccountId, toAccountId: current.accountId }));
  }

  async function save() {
    const amount = Number(draft.amount);
    // 0 rejected; negative input is allowed for refunds (same dialog-level
    // convention as the desktop expense dialog: positive = outflow,
    // negative = inflow).
    if (!draft.date || !Number.isFinite(amount) || amount === 0 || !draft.accountId) {
      setError(t("mobileTxForm.fillRequired"));
      return;
    }
    if (draft.type === "transfer" && !draft.toAccountId) {
      setError(t("mobileTxForm.selectToAccount"));
      return;
    }

    // Category allowlist for deposit-account postings (2026-09-18).
    if ((draft.type === "income" || draft.type === "expense") && draft.accountId) {
      const selected = accounts.find((account) => account.id === draft.accountId);
      const categoryName = availableCategories.find((category) => category.id === draft.categoryId)?.name ?? "";
      if (isDepositAccount(selected ?? null) && !isDepositPostingCategoryAllowed(categoryName, draft.type)) {
        setError(t("txForm.alert.depositCategoryRestricted"));
        return;
      }
    }

    setSaving(true);
    setError("");
    try {
      const body = {
        ...(draft.id ? { id: draft.id } : {}),
        date: draft.date,
        // Stored sign convention (backend): expense is stored negative
        // (outflow), income positive (inflow). The dialog-level input is
        // positive-for-outflow, so flip expense here — same as desktop
        // dialogAmountToStoredAmount.
        amount: draft.type === "expense" ? -amount : amount,
        type: draft.type,
        accountId: draft.accountId,
        toAccountId: draft.type === "transfer" ? draft.toAccountId : undefined,
        categoryId: draft.type === "transfer" ? undefined : draft.categoryId || undefined,
        note: draft.note.trim() || undefined,
      };
      const response = await fetch("/api/v1/transactions/detail", {
        method: draft.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.error ?? t("mobileTxForm.saveFailed"));
      const savedEntryId = String(result.data?.id ?? draft.id ?? "");
      if (savedEntryId && pendingAttachmentFiles.length > 0) {
        try {
          await uploadEntryAttachmentFiles(savedEntryId, pendingAttachmentFiles);
          setPendingAttachmentFiles([]);
        } catch (attachmentError) {
          window.alert(t("attachments.saveAfterCreateFailed", {
            reason: attachmentError instanceof Error ? attachmentError.message : t("attachments.uploadFailed"),
          }));
        }
      }
      setOpen(false);
      dispatchFinanceDataChanged({
        reason: "mobile-transaction-save",
        accountIds: [draft.accountId, draft.toAccountId].filter((id): id is string => Boolean(id)),
        entryIds: savedEntryId ? [savedEntryId] : undefined,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("mobileTxForm.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <ModalLayer className="fixed inset-0 flex items-end overflow-hidden bg-slate-950/30" role="dialog" aria-modal="true" aria-label={draft.id ? t("mobileTxForm.editTitle") : t("mobileTxForm.newTitle")}>
      <div className="flex h-[min(86dvh,42rem)] max-h-[calc(100dvh-max(0.75rem,env(safe-area-inset-top)))] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl">
        <div className="shrink-0 px-4 pt-3">
        <div className="mx-auto mb-3 h-1 w-10 rounded bg-slate-200" />
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">{draft.id ? t("mobileTxForm.editTitle") : t("mobileTxForm.newTitle")}</h2>
          <button type="button" onClick={close} className="flex h-10 w-10 items-center justify-center text-slate-500" aria-label={t("mobileTxForm.close")}>
            <X size={20} />
          </button>
        </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
          {(["expense", "income", "transfer"] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => update("type", type)}
              className={`h-10 rounded-md text-sm font-medium ${draft.type === type ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500"}`}
            >
              {type === "expense" ? t("mobileTxForm.expense") : type === "income" ? t("mobileTxForm.income") : t("mobileTxForm.transfer")}
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-slate-500">{t("mobileTxForm.date")}</span>
            <DateStepper className="mt-1" value={draft.date} onChange={(value) => update("date", value)} />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">{t("mobileTxForm.amount")}</span>
            <CalcInput
              className="mt-1"
              value={draft.amount}
              onChange={(value) => update("amount", value)}
              placeholder="0.00"
              label={t("mobileTxForm.amount")}
              precision={2}
              inputClassName="text-right tabular-nums"
            />
          </label>
        </div>

        <label className="mt-3 block">
          <span className="text-xs text-slate-500">{draft.type === "transfer" ? t("mobileTxForm.transferFromAccount") : t("mobileTxForm.account")}</span>
          <div className={`mt-1 ${REQUIRED_FIELD_CLASS} [&>[role=button]]:h-11`}>
            <SmartSelect
              mode="single"
              value={draft.accountId}
              onChange={(value) => update("accountId", value)}
              options={accountOptions}
              placeholder={t("mobileTxForm.selectAccountPlaceholder")}
              behavior={{ search: true, hierarchy: true, density: "regular", minDropdownWidth: 340, dropdownMaxHeight: 320 }}
            />
          </div>
        </label>

        {draft.type === "transfer" ? (
          <div className="mt-1.5 flex justify-center">
            <button
              type="button"
              onClick={swapTransferAccounts}
              disabled={!draft.accountId && !draft.toAccountId}
              title={t("txForm.swapAccounts")}
              aria-label={t("txForm.swapAccounts")}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 active:bg-slate-100 disabled:opacity-40"
            >
              <ArrowLeftRight size={15} />
            </button>
          </div>
        ) : null}

        {draft.type === "transfer" ? (
          <label className="mt-1.5 block">
            <span className="text-xs text-slate-500">{t("mobileTxForm.transferToAccount")}</span>
            <div className={`mt-1 ${REQUIRED_FIELD_CLASS} [&>[role=button]]:h-11`}>
              <SmartSelect
                mode="single"
                value={draft.toAccountId}
                onChange={(value) => update("toAccountId", value)}
                options={transferAccountOptions}
                placeholder={t("mobileTxForm.selectAccountPlaceholder")}
                behavior={{ search: true, hierarchy: true, density: "regular", minDropdownWidth: 340, dropdownMaxHeight: 320 }}
              />
            </div>
          </label>
        ) : (
          <label className="mt-3 block">
            <span className="text-xs text-slate-500">{t("mobileTxForm.category")}</span>
            <div className={`mt-1 ${REQUIRED_FIELD_CLASS} [&>[role=button]]:h-11`}>
              <SmartSelect
                mode="single"
                value={draft.categoryId}
                onChange={(value) => update("categoryId", value)}
                options={categoryOptions}
                placeholder={t("mobileTxForm.uncategorized")}
                behavior={{ search: true, density: "regular", minDropdownWidth: 340, dropdownMaxHeight: 320 }}
              />
            </div>
          </label>
        )}

        <div className="mt-3">
          <div className="text-xs text-slate-500">{t("mobileTxForm.note")}</div>
          <div className="mt-1 flex items-start gap-2">
            <ClearableNoteField wrapperClassName="flex-1" className="form-input" value={draft.note} onValueChange={(value) => update("note", value)} placeholder={t("mobileTxForm.optional")} />
            <EntryAttachmentButton
              entryId={draft.id}
              pendingFiles={pendingAttachmentFiles}
              onPendingFilesChange={setPendingAttachmentFiles}
            />
          </div>
        </div>
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
        <button type="button" disabled={saving} onClick={save} className="primary-button mt-4 h-11 w-full disabled:opacity-60">
          {saving ? t("mobileTxForm.saving") : t("mobileTxForm.save")}
        </button>
        </div>
      </div>
    </ModalLayer>
  );
}

export function openMobileTransactionEdit(entryId: string) {
  window.dispatchEvent(new CustomEvent("mmh:mobile-transaction:edit", { detail: { entryId } }));
}
