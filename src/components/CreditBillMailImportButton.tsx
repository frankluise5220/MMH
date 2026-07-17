"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { MailSearch, RefreshCw, X } from "lucide-react";
import { DateStepper } from "./DateStepper";
import { useI18n } from "@/lib/i18n";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";

type EmailAccount = {
  id: string;
  label: string;
  username: string;
  mailbox: string;
};

type MailItem = {
  uid: number;
  subject: string;
  from: string;
  date: string;
  hash?: string;
  emailAccountId: string;
  emailAccountLabel: string;
  imported?: boolean;
  importedAt?: string;
};

type MailAttachment = {
  filename: string;
  text?: string;
};

type MailDetail = {
  uid: number;
  subject: string;
  from: string;
  date: string;
  text: string;
  html: string;
  attachments?: MailAttachment[];
};

type ParsedItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  amount: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  category?: string;
  remark?: string;
  counterparty?: string;
  institution?: string;
  postedDate?: string;
  _meta?: {
    institutionName?: string;
    ownerName?: string;
    cardNumberMasked?: string;
    creditLimit?: number;
    billingDay?: number;
    repaymentDay?: number;
  };
};

type ParseState = {
  mail: MailItem;
  items: ParsedItem[];
};

const LAST_WORKING_EMAIL_ACCOUNT_KEY = "mmh_credit_bill_last_working_email_account";
const BILL_MAIL_KEYWORDS = [
  "账单",
  "对账单",
  "月结单",
  "statement",
  "e-statement",
  "credit card statement",
];

function readLastWorkingEmailAccountId() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_WORKING_EMAIL_ACCOUNT_KEY) || "";
  } catch {
    return "";
  }
}

function writeLastWorkingEmailAccountId(accountId: string) {
  if (typeof window === "undefined" || !accountId) return;
  try {
    window.localStorage.setItem(LAST_WORKING_EMAIL_ACCOUNT_KEY, accountId);
  } catch {
    // Local storage can be unavailable in private or restricted browser contexts.
  }
}

function normalizeDateOnlyText(value?: string | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})(?:日)?/);
  if (!match) return raw.slice(0, 10);
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function formatDate(value: string) {
  return normalizeDateOnlyText(value) || value;
}

function buildStatementParseContent(mail: MailDetail) {
  const attachmentText = mail.attachments
    ?.filter((attachment) => attachment.text?.trim())
    .map((attachment) => `【附件：${attachment.filename || "未命名 PDF"}】\n${attachment.text!.trim()}`)
    .join("\n\n");
  return [mail.html?.trim() || mail.text?.trim(), attachmentText]
    .filter((part) => part && part.trim())
    .join("\n\n");
}

function sameMail(a: Pick<MailItem, "emailAccountId" | "uid">, b: Pick<MailItem, "emailAccountId" | "uid">) {
  return a.emailAccountId === b.emailAccountId && a.uid === b.uid;
}

function normalizeParsedItem(item: ParsedItem, accountName: string): ParsedItem {
  const amount = Math.abs(Number(item.amount ?? 0));
  const parsedAccountName = item.account?.trim() || accountName;
  const date = item.date?.trim() || undefined;
  const postedDate = normalizeDateOnlyText(item.postedDate) || normalizeDateOnlyText(date) || undefined;
  if (item.type === "transfer") {
    return {
      ...item,
      date,
      amount,
      account: parsedAccountName,
      toAccount: item.toAccount?.trim() || parsedAccountName,
      fromAccount: item.fromAccount?.trim() || undefined,
      postedDate,
      remark: item.remark?.trim() || item.rawText,
    };
  }
  return {
    ...item,
    date,
    amount,
    account: parsedAccountName,
    postedDate,
    remark: item.remark?.trim() || item.rawText,
  };
}

function canImportItem(item: ParsedItem) {
  if (!item.date?.trim()) return false;
  if (!Number.isFinite(item.amount) || item.amount <= 0) return false;
  if (item.type === "transfer") return Boolean(item.fromAccount?.trim() && item.toAccount?.trim());
  return true;
}

