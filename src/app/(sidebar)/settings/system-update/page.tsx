"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Download, Loader2, RefreshCw, XCircle } from "lucide-react";

type VersionInfo = {
  ok: boolean;
  isDocker?: boolean;
  updaterEnabled?: boolean;
  updateMode?: "git";
  versionSource?: "git" | "env";
  localVersion: string;
  localCommit: string;
  localCommitMsg: string;
  localCommitDate: string;
  githubUrl?: string;
  githubCommit?: string;
  githubCommitMsg?: string;
  githubCommitDate?: string;
  githubCanCheck?: boolean;
  githubFetchError?: string;
  remoteName?: string;
  remoteBranch?: string;
  remoteUrl?: string;
  remoteCommit: string;
  remoteCommitMsg: string;
  remoteCommitDate?: string;
  needsUpdate: boolean;
  canCheckUpdate?: boolean;
  imageSourceConfig?: ImageSourceConfig | null;
  fetchError?: string;
  error?: string;
};

type StepStatus = "pending" | "running" | "completed" | "failed";

type StepState = {
  label: string;
  status: StepStatus;
  output: string;
};

type ImageSourceConfig = {
  source: string;
  appImage: string;
  updaterImage: string;
  customAppImage: string;
  customUpdaterImage: string;
  options: Array<{ value: string; label: string; appImage?: string; updaterImage?: string }>;
};

type ImageSourceDraft = {
  source: string;
  customAppImage: string;
  customUpdaterImage: string;
};

type ImageSpeedResult = {
  source: string;
  image?: string;
  ok: boolean;
  ms?: number;
  error?: string;
};

const UPDATE_STEPS = ["拉取代码", "安装依赖", "生成 Prisma Client", "同步数据库", "构建项目"];
const DOCKER_UPDATE_STEPS = ["同步部署文件", "拉取软件镜像", "重启服务"];

function formatVersionDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

