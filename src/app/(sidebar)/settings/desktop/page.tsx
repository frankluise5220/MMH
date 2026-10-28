"use client";

import { useEffect, useState } from "react";
import SettingsSwitch from "@/components/settings/SettingsSwitch";
import { getDesktopBridge, type MmhDesktopBridge } from "@/lib/client/desktop-bridge";
import { useI18n } from "@/lib/i18n";

export default function DesktopSettingsClient() {
  const { t } = useI18n();
  const [allowLan, setAllowLan] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Electron preload bridge (see electron/preload.cjs); null on web builds.
  const [bridge, setBridge] = useState<MmhDesktopBridge | null>(null);
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<{ kind: "upToDate" | "available" | "downloaded" | "error"; version?: string } | null>(null);

  const isDesktop = bridge !== null;

  useEffect(() => {
    fetch("/api/desktop/config")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setAllowLan(Boolean(d.data.allowLan));
          setLoaded(true);
        }
      })
      .catch(() => setLoaded(true));
  }, []);

  // Read the app version and subscribe to update lifecycle events. Runs once:
  // the bridge cannot appear after hydration in a window that lacks it.
  useEffect(() => {
    const current = getDesktopBridge();
    if (!current) return;
    setBridge(current);
    let unsub: (() => void) | undefined;
    current.getVersion().then((v) => setVersion(v)).catch(() => {});
    unsub = current.onUpdateStatus((s) => {
      if (s.type === "available") setUpdateMsg({ kind: "available", version: s.version });
      else if (s.type === "not-available") setUpdateMsg({ kind: "upToDate" });
      else if (s.type === "downloaded") setUpdateMsg({ kind: "downloaded", version: s.version });
      else if (s.type === "error") setUpdateMsg({ kind: "error" });
    });
    return () => unsub && unsub();
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/desktop/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowLan: next }),
      });
      const d = await res.json();
      if (d.ok) {
        setAllowLan(next);
        setSaved(true);
      }
    } finally {
      setSaving(false);
    }
  }

  async function checkUpdate() {
    if (!bridge || checking) return;
    setChecking(true);
    setUpdateMsg(null);
    try {
      const r = await bridge.checkForUpdates();
      if (!r.ok) {
        setUpdateMsg({ kind: "error" });
      } else if (r.upToDate) {
        setUpdateMsg({ kind: "upToDate" });
      }
      // A successful "available" result is delivered via onUpdateStatus.
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">{t("settings.desktop.title")}</h1>
        <p className="mt-1 text-xs text-slate-500">{t("settings.desktop.restartHint")}</p>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-900">{t("settings.desktop.allowLan")}</div>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {t("settings.desktop.allowLanDesc")}
            </p>
            <p className="mt-2 text-xs text-slate-400">
              {t("settings.desktop.currentBind")}：
              {loaded ? (allowLan ? t("settings.desktop.bindLan") : t("settings.desktop.bindLocal")) : "…"}
            </p>
          </div>
          <SettingsSwitch
            checked={allowLan}
            disabled={saving || !loaded}
            onCheckedChange={(next) => void toggle(next)}
            label={t("settings.desktop.allowLan")}
          />
        </div>
        {saved && (
          <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">
            {t("settings.desktop.restartHint")}
          </p>
        )}
      </section>

      {isDesktop && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900">{t("settings.desktop.update.title")}</div>
              <p className="mt-1 text-xs leading-5 text-slate-500">{t("settings.desktop.update.desc")}</p>
              <p className="mt-2 text-xs text-slate-400">
                {t("settings.desktop.update.currentVersion")}：{version || "…"}
              </p>
              {updateMsg && (
                <p
                  className={`mt-2 rounded-lg px-3 py-2 text-xs ${
                    updateMsg.kind === "error"
                      ? "bg-red-50 text-red-700"
                      : updateMsg.kind === "downloaded"
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-blue-50 text-blue-700"
                  }`}
                >
                  {updateMsg.kind === "upToDate"
                    ? t("settings.desktop.update.upToDate")
                    : updateMsg.kind === "available"
                      ? t("settings.desktop.update.available", { version: updateMsg.version ?? "" })
                      : updateMsg.kind === "downloaded"
                        ? t("settings.desktop.update.downloaded")
                        : t("settings.desktop.update.error")}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={checking}
              onClick={checkUpdate}
              className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
            >
              {checking ? t("settings.desktop.update.checking") : t("settings.desktop.update.check")}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
