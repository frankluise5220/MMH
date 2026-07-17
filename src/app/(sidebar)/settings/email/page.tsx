"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BatchReplaceFieldConfig, BatchReplaceOption } from "@/components/BatchReplacePopoverButton";
import { DateStepper } from "@/components/DateStepper";
import type { SmartSelectOption } from "@/components/SmartSelect";
import { useAccountSSFilter } from "@/components/accountSSFilter";
import { buildAccountDisplayOption, buildGroupedAccountOptions } from "@/lib/account-display";
import { createImportAccountResolver } from "@/lib/account-import-match";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { fetchSettingsBootstrap } from "@/lib/client/settingsCache";

type BatchReplacePopoverButtonComponent = typeof import("@/components/BatchReplacePopoverButton").BatchReplacePopoverButton;
type SmartSelectComponent = typeof import("@/components/SmartSelect").SmartSelect;
type TableColumnFilterComponent = typeof import("@/components/TableColumnFilter").TableColumnFilter;

const BatchReplacePopoverButton = dynamic(
  () => import("@/components/BatchReplacePopoverButton").then((mod) => mod.BatchReplacePopoverButton),
  { ssr: false },
) as BatchReplacePopoverButtonComponent;
const SmartSelect = dynamic(
  () => import("@/components/SmartSelect").then((mod) => mod.SmartSelect),
  { ssr: false },
) as SmartSelectComponent;
const TableColumnFilter = dynamic(
  () => import("@/components/TableColumnFilter").then((mod) => mod.TableColumnFilter),
  { ssr: false },
) as TableColumnFilterComponent;

const MAIL_DISPLAY_LIMIT = 5;
const MAIL_FIXED_KEYWORD = "账单";

const EMAIL_PROVIDER_PRESETS = [
  { key: "qq", label: "QQ邮箱", imapHost: "imap.qq.com", imapPort: "993", smtpHost: "smtp.qq.com", smtpPort: "465" },
  { key: "163", label: "网易163", imapHost: "imap.163.com", imapPort: "993", smtpHost: "smtp.163.com", smtpPort: "465" },
  { key: "126", label: "网易126", imapHost: "imap.126.com", imapPort: "993", smtpHost: "smtp.126.com", smtpPort: "465" },
  { key: "sohu", label: "搜狐邮箱", imapHost: "imap.sohu.com", imapPort: "993", smtpHost: "smtp.sohu.com", smtpPort: "465" },
  { key: "sina", label: "新浪邮箱", imapHost: "imap.sina.com", imapPort: "993", smtpHost: "smtp.sina.com", smtpPort: "465" },
  { key: "gmail", label: "Gmail", imapHost: "imap.gmail.com", imapPort: "993", smtpHost: "smtp.gmail.com", smtpPort: "587" },
] as const;

type Account = {
  id: string;
  label: string;
  username: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpFrom: string | null;
  mailbox: string;
  createdAt: string;
};

type BookAccount = {
  id: string;
  name: string;
  kind: string;
  institutionId?: string | null;
  userId?: string | null;
  groupId?: string | null;
  investProductType?: string | null;
  numberMasked?: string | null;
  creditLimit?: string | number | null;
  billingDay?: number | null;
  repaymentDay?: number | null;
  Institution?: { id?: string; name?: string | null; shortName?: string | null; type?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
};
type BookInstitution = { id: string; name: string; shortName?: string | null; type?: string | null };
type BookUser = { id: string; name: string };
type BookCategory = { id: string; name: string; type: string; parentId?: string | null };
type BookLookups = {
  accounts: BookAccount[];
  institutions: BookInstitution[];
  users: BookUser[];
  categories: BookCategory[];
};
type MailItem = { uid: number; subject: string; from: string; date: string };
type MailAttachment = { id: string; filename: string; contentType: string; size: number; text?: string; parseError?: string };
type MailDetail = { uid: number; subject: string; from: string; date: string; text: string; html: string; attachments?: MailAttachment[] };
type MailListMeta = {
  total: number;
  scanned: number;
  matched: number;
  limited: number;
  hasKeyword: boolean;
  scanLimit: number;
  sinceDate: string;
};
type ParsedItemMeta = {
  institutionName?: string;
  ownerName?: string;
  cardNumberMasked?: string;
  creditLimit?: number;
  billingDay?: number;
  repaymentDay?: number;
};
type ParsedItem = {
  rawText: string; type: "expense" | "income" | "transfer" | "investment";
  date?: string; amount: number; account?: string; fromAccount?: string; toAccount?: string; category?: string; remark?: string; counterparty?: string; institution?: string; postedDate?: string;
  _meta?: ParsedItemMeta;
};
type ImportPreviewColumn = "date" | "postedDate" | "type" | "account" | "counterAccount" | "category" | "institution" | "amount" | "remark" | "status";
type ImportPreviewEditableCell = "date" | "postedDate" | "type" | "account" | "counterAccount" | "category" | "institution" | "amount" | "remark";
type ImportPreviewItem = {
  key: string;
  item: ParsedItem;
  ready: boolean;
  missingFields: string[];
  matchedAccountId?: string;
  selectedAccountId?: string;
};
type ImportPreviewState = {
  items: ImportPreviewItem[];
  selectedKeys: Set<string>;
  selectAll: boolean;
  statementAccountId?: string;
};
const IMPORT_PREVIEW_FILTER_COLUMNS: ImportPreviewColumn[] = ["date", "postedDate", "type", "account", "counterAccount", "category", "institution", "amount", "remark", "status"];
const IMPORT_PREVIEW_FIELD_LABELS: Record<ImportPreviewEditableCell, string> = {
  date: "交易日",
  postedDate: "入账日期",
  type: "类型",
  account: "账户",
  counterAccount: "对手账户",
  category: "分类",
  institution: "收支机构",
  amount: "金额",
  remark: "备注",
};
const PREVIEW_TYPE_OPTIONS: Array<{ value: ParsedItem["type"]; label: string }> = [
  { value: "expense", label: "支出" },
  { value: "income", label: "收入" },
  { value: "transfer", label: "转账" },
  { value: "investment", label: "投资" },
];

function buildBookAccountDisplayOption(account: BookAccount) {
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
  });
}

function isPlaceholderText(value?: string | null) {
  const text = String(value ?? "").trim();
  return !text || /^[-—–]+$/.test(text) || text === "?";
}

function cleanOptionalText(value?: string | null) {
  const text = String(value ?? "").trim();
  return isPlaceholderText(text) ? undefined : text;
}

function normalizeDateOnlyText(value?: string | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const match = raw.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})(?:日)?/);
  if (!match) return raw.slice(0, 10);
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function stripPostingDateNote(value: string) {
  return value
    .replace(/[（(]\s*入账日(?:期)?\s*\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}\s*[)）]/g, "")
    .trim();
}

function inferKnownMerchant(item: ParsedItem) {
  const source = [item.institution, item.counterparty, item.remark, item.rawText]
    .map((value) => cleanOptionalText(value))
    .filter(Boolean)
    .join(" ");
  const normalizedSource = stripPostingDateNote(source);
  if (/美团外卖/.test(normalizedSource)) return { institution: "美团", counterparty: "美团外卖", category: "餐饮" };
  if (/(?:特约)?美团(?:平台)?商户?|美团/.test(normalizedSource)) return { institution: "美团", counterparty: "美团", category: "餐饮" };
  if (/拼多多|付费通/.test(source)) return { institution: "拼多多", counterparty: "拼多多", category: "购物" };
  if (/支付宝/.test(source)) return { institution: "支付宝", counterparty: "支付宝", category: "购物" };
  if (/微信支付|财付通/.test(source)) return { institution: "微信", counterparty: "微信支付", category: "购物" };
  if (/京东|网银在线/.test(source)) return { institution: "京东", counterparty: "京东", category: "购物" };
  return {};
}

function shouldTreatAsTransfer(item: ParsedItem) {
  const source = [item.remark, item.counterparty, item.category, item.rawText]
    .map((value) => cleanOptionalText(value))
    .filter(Boolean)
    .join(" ");
  return /转账|转帐|还款|信用卡还款/.test(source);
}

type AccountCreateDraft = {
  rowKey: string;
  name: string;
  kind: "bank_credit" | "bank_debit" | "cash" | "ewallet" | "other";
  institutionName: string;
  institutionId: string;
  ownerName: string;
  userId: string;
  numberMasked: string;
  creditLimit: string;
  billingDay: string;
  repaymentDay: string;
};

