"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Download, Loader2, RefreshCw, XCircle } from "lucide-react";

type VersionInfo = {
  ok: boolean;
  isDocker?: boolean;
  updateMode?: "git";
  versionSource?: "git" | "env";
  localVersion: string;
  localCommit: string;
  localCommitMsg: string;
  localCommitDate: string;
  githubUrl?: string;
  githubCommit?: string;
  githubCommitMsg?: string;
  githubCanCheck?: boolean;
  githubFetchError?: string;
  remoteName?: string;
  remoteBranch?: string;
  remoteUrl?: string;
  remoteCommit: string;
  remoteCommitMsg: string;
  needsUpdate: boolean;
  canCheckUpdate?: boolean;
  fetchError?: string;
  error?: string;
};

type StepStatus = "pending" | "running" | "completed" | "failed";

type StepState = {
  label: string;
  status: StepStatus;
  output: string;
};

const UPDATE_STEPS = ["拉取代码", "安装依赖", "生成 Prisma Client", "同步数据库", "构建项目"];

export default function SystemUpdatePage() {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [loadingVersion, setLoadingVersion] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [updateDone, setUpdateDone] = useState(false);
  const [updateOk, setUpdateOk] = useState(false);
  const [updateError, setUpdateError] = useState("");

  const loadVersionInfo = useCallback(async () => {
    setLoadingVersion(true);
    try {
      const res = await fetch("/api/v1/settings/system-update", { cache: "no-store" });
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

  function initSteps() {
    return UPDATE_STEPS.map((label) => ({ label, status: "pending" as StepStatus, output: "" }));
  }

  async function startUpdate() {
    setUpdating(true);
    setUpdateDone(false);
    setUpdateOk(false);
    setUpdateError("");
    setSteps(initSteps());

    try {
      const res = await fetch("/api/v1/settings/system-update?mode=update", { method: "POST" });
      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => null);
        setUpdateDone(true);
        setUpdateOk(false);
        setUpdateError(errData?.error || "更新不可用");
        setUpdating(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const dataLine = line.trim();
          if (!dataLine.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(dataLine.slice(6));
            if (event.type === "done") {
              setUpdateDone(true);
              setUpdateOk(Boolean(event.ok));
              setUpdateError(event.error || "");
              setUpdating(false);
              if (event.ok) loadVersionInfo();
            } else if (event.step) {
              setSteps((prev) =>
                prev.map((s) =>
                  s.label === event.step
                    ? { ...s, status: event.status as StepStatus, output: event.output || s.output }
                    : s,
                ),
              );
            }
          } catch {
            // Ignore malformed stream chunks.
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

  function StepIcon({ status }: { status: StepStatus }) {
    switch (status) {
      case "completed":
        return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />;
      case "running":
        return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />;
      case "failed":
        return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
      case "pending":
        return <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-slate-200" />;
    }
  }

  const hasResolvedRemoteCommit = Boolean(
    versionInfo?.remoteCommit && versionInfo.remoteCommit !== "unknown",
  );
  const hasResolvedGitHubCommit = Boolean(
    versionInfo?.githubCommit && versionInfo.githubCommit !== "unknown",
  );
  const canCheckUpdate =
    versionInfo?.ok && versionInfo.canCheckUpdate !== false && hasResolvedRemoteCommit;
  const isLatest = versionInfo?.ok && canCheckUpdate && !versionInfo.needsUpdate;
  const needsUpdate = versionInfo?.ok && canCheckUpdate && versionInfo.needsUpdate;
  const usesGitHubAsUpdateSource =
    Boolean(versionInfo?.remoteUrl) &&
    Boolean(versionInfo?.githubUrl) &&
    versionInfo?.remoteUrl === versionInfo?.githubUrl;
  const dockerManaged = Boolean(versionInfo?.isDocker);

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-800">系统更新</h2>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-slate-800">版本信息</div>
          <button
            onClick={loadVersionInfo}
            disabled={loadingVersion || updating}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loadingVersion ? "animate-spin" : ""}`} />
            刷新远端版本
          </button>
        </div>

        {loadingVersion && !versionInfo ? (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在读取版本...
          </div>
        ) : versionInfo?.ok ? (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-slate-500">当前版本</span>
              <span className="font-semibold text-slate-900">{versionInfo.localCommit}</span>
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {versionInfo.localVersion}
              </span>
              <span className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                {versionInfo.versionSource === "env" ? "镜像版本" : "Git 更新模式"}
              </span>
              {isLatest ? <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">最新版本</span> : null}
              {needsUpdate ? <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700">有新版本</span> : null}
            </div>
            <div className="text-xs text-slate-500">
              {dockerManaged ? "当前镜像" : "本地仓库"} <span className="font-medium text-slate-700">{versionInfo.localCommit}</span>
              {versionInfo.localCommitMsg ? ` ${versionInfo.localCommitMsg}` : ""}
              {versionInfo.localCommitDate ? ` · ${versionInfo.localCommitDate}` : ""}
            </div>
            <div className="text-xs text-slate-500">
              GitHub{" "}
              {hasResolvedGitHubCommit ? (
                <>
                  <span className="font-medium text-slate-700">{versionInfo.githubCommit}</span>
                  {versionInfo.githubCommitMsg ? ` ${versionInfo.githubCommitMsg}` : ""}
                </>
              ) : (
                <span className="text-amber-600">未获取，请检查网络后刷新</span>
              )}
            </div>
            {!usesGitHubAsUpdateSource ? (
              <div className="text-xs text-slate-500">
                更新源仓库{" "}
                <span className="font-medium text-slate-700">
                  {versionInfo.remoteName ?? "origin"}/{versionInfo.remoteBranch ?? "main"}
                </span>
                {versionInfo.remoteUrl ? (
                  <span className="ml-1 break-all text-slate-400">{versionInfo.remoteUrl}</span>
                ) : (
                  <span className="ml-1 text-slate-400">未单独配置时默认使用当前仓库的 Git origin</span>
                )}
              </div>
            ) : null}
            {!canCheckUpdate && versionInfo.fetchError ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                获取更新源版本失败：{versionInfo.fetchError}
              </div>
            ) : null}
            {!hasResolvedGitHubCommit && versionInfo.githubFetchError ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                获取 GitHub 版本失败：{versionInfo.githubFetchError}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-xs text-red-600">获取版本信息失败</div>
        )}
      </section>

      {!updating && !updateDone && versionInfo?.ok ? (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          {dockerManaged ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              当前为 Docker 部署。网页内“更新/重建”不会在运行中的容器里执行构建，请在宿主机项目目录运行
              <div className="mt-2 rounded bg-white/70 px-3 py-2 font-mono text-xs text-slate-700">
                git pull
                <br />
                sudo docker compose pull app
                <br />
                sudo docker compose up -d app
              </div>
              <div className="mt-2 text-xs text-amber-700">也可以直接在容器管理界面拉取镜像并重启 app 容器。</div>
            </div>
          ) : needsUpdate ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-amber-700">
                  <Download className="h-4 w-4 shrink-0" />
                  发现新版本
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  将更新到更新源版本 {versionInfo.remoteCommit}
                  {versionInfo.remoteCommitMsg ? `：${versionInfo.remoteCommitMsg}` : ""}
                </div>
              </div>
              <button
                onClick={startUpdate}
                className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700"
              >
                更新
              </button>
            </div>
          ) : isLatest ? (
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              当前已是最新版本
            </div>
          ) : (
            <div className="text-sm text-amber-700">暂时无法确认远端版本，请点击上方刷新。</div>
          )}
        </section>
      ) : null}

      {(updating || updateDone) && steps.length > 0 ? (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="mb-3 text-sm font-medium text-slate-800">更新进度</div>

          <div className="space-y-2">
            {steps.map((s) => (
              <div key={s.label} className="flex items-start gap-2.5">
                <StepIcon status={s.status} />
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-sm ${
                      s.status === "completed"
                        ? "font-medium text-emerald-700"
                        : s.status === "running"
                          ? "font-medium text-blue-700"
                          : s.status === "failed"
                            ? "font-medium text-red-700"
                            : "text-slate-500"
                    }`}
                  >
                    {s.label}
                    {s.status === "running" ? "（进行中...）" : ""}
                  </div>
                  {s.output && s.status !== "pending" ? (
                    <div
                      className={`mt-0.5 break-all text-xs ${
                        s.status === "failed" ? "text-red-600" : "text-slate-500"
                      }`}
                    >
                      {s.output.length > 240 ? `${s.output.slice(0, 240)}...` : s.output}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {updateDone ? (
            <div className="mt-4">
              {updateOk ? (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                  <div className="text-sm font-medium text-emerald-800">更新完成，请刷新页面加载新版本</div>
                  <button
                    onClick={() => window.location.reload()}
                    className="ml-auto h-8 rounded-md bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-700"
                  >
                    刷新页面
                  </button>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                  <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-red-800">更新失败</div>
                    {updateError ? <div className="mt-1 break-all text-xs text-red-600">{updateError}</div> : null}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
