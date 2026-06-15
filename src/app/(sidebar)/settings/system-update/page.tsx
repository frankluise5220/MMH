"use client";

import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw, CheckCircle2, XCircle, Loader2, Circle,
  AlertTriangle, Download,
} from "lucide-react";

type VersionInfo = {
  ok: boolean;
  localVersion: string;
  localCommit: string;
  localCommitMsg: string;
  localCommitDate: string;
  remoteCommit: string;
  remoteCommitMsg: string;
  needsUpdate: boolean;
};

type StepStatus = "pending" | "running" | "completed" | "failed";

type StepState = {
  label: string;
  status: StepStatus;
  output: string;
};

const UPDATE_STEPS: string[] = [
  "拉取代码",
  "安装依赖",
  "生成 Prisma Client",
  "同步数据库",
  "构建项目",
];

const REBUILD_STEPS: string[] = [
  "安装依赖",
  "生成 Prisma Client",
  "同步数据库",
  "构建项目",
];

export default function SystemUpdatePage() {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [loadingVersion, setLoadingVersion] = useState(true);

  // 更新流程状态
  const [updating, setUpdating] = useState(false);
  const [confirming, setConfirming] = useState(false); // 显示确认对话框
  const [rebuildConfirming, setRebuildConfirming] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [updateDone, setUpdateDone] = useState(false);
  const [updateOk, setUpdateOk] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [mode, setMode] = useState<"update" | "rebuild">("update");

  const loadVersionInfo = useCallback(async () => {
    setLoadingVersion(true);
    try {
      const res = await fetch("/api/v1/settings/system-update");
      const data = await res.json();
      setVersionInfo(data);
    } catch {
      setVersionInfo(null);
    } finally {
      setLoadingVersion(false);
    }
  }, []);

  useEffect(() => {
    loadVersionInfo();
  }, [loadVersionInfo]);

  function initSteps(stepLabels: string[]) {
    return stepLabels.map((label) => ({ label, status: "pending" as StepStatus, output: "" }));
  }

  async function startUpdate(updateMode: "update" | "rebuild") {
    setMode(updateMode);
    setConfirming(false);
    setRebuildConfirming(false);
    setUpdating(true);
    setUpdateDone(false);
    setUpdateOk(false);
    setUpdateError("");

    const stepLabels = updateMode === "update" ? UPDATE_STEPS : REBUILD_STEPS;
    setSteps(initSteps(stepLabels));

    try {
      const res = await fetch(`/api/v1/settings/system-update?mode=${updateMode}`, { method: "POST" });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 解析 SSE 事件：每个事件格式为 data: {JSON}\n\n
        const lines = buffer.split("\n\n");
        // 保留最后一个可能不完整的部分
        buffer = lines.pop() || "";

        for (const line of lines) {
          const dataLine = line.trim();
          if (!dataLine.startsWith("data: ")) continue;
          const jsonStr = dataLine.slice(6);
          try {
            const event = JSON.parse(jsonStr);

            if (event.type === "done") {
              setUpdateDone(true);
              setUpdateOk(event.ok);
              setUpdateError(event.error || "");
              setUpdating(false);
              if (event.ok) {
                // 更新成功后刷新版本信息
                loadVersionInfo();
              }
            } else if (event.step) {
              setSteps((prev) =>
                prev.map((s) =>
                  s.label === event.step
                    ? { ...s, status: event.status as StepStatus, output: event.output || s.output }
                    : s
                )
              );
            }
          } catch {
            // 忽略无法解析的行
          }
        }
      }
    } catch (e) {
      setUpdateDone(true);
      setUpdateOk(false);
      setUpdateError(e instanceof Error ? e.message : "网络错误");
      setUpdating(false);
    }
  }

  // 步骤图标
  function StepIcon({ status }: { status: StepStatus }) {
    switch (status) {
      case "completed":
        return <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />;
      case "running":
        return <Loader2 className="w-4 h-4 text-blue-500 animate-spin shrink-0" />;
      case "failed":
        return <XCircle className="w-4 h-4 text-red-500 shrink-0" />;
      case "pending":
        return <Circle className="w-4 h-4 text-slate-300 shrink-0" />;
    }
  }

  const isLatest = versionInfo?.ok && !versionInfo.needsUpdate;
  const needsUpdate = versionInfo?.ok && versionInfo.needsUpdate;

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-800">系统更新</h2>

      {/* 版本信息 */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-slate-800">版本信息</div>
          <button
            onClick={loadVersionInfo}
            disabled={loadingVersion}
            className="h-7 px-2.5 rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loadingVersion ? "animate-spin" : ""}`} />
            刷新
          </button>
        </div>

        {loadingVersion && !versionInfo ? (
          <div className="text-xs text-slate-500 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            加载中...
          </div>
        ) : versionInfo?.ok ? (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="text-sm text-slate-700">当前版本</div>
              <span className="text-sm font-medium text-slate-900">{versionInfo.localVersion}</span>
              <span className={`text-xs px-2 py-0.5 rounded ${
                isLatest
                  ? "bg-emerald-50 text-emerald-700"
                  : needsUpdate
                    ? "bg-amber-50 text-amber-700"
                    : "bg-slate-100 text-slate-500"
              }`}>
                {isLatest ? "最新版本" : needsUpdate ? "有新版本" : "检测中"}
              </span>
            </div>
            <div className="text-xs text-slate-500">
              本地提交 <span className="font-medium text-slate-700">{versionInfo.localCommit}</span>
              {" "}{versionInfo.localCommitMsg}
              {" "}&middot; {versionInfo.localCommitDate}
            </div>
            <div className="text-xs text-slate-500">
              远程提交 <span className="font-medium text-slate-700">{versionInfo.remoteCommit}</span>
              {versionInfo.remoteCommitMsg && ` ${versionInfo.remoteCommitMsg}`}
            </div>
          </div>
        ) : (
          <div className="text-xs text-red-600">获取版本信息失败</div>
        )}
      </div>

      {/* 更新操作 */}
      {!updating && !updateDone && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          {needsUpdate && (
            <>
              <div className="flex items-center gap-2 mb-2">
                <Download className="w-4 h-4 text-amber-500 shrink-0" />
                <div className="text-sm font-medium text-amber-700">有新版本可用</div>
              </div>
              <div className="text-xs text-amber-600 mb-3">
                远程最新提交 {versionInfo!.remoteCommit}
                {versionInfo!.remoteCommitMsg && ` "${versionInfo!.remoteCommitMsg}"`}
                ，点击更新将拉取最新代码并重新构建系统。
              </div>
              <button
                onClick={() => setConfirming(true)}
                className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700"
              >
                立即更新
              </button>
            </>
          )}

          {isLatest && (
            <>
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                <div className="text-sm font-medium text-emerald-700">当前已是最新版本</div>
              </div>
              <div className="text-xs text-slate-500 mb-3">
                无需更新。如需重新构建，可使用强制重新构建功能。
              </div>
              <button
                onClick={() => setRebuildConfirming(true)}
                className="h-9 px-4 rounded-md border border-blue-200 bg-white text-sm text-blue-600 hover:bg-blue-50"
              >
                强制重新构建
              </button>
            </>
          )}

          {/* 更新确认对话框 */}
          {confirming && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                <div className="text-sm font-medium text-amber-800">确认更新</div>
              </div>
              <div className="text-xs text-amber-700 mb-3">
                更新期间系统将暂时不可用（约5分钟），请确保没有其他用户正在使用。更新完成后需要刷新页面。
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => startUpdate("update")}
                  className="h-9 px-4 rounded-md bg-amber-600 text-white text-sm hover:bg-amber-700"
                >
                  确认更新
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="h-9 px-4 rounded-md border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 重新构建确认对话框 */}
          {rebuildConfirming && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                <div className="text-sm font-medium text-amber-800">确认重新构建</div>
              </div>
              <div className="text-xs text-amber-700 mb-3">
                将重新安装依赖、生成 Prisma Client、同步数据库并构建项目，不拉取新代码。构建期间系统暂时不可用。
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => startUpdate("rebuild")}
                  className="h-9 px-4 rounded-md bg-amber-600 text-white text-sm hover:bg-amber-700"
                >
                  确认构建
                </button>
                <button
                  onClick={() => setRebuildConfirming(false)}
                  className="h-9 px-4 rounded-md border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 更新进度 */}
      {(updating || updateDone) && steps.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-sm font-medium text-slate-800 mb-3">
            {mode === "update" ? "更新进度" : "构建进度"}
          </div>

          <div className="space-y-2">
            {steps.map((s, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <StepIcon status={s.status} />
                <div className="min-w-0 flex-1">
                  <div className={`text-sm ${
                    s.status === "completed" ? "text-emerald-700 font-medium"
                    : s.status === "running" ? "text-blue-700 font-medium"
                    : s.status === "failed" ? "text-red-700 font-medium"
                    : "text-slate-500"
                  }`}>
                    {s.label}
                    {s.status === "running" && "（进行中...）"}
                  </div>
                  {s.output && s.status !== "pending" && (
                    <div className={`text-xs mt-0.5 whitespace-pre-wrap break-all ${
                      s.status === "failed" ? "text-red-600"
                      : s.status === "completed" ? "text-slate-500"
                      : "text-slate-500"
                    }`}>
                      {s.output.length > 300 ? s.output.slice(0, 300) + "..." : s.output}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* 完成后的结果提示 */}
          {updateDone && (
            <div className="mt-4">
              {updateOk ? (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                  <div className="text-sm text-emerald-800 font-medium">
                    {mode === "update" ? "更新完成！请刷新页面以加载新版本" : "构建完成！请刷新页面以加载新版本"}
                  </div>
                  <button
                    onClick={() => window.location.reload()}
                    className="ml-auto h-8 px-3 rounded-md bg-emerald-600 text-white text-xs hover:bg-emerald-700"
                  >
                    刷新页面
                  </button>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                  <XCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-red-800 font-medium">更新失败</div>
                    {updateError && (
                      <div className="text-xs text-red-600 mt-1 whitespace-pre-wrap break-all">
                        {updateError}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
