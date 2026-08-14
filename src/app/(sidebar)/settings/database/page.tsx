"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, RotateCcw, Shield, Upload, RefreshCw } from "lucide-react";
import {
  SettingsActionButton,
  SettingsEmptyRow,
  SettingsRowActions,
  SettingsTable,
  SettingsTd,
  SettingsTh,
} from "@/components/settings/SettingsPageScaffold";
import { generateRandomKey } from "@/lib/client/randomKey";
import {
  createLedgerInviteCodeRecord,
  parseLedgerInviteCodeRecords,
  serializeLedgerInviteCodeRecords,
  type LedgerInviteCodeRecord,
} from "@/lib/ledger-invite-codes";
import {
  isAccessHostnameAllowed,
  isDefaultAllowedAccessHostname,
  normalizeAccessHostname,
  normalizeAllowedAccessList,
  parseAllowedAccessList,
} from "@/lib/access-whitelist";

const ACCESS_WHITELIST_HINT = "开启后只允许名单内的访问域名或 IP 打开 MMH。";
const LEDGER_INVITE_CODE_KEY = "ledger_creation_invite_code";

type SaveFilePickerHandle = {
  name?: string;
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

type OpenFilePickerHandle = {
  getFile: () => Promise<File>;
};

const RESTORE_FILE_PICKER_TYPES = [
  {
    description: "MMH 备份文件",
    accept: {
      "application/json": [".mmh-backup"],
    },
  },
];

type WindowWithFilePickers = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<SaveFilePickerHandle>;
  showOpenFilePicker?: (options: {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<OpenFilePickerHandle[]>;
};

type BackupSaveResult = {
  fileName: string;
  pickedLocation: boolean;
};

type SensitiveOperationCredentials = {
  userPassword: string;
  backupPassphrase?: string;
  backupScope?: "system" | "household";
};

type SettingsValuesResult = {
  ok?: boolean;
  values?: Record<string, string | null>;
  error?: string;
};

type RestoreResponse = {
  ok?: boolean;
  error?: string;
  message?: string;
  restoreId?: string;
  task?: RestoreTask;
  summary?: { counts?: Record<string, number> };
};

type RestoreProgressStage = "idle" | "uploading" | "preparing" | "clearing" | "importing" | "restoring" | "finalizing" | "done";

type RestoreProgressState = {
  stage: RestoreProgressStage;
  percent: number;
  label: string;
  detail?: string;
};

type RestoreTask = {
  id: string;
  status: "queued" | "running" | "success" | "error";
  progress?: RestoreProgressState;
  summary?: { counts?: Record<string, number> };
  error?: string;
};

const RESTORE_PROGRESS_IDLE: RestoreProgressState = {
  stage: "idle",
  percent: 0,
  label: "",
};

const RESTORE_STAGE_ORDER: Record<RestoreProgressStage, number> = {
  idle: -1,
  uploading: 0,
  preparing: 1,
  clearing: 2,
  importing: 3,
  restoring: 4,
  finalizing: 5,
  done: 6,
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

function filenameFromDisposition(value: string | null) {
  if (!value) return "";
  const encodedMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch {
      return encodedMatch[1];
    }
  }
  const match = value.match(/filename="([^"]+)"/i);
  return match?.[1] ?? "";
}

function parseOriginList(value: string | null | undefined) {
  return parseAllowedAccessList(value);
}

function getCurrentAccessHost() {
  if (typeof window === "undefined") return "";
  return normalizeAccessHostname(window.location.hostname);
}

function formatInviteDateTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function saveDataBackup(credentials: SensitiveOperationCredentials): Promise<BackupSaveResult | null> {
  const res = await fetch("/api/v1/settings/backup?mode=export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userPassword: credentials.userPassword,
      backupPassphrase: credentials.backupPassphrase ?? "",
      backupScope: credentials.backupScope ?? "household",
    }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `备份失败（HTTP ${res.status}）`);
  }
  const blob = await res.blob();
  const fileName =
    filenameFromDisposition(res.headers.get("content-disposition")) ||
    `mmh-backup-${Date.now()}.mmh-backup`;
  const savePicker = (window as WindowWithFilePickers).showSaveFilePicker;
  if (savePicker) {
    try {
      const handle = await savePicker({
        suggestedName: fileName,
        types: [{ description: "MMH 加密数据备份", accept: { "application/json": [".mmh-backup"] } }],
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

async function saveDataTableExport(): Promise<BackupSaveResult | null> {
  const res = await fetch("/api/v1/settings/backup?mode=table-export", {
    method: "POST",
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `导出表格失败（HTTP ${res.status}）`);
  }
  const blob = await res.blob();
  const fileName =
    filenameFromDisposition(res.headers.get("content-disposition")) ||
    `mmh-table-export-${Date.now()}.xlsx`;
  const savePicker = (window as WindowWithFilePickers).showSaveFilePicker;
  if (savePicker) {
    try {
      const handle = await savePicker({
        suggestedName: fileName,
        types: [
          {
            description: "MMH 表格导出",
            accept: {
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
            },
          },
        ],
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

function parseRestoreResponseText(value: string) {
  try {
    return JSON.parse(value) as RestoreResponse;
  } catch {
    return null;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeRestoreProgress(progress: RestoreProgressState | undefined, fallback: RestoreProgressState) {
  if (!progress) return fallback;
  return {
    stage: progress.stage,
    percent: Math.max(fallback.percent, Math.max(0, Math.min(100, Math.round(progress.percent)))),
    label: progress.label || fallback.label,
    detail: progress.detail,
  };
}

async function pollRestoreTask(
  restoreId: string,
  onProgress: (progress: RestoreProgressState) => void,
): Promise<RestoreResponse> {
  const deadline = Date.now() + 30 * 60 * 1000;
  let failedPolls = 0;
  let lastProgress: RestoreProgressState = {
    stage: "preparing",
    percent: 35,
    label: "等待恢复",
    detail: "备份文件已上传，正在等待服务端恢复进度",
  };

  while (Date.now() < deadline) {
    await delay(1000);
    try {
      const res = await fetch(
        `/api/v1/settings/backup?mode=restore-status&id=${encodeURIComponent(restoreId)}`,
        { cache: "no-store" },
      );
      const data = (await res.json().catch(() => null)) as RestoreResponse | null;
      if (!res.ok || !data?.ok || !data.task) {
        throw new Error(data?.error || `读取恢复进度失败（HTTP ${res.status}）`);
      }
      failedPolls = 0;
      lastProgress = normalizeRestoreProgress(data.task.progress, lastProgress);
      onProgress(lastProgress);

      if (data.task.status === "success") {
        return {
          ok: true,
          message: "恢复完成",
          summary: data.task.summary,
          task: data.task,
          restoreId,
        };
      }
      if (data.task.status === "error") {
        throw new Error(data.task.error || data.task.progress?.detail || "恢复失败");
      }
    } catch (error) {
      failedPolls += 1;
      if (failedPolls >= 5) {
        throw error instanceof Error ? error : new Error("恢复进度查询失败");
      }
      onProgress({
        ...lastProgress,
        detail: "正在等待服务响应，恢复任务仍在后台执行",
      });
    }
  }

  throw new Error("恢复任务超过 30 分钟仍未完成，请检查服务日志");
}

function restoreDataBackup(
  form: FormData,
  onProgress: (progress: RestoreProgressState) => void,
): Promise<RestoreResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        const uploadPercent = Math.max(3, Math.min(35, Math.round((event.loaded / event.total) * 35)));
        onProgress({
          stage: "uploading",
          percent: uploadPercent,
          label: `上传中 ${Math.round((event.loaded / event.total) * 100)}%`,
          detail: "正在上传备份文件",
        });
        return;
      }
      onProgress({
        stage: "uploading",
        percent: 8,
        label: "上传中",
        detail: "正在上传备份文件",
      });
    };

    xhr.upload.onload = () => {
      onProgress({
        stage: "preparing",
        percent: 35,
        label: "等待服务端",
        detail: "备份文件已上传，正在创建恢复任务",
      });
    };

    xhr.onload = async () => {
      const data = parseRestoreResponseText(xhr.responseText);
      if (xhr.status < 200 || xhr.status >= 300 || !data?.ok) {
        reject(new Error(data?.error || `恢复失败（HTTP ${xhr.status}）`));
        return;
      }
      const restoreId = data.restoreId || data.task?.id;
      if (!restoreId) {
        reject(new Error("服务端没有返回恢复任务编号"));
        return;
      }
      if (data.task?.progress) {
        onProgress(normalizeRestoreProgress(data.task.progress, {
          stage: "preparing",
          percent: 35,
          label: "等待恢复",
        }));
      }
      try {
        resolve(await pollRestoreTask(restoreId, onProgress));
      } catch (error) {
        reject(error);
      }
    };

    xhr.onerror = () => {
      reject(new Error("网络错误，请重试"));
    };
    xhr.onabort = () => {
      reject(new Error("恢复已取消"));
    };

    onProgress({
      stage: "uploading",
      percent: 3,
      label: "上传中",
      detail: "正在准备上传备份文件",
    });
    xhr.open("POST", "/api/v1/settings/backup");
    xhr.send(form);
  });
}

function RestoreProgressView({ progress }: { progress: RestoreProgressState }) {
  if (progress.stage === "idle") return null;

  const activeIndex = RESTORE_STAGE_ORDER[progress.stage];
  const steps: Array<{ stage: RestoreProgressStage; label: string }> = [
    { stage: "uploading", label: "上传" },
    { stage: "preparing", label: "准备" },
    { stage: "clearing", label: "清理" },
    { stage: "importing", label: "导入" },
    { stage: "restoring", label: "还原" },
    { stage: "finalizing", label: "收尾" },
  ];

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <div className="min-w-0 font-medium text-slate-700">{progress.label}</div>
        <div className="shrink-0 tabular-nums text-slate-500">{progress.percent}%</div>
      </div>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-label={progress.label}
      >
        <div
          className="h-full rounded-full bg-blue-500 transition-all duration-300"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
      <div className="mt-2 grid grid-cols-6 gap-1 text-[11px]">
        {steps.map((step) => {
          const stepIndex = RESTORE_STAGE_ORDER[step.stage];
          const active = activeIndex === stepIndex;
          const passed = activeIndex > stepIndex;
          return (
            <div
              key={step.stage}
              className={
                active || passed
                  ? "truncate rounded bg-blue-50 px-2 py-1 text-center font-medium text-blue-700"
                  : "truncate rounded bg-white px-2 py-1 text-center text-slate-400"
              }
            >
              {step.label}
            </div>
          );
        })}
      </div>
      {progress.detail ? <div className="mt-2 text-[11px] text-slate-500">{progress.detail}</div> : null}
    </div>
  );
}

export default function DatabaseSettingsPage() {
  const restoreFileInputRef = useRef<HTMLInputElement | null>(null);
  const [origins, setOrigins] = useState<string[]>([]);
  const [originsLoading, setOriginsLoading] = useState(false);
  const [newOrigin, setNewOrigin] = useState("");
  const [originCheckEnabled, setOriginCheckEnabled] = useState(false);
  const [originMessage, setOriginMessage] = useState("");
  const [originError, setOriginError] = useState("");
  const [ledgerInviteCode, setLedgerInviteCode] = useState("");
  const [ledgerInviteRecords, setLedgerInviteRecords] = useState<LedgerInviteCodeRecord[]>([]);
  const [ledgerInviteLoading, setLedgerInviteLoading] = useState(false);
  const [ledgerInviteSaving, setLedgerInviteSaving] = useState(false);
  const [ledgerInviteMessage, setLedgerInviteMessage] = useState("");
  const [ledgerInviteError, setLedgerInviteError] = useState("");

  const [backuping, setBackuping] = useState(false);
  const [tableExporting, setTableExporting] = useState(false);
  const [backupMessage, setBackupMessage] = useState("");
  const [backupError, setBackupError] = useState("");
  const [backupUserPassword, setBackupUserPassword] = useState("");
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupCrossEnvironment, setBackupCrossEnvironment] = useState(false);
  const [backupScope, setBackupScope] = useState<"system" | "household">("household");
  const [backupPasswordDialogOpen, setBackupPasswordDialogOpen] = useState(false);

  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreUserPassword, setRestoreUserPassword] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [restoreBackupScope, setRestoreBackupScope] = useState<"system" | "household" | null>(null);
  const [restoreConfirmSystemOverwrite, setRestoreConfirmSystemOverwrite] = useState(false);
  const [restorePasswordDialogOpen, setRestorePasswordDialogOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [restoreProgress, setRestoreProgress] = useState<RestoreProgressState>(RESTORE_PROGRESS_IDLE);

  const [resetDbPassword, setResetDbPassword] = useState("");
  const [resetPasswordDialogOpen, setResetPasswordDialogOpen] = useState(false);
  const [resetError, setResetError] = useState("");
  const [resetting, setResetting] = useState(false);

  const [cacheRefreshing, setCacheRefreshing] = useState(false);
  const [cacheRefreshMessage, setCacheRefreshMessage] = useState("");
  const [cacheRefreshError, setCacheRefreshError] = useState("");

  const canBackup = !backuping && !tableExporting && !restoring;
  const canTableExport = !backuping && !tableExporting && !restoring;
  const canRestore = useMemo(
    () => Boolean(restoreFile) && !restoring,
    [restoreFile, restoring],
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
    setOriginMessage("");
    setOriginError("");
    try {
      const keys = ["allowed_dev_origins", "origin_check_enabled"].join(",");
      const data = await fetchJsonWithTimeout<SettingsValuesResult>(
        `/api/v1/settings/system?keys=${encodeURIComponent(keys)}`,
        { cache: "no-store" },
      );
      if (!data.ok) {
        throw new Error(data.error ?? "读取访问白名单失败");
      }
      const values = data.values ?? {};
      const parsedOrigins = parseOriginList(values.allowed_dev_origins);
      setOrigins(parsedOrigins);
      setOriginCheckEnabled(values.origin_check_enabled === "true" && parsedOrigins.length > 0);
    } catch (error) {
      setOrigins([]);
      setOriginCheckEnabled(false);
      setOriginError(error instanceof Error ? error.message : "读取访问白名单失败");
    } finally {
      setOriginsLoading(false);
    }

    try {
      const data = await fetchJsonWithTimeout<SettingsValuesResult>(
        `/api/v1/settings/system?keys=${encodeURIComponent(LEDGER_INVITE_CODE_KEY)}`,
        { cache: "no-store", timeoutMs: 12_000 },
      );
      if (!data.ok) {
        throw new Error(data.error ?? "读取邀请码失败");
      }
      const values = data.values ?? {};
      setLedgerInviteRecords(parseLedgerInviteCodeRecords(values[LEDGER_INVITE_CODE_KEY]));
      setLedgerInviteCode("");
    } catch (error) {
      setLedgerInviteRecords([]);
      setLedgerInviteError(error instanceof Error ? error.message : "读取邀请码失败");
    } finally {
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

  async function saveSystemSetting(key: string, value: string) {
    const res = await fetch("/api/v1/settings/system", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    const raw = await res.text().catch(() => "");
    let data: { ok?: boolean; error?: string } | null = null;
    try {
      data = raw ? JSON.parse(raw) as { ok?: boolean; error?: string } : null;
    } catch {
      data = null;
    }
    if (!res.ok || !data?.ok) {
      if (res.status === 403 && raw.includes("Access Denied")) {
        throw new Error("当前访问的域名或 IP 不在访问白名单内，请用已放行的地址打开后再修改白名单。");
      }
      throw new Error(data?.error ?? "保存失败");
    }
  }

  async function saveOrigins(list: string[]) {
    const normalized = normalizeAllowedAccessList(list);
    try {
      await saveSystemSetting("allowed_dev_origins", JSON.stringify(normalized));
      setOriginError("");
      return true;
    } catch (error) {
      setOriginError(error instanceof Error ? error.message : "保存白名单失败");
      return false;
    }
  }

  async function toggleOriginCheck(enabled: boolean) {
    setOriginMessage("");
    setOriginError("");
    const previous = originCheckEnabled;
    const previousOrigins = origins;
    let nextOrigins = origins;
    let autoAddedHost = "";
    if (enabled) {
      const currentHost = getCurrentAccessHost();
      if (
        currentHost &&
        !isDefaultAllowedAccessHostname(currentHost) &&
        !isAccessHostnameAllowed(currentHost, nextOrigins)
      ) {
        autoAddedHost = currentHost;
        nextOrigins = [...nextOrigins, currentHost];
        setOrigins(nextOrigins);
        const saved = await saveOrigins(nextOrigins);
        if (!saved) {
          setOrigins(previousOrigins);
          setOriginCheckEnabled(previous);
          return;
        }
      }
      if (nextOrigins.length === 0) {
        setOriginCheckEnabled(false);
        setOriginError("请先添加至少一个非本机访问域名或 IP，再开启访问白名单。localhost 和 127.0.0.1 已默认允许。");
        return;
      }
    }
    setOriginCheckEnabled(enabled);
    try {
      await saveSystemSetting("origin_check_enabled", String(enabled));
      setOriginMessage(
        enabled
          ? autoAddedHost
            ? `已自动加入当前访问地址 ${autoAddedHost}，访问白名单已开启`
            : "访问白名单已开启"
          : "访问白名单已关闭",
      );
    } catch (error) {
      setOriginCheckEnabled(previous);
      setOrigins(previousOrigins);
      setOriginError(error instanceof Error ? error.message : "保存白名单开关失败");
    }
  }

  async function addOrigin() {
    setOriginMessage("");
    setOriginError("");
    const value = normalizeAccessHostname(newOrigin);
    if (!value) return;
    if (isDefaultAllowedAccessHostname(value)) {
      setNewOrigin("");
      setOriginMessage("localhost、127.0.0.1 和 ::1 已默认允许，不需要加入白名单。");
      return;
    }
    if (origins.includes(value)) {
      setNewOrigin("");
      setOriginMessage("该来源已在白名单中");
      return;
    }
    const previous = origins;
    const next = [...origins, value];
    setOrigins(next);
    setNewOrigin("");
    const saved = await saveOrigins(next);
    if (!saved) {
      setOrigins(previous);
      return;
    }
    setOriginMessage(originCheckEnabled ? "白名单已更新" : "白名单已更新，开启后生效");
  }

  async function removeOrigin(index: number) {
    setOriginMessage("");
    setOriginError("");
    const previousOrigins = origins;
    const previousEnabled = originCheckEnabled;
    const next = origins.filter((_, i) => i !== index);
    if (next.length === 0 && originCheckEnabled) {
      setOrigins(next);
      setOriginCheckEnabled(false);
      try {
        await saveSystemSetting("origin_check_enabled", "false");
        const saved = await saveOrigins(next);
        if (!saved) {
          setOrigins(previousOrigins);
          return;
        }
        setOriginMessage("白名单已清空，访问白名单已关闭");
      } catch (error) {
        setOrigins(previousOrigins);
        setOriginCheckEnabled(previousEnabled);
        setOriginError(error instanceof Error ? error.message : "关闭白名单失败");
      }
      return;
    }
    const currentHost = getCurrentAccessHost();
    if (
      originCheckEnabled &&
      currentHost &&
      !isDefaultAllowedAccessHostname(currentHost) &&
      !isAccessHostnameAllowed(currentHost, next)
    ) {
      setOriginError("不能删除当前正在访问的域名或 IP，否则会把自己排除在白名单外。");
      return;
    }
    setOrigins(next);
    const saved = await saveOrigins(next);
    if (!saved) {
      setOrigins(previousOrigins);
      setOriginCheckEnabled(previousEnabled);
      return;
    }
    setOriginMessage("白名单已更新");
  }

  function openBackupPasswordDialog() {
    setBackupUserPassword("");
    setBackupPassphrase("");
    setBackupCrossEnvironment(false);
    setBackupScope("household");
    setBackupError("");
    setBackupPasswordDialogOpen(true);
  }

  async function handleBackup() {
    const password = backupUserPassword.trim();
    if (!password) {
      setBackupError("请输入用户密码");
      return;
    }

    const passphrase = backupPassphrase.trim();
    if (backupCrossEnvironment && !passphrase) {
      setBackupError("此备份需要跨环境恢复，请填写备份加密口令");
      return;
    }

    setBackuping(true);
    setBackupMessage("");
    setBackupError("");
    try {
      const result = await saveDataBackup({
        userPassword: password,
        backupPassphrase: passphrase,
        backupScope,
      });
      if (!result) return;
      setBackupPasswordDialogOpen(false);
      setBackupUserPassword("");
      setBackupPassphrase("");
      setBackupCrossEnvironment(false);
      setBackupScope("household");
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

  async function handleTableExport() {
    setTableExporting(true);
    setBackupMessage("");
    setBackupError("");
    try {
      const result = await saveDataTableExport();
      if (!result) return;
      setBackupMessage(
        result.pickedLocation
          ? `表格导出已保存：${result.fileName}`
          : `表格导出已开始下载：${result.fileName}。如未弹出保存位置，请在浏览器默认下载目录查看。`,
      );
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : "导出表格失败");
    } finally {
      setTableExporting(false);
    }
  }

  async function inspectBackupScope(file: File): Promise<"system" | "household"> {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { scope?: { backupScope?: unknown } };
      return parsed?.scope?.backupScope === "household" ? "household" : "system";
    } catch {
      return "system";
    }
  }

  async function applyRestoreFile(nextFile: File | null) {
    setRestoreFile(nextFile);
    setRestoreUserPassword("");
    setRestorePassphrase("");
    setRestoreBackupScope(nextFile ? await inspectBackupScope(nextFile) : null);
    setRestoreConfirmSystemOverwrite(false);
    setRestorePasswordDialogOpen(false);
    setRestoreError("");
    setRestoreMessage("");
    setRestoreProgress(RESTORE_PROGRESS_IDLE);
  }

  async function pickRestoreFile() {
    const openPicker = (window as WindowWithFilePickers).showOpenFilePicker;
    if (!openPicker) {
      restoreFileInputRef.current?.click();
      return;
    }

    try {
      const [handle] = await openPicker({
        multiple: false,
        excludeAcceptAllOption: true,
        types: RESTORE_FILE_PICKER_TYPES,
      });
      if (!handle) return;
      void applyRestoreFile(await handle.getFile());
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setRestoreError(error instanceof Error ? error.message : "选择备份文件失败");
    }
  }

  function openRestorePasswordDialog() {
    if (!restoreFile) {
      setRestoreError("请选择数据备份文件");
      return;
    }
    setRestoreUserPassword("");
    setRestorePassphrase("");
    setRestoreConfirmSystemOverwrite(false);
    setRestoreError("");
    setRestoreProgress(RESTORE_PROGRESS_IDLE);
    setRestorePasswordDialogOpen(true);
  }

  async function handleRestore() {
    if (!restoreFile) {
      setRestoreError("请选择数据备份文件");
      return;
    }
    const password = restoreUserPassword.trim();
    if (!password) {
      setRestoreError("请输入当前用户密码");
      return;
    }
    if (restoreBackupScope === "system" && !restoreConfirmSystemOverwrite) {
      setRestoreError("这是系统备份，恢复会覆盖当前用户，请先勾选确认");
      return;
    }

    setRestoring(true);
    setRestoreError("");
    setRestoreMessage("");
    setRestoreProgress(RESTORE_PROGRESS_IDLE);
    try {
      const form = new FormData();
      form.append("file", restoreFile);
      form.append("userPassword", password);
      form.append("backupPassphrase", restorePassphrase.trim());
      const data = await restoreDataBackup(form, setRestoreProgress);
      const counts = data.summary?.counts;
      const summaryText = counts
        ? `恢复完成：账户 ${counts.accounts ?? 0}，交易 ${counts.transactions ?? 0}，分类 ${counts.categories ?? 0}，机构 ${counts.institutions ?? 0}。`
        : "恢复完成。";
      setRestoreMessage(`${summaryText} 页面将刷新。`);
      setRestorePasswordDialogOpen(false);
      setRestoreUserPassword("");
      setRestorePassphrase("");
      setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      setRestoreProgress(RESTORE_PROGRESS_IDLE);
      setRestoreError(error instanceof Error ? error.message : "恢复失败");
    } finally {
      setRestoring(false);
    }
  }

  function openFactoryResetDialog() {
    setResetDbPassword("");
    setResetError("");
    setResetPasswordDialogOpen(true);
  }

  async function handleFactoryReset() {
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
      const verifyData = await verifyRes.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!verifyRes.ok || !verifyData?.ok) {
        setResetError(verifyData?.error ?? "数据库密码错误");
        return;
      }

      const res = await fetch("/api/v1/settings/factory-reset", { method: "POST" });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (res.ok && data?.ok) {
        setResetPasswordDialogOpen(false);
        setResetDbPassword("");
        window.location.href = "/login";
      } else {
        setResetError(data?.error ?? "操作失败");
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
        <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-800">备份与恢复</div>
            <div className="mt-1 text-xs text-slate-500">
              备份生成加密恢复包；导出表格仅用于查看和处理数据，不能用于恢复。
            </div>
            {restoreFile ? <div className="mt-2 truncate text-xs text-slate-500" title={restoreFile.name}>已选择：{restoreFile.name}</div> : null}
            {backupMessage ? <div className="mt-2 text-xs text-emerald-600">{backupMessage}</div> : null}
            {backupError ? <div className="mt-2 text-xs text-red-600">{backupError}</div> : null}
            {restoreMessage ? <div className="mt-2 text-xs text-emerald-600">{restoreMessage}</div> : null}
            {restoreError ? <div className="mt-2 text-xs text-red-600">{restoreError}</div> : null}
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-2">
            <button
              type="button"
              onClick={openBackupPasswordDialog}
              disabled={!canBackup}
              className="inline-flex h-9 w-32 items-center justify-center gap-2 rounded-md border border-blue-200 bg-white px-3 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {backuping ? "备份中..." : "数据备份"}
            </button>
            <button
              type="button"
              onClick={() => void handleTableExport()}
              disabled={!canTableExport}
              className="inline-flex h-9 w-32 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {tableExporting ? "导出中..." : "导出表格"}
            </button>
            <button
              type="button"
              onClick={() => void pickRestoreFile()}
              disabled={restoring}
              className="inline-flex h-9 w-32 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              <Upload className="h-4 w-4 shrink-0" />
              选择备份
            </button>
            <input
              ref={restoreFileInputRef}
              type="file"
              accept=".mmh-backup"
              className="hidden"
              onChange={(event) => {
                void applyRestoreFile(event.target.files?.[0] ?? null);
              }}
            />
            <button
              type="button"
              onClick={openRestorePasswordDialog}
              disabled={!canRestore}
              className="inline-flex h-9 w-32 items-center justify-center gap-2 rounded-md bg-red-600 px-3 text-sm text-white hover:bg-red-700 disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" />
              {restoring ? "恢复中..." : "开始恢复"}
            </button>
          </div>
        </div>
      </section>

      {backupPasswordDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 px-4">
          <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-4 shadow-xl">
            <div className="text-sm font-semibold text-slate-800">验证当前用户</div>
            <div className="mt-1 text-xs text-slate-500">
              账簿备份不包含用户，恢复后保留当前用户；系统备份包含全部用户，恢复时会覆盖用户。请输入当前用户密码后继续。
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setBackupScope("household");
                  setBackupError("");
                }}
                className={`h-9 rounded-md border px-2 text-xs font-medium ${
                  backupScope === "household"
                    ? "border-blue-300 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                账簿备份
              </button>
              <button
                type="button"
                onClick={() => {
                  setBackupScope("system");
                  setBackupError("");
                }}
                className={`h-9 rounded-md border px-2 text-xs font-medium ${
                  backupScope === "system"
                    ? "border-red-300 bg-red-50 text-red-700"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                系统备份
              </button>
            </div>
            {backupScope === "system" ? (
              <div className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                系统备份会覆盖目标账簿中的用户，包括当前登录用户，请确认后再执行。
              </div>
            ) : (
              <div className="mt-2 rounded-md bg-slate-50 px-2 py-1 text-[11px] text-slate-500">
                账簿备份不包含用户，恢复到当前账簿时会保留现有用户。
              </div>
            )}
            <input
              type="password"
              value={backupUserPassword}
              onChange={(event) => {
                setBackupUserPassword(event.target.value);
                setBackupError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleBackup();
              }}
              placeholder="当前用户密码"
              autoComplete="current-password"
              autoFocus
              className="mt-3 h-10 w-full rounded-md border border-slate-200 px-3 text-sm text-slate-700 outline-none focus:border-blue-400"
            />
            <label className="mt-3 flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={backupCrossEnvironment}
                onChange={(event) => {
                  setBackupCrossEnvironment(event.target.checked);
                  setBackupError("");
                }}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-400"
              />
              此备份需要恢复到其他设备、系统或不同用户
            </label>
            <input
              type="text"
              value={backupPassphrase}
              onChange={(event) => {
                setBackupPassphrase(event.target.value);
                setBackupError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleBackup();
              }}
              placeholder={backupCrossEnvironment ? "备份加密口令（跨环境恢复必填）" : "备份加密口令（可选）"}
              autoComplete="off"
              className="mt-2 h-10 w-full rounded-md border border-slate-200 px-3 text-sm text-slate-700 outline-none focus:border-blue-400"
            />
            <div className="mt-1 text-[11px] text-slate-400">
              此口令会明文显示，便于核对；恢复时需要输入同一口令。仅当前环境恢复时可留空，系统会用当前用户密码加密。
            </div>
            {backupError ? <div className="mt-2 text-xs text-red-600">{backupError}</div> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (backuping) return;
                  setBackupPasswordDialogOpen(false);
                  setBackupUserPassword("");
                  setBackupPassphrase("");
                  setBackupCrossEnvironment(false);
                  setBackupScope("household");
                  setBackupError("");
                }}
                disabled={backuping}
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleBackup()}
                disabled={backuping || backupUserPassword.trim().length === 0}
                className="h-9 rounded-md bg-blue-600 px-3 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {backuping ? "备份中..." : "确认备份"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {restorePasswordDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 px-4">
          <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-4 shadow-xl">
            <div className="text-sm font-semibold text-slate-800">验证当前用户</div>
            <div className="mt-1 text-xs text-slate-500">
              恢复会清空当前账簿并写回备份内容。当前用户密码验证当前系统；备份加密口令用于解密备份文件，两者可以来自不同用户。
            </div>
            <div className="mt-3 rounded-md bg-slate-50 px-2 py-1 text-[11px] text-slate-500">
              {restoreBackupScope === "system"
                ? "已检测到系统备份，恢复将覆盖当前账簿中的全部用户（包括当前登录用户）。"
                : "已检测到账簿备份，不包含用户，恢复后当前用户会保留。"}
            </div>
            {restoreBackupScope === "system" ? (
              <label className="mt-2 flex items-center gap-2 text-xs text-red-700">
                <input
                  type="checkbox"
                  checked={restoreConfirmSystemOverwrite}
                  onChange={(event) => {
                    setRestoreConfirmSystemOverwrite(event.target.checked);
                    setRestoreError("");
                  }}
                  className="h-4 w-4 rounded border-slate-300 text-red-600 focus:ring-red-400"
                />
                我已知晓系统备份会覆盖当前用户
              </label>
            ) : null}
            <input
              type="password"
              value={restoreUserPassword}
              onChange={(event) => {
                setRestoreUserPassword(event.target.value);
                setRestoreError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleRestore();
              }}
              placeholder="当前用户密码"
              autoComplete="current-password"
              autoFocus
              className="mt-3 h-10 w-full rounded-md border border-slate-200 px-3 text-sm text-slate-700 outline-none focus:border-blue-400"
            />
            <input
              type="password"
              value={restorePassphrase}
              onChange={(event) => {
                setRestorePassphrase(event.target.value);
                setRestoreError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleRestore();
              }}
              placeholder="备份加密口令"
              autoComplete="off"
              className="mt-2 h-10 w-full rounded-md border border-slate-200 px-3 text-sm text-slate-700 outline-none focus:border-blue-400"
            />
            <div className="mt-1 text-[11px] text-slate-400">如果备份时未单独设置，请输入创建备份时使用的用户密码；否则填写当时设置的备份加密口令。</div>
            <RestoreProgressView progress={restoreProgress} />
            {restoreError ? <div className="mt-2 text-xs text-red-600">{restoreError}</div> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (restoring) return;
                  setRestorePasswordDialogOpen(false);
                  setRestoreUserPassword("");
                  setRestorePassphrase("");
                  setRestoreConfirmSystemOverwrite(false);
                  setRestoreError("");
                }}
                disabled={restoring}
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleRestore()}
                disabled={
                  restoring ||
                  restoreUserPassword.trim().length === 0 ||
                  (restoreBackupScope === "system" && !restoreConfirmSystemOverwrite)
                }
                className="h-9 rounded-md bg-red-600 px-3 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                {restoring ? "恢复中..." : "确认恢复"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {resetPasswordDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 px-4">
          <div className="w-full max-w-sm rounded-lg border border-red-100 bg-white p-4 shadow-xl">
            <div className="flex items-center gap-2 text-sm font-semibold text-red-800">
              <Shield className="h-4 w-4 shrink-0 text-amber-500" />
              数据库密码验证
            </div>
            <div className="mt-1 text-xs text-slate-500">
              系统初始化会删除所有账簿和业务数据。请输入数据库密码后继续。
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
              placeholder="输入数据库密码"
              autoComplete="off"
              autoFocus
              className="mt-3 h-10 w-full rounded-md border border-red-100 px-3 text-sm text-slate-700 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-50"
            />
            {resetError ? <div className="mt-2 text-xs text-red-600">{resetError}</div> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (resetting) return;
                  setResetPasswordDialogOpen(false);
                  setResetDbPassword("");
                  setResetError("");
                }}
                disabled={resetting}
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleFactoryReset()}
                disabled={resetting || resetDbPassword.trim().length === 0}
                className="h-9 rounded-md bg-red-600 px-3 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                {resetting ? "执行中..." : "确认初始化"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-slate-800">访问白名单</div>
            <div className="mt-0.5 text-xs text-slate-500">{ACCESS_WHITELIST_HINT}</div>
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

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded px-2 py-0.5 ${originCheckEnabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
            {originCheckEnabled ? "已开启" : "未开启"}
          </span>
          <span className="text-slate-500">
            {origins.length > 0 ? `已配置 ${origins.length} 个允许来源` : "暂无白名单条目，当前不会限制访问来源"}
          </span>
        </div>
        {originMessage ? <div className="mt-2 text-xs text-emerald-600">{originMessage}</div> : null}
        {originError ? <div className="mt-2 text-xs text-red-600">{originError}</div> : null}

        <SettingsTable minWidth={620} maxWidth="full" className="mt-3">
          <colgroup>
            <col />
            <col style={{ width: "88px" }} />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <SettingsTh>允许来源</SettingsTh>
              <SettingsTh align="right">操作</SettingsTh>
            </tr>
          </thead>
          <tbody>
            {originsLoading ? (
              <SettingsEmptyRow colSpan={2}>正在读取白名单...</SettingsEmptyRow>
            ) : origins.length > 0 ? (
              origins.map((origin, index) => (
                <tr key={origin} className="hover:bg-slate-50">
                  <SettingsTd className="truncate font-mono text-[11px]" title={origin}>{origin}</SettingsTd>
                  <SettingsTd align="right">
                    <SettingsRowActions>
                      <SettingsActionButton label="删除白名单" variant="delete" onClick={() => void removeOrigin(index)} />
                    </SettingsRowActions>
                  </SettingsTd>
                </tr>
              ))
            ) : (
              <SettingsEmptyRow colSpan={2}>暂无白名单条目。请先添加允许访问的域名或 IP，再开启访问白名单。</SettingsEmptyRow>
            )}
            <tr className="bg-slate-50/60">
              <SettingsTd>
                <input
                  type="text"
                  value={newOrigin}
                  onChange={(event) => setNewOrigin(event.target.value)}
                  placeholder="域名或 IP，例如 mmh.example.com 或 192.168.1.100"
                  disabled={originsLoading}
                  className="h-8 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 focus:border-blue-300 focus:outline-none disabled:bg-slate-50"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void addOrigin();
                  }}
                />
              </SettingsTd>
              <SettingsTd align="right">
                <SettingsRowActions>
                  <SettingsActionButton label="添加白名单" variant="add" onClick={() => void addOrigin()} disabled={originsLoading} />
                </SettingsRowActions>
              </SettingsTd>
            </tr>
          </tbody>
        </SettingsTable>
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
        <SettingsTable minWidth={900} maxWidth="full" className="mt-4">
          <colgroup>
            <col style={{ width: "42%" }} />
            <col style={{ width: "72px" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "160px" }} />
            <col style={{ width: "88px" }} />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <SettingsTh>邀请码</SettingsTh>
              <SettingsTh>状态</SettingsTh>
              <SettingsTh>建立账簿</SettingsTh>
              <SettingsTh>使用时间</SettingsTh>
              <SettingsTh align="right">操作</SettingsTh>
            </tr>
          </thead>
          <tbody>
            {ledgerInviteLoading ? (
              <SettingsEmptyRow colSpan={5}>正在读取邀请码...</SettingsEmptyRow>
            ) : sortedLedgerInviteRecords.length > 0 ? (
              sortedLedgerInviteRecords.map((record) => (
                <tr key={record.code} className="hover:bg-slate-50">
                  <SettingsTd>
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[11px] text-slate-700" title={record.code}>{record.code}</div>
                      <div className="mt-0.5 text-[10px] text-slate-400">创建：{formatInviteDateTime(record.createdAt)}</div>
                    </div>
                  </SettingsTd>
                  <SettingsTd>
                    {record.usedAt ? (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">已使用</span>
                    ) : (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">可使用</span>
                    )}
                  </SettingsTd>
                  <SettingsTd className="max-w-[16rem] truncate" title={record.usedHouseholdName || ""}>
                    {record.usedHouseholdName || "-"}
                  </SettingsTd>
                  <SettingsTd>{formatInviteDateTime(record.usedAt)}</SettingsTd>
                  <SettingsTd align="right">
                    <SettingsRowActions>
                      <SettingsActionButton label="删除邀请码" variant="delete" onClick={() => void removeLedgerInviteCode(record.code)} disabled={ledgerInviteSaving} />
                    </SettingsRowActions>
                  </SettingsTd>
                </tr>
              ))
            ) : ledgerInviteError ? (
              <SettingsEmptyRow colSpan={5}>读取邀请码失败：{ledgerInviteError}</SettingsEmptyRow>
            ) : (
              <SettingsEmptyRow colSpan={5}>暂无已保存的邀请码</SettingsEmptyRow>
            )}
            <tr className="bg-slate-50/60">
              <SettingsTd>
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
                    className="secondary-button h-8 px-2 text-xs disabled:opacity-50"
                  >
                    随机填入
                  </button>
                </div>
              </SettingsTd>
              <SettingsTd><span className="text-xs text-slate-400">新增</span></SettingsTd>
              <SettingsTd><span className="text-xs text-slate-400">-</span></SettingsTd>
              <SettingsTd><span className="text-xs text-slate-400">-</span></SettingsTd>
              <SettingsTd align="right">
                <SettingsRowActions>
                  <SettingsActionButton label={ledgerInviteSaving ? "保存中" : "添加邀请码"} variant="add" onClick={() => void addLedgerInviteCode()} disabled={ledgerInviteLoading || ledgerInviteSaving} />
                </SettingsRowActions>
              </SettingsTd>
            </tr>
          </tbody>
        </SettingsTable>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-800">刷新服务端缓存</div>
            <div className="mt-1 text-xs text-slate-500">
              外部工具改库后，刷新服务端缓存并重新加载页面。
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

        <button
          type="button"
          onClick={openFactoryResetDialog}
          disabled={resetting}
          className="mt-3 h-9 rounded-md bg-red-600 px-4 text-sm text-white hover:bg-red-700 disabled:opacity-50"
        >
          {resetting ? "执行中..." : "系统初始化"}
        </button>
      </section>
    </div>
  );
}