export function CreditBillMailImportButton({
  accountId,
  accountName,
}: {
  accountId?: string;
  accountName: string;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const tf = (key: string, values: Record<string, string | number>) => {
    let text: string = t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
  const [open, setOpen] = useState(false);
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [selectedEmailAccountId, setSelectedEmailAccountId] = useState("");
  const [mails, setMails] = useState<MailItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchingUid, setFetchingUid] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [parsed, setParsed] = useState<ParseState | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSelectedKeys, setPreviewSelectedKeys] = useState<Set<number>>(new Set());
  const [importComplete, setImportComplete] = useState<{ created: number; skipped: number; accountText: string } | null>(null);

  const importableItems = useMemo(
    () => parsed?.items.filter(canImportItem) ?? [],
    [parsed],
  );
  const previewRows = useMemo(
    () => parsed?.items.map((item, key) => ({ key, item, ready: canImportItem(item) })) ?? [],
    [parsed],
  );
  const selectedPreviewItems = useMemo(
    () => previewRows
      .filter((row) => row.ready && previewSelectedKeys.has(row.key))
      .map((row) => row.item),
    [previewRows, previewSelectedKeys],
  );
  const allImportablePreviewSelected =
    importableItems.length > 0 &&
    previewRows.filter((row) => row.ready).every((row) => previewSelectedKeys.has(row.key));

  async function openAndLoad() {
    setOpen(true);
    setPreviewOpen(false);
    setPreviewSelectedKeys(new Set());
    setError("");
    setInfo("");
    setParsed(null);
    setMails([]);
    setEmailAccounts([]);
    await loadEmailAccounts();
  }

  async function loadEmailAccounts() {
    setLoading(true);
    setError("");
    setInfo("");
    setParsed(null);
    setMails([]);
    try {
      const accountRes = await fetch("/api/v1/settings/email-accounts", { cache: "no-store" });
      const accountData = await accountRes.json();
      if (!accountData.ok) throw new Error(accountData.error || t("creditBill.readEmailAccountsFailed"));
      const nextAccounts: EmailAccount[] = Array.isArray(accountData.accounts) ? accountData.accounts : [];
      setEmailAccounts(nextAccounts);
      if (nextAccounts.length === 0) {
        setSelectedEmailAccountId("");
        setMails([]);
        setInfo(t("creditBill.noEmailAccounts"));
        return;
      }

      const rememberedAccountId = readLastWorkingEmailAccountId();
      const rememberedAccount = nextAccounts.find((account) => account.id === rememberedAccountId);
      const defaultAccount = rememberedAccount ?? nextAccounts[0];
      setSelectedEmailAccountId(defaultAccount?.id ?? "");
      if (nextAccounts.length === 1) {
        setInfo(`已选择邮箱：${defaultAccount?.label || defaultAccount?.username}，正在读取账单邮件。`);
        await loadMailsForAccount(defaultAccount!);
        return;
      }

      setInfo(rememberedAccount
        ? `已默认选中上次可正常获取的邮箱：${rememberedAccount.label || rememberedAccount.username}，请确认后读取。`
        : "请选择一个邮箱读取账单邮件。");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("creditBill.readMailFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function loadMailsForAccount(account: EmailAccount) {
    setSelectedEmailAccountId(account.id);
    setLoading(true);
    setError("");
    setInfo("");
    setParsed(null);
    setMails([]);
    try {
      const res = await fetch("/api/v1/email/imap/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          keywords: BILL_MAIL_KEYWORDS,
          limit: 30,
          scanLimit: 800,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || t("creditBill.readFailed"));
      const nextMails: MailItem[] = (Array.isArray(data.items) ? data.items : [])
        .map((item: Omit<MailItem, "emailAccountId" | "emailAccountLabel">) => ({
          ...item,
          emailAccountId: account.id,
          emailAccountLabel: account.label || account.username,
        }))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 30);
      const markedMails = await markImportedMails(nextMails);
      setMails(markedMails);
      writeLastWorkingEmailAccountId(account.id);
      if (nextMails.length === 0) {
        setInfo(t("creditBill.noMatchedMail"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("creditBill.readMailFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function markImportedMails(nextMails: MailItem[]) {
    if (nextMails.length === 0) return nextMails;
    try {
      const res = await fetch("/api/v1/statement/imported-mail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mails: nextMails.map((mail) => ({
            emailAccountId: mail.emailAccountId,
            uid: mail.uid,
            hash: mail.hash,
          })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok || !Array.isArray(data.imported)) return nextMails;
      const importedMap = new Map<string, { createdAt?: string }>();
      const importedHashMap = new Map<string, { createdAt?: string }>();
      for (const item of data.imported) {
        if (item?.emailAccountId && item?.uid) {
          importedMap.set(`${item.emailAccountId}:${item.uid}`, { createdAt: item.createdAt });
        }
        if (item?.hash) {
          importedHashMap.set(item.hash, { createdAt: item.createdAt });
        }
      }
      return nextMails.map((mail) => {
        const imported = importedMap.get(`${mail.emailAccountId}:${mail.uid}`) || (mail.hash ? importedHashMap.get(mail.hash) : undefined);
        return imported ? { ...mail, imported: true, importedAt: imported.createdAt } : mail;
      });
    } catch {
      // The mail list itself is still useful if local import markers cannot be read.
      return nextMails;
    }
  }

  async function loadSelectedAccountMails() {
    const account = emailAccounts.find((item) => item.id === selectedEmailAccountId);
    if (!account) {
      setInfo("请先选择一个邮箱。");
      return;
    }
    await loadMailsForAccount(account);
  }

  async function fetchAndParse(mail: MailItem) {
    setFetchingUid(mail.uid);
    setPreviewOpen(false);
    setPreviewSelectedKeys(new Set());
    setError("");
    setInfo(mail.imported ? "这封账单邮件已经导入过，本次仍可重新预览并再次导入。" : "");
    setImportComplete(null);
    setParsed(null);
    try {
      const fetchRes = await fetch("/api/v1/email/imap/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: mail.emailAccountId, uid: mail.uid }),
      });
      const fetchData = await fetchRes.json();
      if (!fetchData.ok) throw new Error(fetchData.error || t("creditBill.readMailContentFailed"));
      writeLastWorkingEmailAccountId(mail.emailAccountId);
      const content = buildStatementParseContent(fetchData.item);
      if (!content) throw new Error(t("creditBill.emptyMailContent"));

      const parseRes = await fetch("/api/v1/statement/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: content }),
      });
      const parseData = await parseRes.json();
      if (!parseData.ok) throw new Error(parseData.error || t("creditBill.parseFailed"));
      const items = (Array.isArray(parseData.items) ? parseData.items : [])
        .map((item: ParsedItem) => normalizeParsedItem(item, accountName))
        .filter((item: ParsedItem) => item.amount > 0);
      setParsed({ mail, items });
      if (items.length === 0) setInfo(t("creditBill.noItemsInMail"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("creditBill.parseFailed"));
    } finally {
      setFetchingUid(null);
    }
  }

  function openImportPreview() {
    if (!parsed || importableItems.length === 0 || importing || importComplete) return;
    setError("");
    setImportComplete(null);
    setPreviewSelectedKeys(new Set(previewRows.filter((row) => row.ready).map((row) => row.key)));
    setPreviewOpen(true);
  }

  function togglePreviewRow(key: number) {
    const row = previewRows.find((item) => item.key === key);
    if (!row?.ready) return;
    setPreviewSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllPreviewRows() {
    if (allImportablePreviewSelected) {
      setPreviewSelectedKeys(new Set());
      return;
    }
    setPreviewSelectedKeys(new Set(previewRows.filter((row) => row.ready).map((row) => row.key)));
  }

  function updatePreviewItem(key: number, patch: Partial<ParsedItem>) {
    setParsed((current) => {
      if (!current) return current;
      return {
        ...current,
        items: current.items.map((item, index) => {
          if (index !== key) return item;
          return {
            ...item,
            ...patch,
            postedDate: "postedDate" in patch
              ? (normalizeDateOnlyText(patch.postedDate) || undefined)
              : item.postedDate,
          };
        }),
      };
    });
  }

  async function importParsed() {
    if (!parsed || selectedPreviewItems.length === 0 || importing || importComplete) return;
    setImporting(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/v1/statement/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: selectedPreviewItems,
          defaultAccountName: accountName,
          autoCreateAccounts: false,
          mailSource: {
            emailAccountId: parsed.mail.emailAccountId,
            uid: parsed.mail.uid,
            hash: parsed.mail.hash,
            subject: parsed.mail.subject,
            from: parsed.mail.from,
            date: parsed.mail.date,
          },
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || t("creditBill.importFailed"));
      const skippedCount = data.skippedCount ?? 0;
      const firstError = Array.isArray(data.errors) ? data.errors[0]?.error : "";
      const createdAccounts = Array.isArray(data.createdAccounts) ? data.createdAccounts : [];
      const accountText = createdAccounts.length
        ? ` 已自动创建账户：${createdAccounts.map((account: any) => `${account.institutionName ? `${account.institutionName}·` : ""}${account.name}`).join("、")}。`
        : "";
      if (skippedCount > 0) {
        setError(firstError ? `有 ${skippedCount} 条未导入：${firstError}` : `有 ${skippedCount} 条未导入，请检查账户匹配。`);
      }
      const createdCount = data.createdCount ?? 0;
      setInfo(`${tf("creditBill.importDone", { created: createdCount, skipped: skippedCount })}${accountText}`);
      setImportComplete({ created: createdCount, skipped: skippedCount, accountText });
      if (createdCount > 0) {
        const importedMail = parsed.mail;
        setMails((prev) => prev.map((mail) => sameMail(mail, importedMail)
          ? { ...mail, imported: true, importedAt: new Date().toISOString() }
          : mail));
      }
      dispatchFinanceDataChanged({ reason: "credit-bill-mail-import" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("creditBill.importFailed"));
    } finally {
      setImporting(false);
    }
  }

  function confirmImportComplete() {
    setParsed(null);
    setPreviewOpen(false);
    setPreviewSelectedKeys(new Set());
    setImportComplete(null);
    setOpen(false);
    dispatchFinanceDataChanged({ reason: "credit-bill-mail-import", accountIds: accountId ? [accountId] : undefined });
    if (accountId) router.push(`/?accountId=${encodeURIComponent(accountId)}&view=bill`);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        onClick={openAndLoad}
        className="h-7 px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-blue-50 hover:text-blue-700 inline-flex items-center gap-1.5"
        title={t("creditBill.fetchMailTitle")}
      >
        <MailSearch className="h-3.5 w-3.5" />
        {t("creditBill.fetch")}
      </button>

      {open && typeof document !== "undefined" ? createPortal(
        <div className="fixed inset-0 z-[90] flex items-start justify-center bg-slate-900/25 px-4 py-[8vh]">
          <div className="flex max-h-[84vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">{t("creditBill.fetchMailTitle")}</div>
                <div className="mt-0.5 truncate text-xs text-slate-500">
                  {t("creditBill.findingAllBills")}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={emailAccounts.length > 0 ? loadSelectedAccountMails : loadEmailAccounts}
                  disabled={loading || (emailAccounts.length > 0 && !selectedEmailAccountId)}
                  className="secondary-button h-8 px-3 text-xs"
                >
                  <RefreshCw className={`mr-1 inline h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                  {emailAccounts.length > 0 ? "读取邮件" : "读取邮箱列表"}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  title={t("creditBill.close")}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(280px,0.9fr)] gap-0">
              <div className="min-h-0 overflow-auto border-r border-slate-100">
                {emailAccounts.length > 1 ? (
                  <div className="border-b border-slate-100 bg-slate-50/70 px-3 py-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-slate-700">选择邮箱</div>
                      <div className="text-[11px] text-slate-400">选择后点读取邮件</div>
                    </div>
                    <div className="space-y-1.5">
                      {emailAccounts.map((account) => {
                        const selected = selectedEmailAccountId === account.id;
                        const remembered = readLastWorkingEmailAccountId() === account.id;
                        return (
                          <button
                            key={account.id}
                            type="button"
                            onClick={() => {
                              setSelectedEmailAccountId(account.id);
                              setMails([]);
                              setParsed(null);
                              setInfo(`已选择邮箱：${account.label || account.username}，点击“读取邮件”开始查询。`);
                            }}
                            disabled={loading}
                            className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs transition ${
                              selected
                                ? "border-blue-200 bg-blue-50 text-blue-700"
                                : "border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:bg-blue-50/60"
                            } disabled:opacity-60`}
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{account.label || account.username}</span>
                              <span className="block truncate text-[11px] text-slate-400">{account.username}</span>
                            </span>
                            {remembered ? <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">上次可用</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                {loading ? (
                  <div className="px-4 py-10 text-center text-sm text-slate-400">{t("creditBill.loadingMail")}</div>
                ) : mails.length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-slate-400">{t("creditBill.noMatchedMail")}</div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {mails.map((mail) => {
                      const active = parsed?.mail.emailAccountId === mail.emailAccountId && parsed.mail.uid === mail.uid;
                      return (
                        <button
                          key={`${mail.emailAccountId}:${mail.uid}`}
                          type="button"
                          onClick={() => fetchAndParse(mail)}
                          disabled={fetchingUid === mail.uid}
                          className={`block w-full px-4 py-3 text-left hover:bg-blue-50/60 ${active ? "bg-blue-50" : mail.imported ? "bg-emerald-50/30" : ""}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium text-slate-800">{mail.subject || t("creditBill.noSubject")}</span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              {mail.imported ? <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">已导入</span> : null}
                              <span className="text-[11px] text-slate-400">{formatDate(mail.date)}</span>
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                            <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5">{mail.emailAccountLabel}</span>
                            <span className="truncate">{mail.from || t("creditBill.unknownSender")}</span>
                          </div>
                          {mail.imported ? <div className="mt-1 text-[11px] text-emerald-700">本地已有导入记录，可再次导入</div> : null}
                          {fetchingUid === mail.uid ? <div className="mt-1 text-[11px] text-blue-600">{t("creditBill.readingAndParsing")}</div> : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex min-h-0 flex-col">
                <div className="border-b border-slate-100 px-4 py-3">
                  <div className="text-xs font-semibold text-slate-700">{t("creditBill.parseResult")}</div>
                  <div className="mt-0.5 text-[11px] text-slate-400">
                    {parsed ? tf("creditBill.parseCount", { total: parsed.items.length, importable: importableItems.length }) : t("creditBill.pickMail")}
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
                  {parsed ? (
                    parsed.items.length > 0 ? (
                      <div className="space-y-2">
                        {parsed.items.slice(0, 12).map((item, index) => {
                          const ready = canImportItem(item);
                          return (
                            <div key={`${item.date ?? ""}:${item.amount}:${index}`} className={`rounded-lg border px-3 py-2 text-xs ${ready ? "border-slate-200 bg-white" : "border-amber-200 bg-amber-50"}`}>
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium text-slate-700">{item.date || t("creditBill.noDate")} · {item.type === "income" ? t("creditBill.income") : item.type === "transfer" ? t("creditBill.transfer") : t("creditBill.expense")}</span>
                                <span className="tabular-nums text-slate-700">{item.amount.toFixed(2)}</span>
                              </div>
                              <div className="mt-1 truncate text-slate-500">{item.counterparty || item.institution || item.remark || item.rawText}</div>
                              {!ready ? <div className="mt-1 text-amber-700">{t("creditBill.missingImportFields")}</div> : null}
                            </div>
                          );
                        })}
                        {parsed.items.length > 12 ? <div className="text-center text-[11px] text-slate-400">{tf("creditBill.previewOnly", { count: 12 })}</div> : null}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-slate-200 px-3 py-8 text-center text-sm text-slate-400">{t("creditBill.noDetails")}</div>
                    )
                  ) : (
                    <div className="rounded-lg border border-dashed border-slate-200 px-3 py-8 text-center text-sm text-slate-400">{t("creditBill.pickMailHint")}</div>
                  )}
                </div>

                {(error || info) ? (
                  <div className="border-t border-slate-100 px-4 py-2 text-xs">
                    {error ? <div className="text-red-600">{error}</div> : null}
                    {info ? <div className="text-slate-500">{info}</div> : null}
                  </div>
                ) : null}

                <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-3">
                  <button type="button" onClick={() => setOpen(false)} className="secondary-button h-8 px-3 text-xs">
                    {t("creditBill.close")}
                  </button>
                  <button
                    type="button"
                    onClick={openImportPreview}
                    disabled={!parsed || importableItems.length === 0 || importing || Boolean(importComplete)}
                    className="primary-button h-8 px-3 text-xs disabled:opacity-50"
                  >
                    {tf("creditBill.openImportPreview", { count: importableItems.length })}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {previewOpen && parsed && typeof document !== "undefined" ? createPortal(
        <div className="fixed inset-0 z-[100] flex items-start justify-center bg-slate-900/35 px-4 py-[6vh]">
          <div className="flex max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">{t("creditBill.importPreviewTitle")}</div>
                <div className="mt-0.5 truncate text-xs text-slate-500">{t("creditBill.importPreviewDesc")}</div>
              </div>
              <button
                type="button"
                onClick={() => importComplete ? confirmImportComplete() : setPreviewOpen(false)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                title={t("creditBill.close")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              <table className="min-w-full border-separate border-spacing-0 text-xs">
                <thead className="sticky top-0 z-10 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="w-10 border-b border-r border-slate-200 px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={allImportablePreviewSelected}
                        onChange={toggleAllPreviewRows}
                        aria-label="全选可导入记录"
                      />
                    </th>
                    <th className="whitespace-nowrap border-b border-r border-slate-200 px-3 py-2 text-left">日期</th>
                    <th className="whitespace-nowrap border-b border-r border-slate-200 px-3 py-2 text-left">入账日期</th>
                    <th className="whitespace-nowrap border-b border-r border-slate-200 px-3 py-2 text-left">类型</th>
                    <th className="min-w-40 border-b border-r border-slate-200 px-3 py-2 text-left">账户</th>
                    <th className="min-w-36 border-b border-r border-slate-200 px-3 py-2 text-left">分类/对手方</th>
                    <th className="whitespace-nowrap border-b border-r border-slate-200 px-3 py-2 text-right">金额</th>
                    <th className="min-w-56 border-b border-r border-slate-200 px-3 py-2 text-left">备注</th>
                    <th className="whitespace-nowrap border-b border-slate-200 px-3 py-2 text-left">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row) => {
                    const checked = previewSelectedKeys.has(row.key);
                    const item = row.item;
                    return (
                      <tr key={row.key} className={row.ready ? "bg-white hover:bg-blue-50/40" : "bg-amber-50/60 text-amber-800"}>
                        <td className="border-b border-r border-slate-100 px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!row.ready}
                            onChange={() => togglePreviewRow(row.key)}
                            aria-label={`选择第 ${row.key + 1} 条记录`}
                          />
                        </td>
                        <td className="whitespace-nowrap border-b border-r border-slate-100 px-3 py-2">{item.date || "-"}</td>
                        <td className="whitespace-nowrap border-b border-r border-slate-100 px-3 py-2">
                          <DateStepper
                            value={normalizeDateOnlyText(item.postedDate) || normalizeDateOnlyText(item.date)}
                            onChange={(value) => updatePreviewItem(row.key, { postedDate: value || undefined })}
                            className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-blue-400"
                          />
                        </td>
                        <td className="whitespace-nowrap border-b border-r border-slate-100 px-3 py-2">
                          {item.type === "income" ? t("creditBill.income") : item.type === "transfer" ? t("creditBill.transfer") : t("creditBill.expense")}
                        </td>
                        <td className="border-b border-r border-slate-100 px-3 py-2">{item.account || accountName}</td>
                        <td className="border-b border-r border-slate-100 px-3 py-2">{item.category || item.counterparty || item.institution || "-"}</td>
                        <td className="whitespace-nowrap border-b border-r border-slate-100 px-3 py-2 text-right tabular-nums">{item.amount.toFixed(2)}</td>
                        <td className="max-w-72 border-b border-r border-slate-100 px-3 py-2">
                          <div className="truncate" title={item.remark || item.rawText}>{item.remark || item.rawText || "-"}</div>
                        </td>
                        <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2">
                          {row.ready ? <span className="text-emerald-700">可导入</span> : <span className="text-amber-700">缺少必要字段</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {(error || info) ? (
              <div className="border-t border-slate-100 px-4 py-2 text-xs">
                {error ? <div className="text-red-600">{error}</div> : null}
                {info ? <div className="text-slate-500">{info}</div> : null}
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
              <div className="text-xs text-slate-500">
                {importComplete
                  ? t("batchImport.importCompleteConfirmHint")
                  : tf("creditBill.importPreviewSelected", { selected: selectedPreviewItems.length, total: previewRows.length })}
              </div>
              <div className="flex items-center gap-2">
                {!importComplete && (
                  <button type="button" onClick={() => setPreviewOpen(false)} className="secondary-button h-8 px-3 text-xs">
                    {t("creditBill.close")}
                  </button>
                )}
                {importComplete ? (
                  <button
                    type="button"
                    onClick={confirmImportComplete}
                    className="primary-button h-8 px-3 text-xs"
                  >
                    {accountId ? t("batchImport.importCompleteOpenAccount") : t("common.ok")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={importParsed}
                    disabled={selectedPreviewItems.length === 0 || importing}
                    className="primary-button h-8 px-3 text-xs disabled:opacity-50"
                  >
                    {importing ? t("creditBill.importing") : tf("creditBill.confirmImport", { count: selectedPreviewItems.length })}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
