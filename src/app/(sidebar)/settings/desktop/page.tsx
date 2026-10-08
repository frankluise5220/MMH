"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

// Electron preload bridge (see electron/preload.cjs). Only present when the
// app runs inside the desktop shell.
type UpdateStatus =
  | { type: "available"; version: string }
  | { type: "not-available"; version: string }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "error"; message: string };

type MmhDesktopBridge = {
  checkForUpdates: () => Promise<{ ok: boolean; version?: string; upToDate?: boolean; error?: string }>;
  getVersion: () => Promise<string>;
  onUpdateStatus: (cb: (s: UpdateStatus) => void) => () => void;
};

declare global {
  interface Window {
    mmhDesktop?: MmhDesktopBridge;
  }
}

export default function DesktopSettingsClient() {
  const { t } = useI18n();
  const [allowLan, setAllowLan] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<{ kind: "upToDate" | "available" | "downloaded" | "error"; version?: string } | null>(null);

  const isDesktop = typeof window !== "undefined" && !!window.mmhDesktop;

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

  // Read the app version and subscribe to update lifecycle events.
  useEffect(() => {
    if (!isDesktop) return;
    let unsub: (() => void) | undefined;
    window.mmhDesktop!.getVersion().then((v) => setVersion(v)).catch(() => {});
    unsub = window.mmhDesktop!.onUpdateStatus((s) => {
      if (s.type === "available") setUpdateMsg({ kind: "available", version: s.version });
      else if (s.type === "not-available") setUpdateMsg({ kind: "upToDate" });
      else if (s.type === "downloaded") setUpdateMsg({ kind: "downloaded", version: s.version });
      else if (s.type === "error") setUpdateMsg({ kind: "error" });
    });
    return () => unsub && unsub();
  }, [isDesktop]);

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
    if (!isDesktop || checking) return;
    setChecking(true);
    setUpdateMsg(null);
    try {
      const r = await window.mmhDesktop!.checkForUpdates();
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
          <button
            type="button"
            disabled={saving || !loaded}
            onClick={() => toggle(!allowLan)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              allowLan ? "bg-blue-600" : "bg-slate-300"
            } disabled:opacity-50`}
            aria-pressed={allowLan}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                allowLan ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
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
