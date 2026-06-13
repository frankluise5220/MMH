"use client";

import { useEffect, useState } from "react";
import { Shield } from "lucide-react";

export default function SettingsEmailPage() {
  // 发件 - SMTP
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [smtpFrom, setSmtpFrom] = useState("");
  // 发件 - Resend
  const [resendApiKey, setResendApiKey] = useState("");
  const [resendFrom, setResendFrom] = useState("");
  // 收件 - IMAP
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapSecure, setImapSecure] = useState(true);
  const [imapUser, setImapUser] = useState("");
  const [imapPass, setImapPass] = useState("");
  const [imapMailbox, setImapMailbox] = useState("INBOX");
  // 功能开关
  const [passwordResetEnabled, setPasswordResetEnabled] = useState(true);

  const [outboundTab, setOutboundTab] = useState<"smtp" | "resend">("smtp");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // 测试发件
  const [testTo, setTestTo] = useState("");
  const [testSending, setTestSending] = useState(false);

  // 测试收件
  const [testingImap, setTestingImap] = useState(false);

  useEffect(() => {
    fetch("/api/v1/settings/email")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.data) {
          setSmtpHost(d.data.smtpHost ?? "");
          setSmtpPort(String(d.data.smtpPort ?? "465"));
          setSmtpSecure(d.data.smtpSecure !== false);
          setSmtpUser(d.data.smtpUser ?? "");
          setSmtpPass(d.data.smtpPass ?? "");
          setSmtpFrom(d.data.smtpFrom ?? "");
          setResendApiKey(d.data.resendApiKey ?? "");
          setResendFrom(d.data.resendFrom ?? "");
          setImapHost(d.data.emailHost ?? "");
          setImapPort(String(d.data.emailPort ?? "993"));
          setImapSecure(d.data.emailSecure !== false);
          setImapUser(d.data.emailUser ?? "");
          setImapPass(d.data.emailPassword ?? "");
          setImapMailbox(d.data.emailMailbox ?? "INBOX");
          setPasswordResetEnabled(d.data.passwordResetEnabled !== false);
        }
      })
      .catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/v1/settings/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          smtpHost, smtpPort: Number(smtpPort) || 465, smtpSecure,
          smtpUser, smtpPass, smtpFrom,
          resendApiKey, resendFrom,
          emailHost: imapHost, emailPort: Number(imapPort) || 993, emailSecure: imapSecure,
          emailUser: imapUser, emailPassword: imapPass, emailMailbox: imapMailbox,
          passwordResetEnabled,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setInfo("保存成功");
      } else {
        setError(data.error ?? "保存失败");
      }
    } catch {
      setError("网络错误");
    } finally {
      setSaving(false);
    }
  }

  async function testSend() {
    if (!testTo.trim()) { setError("请输入测试收件邮箱"); return; }
    setTestSending(true); setError(""); setInfo("");
    try {
      const res = await fetch("/api/v1/settings/email/test-send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testTo.trim() }),
      });
      const data = await res.json();
      if (data.ok) setInfo("测试邮件发送成功，请检查收件箱。");
      else setError(data.error ?? "发送失败");
    } catch { setError("网络错误"); }
    finally { setTestSending(false); }
  }

  async function testImap() {
    if (!imapHost || !imapUser || !imapPass) { setError("请先填写 IMAP 服务器配置"); return; }
    setTestingImap(true); setError(""); setInfo("");
    try {
      const res = await fetch("/api/v1/email/imap/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: imapHost, port: Number(imapPort) || 993, secure: imapSecure, user: imapUser, password: imapPass, mailbox: imapMailbox || "INBOX" }),
      });
      const data = await res.json();
      if (data.ok) setInfo("IMAP 连接测试成功");
      else setError(data.error ?? "连接失败");
    } catch { setError("网络错误"); }
    finally { setTestingImap(false); }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-800">邮箱配置</h2>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      {info && <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">{info}</div>}

      {/* 1. 发件服务器 */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="text-sm font-medium text-slate-800">发件服务器</div>
        <div className="text-xs text-slate-500 mt-0.5 mb-3">
          配置后可用于激活"找回密码"功能及系统通知邮件。
        </div>

        <div className="flex gap-1 bg-slate-100 rounded-md p-0.5 w-fit mb-3">
          <button className={`px-3 py-1 rounded text-xs font-medium ${outboundTab === "smtp" ? "bg-white shadow text-slate-800" : "text-slate-500"}`}
            onClick={() => setOutboundTab("smtp")}>SMTP</button>
          <button className={`px-3 py-1 rounded text-xs font-medium ${outboundTab === "resend" ? "bg-white shadow text-slate-800" : "text-slate-500"}`}
            onClick={() => setOutboundTab("resend")}>Resend</button>
        </div>

        {outboundTab === "smtp" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="SMTP 主机，如 smtp.qq.com" />
            <div className="flex gap-2">
              <input className="h-9 w-24 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="端口" />
              <label className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 flex items-center gap-2">
                <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />SSL
              </label>
            </div>
            <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="用户名" />
            <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} placeholder="密码/授权码" type="password" />
            <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} placeholder="发件地址，如 noreply@example.com" />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={resendApiKey} onChange={(e) => setResendApiKey(e.target.value)} placeholder="Resend API Key" />
            <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={resendFrom} onChange={(e) => setResendFrom(e.target.value)} placeholder="发件地址，如 noreply@example.com" />
          </div>
        )}

        <div className="mt-3 pt-3 border-t border-slate-100">
          <div className="text-xs text-slate-500 mb-2">发送测试邮件以验证配置</div>
          <div className="flex items-center gap-2">
            <input className="h-9 w-64 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="目标邮箱" />
            <button className="h-9 px-4 rounded-md border border-slate-300 text-sm hover:bg-slate-50 disabled:opacity-50" onClick={testSend} disabled={testSending}>{testSending ? "发送中…" : "发送测试邮件"}</button>
          </div>
        </div>
      </div>

      {/* 2. 收件服务器 */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="text-sm font-medium text-slate-800">收件服务器</div>
        <div className="text-xs text-slate-500 mt-0.5 mb-3">
          配置后可读取邮箱中的银行账单邮件，自动识别并导入交易记录。
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder="IMAP 主机，如 imap.qq.com" />
          <div className="flex gap-2">
            <input className="h-9 w-24 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={imapPort} onChange={(e) => setImapPort(e.target.value)} placeholder="端口" />
            <label className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 flex items-center gap-2">
              <input type="checkbox" checked={imapSecure} onChange={(e) => setImapSecure(e.target.checked)} />TLS
            </label>
          </div>
          <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={imapUser} onChange={(e) => setImapUser(e.target.value)} placeholder="邮箱账号" />
          <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={imapPass} onChange={(e) => setImapPass(e.target.value)} placeholder="授权码/客户端密码" type="password" />
          <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={imapMailbox} onChange={(e) => setImapMailbox(e.target.value)} placeholder="邮箱文件夹，默认 INBOX" />
        </div>

        <div className="mt-3 pt-3 border-t border-slate-100">
          <button className="h-9 px-4 rounded-md border border-slate-300 text-sm hover:bg-slate-50 disabled:opacity-50" onClick={testImap} disabled={testingImap}>{testingImap ? "测试中…" : "测试连接"}</button>
        </div>
      </div>

      {/* 3. 功能开关 */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-slate-800">Wiseme 密码找回</div>
            <div className="text-xs text-slate-500 mt-0.5">开启后，登录页将显示"忘记密码"入口，用户可通过邮箱验证码重置密码。需要先配置发件服务器。</div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" className="sr-only peer" checked={passwordResetEnabled} onChange={(e) => setPasswordResetEnabled(e.target.checked)} />
            <div className="w-9 h-5 bg-slate-200 peer-checked:bg-blue-600 rounded-full peer transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
      </div>

      {/* 保存 */}
      <button className="h-9 px-6 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={save} disabled={saving}>{saving ? "保存中…" : "保存配置"}</button>
    </div>
  );
}