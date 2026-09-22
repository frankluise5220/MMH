"use client";

import { useEffect, useState } from "react";
import {
  SettingsActionButton,
  SettingsPrimaryAddButton,
} from "@/components/settings/SettingsPageScaffold";
import { useI18n } from "@/lib/i18n";

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
  const { t } = useI18n();
  const [status, setStatus] = useState<EmailServiceStatus>({ hasEmailService: false, hasResend: false, hasSmtp: false });
  const [resendApiKey, setResendApiKey] = useState("");
  const [resendFrom, setResendFrom] = useState(RESEND_FROM);
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
        setEditingResend(false);
        setResendApiKey("");
        setResendFrom(data.data.from ?? RESEND_FROM);
      }
    } catch {
      setError(t("settings.passwordRecovery.loadResendFailed"));
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
      setError(t("settings.passwordRecovery.loadStatusFailed"));
    }
  }

  async function testAndSaveResend() {
    if (!resendApiKey.trim()) {
      setError(t("settings.passwordRecovery.enterApiKey"));
      return;
    }
    if (!resendFrom.trim()) {
      setError(t("settings.passwordRecovery.enterFrom"));
      return;
    }
    setTesting(true);
    setError("");
    setInfo("");
    try {
      const from = resendFrom.trim();
      const testRes = await fetch("/api/v1/settings/resend/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: resendApiKey.trim(), from }),
      });
      const testData = await testRes.json();
      if (!testData.ok) {
        setError(testData.error ?? t("settings.passwordRecovery.testFailed"));
        return;
      }

      const saveRes = await fetch("/api/v1/settings/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: resendApiKey.trim(), from }),
      });
      const saveData = await saveRes.json();
      if (!saveData.ok) {
        setError(saveData.error ?? t("settings.passwordRecovery.saveFailed"));
        return;
      }

      setInfo(t("settings.passwordRecovery.saved"));
      setResendApiKey("");
      setResendFrom(from);
      setEditingResend(false);
      await loadResendConfig();
      await checkEmailService();
    } catch {
      setError(t("settings.passwordRecovery.networkError"));
    } finally {
      setTesting(false);
    }
  }

  async function deleteResendConfig() {
    if (!confirm(t("settings.passwordRecovery.deleteConfirm"))) return;
    setSaving(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/v1/settings/resend", { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? t("settings.passwordRecovery.deleteFailed"));
        return;
      }
      setInfo(t("settings.passwordRecovery.deleted"));
      setResendApiKey("");
      setResendFrom(RESEND_FROM);
      await loadResendConfig();
      await checkEmailService();
    } catch {
      setError(t("settings.passwordRecovery.networkError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-800">{t("settings.passwordRecovery")}</h2>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      {info && <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">{info}</div>}

      <div className={`rounded-lg border p-4 ${status.hasEmailService ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${status.hasEmailService ? "bg-emerald-500" : "bg-amber-500"}`} />
          <div className="text-sm font-medium text-slate-800">{t("settings.passwordRecovery.featureTitle")}</div>
        </div>
        {status.hasEmailService ? (
          <div className="mt-1 text-xs text-emerald-700">
            {t("settings.passwordRecovery.enabled", { primary: status.hasSmtp ? "SMTP" : "Resend", fallback: status.hasSmtp && status.hasResend ? t("settings.passwordRecovery.resendFallback") : "" })}
          </div>
        ) : (
          <div className="mt-1 text-xs text-amber-700">{t("settings.passwordRecovery.disabled")}</div>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-slate-800">{t("settings.passwordRecovery.resendTitle")}</div>
            <div className="mt-1 text-xs text-slate-500">{t("settings.passwordRecovery.resendDescription")}</div>
          </div>
          {!editingResend && !resendConfig.configured ? (
            <SettingsPrimaryAddButton
              onClick={() => {
                setEditingResend(true);
                setResendFrom(resendConfig.from || RESEND_FROM);
                setError("");
                setInfo("");
              }}
            >
              {t("settings.passwordRecovery.addConfig")}
            </SettingsPrimaryAddButton>
          ) : null}
        </div>
        <div className="mb-3 rounded-md border border-sky-100 bg-sky-50 px-3 py-3">
          <div className="text-sm font-medium text-slate-800">{t("settings.passwordRecovery.getFreeKeyTitle")}</div>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-5 text-slate-600">
            <li>
              {t("settings.passwordRecovery.getFreeKeyStepRegister")}{" "}
              <a className="font-medium text-sky-700 hover:underline" href="https://resend.com/signup" target="_blank" rel="noreferrer">
                {t("settings.passwordRecovery.getFreeKeyRegisterLink")}
              </a>
            </li>
            <li>
              {t("settings.passwordRecovery.getFreeKeyStepDomain")}{" "}
              <a className="font-medium text-sky-700 hover:underline" href="https://resend.com/domains" target="_blank" rel="noreferrer">
                {t("settings.passwordRecovery.getFreeKeyDomainLink")}
              </a>
            </li>
            <li>
              {t("settings.passwordRecovery.getFreeKeyStepApiKey")}{" "}
              <a className="font-medium text-sky-700 hover:underline" href="https://resend.com/api-keys" target="_blank" rel="noreferrer">
                {t("settings.passwordRecovery.getFreeKeyApiKeyLink")}
              </a>
            </li>
          </ol>
          <div className="mt-2 text-xs leading-5 text-slate-500">{t("settings.passwordRecovery.getFreeKeyNote")}</div>
        </div>
        {resendConfig.configured && !editingResend ? (
          <div className="flex flex-col gap-3 rounded-md border border-slate-100 bg-slate-50 px-3 py-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-medium text-slate-800">{t("settings.passwordRecovery.configured")}</div>
              <div className="mt-1 text-xs text-slate-500">
                {resendConfig.keyPreview} · {resendConfig.from || RESEND_FROM} · {resendConfig.source === "env" ? t("settings.passwordRecovery.envVar") : t("settings.passwordRecovery.systemSetting")}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <SettingsActionButton
                label={t("settings.passwordRecovery.editResend")}
                variant="edit"
                onClick={() => {
                  setEditingResend(true);
                  setResendFrom(resendConfig.from || RESEND_FROM);
                }}
              />
              {resendConfig.canDelete && (
                <SettingsActionButton label={t("settings.passwordRecovery.deleteResend")} variant="delete" onClick={deleteResendConfig} disabled={saving} />
              )}
            </div>
          </div>
        ) : editingResend ? (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-xs text-slate-500">
                <span>{t("settings.passwordRecovery.apiKeyLabel")}</span>
                <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none" value={resendApiKey} onChange={(e) => setResendApiKey(e.target.value)} placeholder={t("settings.passwordRecovery.apiKeyPlaceholder")} type="password" autoComplete="new-password" />
              </label>
              <label className="space-y-1 text-xs text-slate-500">
                <span>{t("settings.passwordRecovery.fromLabel")}</span>
                <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none" value={resendFrom} onChange={(e) => setResendFrom(e.target.value)} placeholder={t("settings.passwordRecovery.fromPlaceholder")} type="email" autoComplete="email" />
              </label>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button className="h-9 rounded-md border border-slate-300 px-4 text-sm hover:bg-slate-50" onClick={() => { setEditingResend(false); setResendApiKey(""); setResendFrom(resendConfig.from || RESEND_FROM); }}>{t("common.cancel")}</button>
              <button className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700 disabled:opacity-50" onClick={testAndSaveResend} disabled={testing}>{testing ? t("settings.passwordRecovery.verifying") : t("settings.passwordRecovery.verifyAndSave")}</button>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm text-slate-400">
            {t("settings.passwordRecovery.noConfig")}
          </div>
        )}
      </div>
    </div>
  );
}
