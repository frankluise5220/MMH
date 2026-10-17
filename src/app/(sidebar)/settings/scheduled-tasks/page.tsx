"use client";

import { useEffect, useState } from "react";
import SettingsSwitch from "@/components/settings/SettingsSwitch";
import { useI18n } from "@/lib/i18n";

/**
 * Scheduled-task settings page.
 *
 * A single switch today: the **balance guard**. With it on, automatic execution
 * stops booking a task whose funding account cannot cover it and leaves the plan
 * marked as "execution failed"; only the notification panel's "ignore balance and
 * generate" (a manual entry point, which never checks the balance) spends anyway.
 */
export default function ScheduledTaskSettingsClient() {
  const { t } = useI18n();
  const [balanceGuard, setBalanceGuard] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v1/settings/scheduled-tasks", { cache: "no-store" })
      .then((res) => res.json())
      .then((body) => {
        if (body?.ok) setBalanceGuard(Boolean(body.data?.balanceGuard));
      })
      .catch(() => {
        // Keep the switch off when the read fails; the user can still toggle it.
      })
      .finally(() => setLoaded(true));
  }, []);

  async function toggle(next: boolean) {
    if (saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/v1/settings/scheduled-tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ balanceGuard: next }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(body?.error || t("settings.scheduledTasks.saveFailed"));
        return;
      }
      setBalanceGuard(Boolean(body.data?.balanceGuard));
      setSaved(true);
    } catch {
      setError(t("settings.scheduledTasks.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">{t("settings.scheduledTasks.title")}</h1>
        <p className="mt-1 text-xs text-slate-500">{t("settings.scheduledTasks.description")}</p>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-900">{t("settings.scheduledTasks.balanceGuard")}</div>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {t("settings.scheduledTasks.balanceGuardDesc")}
            </p>
          </div>
          <SettingsSwitch
            checked={balanceGuard}
            disabled={saving || !loaded}
            onCheckedChange={(next) => void toggle(next)}
            label={t("settings.scheduledTasks.balanceGuard")}
          />
        </div>

        {saved ? (
          <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            {t("settings.scheduledTasks.saved")}
          </p>
        ) : null}
        {error ? (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
        ) : null}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="text-xs font-medium text-slate-700">{t("settings.scheduledTasks.behaviourTitle")}</div>
        <ul className="mt-2 space-y-1.5 text-xs leading-5 text-slate-500">
          <li>· {t("settings.scheduledTasks.behaviour.guard")}</li>
          <li>· {t("settings.scheduledTasks.behaviour.force")}</li>
          <li>· {t("settings.scheduledTasks.behaviour.off")}</li>
        </ul>
      </section>
    </div>
  );
}
