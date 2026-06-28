"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, FileSpreadsheet, RotateCcw, Shield, Upload, RefreshCw } from "lucide-react";

const DEFAULT_ORIGINS_LABEL = "默认白名单：局域网 IP + localhost";
const RESET_CONFIRM_TEXT = "系统初始化";
const RESTORE_CONFIRM_TEXT = "恢复当前账簿";

function filenameFromDisposition(value: string | null) {
  if (!value) return "";
  const match = value.match(/filename="([^"]+)"/i);
  return match?.[1] ?? "";
}

async function downloadBackup(format: "json" | "xlsx") {
  const res = await fetch(`/api/v1/settings/backup?format=${format}`, { cache: "no-store" });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `下载失败（HTTP ${res.status}）`);
  }
  const blob = await res.blob();
  const fileName =
    filenameFromDisposition(res.headers.get("content-disposition")) ||
    `mmh-backup-${Date.now()}.${format === "xlsx" ? "xlsx" : "json"}`;
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
  return fileName;
}

export default function DatabaseSettingsPage() {
  const port = 49152;
  const [status, setStatus] = useState<"checking" | "running" | "stopped">("checking");
  const [loading, setLoading] = useState(false);

  const [origins, setOrigins] = useState<string[]>([]);
  const [originsLoading, setOriginsLoading] = useState(false);
  const [newOrigin, setNewOrigin] = useState("");
  const [originCheckEnabled, setOriginCheckEnabled] = useState(true);

  const [backuping, setBackuping] = useState<"" | "json" | "xlsx">("");
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

  useEffect(() => {
    void checkStatus();
    void loadOrigins();
  }, []);

  async function checkStatus() {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      setStatus(res.ok ? "running" : "stopped");
    } catch {
      setStatus("stopped");
    }
  }

  async function loadOrigins() {
    setOriginsLoading(true);
    try {
      const [originsRes, checkRes] = await Promise.all([
        fetch("/api/v1/settings/system?key=allowed_dev_origins"),
        fetch("/api/v1/settings/system?key=origin_check_enabled"),
      ]);
      const originsData = await originsRes.json();
      const checkData = await checkRes.json();
      if (originsData.ok && originsData.value) {
        setOrigins(
          (JSON.parse(originsData.value) as string[]).map((item) =>
            item.includes(":") ? item.split(":")[0] : item,
          ),
        );
      } else {
        setOrigins([]);
      }
      if (checkData.ok && checkData.value !== undefined) {
        setOriginCheckEnabled(checkData.value !== "false");
      }
    } catch {
      setOrigins([]);
    } finally {
      setOriginsLoading(false);
    }
  }

  async function saveOrigins(list: string[]) {
    try {
      await fetch("/api/v1/settings/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "allowed_dev_origins", value: JSON.stringify(list) }),
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
    const raw = newOrigin.trim();
    if (!raw) return;
    const value = raw.includes(":") ? raw.split(":")[0] : raw;
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

  async function handleBackup(format: "json" | "xlsx") {
    setBackuping(format);
    setBackupMessage("");
    setBackupError("");
    try {
      const fileName = await downloadBackup(format);
      setBackupMessage(`${format === "xlsx" ? "表格备份" : "恢复包"}已下载：${fileName}`);
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : "下载失败");
    } finally {
      setBackuping("");
    }
  }

  async function handleRestore() {
    if (!restoreFile) {
      setRestoreError("请选择恢复包文件");
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

  async function start() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/settings/prisma-studio", { method: "POST" });
      const data = await res.json();
      if (data.ok) setStatus("running");
      else window.alert(data.error || "启动失败");
    } catch {
      window.alert("启动失败");
    } finally {
      setLoading(false);
    }
  }

  async function stop() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/settings/prisma-studio", { method: "DELETE" });
      const data = await res.json();
      if (data.ok) setStatus("stopped");
      else window.alert(data.error || "停止失败");
    } catch {
      window.alert("停止失败");
    } finally {
      setLoading(false);
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
              表格备份用于查看和核对；打包备份用于完整恢复当前账簿。
            </div>
            <div className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
              `表格备份 (.xlsx)`：按工作表展开用户、账户、交易、基金、标签等数据。
              <br />
              `打包备份 (.json)`：用于恢复，会覆盖当前账簿中的现有数据。
            </div>
            {backupMessage ? <div className="mt-2 text-xs text-emerald-600">{backupMessage}</div> : null}
            {backupError ? <div className="mt-2 text-xs text-red-600">{backupError}</div> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleBackup("xlsx")}
              disabled={Boolean(backuping)}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <FileSpreadsheet className="h-4 w-4" />
              {backuping === "xlsx" ? "导出中..." : "表格备份"}
            </button>
            <button
              type="button"
              onClick={() => void handleBackup("json")}
              disabled={Boolean(backuping)}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-blue-200 bg-white px-3 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {backuping === "json" ? "导出中..." : "打包备份"}
            </button>
          </div>
        </div>

        <div className="mt-4 border-t border-slate-100 pt-4">
          <div className="text-sm font-medium text-slate-800">恢复当前账簿</div>
          <div className="mt-1 text-xs text-red-600">
            恢复会清空当前账簿后再写入备份内容。请先下载一份新的打包备份。
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_220px]">
            <label className="flex h-10 cursor-pointer items-center gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 text-sm text-slate-600 hover:border-blue-300 hover:bg-blue-50/40">
              <Upload className="h-4 w-4 shrink-0" />
              <span className="truncate">{restoreFile ? restoreFile.name : "选择 MMH 打包备份（.json）"}</span>
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
            <div className="text-sm font-medium text-slate-800">Prisma Studio</div>
            <div className="mt-0.5 text-xs text-slate-500">
              端口 {port}
              {status === "running" ? (
                <>
                  {" "}
                  |{" "}
                  <a
                    href={`http://127.0.0.1:${port}/`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    打开
                  </a>
                </>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 text-xs ${
                status === "running"
                  ? "bg-emerald-50 text-emerald-700"
                  : status === "stopped"
                    ? "bg-slate-100 text-slate-500"
                    : "bg-amber-50 text-amber-600"
              }`}
            >
              {status === "running" ? "运行中" : status === "stopped" ? "已停止" : "检测中..."}
            </span>
            {status === "running" ? (
              <button
                onClick={stop}
                disabled={loading}
                className="h-8 rounded-md border border-red-200 bg-white px-3 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                停止
              </button>
            ) : status === "stopped" ? (
              <button
                onClick={start}
                disabled={loading}
                className="h-8 rounded-md border border-blue-200 bg-white px-3 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50"
              >
                启动
              </button>
            ) : null}
          </div>
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

            <div className="mt-3 space-y-1.5">
              {origins.map((origin, index) => (
                <div key={origin} className="flex items-center gap-2">
                  <span className="text-sm text-slate-700">{origin}</span>
                  <button
                    onClick={() => void removeOrigin(index)}
                    className="text-xs text-red-500 hover:text-red-700 hover:underline"
                  >
                    删除
                  </button>
                </div>
              ))}
              {origins.length === 0 && !originsLoading ? (
                <div className="text-xs text-slate-400">暂无自定义白名单条目</div>
              ) : null}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <input
                type="text"
                value={newOrigin}
                onChange={(event) => setNewOrigin(event.target.value)}
                placeholder="域名或 IP，例如 mmh.example.com"
                className="h-8 w-56 rounded-md border border-slate-200 px-2 text-sm text-slate-700 focus:border-blue-300 focus:outline-none"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void addOrigin();
                }}
              />
              <button
                onClick={() => void addOrigin()}
                className="h-8 rounded-md border border-blue-200 bg-white px-3 text-sm text-blue-600 hover:bg-blue-50"
              >
                添加
              </button>
            </div>
          </>
        ) : null}
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
