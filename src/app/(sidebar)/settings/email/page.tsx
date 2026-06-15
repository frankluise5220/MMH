"use client";

import { useEffect, useState } from "react";

const RESEND_FROM = "wiseme@floatingice.win";

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

type MailItem = { uid: number; subject: string; from: string; date: string };
type MailDetail = { uid: number; subject: string; from: string; date: string; text: string; html: string };
type ParsedItem = {
  rawText: string; type: "expense" | "income" | "transfer" | "investment";
  date?: string; amount: number; account?: string; category?: string; remark?: string;
};

export default function EmailSettingsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 邮箱账户表单
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapSecure, setImapSecure] = useState(true);
  const [password, setPassword] = useState("");
  const [mailbox, setMailbox] = useState("INBOX");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpFrom, setSmtpFrom] = useState("");

  // Resend 配置
  const [resendApiKey, setResendApiKey] = useState("");

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
  const [importing, setImporting] = useState(false);
  const [mailLimit, setMailLimit] = useState("20");

  // 密码找回自动检测状态
  const [hasEmailService, setHasEmailService] = useState(false);

  useEffect(() => {
    loadAccounts();
    loadResendConfig();
    checkEmailService();
  }, []);

  async function loadAccounts() {
    try {
      const res = await fetch("/api/v1/settings/email-accounts");
      const data = await res.json();
      if (data.ok) setAccounts(data.accounts);
    } catch {}
  }

  async function loadResendConfig() {
    try {
      const res = await fetch("/api/v1/settings/resend");
      const data = await res.json();
      if (data.ok && data.data) {
        setResendApiKey(data.data.apiKey ?? "");
      }
    } catch {}
  }

  async function checkEmailService() {
    try {
      const res = await fetch("/api/v1/settings/email/status");
      const data = await res.json();
      if (data.ok) setHasEmailService(data.hasEmailService);
    } catch {}
  }

  function resetForm() {
    setLabel(""); setUsername(""); setImapHost(""); setImapPort("993");
    setImapSecure(true); setPassword(""); setMailbox("INBOX");
    setSmtpHost(""); setSmtpPort("465"); setSmtpFrom("");
  }

  async function saveAccount() {
    if (!label.trim() || !username.trim() || !imapHost.trim() || !password.trim()) {
      setError("请填写标签名、用户名、IMAP 服务器和授权码");
      return;
    }
    setSaving(true); setError(""); setInfo("");
    try {
      const body: Record<string, unknown> = {
        label: label.trim(), username: username.trim(),
        imapHost: imapHost.trim(), imapPort: Number(imapPort) || 993, imapSecure,
        password, mailbox: mailbox.trim() || "INBOX",
        outboundType: "smtp",
        smtpHost: smtpHost.trim(),
        smtpPort: Number(smtpPort) || 465,
        smtpFrom: smtpFrom.trim(),
      };
      const res = await fetch("/api/v1/settings/email-accounts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        setInfo("保存成功");
        resetForm();
        loadAccounts();
        checkEmailService();
      } else {
        setError(data.error ?? "保存失败");
      }
    } catch { setError("网络错误"); }
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
      checkEmailService();
    } catch {}
  }

  async function testConnection() {
    if (!imapHost.trim() || !username.trim() || !password.trim()) {
      setError("请填写 IMAP 配置和授权码"); return;
    }
    setTesting(true); setTestResult(""); setError("");
    try {
      const body: Record<string, unknown> = {
        imapHost: imapHost.trim(), imapPort: Number(imapPort) || 993, imapSecure,
        username: username.trim(), password, mailbox: mailbox.trim() || "INBOX",
        outboundType: "smtp",
        smtpHost: smtpHost.trim(),
        smtpPort: Number(smtpPort) || 465,
        smtpFrom: smtpFrom.trim(),
      };
      const res = await fetch("/api/v1/settings/email-accounts/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) setTestResult("测试通过: " + data.results.join("; "));
      else setError(data.error ?? "测试失败");
    } catch { setError("网络错误"); }
    finally { setTesting(false); }
  }

  // Resend：测试成功后自动保存
  async function testAndSaveResend() {
    if (!resendApiKey.trim()) {
      setError("请填写 Resend API Key"); return;
    }
    setTesting(true); setError(""); setInfo("");
    try {
      // 先测试
      const testRes = await fetch("/api/v1/settings/resend/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: resendApiKey.trim(), from: RESEND_FROM }),
      });
      const testData = await testRes.json();
      if (!testData.ok) {
        setError(testData.error ?? "Resend 测试失败");
        return;
      }
      // 测试成功，自动保存
      const saveRes = await fetch("/api/v1/settings/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: resendApiKey.trim(), from: RESEND_FROM }),
      });
      const saveData = await saveRes.json();
      if (saveData.ok) {
        setInfo("Resend 测试成功并已保存");
        checkEmailService();
      } else {
        setError(saveData.error ?? "保存失败");
      }
    } catch { setError("网络错误"); }
    finally { setTesting(false); }
  }

  async function listMails() {
    if (!selectedId) return;
    setLoadingMails(true); setError(""); setSelectedMail(null);
    try {
      const res = await fetch("/api/v1/email/imap/list", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: selectedId, limit: Number(mailLimit) || 20 }),
      });
      const data = await res.json();
      if (data.ok) setMailItems(data.items);
      else setError(data.error ?? "读取失败");
    } catch { setError("网络错误"); }
    finally { setLoadingMails(false); }
  }

  async function fetchMail(uid: number) {
    if (!selectedId) return;
    setLoadingMails(true); setError("");
    try {
      const res = await fetch("/api/v1/email/imap/fetch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: selectedId, uid }),
      });
      const data = await res.json();
      if (data.ok) {
        setSelectedMail(data.item);
        setMailContent(data.item.text || data.item.html || "");
      } else setError(data.error ?? "获取失败");
    } catch { setError("网络错误"); }
    finally { setLoadingMails(false); }
  }

  async function parseMail() {
    if (!mailContent.trim()) { setError("无邮件内容"); return; }
    setParsing(true); setError("");
    try {
      const res = await fetch("/api/v1/statement/parse", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: mailContent }),
      });
      const data = await res.json();
      if (data.ok) setParsedItems(data.items);
      else setError(data.error ?? "解析失败");
    } catch { setError("网络错误"); }
    finally { setParsing(false); }
  }

  async function importItems() {
    if (!parsedItems.length) return;
    setImporting(true); setError("");
    try {
      const res = await fetch("/api/v1/statement/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: parsedItems }),
      });
      const data = await res.json();
      if (data.ok) { setInfo(`导入完成: 创建 ${data.createdCount} 条, 跳过 ${data.skippedCount} 条`); setParsedItems([]); }
      else setError(data.error ?? "导入失败");
    } catch { setError("网络错误"); }
    finally { setImporting(false); }
  }

  const selectedAccount = accounts.find(a => a.id === selectedId);

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-800">邮箱设置</h2>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      {info && <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">{info}</div>}

      {/* 密码找回状态提示 */}
      <div className={`rounded-lg border p-4 ${hasEmailService ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${hasEmailService ? "bg-emerald-500" : "bg-amber-500"}`} />
          <div className="text-sm font-medium text-slate-800">密码找回功能</div>
        </div>
        {hasEmailService
          ? <div className="text-xs text-emerald-700 mt-1">已启用 — 已配置发件服务（SMTP 或 Resend），登录页将显示"忘记密码"入口</div>
          : <div className="text-xs text-amber-700 mt-1">未启用 — 请先配置邮箱账户（含 SMTP）或 Resend API Key，才能开启密码找回</div>
        }
      </div>

      {/* Resend 配置 */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="text-sm font-medium text-slate-800 mb-1">Resend 发件服务</div>
        <div className="text-xs text-slate-500 mb-3">填写 API Key 即可启用，发件地址固定为 {RESEND_FROM}</div>
        <div className="flex gap-3 items-end">
          <input className="h-9 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={resendApiKey} onChange={(e) => setResendApiKey(e.target.value)} placeholder="Resend API Key" />
          <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={testAndSaveResend} disabled={testing}>{testing ? "验证中…" : "验证并保存"}</button>
        </div>
      </div>

      {/* 邮箱账户添加表单 */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="text-sm font-medium text-slate-800 mb-3">添加邮箱账户</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="标签名，如 QQ邮箱" />
          <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="邮箱账号" autoComplete="username" />
          <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder="IMAP 主机，如 imap.qq.com" />
          <div className="flex gap-2">
            <input className="h-9 w-24 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={imapPort} onChange={(e) => setImapPort(e.target.value)} placeholder="端口" />
            <label className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 flex items-center gap-2">
              <input type="checkbox" checked={imapSecure} onChange={(e) => setImapSecure(e.target.checked)} />TLS
            </label>
          </div>
          <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="授权码" type="password" autoComplete="new-password" />
          <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={mailbox} onChange={(e) => setMailbox(e.target.value)} placeholder="邮箱文件夹，默认 INBOX" />
        </div>

        {/* SMTP 发件 */}
        <div className="mt-3 pt-3 border-t border-slate-100">
          <div className="text-xs font-medium text-slate-500 mb-2">SMTP 发件（可选）</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="SMTP 主机，如 smtp.qq.com" />
            <input className="h-9 w-24 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="端口" />
            <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} placeholder="发件地址，如 noreply@qq.com" />
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={saveAccount} disabled={saving}>{saving ? "保存中…" : "保存"}</button>
          <button className="h-9 px-4 rounded-md border border-slate-300 text-sm hover:bg-slate-50 disabled:opacity-50" onClick={testConnection} disabled={testing}>{testing ? "测试中…" : "测试连接"}</button>
        </div>
        {testResult && <div className="mt-2 text-xs text-emerald-700">{testResult}</div>}
      </div>

      {/* 账户列表 */}
      {accounts.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-sm font-medium text-slate-800 mb-3">已配置账户</div>
          <div className="space-y-2">
            {accounts.map(acc => (
              <div key={acc.id} className={`flex items-center justify-between p-3 rounded-md border cursor-pointer ${selectedId === acc.id ? "border-blue-300 bg-blue-50" : "border-slate-200 hover:bg-slate-50"}`}
                onClick={() => { setSelectedId(acc.id); setMailItems([]); setSelectedMail(null); setParsedItems([]); }}>
                <div>
                  <div className="text-sm font-medium text-slate-800">{acc.label}</div>
                  <div className="text-xs text-slate-500">{acc.username} · {acc.imapHost}{acc.smtpHost ? ` · SMTP ${acc.smtpHost}` : ""}</div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); deleteAccount(acc.id); }}
                  className="text-xs text-red-500 hover:text-red-700">删除</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 邮件操作区 */}
      {selectedAccount && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-sm font-medium text-slate-800 mb-3">{selectedAccount.label} - 邮箱操作</div>

          <div className="flex items-center gap-2 mb-3">
            <input className="h-9 w-20 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={mailLimit} onChange={(e) => setMailLimit(e.target.value)} placeholder="条数" />
            <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={listMails} disabled={loadingMails}>
              {loadingMails ? "读取中…" : "获取邮件列表"}
            </button>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="max-h-96 overflow-auto rounded-md border border-slate-200 divide-y divide-slate-100">
              {mailItems.map(m => (
                <button key={m.uid} className={`w-full text-left px-3 py-2 text-sm ${selectedMail?.uid === m.uid ? "bg-blue-50" : "hover:bg-slate-50"}`}
                  onClick={() => fetchMail(m.uid)}>
                  <div className="font-medium text-slate-800 truncate">{m.subject || "（无主题）"}</div>
                  <div className="text-xs text-slate-500">{m.from} · {m.date}</div>
                </button>
              ))}
              {mailItems.length === 0 && !loadingMails && (
                <div className="px-3 py-6 text-sm text-slate-500">点击"获取邮件列表"加载</div>
              )}
            </div>

            <div className="space-y-3">
              {selectedMail && (
                <>
                  <div className="text-xs text-slate-500">
                    发件人: {selectedMail.from} · 日期: {selectedMail.date}
                  </div>
                  <div className="max-h-64 overflow-auto rounded-md border border-slate-200 p-3 text-xs whitespace-pre-wrap text-slate-700">
                    {mailContent || "无内容"}
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="h-8 px-3 rounded-md border border-slate-300 text-xs hover:bg-slate-50 disabled:opacity-50" onClick={parseMail} disabled={parsing}>
                      {parsing ? "识别中…" : "AI 识别账单"}
                    </button>
                    {parsedItems.length > 0 && (
                      <button className="h-8 px-3 rounded-md bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-50" onClick={importItems} disabled={importing}>
                        {importing ? "导入中…" : `导入 (${parsedItems.length} 条)`}
                      </button>
                    )}
                  </div>
                </>
              )}
              {parsedItems.length > 0 && (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
                  <div className="text-xs font-medium text-emerald-800 mb-2">识别结果</div>
                  <div className="space-y-1.5 max-h-48 overflow-auto">
                    {parsedItems.map((item, i) => (
                      <div key={i} className="text-xs text-emerald-900">
                        {item.date} · {item.type} · {item.account ?? "?"} · {item.category ?? "?"} · {item.amount}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
