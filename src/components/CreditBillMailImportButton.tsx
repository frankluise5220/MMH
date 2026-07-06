"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { MailSearch, RefreshCw, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";

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

function formatDate(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
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
  if (item.type === "transfer") {
    return {
      ...item,
      amount,
      account: accountName,
      toAccount: item.toAccount?.trim() || accountName,
      fromAccount: item.fromAccount?.trim() || undefined,
      remark: item.remark?.trim() || item.rawText,
    };
  }
  return {
    ...item,
    amount,
    account: accountName,
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
  accountName,
  institutionName,
}: {
  accountName: string;
  institutionName?: string | null;
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
  const keyword = (institutionName || accountName || "").trim();
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

  const importableItems = useMemo(
    () => parsed?.items.filter(canImportItem) ?? [],
    [parsed],
  );

  async function openAndLoad() {
    setOpen(true);
    setError("");
    setInfo("");
    setParsed(null);
    setMails([]);
    setInfo("请选择“读取邮箱列表”，再选择邮箱读取账单邮件。");
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
          keyword,
          limit: 12,
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
        setInfo(tf("creditBill.noMailForKeyword", { keyword }));
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
          })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok || !Array.isArray(data.imported)) return nextMails;
      const importedMap = new Map<string, { createdAt?: string }>();
      for (const item of data.imported) {
        if (!item?.emailAccountId || !item?.uid) continue;
        importedMap.set(`${item.emailAccountId}:${item.uid}`, { createdAt: item.createdAt });
      }
      return nextMails.map((mail) => {
        const imported = importedMap.get(`${mail.emailAccountId}:${mail.uid}`);
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
    setError("");
    setInfo(mail.imported ? "这封账单邮件已经导入过，可以查看解析结果，但通常不需要重复导入。" : "");
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

  async function importParsed() {
    if (!parsed || importableItems.length === 0 || importing) return;
    if (parsed.mail.imported) {
      setInfo("这封账单邮件已经导入过，无需重复导入。");
      return;
    }
    setImporting(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/v1/statement/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: importableItems,
          defaultAccountName: accountName,
          autoCreateAccounts: false,
          mailSource: {
            emailAccountId: parsed.mail.emailAccountId,
            uid: parsed.mail.uid,
            subject: parsed.mail.subject,
            from: parsed.mail.from,
            date: parsed.mail.date,
          },
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || t("creditBill.importFailed"));
      setInfo(tf("creditBill.importDone", { created: data.createdCount ?? 0, skipped: data.skippedCount ?? 0 }));
      if ((data.createdCount ?? 0) > 0) {
        const importedMail = parsed.mail;
        setMails((prev) => prev.map((mail) => sameMail(mail, importedMail)
          ? { ...mail, imported: true, importedAt: new Date().toISOString() }
          : mail));
      }
      setParsed(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("creditBill.importFailed"));
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openAndLoad}
        className="h-7 px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-blue-50 hover:text-blue-700 inline-flex items-center gap-1.5"
        title={tf("creditBill.fetchTitle", { keyword: keyword ? `“${keyword}”` : "" })}
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
                  {tf("creditBill.findingMail", { keyword: keyword || accountName, account: accountName })}
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
                {emailAccounts.length > 0 ? (
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
                          {mail.imported ? <div className="mt-1 text-[11px] text-emerald-700">本地已有导入记录，无需重复导入</div> : null}
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
                    onClick={importParsed}
                    disabled={!parsed || parsed.mail.imported || importableItems.length === 0 || importing}
                    className="primary-button h-8 px-3 text-xs disabled:opacity-50"
                  >
                    {parsed?.mail.imported ? "已导入" : importing ? t("creditBill.importing") : tf("creditBill.confirmImport", { count: importableItems.length })}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