export default function SystemUpdatePage() {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [loadingVersion, setLoadingVersion] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [updateDone, setUpdateDone] = useState(false);
  const [updateOk, setUpdateOk] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [imageSourceDraft, setImageSourceDraft] = useState<ImageSourceDraft>({
    source: "auto",
    customAppImage: "",
    customUpdaterImage: "",
  });
  const [savingImageSource, setSavingImageSource] = useState(false);
  const [imageSourceMessage, setImageSourceMessage] = useState("");
  const [testingImageSource, setTestingImageSource] = useState(false);
  const [imageSpeedResults, setImageSpeedResults] = useState<Record<string, ImageSpeedResult>>({});

  const loadVersionInfo = useCallback(async () => {
    setLoadingVersion(true);
    try {
      const res = await fetch("/api/v1/settings/system-update", { cache: "no-store" });
      const data = await res.json();
      setVersionInfo(data);
      if (data?.imageSourceConfig) {
        setImageSourceDraft({
          source: data.imageSourceConfig.source || "auto",
          customAppImage: data.imageSourceConfig.customAppImage || "",
          customUpdaterImage: data.imageSourceConfig.customUpdaterImage || "",
        });
      }
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

  async function saveImageSource() {
    setSavingImageSource(true);
    setImageSourceMessage("");
    try {
      const res = await fetch("/api/v1/settings/system-update?config=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(imageSourceDraft),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "保存失败");
      }
      setVersionInfo((prev) => prev ? { ...prev, imageSourceConfig: data.config } : prev);
      setImageSourceMessage("已保存");
    } catch (e) {
      setImageSourceMessage(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingImageSource(false);
    }
  }

  async function testImageSourceSpeed(source?: string) {
    setTestingImageSource(true);
    setImageSourceMessage("");
    try {
      const res = await fetch("/api/v1/settings/system-update?speed=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source,
          customAppImage: imageSourceDraft.customAppImage,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "测速失败");
      }
      const next = { ...imageSpeedResults };
      for (const result of data.results as ImageSpeedResult[]) {
        next[result.source] = result;
      }
      setImageSpeedResults(next);
      setImageSourceMessage("测速完成");
    } catch (e) {
      setImageSourceMessage(e instanceof Error ? e.message : "测速失败");
    } finally {
      setTestingImageSource(false);
    }
  }

  async function startUpdate() {
    setUpdating(true);
    setUpdateDone(false);
    setUpdateOk(false);
    setUpdateError("");
    setSteps(versionInfo?.isDocker ? DOCKER_UPDATE_STEPS.map((label) => ({ label, status: "pending" as StepStatus, output: "" })) : initSteps());

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

      if (versionInfo?.isDocker) {
        pollDockerUpdate();
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

  async function pollDockerUpdate() {
    let shouldContinue = true;
    while (shouldContinue) {
      try {
        const res = await fetch("/api/v1/settings/system-update?status=1", { method: "POST", cache: "no-store" });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "查询更新状态失败");
        const task = data.task as { status?: string; currentStep?: string; logs?: string[]; error?: string };
        const current = task.currentStep || "";
        const logs = (task.logs ?? []).slice(-8).join("\n");
        setSteps((prev) =>
          prev.map((step) => {
            if (step.label === current) return { ...step, status: "running", output: logs };
            if (DOCKER_UPDATE_STEPS.indexOf(step.label) < DOCKER_UPDATE_STEPS.indexOf(current)) return { ...step, status: "completed", output: step.output || logs };
            return step;
          }),
        );
        if (task.status === "completed") {
          setSteps((prev) => prev.map((step) => ({ ...step, status: "completed", output: step.output || logs })));
          setUpdateDone(true);
          setUpdateOk(true);
          setUpdating(false);
          shouldContinue = false;
          setTimeout(() => window.location.reload(), 2500);
        } else if (task.status === "failed") {
          setUpdateDone(true);
          setUpdateOk(false);
          setUpdateError(task.error || "更新失败");
          setUpdating(false);
          shouldContinue = false;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      } catch (e) {
        setUpdateDone(true);
        setUpdateOk(false);
        setUpdateError(e instanceof Error ? e.message : "查询更新状态失败");
        setUpdating(false);
        shouldContinue = false;
      }
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
  const canCheckUpdate =
    versionInfo?.ok && versionInfo.canCheckUpdate !== false && hasResolvedRemoteCommit;
  const isLatest = versionInfo?.ok && canCheckUpdate && !versionInfo.needsUpdate;
  const needsUpdate = versionInfo?.ok && canCheckUpdate && versionInfo.needsUpdate;
  const dockerManaged = Boolean(versionInfo?.isDocker);
  const currentVersionText = [versionInfo?.localCommit, formatVersionDate(versionInfo?.localCommitDate)]
    .filter(Boolean)
    .join(" · ");
  const availableVersionText = [versionInfo?.remoteCommit, formatVersionDate(versionInfo?.remoteCommitDate)]
    .filter(Boolean)
    .join(" · ");
  const updateStatusText = needsUpdate
    ? "可更新"
    : isLatest
      ? "已是最新版本"
      : "未确认";

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-800">系统更新</h2>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-slate-800">软件更新（镜像）</div>
          <button
            onClick={loadVersionInfo}
            disabled={loadingVersion || updating}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loadingVersion ? "animate-spin" : ""}`} />
            查询
          </button>
        </div>

        {loadingVersion && !versionInfo ? (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在读取版本...
          </div>
        ) : versionInfo?.ok ? (
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 md:grid-cols-[104px_1fr]">
              <div className="text-slate-500">当前版本</div>
              <div className="min-w-0">
                <span className="font-semibold text-slate-900">{currentVersionText || "unknown"}</span>
                {versionInfo.localCommitMsg ? (
                  <span className="ml-2 text-xs text-slate-500">{versionInfo.localCommitMsg}</span>
                ) : null}
              </div>

              <div className="text-slate-500">远端版本</div>
              <div className="min-w-0">
                {canCheckUpdate ? (
                  <>
                    <span className="font-semibold text-slate-900">{availableVersionText || versionInfo.remoteCommit}</span>
                    {versionInfo.remoteCommitMsg ? (
                      <span className="ml-2 text-xs text-slate-500">{versionInfo.remoteCommitMsg}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-amber-600">未获取，请检查网络后查询</span>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  needsUpdate
                    ? "bg-amber-50 text-amber-700"
                    : isLatest
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-slate-100 text-slate-600"
                }`}
              >
                {updateStatusText}
              </span>
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {versionInfo.localVersion}
              </span>
            </div>

            {!canCheckUpdate && (versionInfo.fetchError || versionInfo.githubFetchError) ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                获取远端版本失败：{versionInfo.fetchError || versionInfo.githubFetchError}
              </div>
            ) : null}

            {dockerManaged && versionInfo.imageSourceConfig ? (
              <div className="border-t border-slate-100 pt-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-slate-500">镜像源</div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => testImageSourceSpeed()}
                      disabled={testingImageSource || savingImageSource || updating}
                      className="h-8 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {testingImageSource ? "测速中" : "测试速度"}
                    </button>
                    <button
                      onClick={saveImageSource}
                      disabled={savingImageSource || updating}
                      className="h-8 rounded-md bg-slate-800 px-3 text-xs text-white hover:bg-slate-700 disabled:opacity-50"
                    >
                      {savingImageSource ? "保存中" : "保存"}
                    </button>
                  </div>
                </div>

                <div className="overflow-hidden rounded-md border border-slate-200">
                  {versionInfo.imageSourceConfig.options.map((option) => {
                    const selected = imageSourceDraft.source === option.value;
                    const speed = imageSpeedResults[option.value];
                    const appImage =
                      option.value === "custom"
                        ? imageSourceDraft.customAppImage || option.appImage || "未填写"
                        : option.appImage || versionInfo.imageSourceConfig?.appImage || "";
                    return (
                      <label
                        key={option.value}
                        onClick={() => {
                          setImageSourceDraft((draft) => ({ ...draft, source: option.value }));
                          setImageSourceMessage("");
                        }}
                        className={`grid cursor-pointer grid-cols-[28px_92px_1fr_88px] items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-b-0 hover:bg-slate-50 ${
                          selected ? "bg-blue-50/60" : ""
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          readOnly
                          disabled={savingImageSource || updating}
                          className="h-4 w-4 rounded border-slate-300 text-blue-600"
                        />
                        <span className="font-medium text-slate-800">{option.label}</span>
                        <span className="min-w-0 truncate font-mono text-slate-500">{appImage || "自动检测可用镜像源"}</span>
                        <span
                          className={`text-right ${
                            speed?.ok ? "text-emerald-600" : speed ? "text-red-600" : "text-slate-400"
                          }`}
                        >
                          {speed ? (speed.ok ? `${speed.ms}ms` : "失败") : option.value === "auto" ? "自动" : "未测"}
                        </span>
                      </label>
                    );
                  })}
                </div>

                {imageSourceDraft.source === "custom" ? (
                  <div className="mt-2 grid gap-2 md:grid-cols-[104px_1fr]">
                    <div className="text-xs text-slate-500">应用镜像</div>
                    <input
                      value={imageSourceDraft.customAppImage}
                      onChange={(event) => setImageSourceDraft((draft) => ({ ...draft, customAppImage: event.target.value }))}
                      disabled={savingImageSource || updating}
                      className="h-8 rounded-md border border-slate-200 px-2 text-sm text-slate-700 outline-none focus:border-blue-400 disabled:opacity-50"
                      placeholder="registry.example.com/frankluise5220/mmh:latest"
                    />
                    <div className="text-xs text-slate-500">更新器镜像</div>
                    <input
                      value={imageSourceDraft.customUpdaterImage}
                      onChange={(event) => setImageSourceDraft((draft) => ({ ...draft, customUpdaterImage: event.target.value }))}
                      disabled={savingImageSource || updating}
                      className="h-8 rounded-md border border-slate-200 px-2 text-sm text-slate-700 outline-none focus:border-blue-400 disabled:opacity-50"
                      placeholder="registry.example.com/frankluise5220/mmh-updater:latest"
                    />
                  </div>
                ) : null}

                <div className="mt-1 min-h-4 text-xs text-slate-500">
                  {imageSourceMessage || "测速只检查镜像清单响应，不下载镜像层。"}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-xs text-red-600">获取版本信息失败</div>
        )}
      </section>

      {!updating && !updateDone && versionInfo?.ok ? (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          {needsUpdate && (!dockerManaged || versionInfo.updaterEnabled) ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-amber-700">
                  <Download className="h-4 w-4 shrink-0" />
                  发现新版本
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {dockerManaged ? "将同步部署文件、拉取新镜像并重启服务。" : `将更新到 ${versionInfo.remoteCommit}`}
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
          ) : dockerManaged ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              当前为 Docker 部署，但未启用宿主机更新执行器。请在宿主机项目目录运行
              <div className="mt-2 rounded bg-white/70 px-3 py-2 font-mono text-xs text-slate-700">
                git pull
                <br />
                sudo docker compose pull app updater
                <br />
                sudo docker compose up -d
              </div>
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