export default function EmailSettingsPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAccountModal, setShowAccountModal] = useState(false);

  // 邮箱账户表单
  const [providerKey, setProviderKey] = useState("");
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapSecure, setImapSecure] = useState(true);
  const [password, setPassword] = useState("");
  const [mailbox, setMailbox] = useState("INBOX");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [smtpFrom, setSmtpFrom] = useState("");

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // 邮件操作
  const [mailItems, setMailItems] = useState<MailItem[]>([]);
  const [loadingMails, setLoadingMails] = useState(false);
  const [selectedMail, setSelectedMail] = useState<MailDetail | null>(null);
  const [mailContent, setMailContent] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parsedItems, setParsedItems] = useState<ParsedItem[]>([]);
  const [importPreview, setImportPreview] = useState<ImportPreviewState | null>(null);
  const [bookAccounts, setBookAccounts] = useState<BookAccount[]>([]);
  const [bookInstitutions, setBookInstitutions] = useState<BookInstitution[]>([]);
  const [bookUsers, setBookUsers] = useState<BookUser[]>([]);
  const [bookCategories, setBookCategories] = useState<BookCategory[]>([]);
  const bookLookupsRef = useRef<BookLookups>({ accounts: [], institutions: [], users: [], categories: [] });
  const [accountDraft, setAccountDraft] = useState<AccountCreateDraft | null>(null);
  const [savingAccountDraft, setSavingAccountDraft] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importComplete, setImportComplete] = useState<{ created: number; skipped: number; accountId: string | null } | null>(null);
  const [mailRange, setMailRange] = useState("month");
  const [mailListHint, setMailListHint] = useState("");
  const [accountTested, setAccountTested] = useState(false);
  const [previewColumnFilters, setPreviewColumnFilters] = useState<Partial<Record<ImportPreviewColumn, string[]>>>({});
  const [activePreviewFilterColumn, setActivePreviewFilterColumn] = useState<ImportPreviewColumn | null>(null);
  const [editingPreviewCell, setEditingPreviewCell] = useState<{ rowKey: string; field: "postedDate" | "type" | "category" } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadAccounts(controller.signal);
    return () => controller.abort();
  }, []);

  async function loadAccounts(signal?: AbortSignal) {
    setLoadingAccounts(true);
    try {
      const res = await fetch("/api/v1/settings/email-accounts", { signal });
      const data = await res.json();
      if (data.ok) setAccounts(data.accounts);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    } finally {
      if (!signal?.aborted) setLoadingAccounts(false);
    }
  }

  async function loadBookLookups() {
    try {
      const bootstrap = await fetchSettingsBootstrap();
      const lookups: BookLookups = {
        accounts: Array.isArray(bootstrap.accounts) ? bootstrap.accounts as BookAccount[] : [],
        institutions: Array.isArray(bootstrap.institutions) ? bootstrap.institutions : [],
        users: Array.isArray(bootstrap.users) ? bootstrap.users : [],
        categories: Array.isArray(bootstrap.categories) ? bootstrap.categories : [],
      };
      bookLookupsRef.current = lookups;
      setBookAccounts(lookups.accounts);
      setBookInstitutions(lookups.institutions);
      setBookUsers(lookups.users);
      setBookCategories(lookups.categories);
      return lookups;
    } catch {}
    return bookLookupsRef.current;
  }

  function resetForm() {
    setEditingId(null); setProviderKey(""); setLabel(""); setUsername(""); setImapHost(""); setImapPort("993");
    setImapSecure(true); setPassword(""); setMailbox("INBOX");
    setSmtpHost(""); setSmtpPort("465"); setSmtpSecure(true); setSmtpFrom("");
    setTestResult("");
    setAccountTested(false);
  }

  function openCreateAccountModal() {
    resetForm();
    setError("");
    setInfo("");
    setShowAccountModal(true);
  }

  function closeAccountModal() {
    setShowAccountModal(false);
    resetForm();
  }

  function applyProviderPreset(key: string) {
    setProviderKey(key);
    const preset = EMAIL_PROVIDER_PRESETS.find((item) => item.key === key);
    if (!preset) return;
    setLabel((current) => current || preset.label);
    setImapHost(preset.imapHost);
    setImapPort(preset.imapPort);
    setImapSecure(true);
    setSmtpHost(preset.smtpHost);
    setSmtpPort(preset.smtpPort);
    setSmtpSecure(preset.smtpPort === "465");
    setSmtpFrom((current) => current || username.trim());
  }

  function editAccount(account: Account) {
    setEditingId(account.id);
    setShowAccountModal(true);
    setProviderKey("");
    setLabel(account.label);
    setUsername(account.username);
    setImapHost(account.imapHost);
    setImapPort(String(account.imapPort ?? 993));
    setImapSecure(account.imapSecure);
    setPassword("");
    setMailbox(account.mailbox || "INBOX");
    setSmtpHost(account.smtpHost ?? "");
    setSmtpPort(String(account.smtpPort ?? 465));
    setSmtpSecure(account.smtpPort == null ? true : account.smtpPort === 465);
    setSmtpFrom(account.smtpFrom ?? account.username);
    setTestResult("");
    setAccountTested(false);
    setError("");
    setInfo("修改邮箱账户时，如不更换授权码，可留空。可先测试连接，测试通过后直接保存。");
  }

  function buildAccountBody(requirePassword: boolean) {
    const trimmedUsername = username.trim();
    const body: Record<string, unknown> = {
      accountId: editingId ?? undefined,
      label: label.trim(),
      username: trimmedUsername,
      imapHost: imapHost.trim(),
      imapPort: Number(imapPort) || 993,
      imapSecure,
      mailbox: mailbox.trim() || "INBOX",
      outboundType: "smtp",
      smtpHost: smtpHost.trim(),
      smtpPort: Number(smtpPort) || 465,
      smtpSecure,
      smtpFrom: (smtpFrom.trim() || trimmedUsername),
    };
    if (password.trim() || requirePassword) body.password = password.trim();
    return body;
  }

  async function runAccountConnectionTest(body: Record<string, unknown>) {
    const res = await fetch("/api/v1/settings/email-accounts/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? "测试失败");
    return Array.isArray(data.results) ? data.results.join("; ") : "测试通过";
  }

  async function saveAccount() {
    if (!label.trim() || !username.trim() || !imapHost.trim() || (!editingId && !password.trim())) {
      setError(editingId ? "请填写标签名、用户名和 IMAP 服务器" : "请填写标签名、用户名、IMAP 服务器和授权码");
      return;
    }
    setSaving(true); setError(""); setInfo(""); setTestResult("");
    try {
      const body = buildAccountBody(!editingId);
      const res = await fetch("/api/v1/settings/email-accounts", {
        method: editingId ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingId ? { id: editingId, ...body } : body),
      });
      const data = await res.json();
      if (data.ok) {
        setInfo("邮箱账户已保存");
        closeAccountModal();
        loadAccounts();
      } else {
        setError(data.error ?? "保存失败");
      }
    } catch (e) { setError(e instanceof Error ? e.message : "网络错误"); }
    finally { setSaving(false); }
  }

  async function deleteAccount(id: string) {
    if (!confirm("确定删除此邮箱账户？")) return;
    try {
      await fetch("/api/v1/settings/email-accounts", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (selectedId === id) { setSelectedId(null); setMailItems([]); setSelectedMail(null); }
      loadAccounts();
    } catch {}
  }

  async function testConnection() {
    if (!imapHost.trim() || !username.trim() || (!editingId && !password.trim())) {
      setError(editingId ? "请填写 IMAP 配置；如要重新测试密码，请填写授权码" : "请填写 IMAP 配置和授权码"); return;
    }
    setTesting(true); setTestResult(""); setError("");
    try {
      const message = await runAccountConnectionTest(buildAccountBody(!editingId));
      setTestResult(`测试通过: ${message}`);
      setAccountTested(true);
    } catch (e) { setError(e instanceof Error ? e.message : "网络错误"); }
    finally { setTesting(false); }
  }

  function buildMailListHint(meta: MailListMeta | undefined, itemCount: number) {
    if (!meta) return "";
    const scope = meta.sinceDate ? `自 ${meta.sinceDate} 起` : `最近 ${meta.scanLimit} 封内`;
    if (itemCount > 0) {
      return `${scope}扫描 ${meta.scanned} 封，按“${MAIL_FIXED_KEYWORD}”匹配到 ${meta.matched} 封，当前展示 ${itemCount} 封。`;
    }
    return `${scope}扫描 ${meta.scanned} 封，没有找到主题或发件人包含“${MAIL_FIXED_KEYWORD}”的邮件。`;
  }

  function monthAgoDateString() {
    const date = new Date();
    date.setMonth(date.getMonth() - 1);
    return date.toISOString().slice(0, 10);
  }

  function scanLimitForRange() {
    if (mailRange === "50") return 50;
    if (mailRange === "100") return 100;
    if (mailRange === "500") return 500;
    if (mailRange === "1000") return 1000;
    return 500;
  }

  async function listMails(accountId = selectedId) {
    if (!accountId) return;
    setLoadingMails(true); setError(""); setSelectedMail(null); setMailListHint(""); setParsedItems([]); setImportPreview(null); setImportComplete(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch("/api/v1/email/imap/list", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          limit: MAIL_DISPLAY_LIMIT,
          scanLimit: scanLimitForRange(),
          sinceDate: mailRange === "month" ? monthAgoDateString() : undefined,
          keyword: MAIL_FIXED_KEYWORD,
        }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.ok) {
        setMailItems(data.items);
        setMailListHint(buildMailListHint(data.meta, Array.isArray(data.items) ? data.items.length : 0));
      }
      else setError(data.error ?? "读取失败");
    } catch (e) {
      setError(e instanceof DOMException && e.name === "AbortError" ? "读取超时，请检查 IMAP 配置、授权码或网络连接" : "网络错误");
    }
    finally {
      clearTimeout(timer);
      setLoadingMails(false);
    }
  }

  function buildStatementParseContent(mail: MailDetail | null, fallbackContent = "") {
    const attachmentText = mail?.attachments
      ?.filter((attachment) => attachment.text?.trim())
      .map((attachment) => `【附件：${attachment.filename || "未命名 PDF"}】\n${attachment.text!.trim()}`)
      .join("\n\n");
    return [mail?.html?.trim() || fallbackContent.trim(), attachmentText]
      .filter((part) => part && part.trim())
      .join("\n\n");
  }

  async function fetchMail(uid: number, autoParse = false) {
    if (!selectedId) return;
    setLoadingMails(true); setError(""); setParsedItems([]); setImportPreview(null); setImportComplete(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch("/api/v1/email/imap/fetch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: selectedId, uid }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.ok) {
        setSelectedMail(data.item);
        setMailContent(data.item.text || data.item.html || "");
        if (autoParse) await parseMail(data.item, true);
      } else setError(data.error ?? "获取失败");
    } catch (e) {
      setError(e instanceof DOMException && e.name === "AbortError" ? "读取邮件内容超时，请稍后重试" : "网络错误");
    }
    finally {
      clearTimeout(timer);
      setLoadingMails(false);
    }
  }

  async function parseMail(mail = selectedMail, autoOpenPreview = false) {
    const sourceContent = buildStatementParseContent(mail, mail === selectedMail ? mailContent : (mail?.text || mail?.html || ""));
    if (!sourceContent) { setError("无邮件内容"); return; }
    setParsing(true); setError("");
    setImportComplete(null);
    try {
      const res = await fetch("/api/v1/statement/parse", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sourceContent }),
      });
      const data = await res.json();
      if (data.ok) {
        const items = Array.isArray(data.items) ? data.items.map(normalizeItemForImport) : [];
        setParsedItems(items);
        if (autoOpenPreview) {
          if (items.length > 0) {
            await loadBookLookups();
            openImportPreview(items);
          }
          else setError("这封邮件没有识别到账单明细，请换一封或检查附件内容。");
        }
      }
      else setError(data.error ?? "解析失败");
    } catch { setError("网络错误"); }
    finally { setParsing(false); }
  }

  async function importItems() {
    if (importComplete) return;
    const sourceItems = importPreview
      ? importPreview.items
          .filter((row) => importPreview.selectedKeys.has(row.key))
          .map((row) => {
            const statementAccountName = selectedPreviewAccountName(row) ?? row.item.account;
            if (row.item.type === "transfer") {
              return {
                ...row.item,
                account: statementAccountName,
                fromAccount: cleanOptionalText(row.item.fromAccount) ?? cleanOptionalText(row.item.toAccount),
                toAccount: statementAccountName,
              };
            }
            return { ...row.item, account: statementAccountName };
          })
      : parsedItems;
    if (!sourceItems.length) return;
    const selectedAccountIds = importPreview
      ? Array.from(new Set(importPreview.items
          .filter((row) => importPreview.selectedKeys.has(row.key))
          .map((row) => row.selectedAccountId ?? row.matchedAccountId ?? importPreview.statementAccountId)
          .filter((id): id is string => Boolean(id))))
      : [];
    const targetAccountId = selectedAccountIds.length === 1 ? selectedAccountIds[0] : null;
    setImporting(true); setError("");
    setImportComplete(null);
    try {
      const res = await fetch("/api/v1/statement/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: sourceItems, autoCreateAccounts: false }),
      });
      const data = await res.json();
      if (data.ok) {
        const createdAccounts = Array.isArray(data.createdAccounts) ? data.createdAccounts : [];
        const accountText = createdAccounts.length
          ? `；已自动创建账户：${createdAccounts.map((account: any) => `${account.institutionName ? `${account.institutionName}·` : ""}${account.name}`).join("、")}`
          : "";
        const createdCount = data.createdCount ?? 0;
        const skippedCount = data.skippedCount ?? 0;
        setInfo(`导入完成: 创建 ${createdCount} 条, 跳过 ${skippedCount} 条${accountText}`);
        if ((data.skippedCount ?? 0) > 0) {
          const firstError = Array.isArray(data.errors) ? data.errors[0]?.error : "";
          setError(firstError ? `有 ${data.skippedCount} 条未导入：${firstError}` : `有 ${data.skippedCount} 条未导入，请检查账户匹配。`);
        }
        setImportComplete({ created: createdCount, skipped: skippedCount, accountId: targetAccountId });
        dispatchFinanceDataChanged({ reason: "email-bill-import", accountIds: targetAccountId ? [targetAccountId] : undefined });
      }
      else setError(data.error ?? "导入失败");
    } catch { setError("网络错误"); }
    finally { setImporting(false); }
  }

  function confirmImportComplete() {
    const targetAccountId = importComplete?.accountId ?? null;
    setParsedItems([]);
    setImportPreview(null);
    setImportComplete(null);
    dispatchFinanceDataChanged({ reason: "email-bill-import", accountIds: targetAccountId ? [targetAccountId] : undefined });
    if (targetAccountId) {
      const account = bookAccounts.find((item) => item.id === targetAccountId);
      const view = account?.kind === "bank_credit" ? "bill" : "detail";
      router.push(`/?accountId=${encodeURIComponent(targetAccountId)}&view=${view}`);
    }
    router.refresh();
  }

  const selectedAccount = accounts.find(a => a.id === selectedId);

  function selectAccountForMail(accountId: string) {
    setSelectedId(accountId);
    setMailItems([]);
    setMailListHint("");
    setSelectedMail(null);
    setParsedItems([]);
    setImportPreview(null);
  }

  function buildMailPreviewHtml(mail: MailDetail) {
    const html = mail.html?.trim();
    if (html) {
      return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;padding:12px;background:#fff;color:#0f172a;font:13px/1.5 sans-serif;}img{max-width:100%;height:auto;}table{max-width:100%;}a{color:#2563eb;}</style></head><body>${html}</body></html>`;
    }
    const escaped = (mail.text || "无内容")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:12px;background:#fff;color:#334155;font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;}</style></head><body>${escaped}</body></html>`;
  }

  function isRowReadyForImport(item: ParsedItem) {
    const amountAbs = Math.abs(item.amount ?? 0);
    if (!Number.isFinite(amountAbs) || amountAbs <= 0) return false;
    if (item.type === "transfer") return !!(item.fromAccount?.trim() && (item.account?.trim() || item.toAccount?.trim() || item._meta?.institutionName));
    return !!(item.account?.trim() || item._meta?.institutionName);
  }

  function getMissingFields(item: ParsedItem) {
    const missing: string[] = [];
    if (!item.date?.trim()) missing.push("日期");
    if (!(item.amount > 0)) missing.push("金额");
    if (item.type === "transfer") {
      if (!item.account?.trim() && !item.toAccount?.trim() && !item._meta?.institutionName) missing.push("账户");
      if (!item.fromAccount?.trim()) missing.push("对手账户");
    } else if (!item.account?.trim() && !item._meta?.institutionName) {
      missing.push("账户");
    }
    return missing;
  }

  function accountNameFromId(accountId?: string | null) {
    if (!accountId) return undefined;
    return bookAccounts.find((account) => account.id === accountId)?.name;
  }

  function guessDebitTransferAccountName(item: ParsedItem) {
    const source = [item.remark, item.counterparty, item.category, item.rawText]
      .map((value) => cleanOptionalText(value))
      .filter(Boolean)
      .join(" ");
    const sourceKey = normalizedKey(source);
    if (!sourceKey) return undefined;

    const debitAccounts = bookAccounts.filter((account) => account.kind === "bank_debit");
    for (const account of debitAccounts) {
      const accountKeys = [
        account.name,
        stripOwnerPrefix(account.name),
        account.Institution?.name,
        account.Institution?.shortName,
      ].map(normalizedKey).filter((key) => key.length >= 2);
      if (accountKeys.some((key) => sourceKey.includes(key))) return account.name;
    }

    const digitSource = source.replace(/\D/g, "");
    const last4Matches = debitAccounts.filter((account) => {
      const last4 = String(account.numberMasked ?? "").replace(/\D/g, "");
      return last4.length >= 4 && digitSource.includes(last4);
    });
    if (last4Matches.length === 1) return last4Matches[0].name;

    const institutionMatches = debitAccounts.filter((account) => {
      const institutionKeys = [account.Institution?.name, account.Institution?.shortName]
        .map(normalizedKey)
        .filter((key) => key.length >= 2);
      return institutionKeys.some((key) => sourceKey.includes(key));
    });
    return institutionMatches.length === 1 ? institutionMatches[0].name : undefined;
  }

  function openDebitAccountDraft(rowKey: string) {
    setAccountDraft({
      rowKey,
      name: "",
      kind: "bank_debit",
      institutionName: "",
      institutionId: "",
      ownerName: "",
      userId: "",
      numberMasked: "",
      creditLimit: "",
      billingDay: "",
      repaymentDay: "",
    });
  }

  function primaryAccountNameForItem(item: ParsedItem, row?: ImportPreviewItem) {
    return (row ? selectedPreviewAccountName(row) : null) ?? cleanOptionalText(item.account) ?? cleanOptionalText(item.fromAccount);
  }

  function normalizeItemForImport(item: ParsedItem): ParsedItem {
    const merchant = inferKnownMerchant(item);
    const remark = cleanOptionalText(item.remark);
    const treatAsTransfer = item.type === "transfer" || shouldTreatAsTransfer(item);
    const date = item.date?.trim() || undefined;
    const postedDate = normalizeDateOnlyText(item.postedDate) ?? normalizeDateOnlyText(date);
    return {
      rawText: item.rawText,
      type: treatAsTransfer ? "transfer" : item.type,
      date,
      amount: Math.abs(item.amount ?? 0) || 0,
      account: cleanOptionalText(item.account),
      fromAccount: treatAsTransfer ? guessDebitTransferAccountName(item) : cleanOptionalText(item.fromAccount),
      toAccount: treatAsTransfer ? undefined : cleanOptionalText(item.toAccount),
      category: treatAsTransfer ? undefined : cleanOptionalText(item.category) || merchant.category,
      remark,
      counterparty: treatAsTransfer ? cleanOptionalText(item.counterparty) : cleanOptionalText(item.counterparty) || merchant.counterparty,
      institution: treatAsTransfer ? cleanOptionalText(item.institution) : cleanOptionalText(item.institution) || merchant.institution,
      postedDate,
      _meta: item._meta ? {
        institutionName: cleanOptionalText(item._meta.institutionName),
        ownerName: cleanOptionalText(item._meta.ownerName),
        cardNumberMasked: cleanOptionalText(item._meta.cardNumberMasked),
        creditLimit: item._meta.creditLimit,
        billingDay: item._meta.billingDay,
        repaymentDay: item._meta.repaymentDay,
      } : undefined,
    };
  }

  function openImportPreview(items: ParsedItem[]) {
    const normalizedItems = items.map((item) => ({
      ...item,
      postedDate: normalizeDateOnlyText(item.postedDate) ?? normalizeDateOnlyText(item.date),
    }));
    const baseRows = normalizedItems.map((item, index) => ({
      key: `mail-${index}-${item.date ?? ""}-${item.amount ?? 0}`,
      item,
      ready: isRowReadyForImport(item),
      missingFields: getMissingFields(item),
      ...resolvePreviewAccount(item),
    }));
    const accountIds = Array.from(new Set(baseRows.map((row) => row.selectedAccountId ?? row.matchedAccountId).filter(Boolean)));
    const statementAccountId = accountIds.length === 1 ? accountIds[0] : undefined;
    const rows = baseRows.map((row) => ({
      ...row,
      selectedAccountId: row.selectedAccountId ?? statementAccountId,
      matchedAccountId: row.matchedAccountId ?? statementAccountId,
      ready: row.ready && Boolean(row.selectedAccountId || row.matchedAccountId || statementAccountId),
      missingFields: row.ready && !row.selectedAccountId && !row.matchedAccountId && !statementAccountId
        ? [...row.missingFields, "账户"]
        : row.missingFields,
    }));
    setImportPreview({
      items: rows,
      selectedKeys: new Set(rows.filter((row) => row.ready).map((row) => row.key)),
      selectAll: rows.length > 0 && rows.every((row) => row.ready),
      statementAccountId,
    });
  }

  function updatePreviewRow(rowKey: string, patch: Partial<ParsedItem>, accountId?: string | null) {
    if (!importPreview) return;
    const nextItems = importPreview.items.map((row) =>
      row.key === rowKey ? recomputePreviewRow(row, patch, accountId) : row
    );
    setImportPreview(recomputePreviewState(nextItems));
    setParsedItems(nextItems.map((row) => row.item));
  }

  function togglePreviewItem(key: string) {
    if (!importPreview) return;
    const row = importPreview.items.find((item) => item.key === key);
    if (row && !row.ready && !importPreview.selectedKeys.has(key)) return;
    const selectedKeys = new Set(importPreview.selectedKeys);
    if (selectedKeys.has(key)) selectedKeys.delete(key);
    else selectedKeys.add(key);
    setImportPreview({ ...importPreview, selectedKeys, selectAll: selectedKeys.size === importPreview.items.length });
  }

  function togglePreviewAll() {
    if (!importPreview) return;
    const selectedKeys = new Set(importPreview.selectedKeys);
    const targetRows = filteredPreviewRows.length > 0 ? filteredPreviewRows : importPreview.items;
    const allFilteredSelected = targetRows.length > 0 && targetRows.every((row) => !row.ready || selectedKeys.has(row.key));
    for (const row of targetRows) {
      if (!row.ready) continue;
      if (!allFilteredSelected) selectedKeys.add(row.key);
      else selectedKeys.delete(row.key);
    }
    setImportPreview({ ...importPreview, selectedKeys, selectAll: importPreview.items.length > 0 && importPreview.items.filter((row) => row.ready).every((row) => selectedKeys.has(row.key)) });
  }

  function normalizedKey(value?: string | null) {
    return String(value ?? "").trim().replace(/[·•\-—_\s()[\]（）【】]/g, "").toLowerCase();
  }

  function isCreditStatement(item: ParsedItem) {
    return Boolean(item._meta?.institutionName || item._meta?.cardNumberMasked || /信用卡/.test(accountLabel(item)));
  }

  function resolvePreviewAccount(item: ParsedItem) {
    const accountsForMatch = bookLookupsRef.current.accounts;
    const label = accountLabel(item);
    const credit = isCreditStatement(item);
    const last4 = String(item._meta?.cardNumberMasked ?? "").trim();
    const bank = item._meta?.institutionName;
    const resolver = createImportAccountResolver(accountsForMatch);
    const candidates = Array.from(new Set([
      label,
      item.account,
      stripOwnerPrefix(label),
      bank && `${bank}信用卡`,
      bank && last4 ? `${bank}信用卡(${last4})` : "",
      bank && last4 ? `${bank}信用卡${last4}` : "",
    ].filter((value): value is string => Boolean(value?.trim()))));
    let found: BookAccount | null = null;
    for (const candidate of candidates) {
      const matched = resolver(candidate);
      if (!matched) continue;
      if (credit && matched.kind !== "bank_credit") continue;
      found = matched;
      break;
    }
    return { matchedAccountId: found?.id, selectedAccountId: found?.id };
  }

  function stripOwnerPrefix(value: string) {
    const match = value.trim().match(/^(.+?)的(.+)$/);
    return match?.[2]?.trim() || value.trim();
  }

  function previewAccountOptions(item: ParsedItem) {
    const credit = isCreditStatement(item);
    return previewAccountDisplayOptions.filter((account) => !credit || account.kind === "bank_credit");
  }

  function recomputePreviewState(items: ImportPreviewItem[]): ImportPreviewState {
    const selectedKeys = new Set(items.filter((row) => row.ready).map((row) => row.key));
    const accountIds = Array.from(new Set(items.map((row) => row.selectedAccountId ?? row.matchedAccountId).filter(Boolean)));
    return {
      items,
      selectedKeys,
      selectAll: items.length > 0 && selectedKeys.size === items.length,
      statementAccountId: accountIds.length === 1 ? accountIds[0] : importPreview?.statementAccountId,
    };
  }

  const selectedPreviewAccountName = useCallback((row: ImportPreviewItem) => {
    const accountId = row.selectedAccountId ?? row.matchedAccountId ?? importPreview?.statementAccountId;
    return bookAccounts.find((account) => account.id === accountId)?.name ?? null;
  }, [bookAccounts, importPreview?.statementAccountId]);
  const previewAccountDisplayOptions = useMemo(
    () => bookAccounts
      .map((account) => buildBookAccountDisplayOption(account))
      .sort((a, b) => a.selectorLabel.localeCompare(b.selectorLabel, "zh-Hans-CN")),
    [bookAccounts],
  );
  const previewAccountDisplayById = useMemo(
    () => new Map(previewAccountDisplayOptions.map((account) => [account.id, account])),
    [previewAccountDisplayOptions],
  );
  const previewAccountDisplayLabelById = useCallback((accountId?: string | null) => {
    if (!accountId) return null;
    const account = previewAccountDisplayById.get(accountId);
    return account?.selectorLabel ?? account?.label ?? null;
  }, [previewAccountDisplayById]);
  const previewAccountDisplayTitleById = useCallback((accountId?: string | null) => {
    if (!accountId) return null;
    const account = previewAccountDisplayById.get(accountId);
    return account?.hoverTitle ?? account?.selectorLabel ?? account?.label ?? null;
  }, [previewAccountDisplayById]);
  const selectedPreviewAccountDisplayLabel = useCallback((row: ImportPreviewItem) => {
    const accountId = row.selectedAccountId ?? row.matchedAccountId ?? importPreview?.statementAccountId;
    return previewAccountDisplayLabelById(accountId);
  }, [importPreview?.statementAccountId, previewAccountDisplayLabelById]);
  const selectedPreviewAccountDisplayTitle = useCallback((row: ImportPreviewItem) => {
    const accountId = row.selectedAccountId ?? row.matchedAccountId ?? importPreview?.statementAccountId;
    return previewAccountDisplayTitleById(accountId);
  }, [importPreview?.statementAccountId, previewAccountDisplayTitleById]);

  const hasImportPreview = importPreview !== null;
  const previewFilterRows = useMemo(() => importPreview?.items ?? [], [importPreview]);
  const getPreviewColumnValue = useCallback((row: ImportPreviewItem, column: ImportPreviewColumn) => {
    const item = row.item;
    if (column === "date") return item.date?.trim() || "(空)";
    if (column === "postedDate") return normalizeDateOnlyText(item.postedDate) || "(空)";
    if (column === "type") return typeLabel(item.type);
    if (column === "account") return selectedPreviewAccountDisplayLabel(row) || accountLabel(item) || "(空)";
    if (column === "counterAccount") return cleanOptionalText(item.fromAccount) || cleanOptionalText(item.toAccount) || "(空)";
    if (column === "category") return item.category?.trim() || "(空)";
    if (column === "institution") return item.institution?.trim() || "(空)";
    if (column === "amount") return Number.isFinite(item.amount) ? item.amount.toFixed(2) : "(空)";
    if (column === "remark") return (item.remark || item.rawText || "").trim() || "(空)";
    return row.ready ? "可导入" : row.missingFields.includes("账户") ? "缺账户" : `缺${row.missingFields.join("、") || "字段"}`;
  }, [selectedPreviewAccountDisplayLabel]);
  const previewColumnFilterOptions = useMemo(() => {
    if (!activePreviewFilterColumn) return [];
    return Array.from(new Set(previewFilterRows.map((row) => getPreviewColumnValue(row, activePreviewFilterColumn))))
      .sort((a, b) => (a === "(空)" ? 1 : b === "(空)" ? -1 : a.localeCompare(b, "zh-CN")));
  }, [activePreviewFilterColumn, getPreviewColumnValue, previewFilterRows]);
  const filteredPreviewRows = useMemo(() => {
    return previewFilterRows.filter((row) => IMPORT_PREVIEW_FILTER_COLUMNS.every((column) => {
      const allowedValues = previewColumnFilters[column];
      return !allowedValues?.length || allowedValues.includes(getPreviewColumnValue(row, column));
    }));
  }, [getPreviewColumnValue, previewColumnFilters, previewFilterRows]);
  const filteredPreviewKeys = useMemo(() => new Set(filteredPreviewRows.map((row) => row.key)), [filteredPreviewRows]);
  const selectedFilteredPreviewKeys = useMemo(() => {
    if (!importPreview) return [];
    return Array.from(importPreview.selectedKeys).filter((key) => filteredPreviewKeys.has(key));
  }, [filteredPreviewKeys, importPreview]);
  const previewAccountReplaceOptions = useMemo<BatchReplaceOption[]>(() => {
    if (!hasImportPreview) return [{ value: "", label: "未选择" }];
    return [
      { value: "", label: "未选择" },
      ...previewAccountDisplayOptions
        .map((account) => ({ value: account.id, label: account.selectorLabel, title: account.hoverTitle })),
    ];
  }, [hasImportPreview, previewAccountDisplayOptions]);
  const previewDebitAccountReplaceOptions = useMemo<BatchReplaceOption[]>(() => {
    if (!hasImportPreview) return [{ value: "", label: "未选择" }];
    return [
      { value: "", label: "未选择" },
      ...previewAccountDisplayOptions
        .filter((account) => account.kind === "bank_debit")
        .map((account) => ({ value: account.id, label: account.selectorLabel, title: account.hoverTitle })),
    ];
  }, [hasImportPreview, previewAccountDisplayOptions]);
  const previewDebitAccountDisplayOptions = useMemo(
    () => {
      if (!hasImportPreview) return [];
      return previewAccountDisplayOptions.filter((account) => account.kind === "bank_debit");
    },
    [hasImportPreview, previewAccountDisplayOptions],
  );
  const previewDebitAccountOptions = useMemo<SmartSelectOption[]>(
    () => {
      if (!hasImportPreview) return [];
      const displayById = new Map(previewDebitAccountDisplayOptions.map((account) => [account.id, account]));
      return buildGroupedAccountOptions(previewDebitAccountDisplayOptions).map((option) => {
        if (option.isHeader) return option;
        const account = displayById.get(option.id);
        const groupName = account?.groupName?.trim();
        if (!groupName) return option;
        return {
          ...option,
          subLabel: option.subLabel ? `${groupName} · ${option.subLabel}` : groupName,
        };
      });
    },
    [hasImportPreview, previewDebitAccountDisplayOptions],
  );
  const {
    ownerFilterLabel: previewDebitOwnerFilterLabel,
    cycleOwnerFilter: cyclePreviewDebitOwnerFilter,
    filteredOptions: previewDebitAccountFilteredOptions,
    visibleOptionIds: previewDebitVisibleOptionIds,
  } = useAccountSSFilter(previewDebitAccountOptions);
  const displayPreviewDebitAccountOptions = useMemo(() => {
    const source = previewDebitAccountFilteredOptions?.length ? previewDebitAccountFilteredOptions : previewDebitAccountOptions;
    if (!previewDebitVisibleOptionIds) return source;
    return source.filter((option) => option.isHeader || previewDebitVisibleOptionIds.has(option.id));
  }, [previewDebitAccountFilteredOptions, previewDebitAccountOptions, previewDebitVisibleOptionIds]);
  const previewCategoryOptions = useMemo(() => {
    if (!hasImportPreview) return [];
    return bookCategories
      .filter((category) => category.type === "expense" || category.type === "income")
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  }, [bookCategories, hasImportPreview]);
  const previewCategoryById = useMemo(
    () => new Map(bookCategories.map((category) => [category.id, category])),
    [bookCategories],
  );
  const previewCategoryReplaceOptions = useMemo<BatchReplaceOption[]>(() => {
    if (!hasImportPreview) return [];
    const typeLabels: Record<string, string> = { expense: "支出分类", income: "收入分类" };
    const options: BatchReplaceOption[] = [{ value: "", label: "清除分类" }];
    const indent = "　";

    for (const type of ["expense", "income"]) {
      const typedCategories = bookCategories.filter((category) => category.type === type);
      if (typedCategories.length === 0) continue;
      const childrenByParentId = new Map<string | null, typeof typedCategories>();
      for (const category of typedCategories) {
        const key = category.parentId ?? null;
        const list = childrenByParentId.get(key) ?? [];
        list.push(category);
        childrenByParentId.set(key, list);
      }
      for (const list of childrenByParentId.values()) {
        list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
      }

      const headerId = `preview-category-type:${type}`;
      options.push({ value: headerId, label: typeLabels[type] ?? type, isHeader: true });

      function walk(parentId: string | null, level: number, parentOptionId: string) {
        const children = childrenByParentId.get(parentId) ?? [];
        for (const child of children) {
          const hasChildren = (childrenByParentId.get(child.id) ?? []).length > 0;
          options.push({
            value: child.id,
            label: `${indent.repeat(level)}${child.name}`,
            subLabel: typeLabels[type] ?? type,
            parentId: parentOptionId,
            isGroup: hasChildren,
          });
          if (hasChildren) walk(child.id, level + 1, child.id);
        }
      }

      walk(null, 0, headerId);
    }

    return options;
  }, [bookCategories, hasImportPreview]);
  const previewReplaceFields = useMemo<BatchReplaceFieldConfig<ImportPreviewEditableCell>[]>(() => {
    if (!hasImportPreview) return [];
    return [
      { value: "date", label: IMPORT_PREVIEW_FIELD_LABELS.date, kind: "text", placeholder: "YYYY-MM-DD 或含时间" },
      { value: "postedDate", label: IMPORT_PREVIEW_FIELD_LABELS.postedDate, kind: "date", placeholder: "YYYY-MM-DD" },
      {
        value: "type",
        label: IMPORT_PREVIEW_FIELD_LABELS.type,
        kind: "select",
        options: [
          { value: "", label: "选择类型" },
          { value: "expense", label: "支出" },
          { value: "income", label: "收入" },
          { value: "transfer", label: "转账" },
          { value: "investment", label: "投资" },
        ],
      },
      { value: "account", label: IMPORT_PREVIEW_FIELD_LABELS.account, kind: "smartSelect", options: previewAccountReplaceOptions },
      { value: "counterAccount", label: IMPORT_PREVIEW_FIELD_LABELS.counterAccount, kind: "smartSelect", options: previewDebitAccountReplaceOptions },
      {
        value: "category",
        label: IMPORT_PREVIEW_FIELD_LABELS.category,
        kind: "smartSelect",
        options: previewCategoryReplaceOptions,
        placeholder: "选择分类",
        allowEmpty: true,
        smartSelectBehavior: {
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
        },
      },
      { value: "institution", label: IMPORT_PREVIEW_FIELD_LABELS.institution, kind: "text", placeholder: "银行或第三方支付机构" },
      { value: "amount", label: IMPORT_PREVIEW_FIELD_LABELS.amount, kind: "number", placeholder: "输入金额" },
      { value: "remark", label: IMPORT_PREVIEW_FIELD_LABELS.remark, kind: "text", placeholder: "输入备注" },
    ];
  }, [hasImportPreview, previewAccountReplaceOptions, previewCategoryReplaceOptions, previewDebitAccountReplaceOptions]);

  function previewDebitAccountIdFromName(accountName: string) {
    const nameKey = normalizedKey(accountName);
    if (!nameKey) return undefined;
    const found = bookAccounts.find((account) =>
      account.kind === "bank_debit" &&
      normalizedKey(account.name) === nameKey
    );
    return found?.id;
  }

  function recomputePreviewRow(row: ImportPreviewItem, itemPatch: Partial<ParsedItem>, accountId?: string | null): ImportPreviewItem {
    let item = { ...row.item, ...itemPatch };
    if ("postedDate" in itemPatch) {
      item.postedDate = normalizeDateOnlyText(itemPatch.postedDate);
    }
    if ("date" in itemPatch && !("postedDate" in itemPatch)) {
      const previousDate = normalizeDateOnlyText(row.item.date);
      const previousPostedDate = normalizeDateOnlyText(row.item.postedDate);
      const nextDate = normalizeDateOnlyText(itemPatch.date);
      if (!previousPostedDate || previousPostedDate === previousDate) {
        item.postedDate = nextDate;
      }
    }
    if (itemPatch.type === "transfer") {
      item = {
        ...item,
        account: item.account || primaryAccountNameForItem(item, row),
        fromAccount: item.fromAccount || undefined,
        toAccount: undefined,
      };
    } else if (itemPatch.type) {
      item = {
        ...item,
        account: item.account || item.fromAccount || primaryAccountNameForItem(item, row),
        fromAccount: undefined,
        toAccount: undefined,
      };
    }
    const resolved = accountId === undefined
      ? (row.selectedAccountId || row.matchedAccountId ? { selectedAccountId: row.selectedAccountId, matchedAccountId: row.matchedAccountId } : resolvePreviewAccount(item))
      : { selectedAccountId: accountId || undefined, matchedAccountId: accountId || undefined };
    const missingFields = getMissingFields(item);
    const ready = isRowReadyForImport(item) && Boolean(resolved.selectedAccountId || resolved.matchedAccountId || importPreview?.statementAccountId);
    return {
      ...row,
      item,
      ...resolved,
      missingFields: ready ? missingFields : Array.from(new Set([...missingFields, ...(resolved.selectedAccountId || resolved.matchedAccountId || importPreview?.statementAccountId ? [] : ["账户"])])),
      ready,
    };
  }

  function applyPreviewReplace(field: ImportPreviewEditableCell, value: string) {
    if (!importPreview) throw new Error("没有导入预览");
    if (selectedFilteredPreviewKeys.length === 0) throw new Error("请先勾选记录，或按筛选结果全选");
    const nextItems = importPreview.items.map((row) => {
      if (!selectedFilteredPreviewKeys.includes(row.key)) return row;
      if (field === "amount") return recomputePreviewRow(row, { amount: Math.abs(Number(value) || 0) });
      if (field === "type") return recomputePreviewRow(row, { type: value as ParsedItem["type"] });
      if (field === "account") {
        const nextName = accountNameFromId(value) ?? undefined;
        return recomputePreviewRow(row, { account: nextName }, value || null);
      }
      if (field === "counterAccount") {
        const nextName = accountNameFromId(value) ?? undefined;
        return recomputePreviewRow(row, { fromAccount: nextName, toAccount: undefined });
      }
      if (field === "category") {
        const nextName = value ? previewCategoryById.get(value)?.name ?? value : undefined;
        return recomputePreviewRow(row, { category: nextName });
      }
      return recomputePreviewRow(row, { [field]: value || undefined } as Partial<ParsedItem>);
    });
    setImportPreview(recomputePreviewState(nextItems));
    setParsedItems(nextItems.map((row) => row.item));
    return `已批量修改 ${selectedFilteredPreviewKeys.length} 条：${IMPORT_PREVIEW_FIELD_LABELS[field]}。`;
  }

  function renderPreviewColumnFilter(column: ImportPreviewColumn, label: string) {
    const selectedValues = previewColumnFilters[column] ?? [];
    const isOpen = activePreviewFilterColumn === column;
    return (
      <TableColumnFilter
        label={label}
        options={isOpen ? previewColumnFilterOptions : []}
        selectedValues={selectedValues}
        open={isOpen}
        onToggleOpen={() => setActivePreviewFilterColumn((current) => current === column ? null : column)}
        onClose={() => setActivePreviewFilterColumn(null)}
        onChange={(values) => setPreviewColumnFilters((current) => ({ ...current, [column]: values }))}
      />
    );
  }

  function updatePreviewAccount(rowKey: string, accountId: string) {
    if (!importPreview) return;
    const target = importPreview.items.find((row) => row.key === rowKey);
    const account = bookAccounts.find((item) => item.id === accountId);
    if (!target || !account) return;
    const targetLabel = accountLabel(target.item);
    const nextItems = importPreview.items.map((row) => {
      if (accountLabel(row.item) !== targetLabel) return row;
      const item = { ...row.item, account: account.name };
      const missingFields = getMissingFields(item);
      const ready = isRowReadyForImport(item);
      return { ...row, item, selectedAccountId: account.id, matchedAccountId: account.id, missingFields, ready };
    });
    setImportPreview(recomputePreviewState(nextItems));
    setParsedItems((current) => current.map((item) => accountLabel(item) === targetLabel ? { ...item, account: account.name } : item));
  }

  function applyPreviewAccountFromCreated(rowKey: string, account: BookAccount) {
    if (!importPreview) return;
    const target = importPreview.items.find((row) => row.key === rowKey);
    if (!target) return;
    const targetLabel = accountLabel(target.item);
    const nextItems = importPreview.items.map((row) => {
      if (accountLabel(row.item) !== targetLabel) return row;
      const item = { ...row.item, account: account.name };
      const missingFields = getMissingFields(item);
      const ready = isRowReadyForImport(item);
      return { ...row, item, selectedAccountId: account.id, matchedAccountId: account.id, missingFields, ready };
    });
    setImportPreview(recomputePreviewState(nextItems));
    setParsedItems((current) => current.map((item) => accountLabel(item) === targetLabel ? { ...item, account: account.name } : item));
  }

  function clearPreviewAccount(rowKey: string) {
    if (!importPreview) return;
    const target = importPreview.items.find((row) => row.key === rowKey);
    if (!target) return;
    const targetLabel = accountLabel(target.item);
    const nextItems = importPreview.items.map((row) => {
      if (accountLabel(row.item) !== targetLabel) return row;
      const item = { ...row.item, account: undefined };
      return {
        ...row,
        item,
        selectedAccountId: undefined,
        matchedAccountId: undefined,
        ready: false,
        missingFields: Array.from(new Set([...getMissingFields(item), "账户"])),
      };
    });
    setImportPreview(recomputePreviewState(nextItems));
  }

  function openAccountDraft(row: ImportPreviewItem) {
    const item = row.item;
    const bankName = item._meta?.institutionName ?? "";
    const ownerName = item._meta?.ownerName ?? "";
    const institution = bookLookupsRef.current.institutions.find((inst) => normalizedKey(inst.name) === normalizedKey(bankName) || normalizedKey(inst.shortName) === normalizedKey(bankName));
    const user = bookLookupsRef.current.users.find((u) => normalizedKey(u.name) === normalizedKey(ownerName));
    setAccountDraft({
      rowKey: row.key,
      name: item.account || accountLabel(item),
      kind: isCreditStatement(item) ? "bank_credit" : "bank_debit",
      institutionName: bankName,
      institutionId: institution?.id ?? "",
      ownerName,
      userId: user?.id ?? "",
      numberMasked: item._meta?.cardNumberMasked ?? "",
      creditLimit: item._meta?.creditLimit != null ? String(item._meta.creditLimit) : "",
      billingDay: item._meta?.billingDay != null ? String(item._meta.billingDay) : "",
      repaymentDay: item._meta?.repaymentDay != null ? String(item._meta.repaymentDay) : "",
    });
  }

  async function ensureInstitutionForDraft(draft: AccountCreateDraft) {
    if (draft.institutionId) return draft.institutionId;
    const name = draft.institutionName.trim();
    if (!name) return "";
    const existing = bookInstitutions.find((inst) => normalizedKey(inst.name) === normalizedKey(name) || normalizedKey(inst.shortName) === normalizedKey(name));
    if (existing) return existing.id;
    const res = await fetch("/api/v1/institution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, shortName: name, type: "bank" }),
    });
    const data = await res.json();
    if (!data.ok && res.status !== 409) throw new Error(data.error ?? "创建机构失败");
    if (data.ok && data.institution) {
      setBookInstitutions((current) => [...current, data.institution]);
      return data.institution.id;
    }
    const lookups = await loadBookLookups();
    const retry = lookups.institutions.find((inst) => normalizedKey(inst.name) === normalizedKey(name));
    return retry?.id ?? "";
  }

  async function createAccountFromDraft() {
    if (!accountDraft?.name.trim()) return;
    setSavingAccountDraft(true); setError("");
    try {
      const institutionId = await ensureInstitutionForDraft(accountDraft);
      const res = await fetch("/api/v1/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: accountDraft.name.trim(),
          kind: accountDraft.kind,
          institutionId: institutionId || undefined,
          userId: accountDraft.userId || undefined,
          numberMasked: accountDraft.numberMasked.trim() || undefined,
          creditLimit: accountDraft.creditLimit.trim() || undefined,
          billingDay: accountDraft.billingDay.trim() || undefined,
          repaymentDay: accountDraft.repaymentDay.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "创建账户失败");
      const created: BookAccount = data.account;
      setBookAccounts((current) => [...current, created]);
      setAccountDraft(null);
      applyPreviewAccountFromCreated(accountDraft.rowKey, created);
      await loadBookLookups();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建账户失败");
    } finally {
      setSavingAccountDraft(false);
    }
  }

  function typeLabel(type: ParsedItem["type"]) {
    if (type === "income") return "收入";
    if (type === "transfer") return "转账";
    if (type === "investment") return "投资";
    return "支出";
  }

  function previewAmountText(item: ParsedItem) {
    return Math.abs(item.amount ?? 0).toFixed(2);
  }

  function amountTextClass(type: ParsedItem["type"]) {
    if (type === "income") return "text-emerald-600";
    if (type === "expense") return "text-red-600";
    return "text-slate-800";
  }

  function accountLabel(item: ParsedItem) {
    if (item.account) return item.account;
    const bank = item._meta?.institutionName;
    const last4 = item._meta?.cardNumberMasked;
    if (bank) return `${bank}信用卡${last4 ? `(${last4})` : ""}`;
    return "未识别账户";
  }

  function formatAttachmentSize(size: number) {
    if (!Number.isFinite(size) || size <= 0) return "";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-800">邮箱设置</h2>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      {info && <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">{info}</div>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-slate-800">邮箱账户</div>
            <button className="h-7 px-2 rounded-md border border-slate-300 text-xs hover:bg-slate-50" onClick={openCreateAccountModal}>新增</button>
          </div>
          <div className="max-h-[220px] space-y-2 overflow-y-auto pr-1">
            {loadingAccounts ? (
              <div className="rounded-md border border-dashed border-slate-200 px-3 py-8 text-center text-xs text-slate-400">加载邮箱账户…</div>
            ) : accounts.length > 0 ? accounts.map(acc => (
              <div key={acc.id} className={`flex items-center gap-2 rounded-md border px-2.5 py-2 ${selectedId === acc.id ? "border-blue-300 bg-blue-50" : "border-slate-200 hover:bg-slate-50"}`}>
                <button className="min-w-0 flex-1 text-left" onClick={() => selectAccountForMail(acc.id)}>
                  <div className="truncate text-sm font-medium text-slate-800">{acc.label}</div>
                  <div className="truncate text-[11px] text-slate-500">{acc.username}</div>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <button title="编辑" aria-label="编辑" onClick={(e) => { e.stopPropagation(); editAccount(acc); }}
                    className="h-7 w-7 rounded-md border border-blue-200 text-blue-600 hover:bg-blue-50">✎</button>
                  <button title="删除" aria-label="删除" onClick={(e) => { e.stopPropagation(); deleteAccount(acc.id); }}
                    className="h-7 w-7 rounded-md border border-red-200 text-red-600 hover:bg-red-50">×</button>
                </div>
              </div>
            )) : (
              <div className="rounded-md border border-dashed border-slate-200 px-3 py-8 text-center text-xs text-slate-400">暂无邮箱账户</div>
            )}
          </div>
        </div>
        <div className="min-h-[520px] rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
            <div className="overflow-hidden rounded-md border border-slate-200">
              <div className="border-b border-slate-100 bg-slate-50 p-2">
                <div className="mb-2 text-sm font-medium text-slate-800">{selectedAccount ? selectedAccount.label : "邮箱读取"}</div>
                <div className="grid grid-cols-[minmax(92px,1fr)_120px_76px] items-center gap-2">
                  <div className="flex h-8 items-center truncate rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600">
                    关键词：{MAIL_FIXED_KEYWORD}
                  </div>
                  <select className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs outline-none" value={mailRange} onChange={(e) => setMailRange(e.target.value)}>
                    <option value="month">最近一个月</option>
                    <option value="50">最近 50 封</option>
                    <option value="100">最近 100 封</option>
                    <option value="500">最近 500 封</option>
                    <option value="1000">最近 1000 封（较慢）</option>
                  </select>
                  <button className="h-8 rounded-md bg-blue-600 text-xs text-white hover:bg-blue-700 disabled:opacity-50" onClick={() => listMails()} disabled={!selectedAccount || loadingMails}>
                    {loadingMails ? "读取中…" : "获取邮件"}
                  </button>
                </div>
                {mailListHint && <div className="text-[11px] leading-5 text-blue-600">{mailListHint}</div>}
              </div>
              <div className="max-h-[430px] overflow-auto divide-y divide-slate-100">
                {mailItems.map(m => (
                  <button key={m.uid} className={`w-full text-left px-2.5 py-2 text-xs ${selectedMail?.uid === m.uid ? "bg-blue-50" : "hover:bg-slate-50"}`}
                    onClick={() => fetchMail(m.uid)}>
                    <div className="truncate font-medium text-slate-800">{m.subject || "（无主题）"}</div>
                    <div className="truncate text-[11px] text-slate-500">{m.from}</div>
                    <div className="mt-0.5 text-[10px] text-slate-400">{m.date}</div>
                  </button>
                ))}
                {mailItems.length === 0 && !loadingMails && (
                  <div className="px-3 py-10 text-xs text-slate-500">{selectedAccount ? "点击获取邮件读取列表" : "请选择左侧邮箱账户"}</div>
                )}
              </div>
            </div>

            <div className="space-y-3">
              {selectedMail ? (
                <>
                  <div className="text-xs text-slate-500">
                    发件人: {selectedMail.from} · 日期: {selectedMail.date}
                  </div>
                  <iframe
                    className="h-[360px] w-full rounded-md border border-slate-200 bg-white"
                    sandbox="allow-popups allow-popups-to-escape-sandbox"
                    srcDoc={buildMailPreviewHtml(selectedMail)}
                    title="邮件内容预览"
                  />
                  {selectedMail.attachments && selectedMail.attachments.length > 0 && (
                    <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                      <div className="mb-1 text-xs font-medium text-slate-700">附件</div>
                      <div className="space-y-1.5">
                        {selectedMail.attachments.map((attachment) => (
                          <div key={attachment.id} className="rounded border border-slate-100 bg-white px-2 py-1.5 text-xs text-slate-600">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate font-medium text-slate-700">{attachment.filename || "未命名附件"}</span>
                              <span className="shrink-0 text-slate-400">{formatAttachmentSize(attachment.size)}</span>
                            </div>
                            {attachment.text ? (
                              <div className="mt-0.5 text-emerald-700">已提取 PDF 文字，识别时会一起分析。</div>
                            ) : attachment.parseError ? (
                              <div className="mt-0.5 text-amber-700">{attachment.parseError}</div>
                            ) : (
                              <div className="mt-0.5 text-slate-400">{attachment.contentType || "附件"}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <button className="h-8 px-3 rounded-md bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-50" onClick={() => parseMail(selectedMail, true)} disabled={parsing}>
                      {parsing ? "识别中…" : "导入账单"}
                    </button>
                  </div>
                </>
              ) : (
                <div className="rounded-md border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">选中一封邮件后预览内容，再点导入账单</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {importPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-6">
          <div className="flex max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">账单导入预览</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  已识别 {importPreview.items.length} 条，默认选择可导入记录。信用卡会按账单中的姓名、银行、尾号、账单日自动匹配或生成账户。
                </div>
              </div>
              <button className="h-8 w-8 rounded-md border border-slate-300 text-slate-500 hover:bg-white" onClick={() => importComplete ? confirmImportComplete() : setImportPreview(null)}>×</button>
            </div>

            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2">
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <input type="checkbox" checked={importPreview.selectAll} onChange={togglePreviewAll} />
                  全选
                </label>
                <BatchReplacePopoverButton
                  fields={previewReplaceFields}
                  targetCount={selectedFilteredPreviewKeys.length}
                  targetLabel="筛选后已选"
                  panelAlign="left"
                  disabledTitle="请先勾选记录，可先按表头筛选后全选"
                  buttonTitle={`批量修改筛选后已选 ${selectedFilteredPreviewKeys.length} 条`}
                  messageClassName="sr-only"
                  onApply={applyPreviewReplace}
                />
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                {importPreview.statementAccountId && (
                  <span>
                    账户：{previewAccountDisplayLabelById(importPreview.statementAccountId) ?? "已匹配账户"}
                  </span>
                )}
                <span>筛选 {filteredPreviewRows.length} / {importPreview.items.length} 条</span>
                <span>将导入 {importPreview.selectedKeys.size} 条</span>
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="sticky top-0 bg-white text-slate-500 shadow-sm">
                  <tr>
                    <th className="w-10 px-3 py-2"></th>
                    <th className="px-3 py-2">{renderPreviewColumnFilter("date", "交易日")}</th>
                    <th className="px-3 py-2">{renderPreviewColumnFilter("postedDate", "入账日期")}</th>
                    <th className="px-3 py-2">{renderPreviewColumnFilter("type", "类型")}</th>
                    <th className="px-3 py-2">{renderPreviewColumnFilter("account", "账户")}</th>
                    <th className="px-3 py-2">{renderPreviewColumnFilter("counterAccount", "对手账户")}</th>
                    <th className="px-3 py-2">{renderPreviewColumnFilter("category", "分类")}</th>
                    <th className="px-3 py-2">{renderPreviewColumnFilter("institution", "收支机构")}</th>
                    <th className="px-3 py-2 text-right">{renderPreviewColumnFilter("amount", "金额")}</th>
                    <th className="min-w-[260px] px-3 py-2">{renderPreviewColumnFilter("remark", "备注")}</th>
                    <th className="px-3 py-2">{renderPreviewColumnFilter("status", "状态")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredPreviewRows.map((row) => {
                    const item = row.item;
                    const checked = importPreview.selectedKeys.has(row.key);
                    return (
                      <tr key={row.key} className={checked ? "bg-blue-50/40" : "bg-white"}>
                        <td className="px-3 py-2 align-top">
                          <input type="checkbox" checked={checked} onChange={() => togglePreviewItem(row.key)} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 align-top tabular-nums text-slate-700">{item.date || "-"}</td>
                        <td className="whitespace-nowrap px-3 py-2 align-top tabular-nums text-slate-500" onDoubleClick={() => setEditingPreviewCell({ rowKey: row.key, field: "postedDate" })}>
                          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "postedDate" ? (
                            <DateStepper
                              autoFocus
                              className="h-8 rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
                              value={normalizeDateOnlyText(item.postedDate) ?? ""}
                              onBlur={() => setEditingPreviewCell(null)}
                              onChange={(value) => {
                                updatePreviewRow(row.key, { postedDate: value || undefined });
                                setEditingPreviewCell(null);
                              }}
                            />
                          ) : (
                            <span className="cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title="双击修改入账日期">{normalizeDateOnlyText(item.postedDate) || "-"}</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 align-top text-slate-700" onDoubleClick={() => setEditingPreviewCell({ rowKey: row.key, field: "type" })}>
                          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "type" ? (
                            <select
                              autoFocus
                              className="h-8 rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
                              value={item.type}
                              onBlur={() => setEditingPreviewCell(null)}
                              onChange={(e) => {
                                updatePreviewRow(row.key, { type: e.target.value as ParsedItem["type"] });
                                setEditingPreviewCell(null);
                              }}
                            >
                              {PREVIEW_TYPE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                          ) : (
                            <span className="cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title="双击修改类型">{typeLabel(item.type)}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top text-slate-700">
                          {row.ready || item.type === "transfer" ? (
                            <div className="space-y-1">
                              <span className="whitespace-nowrap text-slate-700" title={selectedPreviewAccountDisplayTitle(row) ?? accountLabel(item)}>
                                {selectedPreviewAccountDisplayLabel(row) ?? accountLabel(item)}
                              </span>
                              {item.type === "transfer" ? <div className="text-[11px] text-slate-400">到账账户</div> : null}
                            </div>
                          ) : (
                            <div className="min-w-[220px] space-y-1.5">
                              <div className="truncate text-[11px] text-slate-400" title={accountLabel(item)}>账单识别：{accountLabel(item)}</div>
                              <select
                                className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-xs outline-none"
                                value={row.selectedAccountId ?? row.matchedAccountId ?? ""}
                                onChange={(e) => e.target.value ? updatePreviewAccount(row.key, e.target.value) : clearPreviewAccount(row.key)}
                              >
                                <option value="">{isCreditStatement(item) ? "选择信用卡账户" : "选择账户"}</option>
                                {previewAccountOptions(item).map((account) => (
                                  <option key={account.id} value={account.id} title={account.hoverTitle}>
                                    {account.selectorLabel}
                                  </option>
                                ))}
                              </select>
                              <div className="flex items-center justify-between gap-2">
                                {item._meta?.ownerName ? <span className="text-[11px] text-slate-400">持卡人 {item._meta.ownerName}</span> : <span />}
                                <button className="h-7 px-2 rounded-md border border-blue-200 text-[11px] text-blue-600 hover:bg-blue-50" onClick={() => openAccountDraft(row)}>
                                  创建账户
                                </button>
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="min-w-[180px] px-3 py-2 align-top text-slate-700">
                          {item.type === "transfer" ? (
                            <div className="min-w-[260px] space-y-1">
                              <SmartSelect
                                mode="single"
                                value={previewDebitAccountIdFromName(item.fromAccount ?? item.toAccount ?? "") ?? ""}
                                onChange={(accountId) => {
                                  const nextName = accountNameFromId(accountId);
                                  const nextItems = importPreview.items.map((previewRow) =>
                                    previewRow.key === row.key ? recomputePreviewRow(previewRow, { fromAccount: nextName, toAccount: undefined }) : previewRow
                                  );
                                  setImportPreview(recomputePreviewState(nextItems));
                                  setParsedItems(nextItems.map((previewRow) => previewRow.item));
                                }}
                                options={displayPreviewDebitAccountOptions}
                                placeholder="选择还款借记卡"
                                onCreateClick={() => openDebitAccountDraft(row.key)}
                                createLabel="新增账户"
                                onCycleOwnerFilter={cyclePreviewDebitOwnerFilter}
                                ownerFilterLabel={previewDebitOwnerFilterLabel}
                                behavior={{
                                  search: true,
                                  hierarchy: true,
                                  clearable: true,
                                  cycleSelectionWithArrowKeys: true,
                                  minDropdownWidth: 460,
                                }}
                              />
                              <div className="text-[11px] text-slate-400">资金流出账户</div>
                            </div>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 align-top text-slate-700" onDoubleClick={() => setEditingPreviewCell({ rowKey: row.key, field: "category" })}>
                          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "category" ? (
                            <select
                              autoFocus
                              className="h-8 min-w-[120px] rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
                              value={item.category ?? ""}
                              onBlur={() => setEditingPreviewCell(null)}
                              onChange={(e) => {
                                updatePreviewRow(row.key, { category: e.target.value || undefined });
                                setEditingPreviewCell(null);
                              }}
                            >
                              <option value="">未分类</option>
                              {previewCategoryOptions
                                .filter((category) => category.type === item.type || (item.type !== "income" && category.type === "expense"))
                                .map((category) => (
                                  <option key={category.id} value={category.name}>{category.name}</option>
                                ))}
                            </select>
                          ) : (
                            <span className="cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title="双击修改分类">{item.category || "-"}</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 align-top text-slate-700">{item.institution || "-"}</td>
                        <td className={`whitespace-nowrap px-3 py-2 text-right align-top tabular-nums ${amountTextClass(item.type)}`}>{previewAmountText(item)}</td>
                        <td className="px-3 py-2 align-top text-slate-600">{item.remark || item.rawText}</td>
                        <td className="whitespace-nowrap px-3 py-2 align-top">
                          {row.ready ? (
                            <span className="text-[11px] text-slate-400">-</span>
                          ) : (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                              {row.missingFields.includes("账户") ? "请选择或创建账户" : `缺 ${row.missingFields.join("、")}`}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredPreviewRows.length === 0 && (
                    <tr>
                      <td colSpan={11} className="px-4 py-8 text-center text-sm text-slate-500">没有符合筛选条件的记录。</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-xs text-slate-500">
                {importComplete ? "导入已完成，请确认后返回。" : `将导入 ${importPreview.selectedKeys.size} 条`}
              </div>
              <div className="flex items-center gap-2">
                {!importComplete && (
                  <button className="h-9 px-4 rounded-md border border-slate-300 bg-white text-sm hover:bg-slate-50" onClick={() => setImportPreview(null)}>
                    取消
                  </button>
                )}
                {importComplete ? (
                  <button className="h-9 px-4 rounded-md bg-green-600 text-white text-sm hover:bg-green-700" onClick={confirmImportComplete}>
                    {importComplete.accountId ? "确定并打开账户" : "确定并返回开始界面"}
                  </button>
                ) : (
                  <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed" onClick={importItems} disabled={importing || importPreview.selectedKeys.size === 0 || importPreview.items.some((row) => importPreview.selectedKeys.has(row.key) && !row.ready)}>
                    {importing ? "导入中…" : `确认导入 ${importPreview.selectedKeys.size} 条`}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {accountDraft && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 px-4 py-6">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">根据账单创建账户</div>
                <div className="mt-1 text-xs text-slate-500">识别到的信息已预填，确认后会回填到当前账单导入预览。</div>
              </div>
              <button className="h-8 w-8 rounded-md border border-slate-300 text-slate-500 hover:bg-slate-50" onClick={() => setAccountDraft(null)}>×</button>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="text-xs text-slate-500">
                账户名称
                <input className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none" value={accountDraft.name} onChange={(e) => setAccountDraft((current) => current ? { ...current, name: e.target.value } : current)} />
              </label>
              <label className="text-xs text-slate-500">
                账户类型
                <select className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={accountDraft.kind} onChange={(e) => setAccountDraft((current) => current ? { ...current, kind: e.target.value as AccountCreateDraft["kind"] } : current)}>
                  <option value="bank_credit">信用卡</option>
                  <option value="bank_debit">储蓄卡</option>
                  <option value="ewallet">电子钱包</option>
                  <option value="cash">现金</option>
                  <option value="other">其他</option>
                </select>
              </label>
              <label className="text-xs text-slate-500">
                机构
                <select
                  className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  value={accountDraft.institutionId}
                  onChange={(e) => {
                    const institution = bookInstitutions.find((item) => item.id === e.target.value);
                    setAccountDraft((current) => current ? { ...current, institutionId: e.target.value, institutionName: institution?.name ?? current.institutionName } : current);
                  }}
                >
                  <option value="">新建/不选择机构</option>
                  {bookInstitutions.map((institution) => (
                    <option key={institution.id} value={institution.id}>{institution.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-500">
                新机构名称
                <input className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none" value={accountDraft.institutionName} onChange={(e) => setAccountDraft((current) => current ? { ...current, institutionName: e.target.value, institutionId: "" } : current)} placeholder="如 兴业银行" />
              </label>
              <label className="text-xs text-slate-500">
                所有人
                <select className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={accountDraft.userId} onChange={(e) => setAccountDraft((current) => current ? { ...current, userId: e.target.value } : current)}>
                  <option value="">{accountDraft.ownerName ? `识别到：${accountDraft.ownerName}` : "不指定"}</option>
                  {bookUsers.map((user) => (
                    <option key={user.id} value={user.id}>{user.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-500">
                尾号
                <input className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none" value={accountDraft.numberMasked} onChange={(e) => setAccountDraft((current) => current ? { ...current, numberMasked: e.target.value } : current)} placeholder="如 1100" />
              </label>
              {accountDraft.kind === "bank_credit" && (
                <>
                  <label className="text-xs text-slate-500">
                    信用额度
                    <input className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none" value={accountDraft.creditLimit} onChange={(e) => setAccountDraft((current) => current ? { ...current, creditLimit: e.target.value } : current)} />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs text-slate-500">
                      账单日
                      <input className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none" value={accountDraft.billingDay} onChange={(e) => setAccountDraft((current) => current ? { ...current, billingDay: e.target.value } : current)} />
                    </label>
                    <label className="text-xs text-slate-500">
                      还款日
                      <input className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none" value={accountDraft.repaymentDay} onChange={(e) => setAccountDraft((current) => current ? { ...current, repaymentDay: e.target.value } : current)} />
                    </label>
                  </div>
                </>
              )}
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button className="h-9 px-4 rounded-md border border-slate-300 text-sm hover:bg-slate-50" onClick={() => setAccountDraft(null)}>取消</button>
              <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={createAccountFromDraft} disabled={savingAccountDraft || !accountDraft.name.trim()}>
                {savingAccountDraft ? "创建中…" : "创建并使用"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAccountModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-6">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-slate-800">{editingId ? "修改邮箱账户" : "添加邮箱账户"}</div>
                <div className="mt-1 text-xs text-slate-500">先点测试确认连接；测试通过后保存不会再重复测试。</div>
              </div>
              <button className="h-8 w-8 rounded-md border border-slate-300 text-slate-500 hover:bg-slate-50" onClick={closeAccountModal}>×</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <select className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={providerKey} onChange={(e) => applyProviderPreset(e.target.value)}>
                <option value="">选择邮箱模板（可选）</option>
                {EMAIL_PROVIDER_PRESETS.map((preset) => (
                  <option key={preset.key} value={preset.key}>{preset.label}</option>
                ))}
              </select>
              <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="标签名，如 QQ邮箱" />
              <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={username} onChange={(e) => { setUsername(e.target.value); if (!smtpFrom.trim()) setSmtpFrom(e.target.value); }} placeholder="邮箱账号" autoComplete="username" />
              <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder="IMAP 主机，如 imap.qq.com" />
              <div className="flex gap-2">
                <input className="h-9 w-24 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={imapPort} onChange={(e) => setImapPort(e.target.value)} placeholder="端口" />
                <label className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 flex items-center gap-2">
                  <input type="checkbox" checked={imapSecure} onChange={(e) => setImapSecure(e.target.checked)} />TLS
                </label>
              </div>
              <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={editingId ? "新授权码，不修改可留空" : "授权码/密码"} type="password" autoComplete="new-password" />
              <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={mailbox} onChange={(e) => setMailbox(e.target.value)} placeholder="邮箱文件夹，默认 INBOX" />
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100">
              <div className="text-xs font-medium text-slate-500 mb-2">SMTP 发件（可选）</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="SMTP 主机，如 smtp.qq.com" />
                <input className="h-9 w-24 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={smtpPort} onChange={(e) => { setSmtpPort(e.target.value); setSmtpSecure(e.target.value === "465"); }} placeholder="端口" />
                <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} placeholder="发件地址，如 noreply@qq.com" />
              </div>
              <div className="mt-2 text-xs text-slate-500">
                SMTP 端口 465 使用 SSL；587 使用 STARTTLS。Gmail 发信用 587 更通用，收信用 IMAP 993。
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button className="h-9 px-4 rounded-md border border-slate-300 text-sm hover:bg-slate-50" onClick={closeAccountModal}>取消</button>
              <button className="h-9 px-4 rounded-md border border-slate-300 text-sm hover:bg-slate-50 disabled:opacity-50" onClick={testConnection} disabled={testing}>{testing ? "测试中…" : "测试连接"}</button>
              <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={saveAccount} disabled={saving}>{saving ? "保存中…" : editingId ? "保存修改" : "保存"}</button>
            </div>
            {testResult && <div className="mt-2 text-xs text-emerald-700">{testResult}</div>}
            {!accountTested && <div className="mt-2 text-xs text-slate-500">建议先测试连接，测试通过后再保存。</div>}
          </div>
        </div>
      )}
    </div>
  );
}
