"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, RotateCcw, Shield, Upload, RefreshCw } from "lucide-react";
import { generateRandomKey } from "@/lib/client/randomKey";
import {
  createLedgerInviteCodeRecord,
  parseLedgerInviteCodeRecords,
  serializeLedgerInviteCodeRecords,
  type LedgerInviteCodeRecord,
} from "@/lib/ledger-invite-codes";

const DEFAULT_ORIGINS_LABEL = "默认白名单：localhost、127.0.0.1、192.168.2.199；其他地址需手动添加";
const RESET_CONFIRM_TEXT = "系统初始化";
const RESTORE_CONFIRM_TEXT = "恢复当前账簿";
const LEDGER_INVITE_CODE_KEY = "ledger_creation_invite_code";

type SaveFilePickerHandle = {
  name?: string;
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

type WindowWithSavePicker = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<SaveFilePickerHandle>;
};

type BackupSaveResult = {
  fileName: string;
  pickedLocation: boolean;
};

type SettingsValuesResult = {
  ok?: boolean;
  values?: Record<string, string | null>;
  error?: string;
};

async function fetchJsonWithTimeout<T>(url: string, options?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs = 8000, ...fetchOptions } = options ?? {};
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null) as T | null;
    if (!res.ok || !data) {
      const maybeError = data as { error?: string } | null;
      throw new Error(maybeError?.error ?? `读取失败（HTTP ${res.status}）`);
    }
    return data;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("读取超时，请稍后重试");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function normalizeOriginHost(value: string) {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.split(":")[0]?.trim().toLowerCase() ?? "";
  }
}

function filenameFromDisposition(value: string | null) {
  if (!value) return "";
  const match = value.match(/filename="([^"]+)"/i);
  return match?.[1] ?? "";
}

function parseOriginList(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.map((item) => normalizeOriginHost(String(item ?? ""))).filter(Boolean)));
  } catch {
    return [];
  }
}

function formatInviteDateTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function saveDataBackup(): Promise<BackupSaveResult | null> {
  const res = await fetch("/api/v1/settings/backup?format=json", { cache: "no-store" });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `备份失败（HTTP ${res.status}）`);
  }
  const blob = await res.blob();
  const fileName =
    filenameFromDisposition(res.headers.get("content-disposition")) ||
    `mmh-backup-${Date.now()}.json`;
  const savePicker = (window as WindowWithSavePicker).showSaveFilePicker;
  if (savePicker) {
    try {
      const handle = await savePicker({
        suggestedName: fileName,
        types: [{ description: "MMH 数据备份 JSON", accept: { "application/json": [".json"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { fileName: handle.name || fileName, pickedLocation: true };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      throw error;
    }
  }

  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
  return { fileName, pickedLocation: false };
}

export default function DatabaseSettingsPage() {
  const [origins, setOrigins] = useState<string[]>([]);
  const [originsLoading, setOriginsLoading] = useState(false);
  const [newOrigin, setNewOrigin] = useState("");
  const [originCheckEnabled, setOriginCheckEnabled] = useState(true);
  const [ledgerInviteCode, setLedgerInviteCode] = useState("");
  const [ledgerInviteRecords, setLedgerInviteRecords] = useState<LedgerInviteCodeRecord[]>([]);
  const [ledgerInviteLoading, setLedgerInviteLoading] = useState(false);
  const [ledgerInviteSaving, setLedgerInviteSaving] = useState(false);
  const [ledgerInviteMessage, setLedgerInviteMessage] = useState("");
  const [ledgerInviteError, setLedgerInviteError] = useState("");

  const [backuping, setBackuping] = useState(false);
  const [backupMessage, setBackupMessage] = useState("");
  const [backupError, setBackupError] = useState("");

  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreConfirmText, setRestoreConfirmText] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState("");
  const [restoreError, setRestoreError] = useState("");

  const [resetConfirmText, setResetConfirmText] = useState("");
  const [resetDbPassword, setResetDbPassword] = useState("");
  const [resetError, setResetError] = useState("");
  const [resetting, setResetting] = useState(false);

  const [cacheRefreshing, setCacheRefreshing] = useState(false);
  const [cacheRefreshMessage, setCacheRefreshMessage] = useState("");
  const [cacheRefreshError, setCacheRefreshError] = useState("");

  const canRestore = useMemo(
    () => Boolean(restoreFile) && restoreConfirmText === RESTORE_CONFIRM_TEXT && !restoring,
    [restoreConfirmText, restoreFile, restoring],
  );
  const sortedLedgerInviteRecords = useMemo(
    () => [...ledgerInviteRecords].sort((a, b) => {
      if (Boolean(a.usedAt) !== Boolean(b.usedAt)) return a.usedAt ? 1 : -1;
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    }),
    [ledgerInviteRecords],
  );

  useEffect(() => {
    void loadDatabaseSettings();
  }, []);

  async function loadDatabaseSettings() {
    setOriginsLoading(true);
    setLedgerInviteLoading(true);
    setLedgerInviteError("");
    try {
      const keys = ["allowed_dev_origins", "origin_check_enabled", LEDGER_INVITE_CODE_KEY].join(",");
      const data = await fetchJsonWithTimeout<SettingsValuesResult>(
        `/api/v1/settings/system?keys=${encodeURIComponent(keys)}`,
        { cache: "no-store" },
      );
      if (!data.ok) {
        throw new Error(data.error ?? "读取数据库设置失败");
      }
      const values = data.values ?? {};
      setOrigins(parseOriginList(values.allowed_dev_origins));
      if (values.origin_check_enabled !== undefined && values.origin_check_enabled !== null) {
        setOriginCheckEnabled(values.origin_check_enabled !== "false");
      }
      setLedgerInviteRecords(parseLedgerInviteCodeRecords(values[LEDGER_INVITE_CODE_KEY]));
      setLedgerInviteCode("");
    } catch (error) {
      setOrigins([]);
      setLedgerInviteError(error instanceof Error ? error.message : "读取数据库设置失败");
    } finally {
      setOriginsLoading(false);
      setLedgerInviteLoading(false);
    }
  }

  async function saveLedgerInviteRecords(nextRecords: LedgerInviteCodeRecord[], successMessage: string) {
    setLedgerInviteSaving(true);
    setLedgerInviteError("");
    setLedgerInviteMessage("");
    try {
      const res = await fetch("/api/v1/settings/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: LEDGER_INVITE_CODE_KEY, value: serializeLedgerInviteCodeRecords(nextRecords) }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? "保存邀请码失败");
      }
      const normalized = parseLedgerInviteCodeRecords(serializeLedgerInviteCodeRecords(nextRecords));
      setLedgerInviteRecords(normalized);
      setLedgerInviteCode("");
      setLedgerInviteMessage(normalized.length > 0 ? successMessage : "已关闭登录页新建账簿");
    } catch (error) {
      setLedgerInviteError(error instanceof Error ? error.message : "保存邀请码失败");
    } finally {
      setLedgerInviteSaving(false);
    }
  }

  async function addLedgerInviteCode() {
    const code = ledgerInviteCode.trim();
    if (!code) {
      setLedgerInviteError("请输入邀请码");
      return;
    }
    if (ledgerInviteRecords.some((record) => record.code === code)) {
      setLedgerInviteError("邀请码已存在");
      return;
    }
    await saveLedgerInviteRecords([...ledgerInviteRecords, createLedgerInviteCodeRecord(code)], "邀请码已添加");
  }

  async function removeLedgerInviteCode(code: string) {
    const nextRecords = ledgerInviteRecords.filter((item) => item.code !== code);
    await saveLedgerInviteRecords(nextRecords, "邀请码已删除");
  }

  async function saveOrigins(list: string[]) {
    const normalized = Array.from(new Set(list.map(normalizeOriginHost).filter(Boolean)));
    try {
      await fetch("/api/v1/settings/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "allowed_dev_origins", value: JSON.stringify(normalized) }),
      });
    } catch {
      window.alert("保存失败");
    }
  }

  async function toggleOriginCheck(enabled: boolean) {
    setOriginCheckEnabled(enabled);
    await fetch("/api/v1/settings/system", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "origin_check_enabled", value: String(enabled) }),
    }).catch(() => {});
  }

  async function addOrigin() {
    const value = normalizeOriginHost(newOrigin);
    if (!value) return;
    if (origins.includes(value)) {
      setNewOrigin("");
      return;
    }
    const next = [...origins, value];
    setOrigins(next);
    setNewOrigin("");
    await saveOrigins(next);
  }

  async function removeOrigin(index: number) {
    const next = origins.filter((_, i) => i !== index);
    setOrigins(next);
    await saveOrigins(next);
  }

  async function handleBackup() {
    setBackuping(true);
    setBackupMessage("");
    setBackupError("");
    try {
      const result = await saveDataBackup();
      if (!result) return;
      setBackupMessage(
        result.pickedLocation
          ? `数据备份已保存：${result.fileName}`
          : `数据备份已开始下载：${result.fileName}。如未弹出保存位置，请在浏览器默认下载目录查看。`,
      );
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : "备份失败");
    } finally {
      setBackuping(false);
    }
  }

  async function handleRestore() {
    if (!restoreFile) {
      setRestoreError("请选择数据备份文件");
      return;
    }
    if (restoreConfirmText !== RESTORE_CONFIRM_TEXT) {
      setRestoreError("请输入正确的确认文字");
      return;
    }

    setRestoring(true);
    setRestoreError("");
    setRestoreMessage("");
    try {
      const form = new FormData();
      form.append("file", restoreFile);
      const res = await fetch("/api/v1/settings/backup", {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; message?: string; summary?: { counts?: Record<string, number> } }
        | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "恢复失败");
      }
      const count = data.summary?.counts?.transactions ?? 0;
      setRestoreMessage(`恢复完成，已写入 ${count} 条交易记录。页面将刷新。`);
      setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : "恢复失败");
    } finally {
      setRestoring(false);
    }
  }

  async function handleFactoryReset() {
    if (resetConfirmText !== RESET_CONFIRM_TEXT) {
      setResetError("请输入正确的确认文字");
      return;
    }
    if (!resetDbPassword.trim()) {
      setResetError("请输入数据库密码");
      return;
    }
    setResetting(true);
    setResetError("");
    try {
      const verifyRes = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetDbPassword, verifySystem: true }),
      });
      const verifyData = await verifyRes.json();
      if (!verifyData.ok) {
        setResetError(verifyData.error ?? "数据库密码错误");
        return;
      }

      const res = await fetch("/api/v1/settings/factory-reset", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        window.location.href = "/login";
      } else {
        setResetError(data.error ?? "操作失败");
      }
    } catch {
      setResetError("网络错误，请重试");
    } finally {
      setResetting(false);
    }
  }

  async function handleCacheRefresh() {
    setCacheRefreshing(true);
    setCacheRefreshMessage("");
    setCacheRefreshError("");
    try {
      const res = await fetch("/api/v1/settings/revalidate", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "刷新失败");
      }
      setCacheRefreshMessage("缓存已刷新，正在重新加载页面…");
      setTimeout(() => window.location.href = "/", 800);
    } catch (e) {
      setCacheRefreshError(e instanceof Error ? e.message : "刷新失败");
    } finally {
      setCacheRefreshing(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-800">数据库</h2>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-800">备份与恢复</div>
            <div className="mt-1 text-xs text-slate-500">
              保存当前账簿的数据备份，用于恢复当前账簿。
            </div>
            <div className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
              数据备份包含账簿基础资料、用户、账户、分类、标签、流水、投资、保险、计划任务等恢复当前账簿所需的数据。
            </div>
            {backupMessage ? <div className="mt-2 text-xs text-emerald-600">{backupMessage}</div> : null}
            {backupError ? <div className="mt-2 text-xs text-red-600">{backupError}</div> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleBackup()}
              disabled={backuping}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-blue-200 bg-white px-3 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {backuping ? "备份中..." : "数据备份"}
            </button>
          </div>
        </div>

        <div className="mt-4 border-t border-slate-100 pt-4">
          <div className="text-sm font-medium text-slate-800">恢复当前账簿</div>
          <div className="mt-1 text-xs text-red-600">
            恢复会清空当前账簿后再写入备份内容。请先保存一份新的数据备份。
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_220px]">
            <label className="flex h-10 cursor-pointer items-center gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 text-sm text-slate-600 hover:border-blue-300 hover:bg-blue-50/40">
              <Upload className="h-4 w-4 shrink-0" />
              <span className="truncate">{restoreFile ? restoreFile.name : "选择 MMH 数据备份（.json）"}</span>
              <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(event) => {
                  const nextFile = event.target.files?.[0] ?? null;
                  setRestoreFile(nextFile);
                  setRestoreError("");
                  setRestoreMessage("");
                }}
              />
            </label>
            <input
              value={restoreConfirmText}
              onChange={(event) => {
                setRestoreConfirmText(event.target.value);
                setRestoreError("");
              }}
              placeholder={RESTORE_CONFIRM_TEXT}
              className="h-10 rounded-md border border-slate-200 px-3 text-sm text-slate-700 outline-none focus:border-blue-400"
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void handleRestore()}
              disabled={!canRestore}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-red-600 px-4 text-sm text-white hover:bg-red-700 disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" />
              {restoring ? "恢复中..." : "开始恢复"}
            </button>
            <div className="text-xs text-slate-500">请输入“{RESTORE_CONFIRM_TEXT}”后才能恢复。</div>
          </div>
          {restoreMessage ? <div className="mt-2 text-xs text-emerald-600">{restoreMessage}</div> : null}
          {restoreError ? <div className="mt-2 text-xs text-red-600">{restoreError}</div> : null}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-slate-800">访问白名单</div>
            <div className="mt-0.5 text-xs text-slate-500">{DEFAULT_ORIGINS_LABEL}</div>
          </div>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={originCheckEnabled}
              onChange={(event) => void toggleOriginCheck(event.target.checked)}
            />
            <div className="h-5 w-9 rounded-full bg-slate-200 transition-colors after:absolute after:start-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all after:content-[''] peer-checked:bg-blue-600 peer-checked:after:translate-x-4" />
          </label>
        </div>

        {originCheckEnabled ? (
          <>
            <div className="mt-2 text-xs text-slate-500">
              添加允许访问本系统的域名或 IP，不在白名单内的来源会被拒绝。
            </div>

            <div className="mt-3 max-w-[560px] overflow-hidden rounded-md border border-slate-200 bg-white">
              <div className="grid grid-cols-[minmax(220px,1fr)_72px] border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500">
                <div>允许来源</div>
                <div className="text-right">操作</div>
              </div>
              <div className="max-h-52 overflow-y-auto">
                {originsLoading ? (
                  <div className="px-3 py-3 text-xs text-slate-400">正在读取白名单...</div>
                ) : origins.length > 0 ? (
                  origins.map((origin, index) => (
                    <div key={origin} className="grid grid-cols-[minmax(220px,1fr)_72px] items-center gap-2 border-b border-slate-50 px-3 py-2 text-xs last:border-b-0">
                      <span className="min-w-0 truncate text-slate-700" title={origin}>{origin}</span>
                      <button
                        type="button"
                        onClick={() => void removeOrigin(index)}
                        className="justify-self-end text-xs text-red-500 hover:text-red-700 hover:underline"
                      >
                        删除
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="border-b border-slate-50 px-3 py-3 text-xs text-slate-400">暂无自定义白名单条目</div>
                )}
                <div className="grid grid-cols-[minmax(220px,1fr)_72px] items-center gap-2 bg-slate-50/60 px-3 py-2">
                  <input
                    type="text"
                    value={newOrigin}
                    onChange={(event) => setNewOrigin(event.target.value)}
                    placeholder="域名或 IP，例如 mmh.example.com 或 192.168.2.149"
                    disabled={originsLoading}
                    className="h-8 min-w-0 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 focus:border-blue-300 focus:outline-none disabled:bg-slate-50"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void addOrigin();
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void addOrigin()}
                    disabled={originsLoading}
                    className="h-8 justify-self-end rounded-md border border-blue-200 bg-white px-3 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    添加
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-800">登录页新建账簿邀请码</div>
            <div className="mt-1 text-xs text-slate-500">
              邀请码只能使用一次。使用后会记录建立的账簿和使用时间，并自动失效。
            </div>
            {ledgerInviteMessage ? <div className="mt-2 text-xs text-emerald-600">{ledgerInviteMessage}</div> : null}
            {ledgerInviteError ? <div className="mt-2 text-xs text-red-600">{ledgerInviteError}</div> : null}
          </div>
        </div>
        <div className="mt-4 max-w-[860px] overflow-hidden rounded-md border border-slate-200 bg-white">
          <div className="grid grid-cols-[minmax(160px,1.2fr)_76px_minmax(140px,1fr)_128px_64px] border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500">
            <div>邀请码</div>
            <div>状态</div>
            <div>建立账簿</div>
            <div>使用时间</div>
            <div className="text-right">操作</div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {ledgerInviteLoading ? (
              <div className="px-3 py-3 text-xs text-slate-400">正在读取邀请码...</div>
            ) : sortedLedgerInviteRecords.length > 0 ? (
              sortedLedgerInviteRecords.map((record) => (
                <div key={record.code} className="grid grid-cols-[minmax(160px,1.2fr)_76px_minmax(140px,1fr)_128px_64px] items-center gap-2 border-b border-slate-50 px-3 py-2 text-xs last:border-b-0">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-slate-700" title={record.code}>{record.code}</div>
                    <div className="mt-0.5 text-[10px] text-slate-400">创建：{formatInviteDateTime(record.createdAt)}</div>
                  </div>
                  <div>
                    {record.usedAt ? (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">已使用</span>
                    ) : (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">可使用</span>
                    )}
                  </div>
                  <div className="min-w-0 truncate text-slate-600" title={record.usedHouseholdName || ""}>
                    {record.usedHouseholdName || "-"}
                  </div>
                  <div className="text-slate-500">{formatInviteDateTime(record.usedAt)}</div>
                  <button
                    type="button"
                    onClick={() => void removeLedgerInviteCode(record.code)}
                    disabled={ledgerInviteSaving}
                    className="justify-self-end text-xs text-red-500 hover:text-red-700 hover:underline disabled:opacity-50"
                  >
                    删除
                  </button>
                </div>
              ))
            ) : (
              <div className="px-3 py-3 text-xs text-slate-400">暂无已保存的邀请码</div>
            )}
            <div className="grid grid-cols-[minmax(160px,1.2fr)_76px_minmax(140px,1fr)_128px_64px] items-center gap-2 bg-slate-50/60 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <input
                  type="text"
                  value={ledgerInviteCode}
                  onChange={(event) => {
                    setLedgerInviteCode(event.target.value);
                    setLedgerInviteError("");
                    setLedgerInviteMessage("");
                  }}
                  placeholder={ledgerInviteLoading ? "读取中..." : "输入新的邀请码"}
                  disabled={ledgerInviteLoading || ledgerInviteSaving}
                  className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 focus:border-blue-300 focus:outline-none disabled:bg-slate-50"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void addLedgerInviteCode();
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    setLedgerInviteCode(generateRandomKey());
                    setLedgerInviteError("");
                    setLedgerInviteMessage("");
                  }}
                  disabled={ledgerInviteLoading || ledgerInviteSaving}
                  className="shrink-0 text-xs text-blue-600 hover:text-blue-700 hover:underline disabled:opacity-50"
                >
                  随机填入
                </button>
              </div>
              <div className="text-xs text-slate-400">新增</div>
              <div className="text-xs text-slate-400">-</div>
              <div className="text-xs text-slate-400">-</div>
              <button
                type="button"
                onClick={() => void addLedgerInviteCode()}
                disabled={ledgerInviteLoading || ledgerInviteSaving}
                className="justify-self-end text-xs text-blue-600 hover:text-blue-700 hover:underline disabled:opacity-50"
              >
                {ledgerInviteSaving ? "保存中" : "添加"}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-800">刷新服务端缓存</div>
            <div className="mt-1 text-xs text-slate-500">
              当数据库被外部工具直接修改（例如批量删除重复记录、Prisma Studio 编辑）后，页面可能仍显示旧数据。点击此处强制刷新服务端缓存，让 Web 重新读取最新数据。
            </div>
            {cacheRefreshMessage ? <div className="mt-2 text-xs text-emerald-600">{cacheRefreshMessage}</div> : null}
            {cacheRefreshError ? <div className="mt-2 text-xs text-red-600">{cacheRefreshError}</div> : null}
          </div>
          <button
            type="button"
            onClick={() => void handleCacheRefresh()}
            disabled={cacheRefreshing}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${cacheRefreshing ? "animate-spin" : ""}`} />
            {cacheRefreshing ? "刷新中..." : "刷新缓存"}
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-red-200 bg-red-50 p-4">
        <div className="text-sm font-medium text-red-800">系统初始化</div>
        <div className="mt-0.5 text-xs text-red-600">
          此操作不可撤销，将删除所有账簿、交易、账户、分类、用户等数据，恢复到第一次安装完成后的状态。
        </div>

        <div className="mt-3 space-y-3">
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">
              请输入 <span className="font-bold text-red-700">{RESET_CONFIRM_TEXT}</span> 以确认操作
            </div>
            <input
              value={resetConfirmText}
              onChange={(event) => {
                setResetConfirmText(event.target.value);
                setResetError("");
              }}
              className="h-9 w-64 rounded-md border border-red-200 bg-white px-3 text-sm outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100"
              placeholder={RESET_CONFIRM_TEXT}
              autoComplete="off"
            />
          </div>

          <div className="border-t border-red-100 pt-2">
            <div className="mb-1 flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span className="text-xs font-medium text-amber-700">数据库密码验证</span>
            </div>
            <input
              type="password"
              value={resetDbPassword}
              onChange={(event) => {
                setResetDbPassword(event.target.value);
                setResetError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleFactoryReset();
              }}
              className="h-9 w-64 rounded-md border border-amber-200 bg-white px-3 text-sm outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
              placeholder="输入数据库密码"
              autoComplete="off"
            />
            <div className="mt-1 text-[10px] text-slate-400">系统初始化前必须验证数据库密码。</div>
          </div>

          {resetError ? <div className="text-sm text-red-600">{resetError}</div> : null}

          <button
            type="button"
            onClick={() => void handleFactoryReset()}
            disabled={resetting || resetConfirmText !== RESET_CONFIRM_TEXT || !resetDbPassword.trim()}
            className="h-9 rounded-md bg-red-600 px-4 text-sm text-white hover:bg-red-700 disabled:opacity-50"
          >
            {resetting ? "执行中..." : "系统初始化"}
          </button>
        </div>
      </section>
    </div>
  );
}
