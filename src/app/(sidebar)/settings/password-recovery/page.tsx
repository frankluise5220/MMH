"use client";

import { useEffect, useState } from "react";

const RESEND_FROM = "mmh@floatingice.win";

type EmailServiceStatus = {
  hasEmailService: boolean;
  hasResend: boolean;
  hasSmtp: boolean;
};

type ResendConfig = {
  configured: boolean;
  keyPreview: string;
  from: string;
  source: "db" | "env" | "none";
  canDelete: boolean;
};

export default function PasswordRecoverySettingsPage() {
  const [status, setStatus] = useState<EmailServiceStatus>({ hasEmailService: false, hasResend: false, hasSmtp: false });
  const [resendApiKey, setResendApiKey] = useState("");
  const [resendConfig, setResendConfig] = useState<ResendConfig>({ configured: false, keyPreview: "", from: RESEND_FROM, source: "none", canDelete: false });
  const [editingResend, setEditingResend] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  useEffect(() => {
    loadResendConfig();
    checkEmailService();
  }, []);

  async function loadResendConfig() {
    try {
      const res = await fetch("/api/v1/settings/resend");
      const data = await res.json();
      if (data.ok && data.data) {
        setResendConfig({
          configured: Boolean(data.data.configured),
          keyPreview: data.data.keyPreview ?? "",
          from: data.data.from ?? RESEND_FROM,
          source: data.data.source ?? "none",
          canDelete: Boolean(data.data.canDelete),
        });
        setEditingResend(!data.data.configured);
        setResendApiKey("");
      }
    } catch {
      setError("读取 Resend 配置失败");
    }
  }

  async function checkEmailService() {
    try {
      const res = await fetch("/api/v1/settings/email/status");
      const data = await res.json();
      if (data.ok) {
        setStatus({
          hasEmailService: Boolean(data.hasEmailService),
          hasResend: Boolean(data.hasResend),
          hasSmtp: Boolean(data.hasSmtp),
        });
      }
    } catch {
      setError("读取密码找回状态失败");
    }
  }

  async function testAndSaveResend() {
    if (!resendApiKey.trim()) {
      setError("请填写 Resend API Key");
      return;
    }
    setTesting(true);
    setError("");
    setInfo("");
    try {
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

      const saveRes = await fetch("/api/v1/settings/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: resendApiKey.trim(), from: RESEND_FROM }),
      });
      const saveData = await saveRes.json();
      if (!saveData.ok) {
        setError(saveData.error ?? "保存失败");
        return;
      }

      setInfo("Resend 测试成功并已保存");
      setResendApiKey("");
      setEditingResend(false);
      await loadResendConfig();
      await checkEmailService();
    } catch {
      setError("网络错误");
    } finally {
      setTesting(false);
    }
  }

  async function deleteResendConfig() {
    if (!confirm("确定删除 Resend 发件配置？")) return;
    setSaving(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/v1/settings/resend", { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "删除失败");
        return;
      }
      setInfo("Resend 配置已删除");
      setResendApiKey("");
      await loadResendConfig();
      await checkEmailService();
    } catch {
      setError("网络错误");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-800">密码找回</h2>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      {info && <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">{info}</div>}

      <div className={`rounded-lg border p-4 ${status.hasEmailService ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${status.hasEmailService ? "bg-emerald-500" : "bg-amber-500"}`} />
          <div className="text-sm font-medium text-slate-800">密码找回功能</div>
        </div>
        {status.hasEmailService ? (
          <div className="mt-1 text-xs text-emerald-700">
            已启用，登录页会显示“忘记密码”。当前优先使用 {status.hasResend ? "Resend" : "SMTP"}{status.hasResend && status.hasSmtp ? "，SMTP 作为备用" : ""}。
          </div>
        ) : (
          <div className="mt-1 text-xs text-amber-700">未启用，请配置 SMTP 邮箱账户或 Resend 发件服务。</div>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="text-sm font-medium text-slate-800 mb-1">Resend 发件服务</div>
        <div className="text-xs text-slate-500 mb-3">API Key 保存后只显示摘要；需要更换时点修改，删除后密码找回会自动重新检测。</div>
        {resendConfig.configured && !editingResend ? (
          <div className="flex flex-col gap-3 rounded-md border border-slate-100 bg-slate-50 px-3 py-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-medium text-slate-800">已配置 Resend</div>
              <div className="mt-1 text-xs text-slate-500">
                {resendConfig.keyPreview} · {resendConfig.from || RESEND_FROM} · {resendConfig.source === "env" ? "环境变量" : "系统设置"}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button className="h-8 px-3 rounded-md border border-slate-300 text-xs hover:bg-white" onClick={() => setEditingResend(true)}>修改</button>
              {resendConfig.canDelete && (
                <button className="h-8 px-3 rounded-md border border-red-200 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50" onClick={deleteResendConfig} disabled={saving}>删除</button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex gap-3 items-end">
            <input className="h-9 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={resendApiKey} onChange={(e) => setResendApiKey(e.target.value)} placeholder="填写新的 Resend API Key" type="password" autoComplete="new-password" />
            <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={testAndSaveResend} disabled={testing}>{testing ? "验证中…" : "验证并保存"}</button>
            {resendConfig.configured && (
              <button className="h-9 px-4 rounded-md border border-slate-300 text-sm hover:bg-slate-50" onClick={() => { setEditingResend(false); setResendApiKey(""); }}>取消</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
