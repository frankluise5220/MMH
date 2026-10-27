"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, XCircle } from "lucide-react";
import {
  APP_PREFS_EVENT,
  getTimeZonePreference,
  type DisplayLanguage,
} from "@/lib/client/appPreferences";
import { useI18n } from "@/lib/i18n";

type VersionInfo = {
  ok: boolean;
  deploymentTarget?: "docker" | "fnos" | "synology" | "standalone";
  isDocker?: boolean;
  isFnos?: boolean;
  isSynology?: boolean;
  updaterEnabled?: boolean;
  updateMode?: "git" | "fnos" | "synology";
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
  remoteVersion?: string;
  remoteCommit: string;
  remoteCommitMsg: string;
  remoteCommitDate?: string;
  needsUpdate: boolean;
  canCheckUpdate?: boolean;
  imageSourceConfig?: ImageSourceConfig | null;
  localReleaseNotes?: string;
  localReleaseNotesI18n?: Partial<Record<DisplayLanguage, string>>;
  fetchError?: string;
  error?: string;
};

type StepStatus = "pending" | "running" | "completed" | "failed";

type StepState = {
  key: string;
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
  version?: {
    digest?: string;
    digestShort?: string;
    revision?: string;
    commit?: string;
    created?: string;
    message?: string;
    version?: string;
  };
  error?: string;
};

// Step keys are matched against the step names emitted by the update API (data, not UI copy).
const UPDATE_STEPS = ["拉取代码", "安装依赖", "生成 Prisma Client", "同步数据库", "构建项目"];
const DOCKER_UPDATE_STEPS = ["更新前快照", "同步部署文件", "检测镜像源", "拉取应用镜像", "重启服务"];

function updateStepLabel(key: string, t: (key: string) => string) {
  switch (key) {
    case "拉取代码": return t("settings.systemUpdate.step.pullCode");
    case "安装依赖": return t("settings.systemUpdate.step.installDeps");
    case "生成 Prisma Client": return t("settings.systemUpdate.step.generatePrisma");
    case "同步数据库": return t("settings.systemUpdate.step.syncDb");
    case "构建项目": return t("settings.systemUpdate.step.build");
    case "更新前快照": return t("settings.systemUpdate.step.takeSnapshot");
    case "同步部署文件": return t("settings.systemUpdate.step.syncFiles");
    case "检测镜像源": return t("settings.systemUpdate.step.detectMirror");
    case "拉取应用镜像": return t("settings.systemUpdate.step.pullImage");
    case "重启服务": return t("settings.systemUpdate.step.restartService");
    default: return key;
  }
}
const FIXED_IMAGE_SOURCE_OPTIONS = [
  { value: "auto", label: "", appImage: "", updaterImage: "" },
  { value: "ghcr", label: "GHCR", appImage: "ghcr.io/frankluise5220/mmh:latest", updaterImage: "ghcr.io/frankluise5220/mmh-updater:latest" },
  { value: "dockerproxy", label: "dockerproxy", appImage: "ghcr.dockerproxy.net/frankluise5220/mmh:latest", updaterImage: "ghcr.dockerproxy.net/frankluise5220/mmh-updater:latest" },
  { value: "nju", label: "NJU", appImage: "ghcr.nju.edu.cn/frankluise5220/mmh:latest", updaterImage: "ghcr.nju.edu.cn/frankluise5220/mmh-updater:latest" },
  { value: "daocloud", label: "DaoCloud", appImage: "ghcr.m.daocloud.io/frankluise5220/mmh:latest", updaterImage: "ghcr.m.daocloud.io/frankluise5220/mmh-updater:latest" },
  { value: "fnvps", label: "FN VPS", appImage: "fnapp.floatingice.win:5000/frankluise5220/mmh:latest", updaterImage: "fnapp.floatingice.win:5000/frankluise5220/mmh-updater:latest" },
];

function formatVersionDate(value: string | undefined, timeZone: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  };
  options.timeZone = timeZone;
  return new Intl.DateTimeFormat("zh-CN", options).format(date).replace(/\//g, "-");
}

function cleanVersionPart(value: string | undefined) {
  const text = String(value ?? "").trim();
  return text && text !== "unknown" ? text : "";
}

function formatVersionLine(
  version: string | undefined,
  commit: string | undefined,
  date: string | undefined,
  timeZone: string,
) {
  const head = [
    cleanVersionPart(version),
    cleanVersionPart(commit),
  ].filter(Boolean).join(" ");
  return [head, formatVersionDate(date, timeZone)].filter(Boolean).join(" · ");
}

function formatImageVersion(result: ImageSpeedResult | undefined, timeZone: string, t: (key: string) => string) {
  if (!result) return "";
  if (!result.ok) return result.error || t("settings.systemUpdate.failed");
  const version = result.version?.version || "";
  const commit = result.version?.commit || "";
  const digest = result.version?.digestShort || "";
  const date = formatVersionDate(result.version?.created, timeZone);
  const versionAndCommit = [version, commit].filter(Boolean).join(" ");
  if (versionAndCommit && date) return `${versionAndCommit} · ${date}`;
  if (versionAndCommit) return versionAndCommit;
  if (digest) return `digest ${digest}`;
  return t("settings.systemUpdate.versionUnread");
}

function imageSourceOptionLabel(option: { value: string; label: string }, t: (key: string) => string) {
  return option.value === "auto" ? t("settings.systemUpdate.autoSelect") : option.label;
}

function stripMarkdownEmphasis(value: string) {
  return value.replace(/^\*\*(.+)\*\*$/, "$1").trim();
}

function ReleaseNotesText({ value }: { value: string }) {
  const blocks = value
    .split(/\r?\n/)
    .map((line) => line.trimEnd());

  return (
    <div className="min-w-0 space-y-2 text-slate-700">
      {blocks.map((line, index) => {
        const key = `${index}-${line}`;
        const trimmed = line.trim();
        if (!trimmed) return <div key={key} className="h-1" aria-hidden="true" />;

        const heading = trimmed.match(/^(#{2,4})\s+(.+)$/);
        if (heading) {
          const level = heading[1].length;
          return (
            <div
              key={key}
              className={`${level === 2 ? "pt-1 text-sm" : "text-xs"} font-semibold text-slate-900`}
            >
              {stripMarkdownEmphasis(heading[2])}
            </div>
          );
        }

        if (trimmed.startsWith(">")) {
          return (
            <div key={key} className="border-l-2 border-blue-200 pl-3 text-xs leading-5 text-slate-600">
              {stripMarkdownEmphasis(trimmed.replace(/^>\s*/, ""))}
            </div>
          );
        }

        const bullet = trimmed.match(/^-\s+(.+)$/);
        if (bullet) {
          return (
            <div key={key} className="flex min-w-0 gap-2 text-xs leading-5 text-slate-700">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
              <span className="min-w-0 break-words">{stripMarkdownEmphasis(bullet[1])}</span>
            </div>
          );
        }

        return <div key={key} className="break-words text-xs leading-5 text-slate-700">{stripMarkdownEmphasis(trimmed)}</div>;
      })}
    </div>
  );
}

// The updater image lives in the same registry as the app image with the repo
// name `mmh-updater`, so the custom source only needs the app image address.
function deriveUpdaterImage(appImage: string) {
  const value = appImage.trim();
  if (!value) return "";
  return value.replace(/\/(mmh)(?=[:@]|$)/, "/mmh-updater");
}

export default function SystemUpdatePage() {
  const { t, language } = useI18n();
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [loadingVersion, setLoadingVersion] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [updateDone, setUpdateDone] = useState(false);
  const [updateOk, setUpdateOk] = useState(false);
  const [updateError, setUpdateError] = useState("");
  // Docker updates are executed by the host updater; the console panel mirrors
  // its full log (commands included) so the page shows what actually ran
  // instead of only a step label.
  const [consoleLines, setConsoleLines] = useState<string[]>([]);
  const [imageSourceDraft, setImageSourceDraft] = useState<ImageSourceDraft>({
    source: "auto",
    customAppImage: "",
    customUpdaterImage: "",
  });
  const [savingImageSource, setSavingImageSource] = useState(false);
  const [imageSourceMessage, setImageSourceMessage] = useState("");
  // Synchronous guard so rapid row clicks cannot start overlapping saves.
  const imageSourceSaveInFlightRef = useRef(false);
  const customImageSourceIncomplete = imageSourceDraft.source === "custom"
    && !imageSourceDraft.customAppImage.trim();
  const [testingImageSource, setTestingImageSource] = useState(false);
  const [imageSpeedResults, setImageSpeedResults] = useState<Record<string, ImageSpeedResult>>({});
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");

  const loadVersionInfo = useCallback(async (options?: { checkRemote?: boolean }) => {
    setLoadingVersion(true);
    try {
      const query = options?.checkRemote ? "?check=1" : "";
      const res = await fetch(`/api/v1/settings/system-update${query}`, { cache: "no-store" });
      const data = await res.json();
      setVersionInfo(data);
      if (data?.imageSourceConfig) {
        setImageSourceDraft({
          source: data.imageSourceConfig.source || "auto",
          customAppImage: data.imageSourceConfig.customAppImage || "",
          customUpdaterImage: deriveUpdaterImage(data.imageSourceConfig.customAppImage || ""),
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

  useEffect(() => {
    function syncTimeZonePreference() {
      setTimeZone(getTimeZonePreference());
    }
    syncTimeZonePreference();
    window.addEventListener(APP_PREFS_EVENT, syncTimeZonePreference);
    return () => window.removeEventListener(APP_PREFS_EVENT, syncTimeZonePreference);
  }, []);

  function initSteps() {
    return UPDATE_STEPS.map((key) => ({ key, label: updateStepLabel(key, t), status: "pending" as StepStatus, output: "" }));
  }

  async function saveImageSource(draftOverride?: ImageSourceDraft) {
    setSavingImageSource(true);
    setImageSourceMessage("");
    const draft = draftOverride ?? imageSourceDraft;
    try {
      const res = await fetch("/api/v1/settings/system-update?config=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || t("settings.systemUpdate.saveFailed"));
      }
      setVersionInfo((prev) => prev ? { ...prev, imageSourceConfig: data.config } : prev);
      setImageSourceMessage(t("settings.systemUpdate.saved"));
      return true;
    } catch (e) {
      setImageSourceMessage(e instanceof Error ? e.message : t("settings.systemUpdate.saveFailed"));
      return false;
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
        throw new Error(data?.error || t("settings.systemUpdate.speedTestFailed"));
      }
      const next = { ...imageSpeedResults };
      for (const result of data.results as ImageSpeedResult[]) {
        next[result.source] = result;
      }
      setImageSpeedResults(next);
      setImageSourceMessage(t("settings.systemUpdate.speedTestDone"));
    } catch (e) {
      setImageSourceMessage(e instanceof Error ? e.message : t("settings.systemUpdate.speedTestFailed"));
    } finally {
      setTestingImageSource(false);
    }
  }

  async function startUpdate() {
    setUpdating(true);
    setUpdateDone(false);
    setUpdateOk(false);
    setUpdateError("");
    setConsoleLines([]);
    setSteps(versionInfo?.isDocker ? DOCKER_UPDATE_STEPS.map((key) => ({ key, label: updateStepLabel(key, t), status: "pending" as StepStatus, output: "" })) : initSteps());

    // The image source list is a draft until saved, but the updater only reads
    // the persisted config. Persist the visible selection before updating so
    // the update uses exactly the source the user sees selected.
    const savedConfig = versionInfo?.imageSourceConfig;
    if (savedConfig) {
      const draft = imageSourceDraft;
      const customImageChanged = draft.source === "custom"
        && (savedConfig.customAppImage || "") !== (draft.customAppImage || "");
      if (savedConfig.source !== draft.source || customImageChanged) {
        const saved = await saveImageSource();
        if (!saved) {
          setUpdateDone(true);
          setUpdateOk(false);
          setUpdateError(t("settings.systemUpdate.saveFailed"));
          setUpdating(false);
          return;
        }
      }
    }

    try {
      const res = await fetch("/api/v1/settings/system-update?mode=update", { method: "POST" });
      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => null);
        setUpdateDone(true);
        setUpdateOk(false);
        setUpdateError(errData?.error || t("settings.systemUpdate.updateUnavailable"));
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
                  s.key === event.step
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
      setUpdateError(e instanceof Error ? e.message : t("settings.systemUpdate.networkError"));
      setUpdating(false);
    }
  }

  async function pollDockerUpdate() {
    let shouldContinue = true;
    let statusFetchFailures = 0;
    let lastCurrentStep = "";
    let restartWaitStartedAt: number | null = null;
    // While the app container restarts, this page cannot reach the app and
    // fetch failures are expected. On low-power NAS devices a cold start
    // (compat migration + Prisma sync + Next.js boot) can take over a minute,
    // so the restart wait budget is measured by total consecutive downtime
    // rather than by the number of failures.
    const RESTART_MAX_WAIT_MS = 8 * 60 * 1000;
    const STATUS_FETCH_TIMEOUT_MS = 20 * 1000;
    const MAX_UPSTREAM_ERRORS = 5;
    while (shouldContinue) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), STATUS_FETCH_TIMEOUT_MS);
        const res = await fetch("/api/v1/settings/system-update?status=1", {
          method: "POST",
          cache: "no-store",
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || t("settings.systemUpdate.statusQueryFailed"));
        statusFetchFailures = 0;
        const task = data.task as {
          status?: string;
          currentStep?: string;
          logs?: string[];
          error?: string;
          rollback?: { attempted?: boolean; appRestored?: boolean; dbRestored?: boolean; error?: string } | null;
        };
        const current = task.currentStep || "";
        lastCurrentStep = current || lastCurrentStep;
        // The updater echoes every command it runs, so the console panel shows
        // the whole sequence instead of the last few lines of the current step.
        const logs = Array.isArray(task.logs) ? task.logs : [];
        setConsoleLines(logs);
        const currentIndex = DOCKER_UPDATE_STEPS.indexOf(current);
        setSteps((prev) =>
          prev.map((step) => {
            if (step.key === current) return { ...step, status: "running" };
            if (currentIndex >= 0 && DOCKER_UPDATE_STEPS.indexOf(step.key) < currentIndex) return { ...step, status: "completed" };
            return step;
          }),
        );
        // The updater recreates itself after the app is restarted. Older updater
        // images keep task state only in memory, so the first successful status
        // response after reconnect can be `idle` instead of `completed`.
        const updaterRestartedAfterApp = task.status === "idle" && lastCurrentStep === "重启服务";
        if (task.status === "completed" || updaterRestartedAfterApp) {
          setSteps((prev) => prev.map((step) => ({ ...step, status: "completed" })));
          setUpdateDone(true);
          setUpdateOk(true);
          setUpdating(false);
          shouldContinue = false;
          // No auto-reload here on purpose: reloading would wipe the console
          // panel the operator just asked for. The success card offers a manual
          // reload button instead.
        } else if (task.status === "rolledback") {
          // The updater restored the previous application image and the database
          // snapshot, so the service this page is talking to is the old version
          // again. Report it as a failed update that was rolled back rather than
          // leaving the progress list spinning on a status it will never reach.
          setSteps((prev) => prev.map((step) => (
            step.status === "running" ? { ...step, status: "failed" } : step
          )));
          setUpdateDone(true);
          setUpdateOk(false);
          setUpdateError(
            task.rollback?.dbRestored === false
              ? t("settings.systemUpdate.rolledBackPartial")
              : t("settings.systemUpdate.rolledBack"),
          );
          setUpdating(false);
          shouldContinue = false;
        } else if (task.status === "failed") {
          const rollbackError = task.rollback?.error;
          setUpdateDone(true);
          setUpdateOk(false);
          setUpdateError(
            rollbackError
              ? t("settings.systemUpdate.rollbackFailed", { message: rollbackError })
              : task.error || t("settings.systemUpdate.updateFailed"),
          );
          setUpdating(false);
          shouldContinue = false;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : t("settings.systemUpdate.statusQueryFailed");
        const isNetworkFailure =
          e instanceof TypeError ||
          (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError");
        if (isNetworkFailure) {
          // The app is unreachable: its container is restarting or has not
          // finished booting. This is normal during the restart phase, so give
          // enough total wait budget instead of reporting a slow restart as a
          // failed update.
          if (restartWaitStartedAt === null) restartWaitStartedAt = Date.now();
          const waitedMs = Date.now() - restartWaitStartedAt;
          if (waitedMs < RESTART_MAX_WAIT_MS) {
            setSteps((prev) =>
              prev.map((step) =>
                step.key === "重启服务"
                  ? { ...step, status: "running", output: t("settings.systemUpdate.reconnecting", { seconds: Math.round(waitedMs / 1000) }) }
                  : step,
              ),
            );
            await new Promise((resolve) => setTimeout(resolve, 1500));
            continue;
          }
          setUpdateDone(true);
          setUpdateOk(false);
          setUpdateError(
            t("settings.systemUpdate.restartTimeout", { seconds: Math.round(waitedMs / 1000) }),
          );
          setUpdating(false);
          shouldContinue = false;
        } else {
          // The app is reachable but the update executor status query failed
          // (for example the executor is rebuilding or crashed).
          statusFetchFailures += 1;
          if (statusFetchFailures >= MAX_UPSTREAM_ERRORS) {
            setUpdateDone(true);
            setUpdateOk(false);
            setUpdateError(
              t("settings.systemUpdate.updaterQueryFailed", { message }),
            );
            setUpdating(false);
            shouldContinue = false;
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
        }
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
  const synologyManaged = Boolean(versionInfo?.isSynology || versionInfo?.deploymentTarget === "synology");
  const fnosManaged = Boolean(versionInfo?.isFnos || versionInfo?.deploymentTarget === "fnos");
  const packageManaged = fnosManaged || synologyManaged;
  const packageLabel = synologyManaged ? "SPK" : "FNOS";
  const currentVersionText = packageManaged
    ? `${cleanVersionPart(versionInfo?.localVersion) || "unknown"} ${packageLabel}`
    : formatVersionLine(versionInfo?.localVersion, versionInfo?.localCommit, versionInfo?.localCommitDate, timeZone);
  const localReleaseNotes = versionInfo?.localReleaseNotes?.trim() || "";
  // 「本版说明」按界面语言取正文，该语言没有就回落中文正文；两者都为空时整块不渲染。
  // `localReleaseNotes` 是各商店共用的单行短说明，`ReleaseNotesText` 按 `\n` 切行渲染，
  // 单行文本会挤成一整团，所以它只作最后兜底（旧包没有 mmhReleaseNotesI18n 时的回落）。
  const releaseNotesText = versionInfo?.localReleaseNotesI18n?.[language]?.trim()
    || versionInfo?.localReleaseNotesI18n?.["zh-CN"]?.trim()
    || localReleaseNotes;
  const availableVersionText = formatVersionLine(
    versionInfo?.remoteVersion,
    versionInfo?.remoteCommit,
    versionInfo?.remoteCommitDate,
    timeZone,
  );
  const remoteSourceText = [
    versionInfo?.remoteName,
    versionInfo?.remoteUrl,
  ].filter(Boolean).join(" · ");
  const githubProjectUrl = (versionInfo?.githubUrl || "https://github.com/frankluise5220/MMH").replace(/\.git$/, "");
  const githubReleaseUrl = versionInfo?.localVersion && versionInfo.localVersion !== "unknown"
    ? `${githubProjectUrl}/releases/tag/v${versionInfo.localVersion}`
    : `${githubProjectUrl}/releases`;
  const updateStatusText = needsUpdate
    ? t("settings.systemUpdate.updateAvailable")
    : isLatest
      ? t("settings.systemUpdate.isLatest")
      : t("settings.systemUpdate.unconfirmed");
  const canStartUpdate = !packageManaged && needsUpdate && (!dockerManaged || versionInfo.updaterEnabled);
  const updateActionPanel = !updating && !updateDone && versionInfo?.ok && !canStartUpdate ? (
    <div className="border-t border-slate-100 pt-3">
      {isLatest ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {t("settings.systemUpdate.currentIsLatest")}
        </div>
      ) : needsUpdate && !canStartUpdate && dockerManaged ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t("settings.systemUpdate.dockerUpdaterDisabled")}
          <div className="mt-2 space-y-2 text-xs">
            <div>
              <div className="text-amber-900/80">{t("settings.systemUpdate.dockerUpdaterEnableHint")}</div>
              <pre className="mt-1 overflow-x-auto rounded bg-white/70 px-3 py-2 font-mono text-slate-700">{`cd ~/mmh
grep -qE '^MMH_UPDATE_TOKEN=..*' .env || echo 'MMH_UPDATE_TOKEN="'$(openssl rand -hex 24)'"' >> .env
sudo docker compose -p mmh up -d app updater`}</pre>
            </div>
            <div>
              <div className="text-amber-900/80">{t("settings.systemUpdate.dockerUpdaterManualHint")}</div>
              <pre className="mt-1 overflow-x-auto rounded bg-white/70 px-3 py-2 font-mono text-slate-700">{`cd ~/mmh
sudo docker compose -p mmh pull app updater
sudo docker compose -p mmh up -d app updater`}</pre>
            </div>
            <div className="text-amber-900/80">{t("settings.systemUpdate.dockerUpdaterImageSourceHint")}</div>
          </div>
        </div>
      ) : !canCheckUpdate ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          {t("settings.systemUpdate.cannotCheckRemote")}
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-800">{packageManaged ? t("settings.systemUpdate.versionInfo") : t("settings.systemUpdate.title")}</h2>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-slate-800">
            {packageManaged ? t("settings.systemUpdate.versionInfo") : dockerManaged ? t("settings.systemUpdate.softwareUpdateImage") : t("settings.systemUpdate.softwareUpdate")}
          </div>
          <button
            onClick={() => loadVersionInfo({ checkRemote: true })}
            disabled={loadingVersion || updating}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loadingVersion ? "animate-spin" : ""}`} />
            {t("settings.systemUpdate.refresh")}
          </button>
        </div>

        {!loadingVersion && !versionInfo ? (
          <div className="rounded-md border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-center text-sm text-slate-500">
            {packageManaged ? t("settings.systemUpdate.readFailedFnos") : t("settings.systemUpdate.readFailed")}
          </div>
        ) : loadingVersion && !versionInfo ? (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("settings.systemUpdate.readingVersion")}
          </div>
        ) : versionInfo?.ok ? (
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 md:grid-cols-[104px_1fr]">
              <div className="text-slate-500">{t("settings.systemUpdate.currentVersion")}</div>
              <div className="min-w-0">
                <span className="font-semibold text-slate-900">{currentVersionText || "unknown"}</span>
                {packageManaged ? (
                  <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{synologyManaged ? t("settings.systemUpdate.synologyPackage") : t("settings.systemUpdate.fnosPackage")}</span>
                ) : versionInfo.localCommitMsg ? (
                  <span className="ml-2 text-xs text-slate-500">{versionInfo.localCommitMsg}</span>
                ) : null}
              </div>

              {releaseNotesText ? (
                <>
                  <div className="text-slate-500">{t("settings.systemUpdate.releaseNotes")}</div>
                  <ReleaseNotesText value={releaseNotesText} />
                </>
              ) : null}

              <div className="text-slate-500">{t("settings.systemUpdate.projectUrl")}</div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <a
                    href={githubProjectUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-blue-600 hover:text-blue-700"
                  >
                    {t("settings.systemUpdate.githubHome")}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  <a
                    href={githubReleaseUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-800"
                  >
                    {t("settings.systemUpdate.currentRelease")}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              </div>

              <div className="text-slate-500">{packageManaged ? t("settings.systemUpdate.updateMethod") : needsUpdate ? t("settings.systemUpdate.availableVersion") : t("settings.systemUpdate.remoteVersion")}</div>
              <div className="min-w-0">
                {packageManaged ? (
                  <span className="text-slate-600">{synologyManaged ? t("settings.systemUpdate.managedBySynology") : t("settings.systemUpdate.managedByFnos")}</span>
                ) : canCheckUpdate ? (
                  <>
                    <span className="font-semibold text-slate-900">{availableVersionText || versionInfo.remoteCommit}</span>
                    {versionInfo.remoteCommitMsg ? (
                      <span className="ml-2 text-xs text-slate-500">{versionInfo.remoteCommitMsg}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-amber-600">{t("settings.systemUpdate.notFetched")}</span>
                )}
              </div>

              {canCheckUpdate && remoteSourceText ? (
                <>
                  <div className="text-slate-500">{t("settings.systemUpdate.versionSource")}</div>
                  <div className="min-w-0 truncate text-xs text-slate-500" title={remoteSourceText}>
                    {remoteSourceText}
                  </div>
                </>
              ) : null}
            </div>

            {packageManaged ? (
              <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                {synologyManaged ? t("settings.systemUpdate.synologyManagedInfo") : t("settings.systemUpdate.fnosManagedInfo")}
              </div>
            ) : null}

            {!packageManaged && !isLatest ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      needsUpdate
                        ? "bg-amber-50 text-amber-700"
                        : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {updateStatusText}
                  </span>
                  {needsUpdate ? (
                    <span className="text-xs text-slate-500">
                      {dockerManaged ? t("settings.systemUpdate.willPullImage") : t("settings.systemUpdate.willUpdateTo", { version: availableVersionText || versionInfo.remoteCommit })}
                    </span>
                  ) : null}
                </div>
                {canStartUpdate ? (
                  <button
                    onClick={startUpdate}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {t("settings.systemUpdate.update")}
                  </button>
                ) : null}
              </div>
            ) : null}

            {!packageManaged && !canCheckUpdate && (versionInfo.fetchError || versionInfo.githubFetchError) ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                {t("settings.systemUpdate.fetchRemoteFailed", { error: versionInfo.fetchError || versionInfo.githubFetchError || "" })}
              </div>
            ) : null}

            {!packageManaged && canCheckUpdate && versionInfo.remoteName?.startsWith("image:") && versionInfo.githubFetchError ? (
              <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                {t("settings.systemUpdate.githubFallback")}
              </div>
            ) : null}

            {!packageManaged ? updateActionPanel : null}

            {!packageManaged && dockerManaged && versionInfo.imageSourceConfig ? (
              <div className="border-t border-slate-100 pt-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-slate-500">{t("settings.systemUpdate.imageSource")}</div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => testImageSourceSpeed()}
                      disabled={testingImageSource || savingImageSource || updating}
                      className="h-8 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {testingImageSource ? t("settings.systemUpdate.speedTesting") : t("settings.systemUpdate.testSpeed")}
                    </button>
                    <button
                      onClick={() => saveImageSource()}
                      disabled={savingImageSource || updating || customImageSourceIncomplete}
                      className="h-8 rounded-md bg-slate-800 px-3 text-xs text-white hover:bg-slate-700 disabled:opacity-50"
                    >
                      {savingImageSource ? t("settings.systemUpdate.saving") : t("common.save")}
                    </button>
                  </div>
                </div>

                <div className="overflow-hidden rounded-md border border-slate-200">
                  {[
                    ...FIXED_IMAGE_SOURCE_OPTIONS,
                    ...(versionInfo.imageSourceConfig.options ?? []).filter((option) => option.value === "custom"),
                  ].map((option) => {
                    const selected = imageSourceDraft.source === option.value;
                    const speed = imageSpeedResults[option.value];
                    const appImage =
                      option.value === "custom"
                        ? imageSourceDraft.customAppImage || option.appImage || t("settings.systemUpdate.notFilled")
                        : option.appImage || "";
                    return (
                      <label
                        key={option.value}
                        onClick={() => {
                          if (imageSourceSaveInFlightRef.current || updating) return;
                          if (imageSourceDraft.source === option.value) return;
                          // Selecting a source takes effect immediately: persist
                          // the new draft instead of waiting for the Save button.
                          const nextDraft = { ...imageSourceDraft, source: option.value };
                          setImageSourceDraft(nextDraft);
                          setImageSourceMessage("");
                          // Custom needs an image address before it can be
                          // saved; it is persisted by Save or on update.
                          if (option.value === "custom") return;
                          imageSourceSaveInFlightRef.current = true;
                          void saveImageSource(nextDraft).finally(() => {
                            imageSourceSaveInFlightRef.current = false;
                          });
                        }}
                        className={`grid cursor-pointer grid-cols-[28px_92px_minmax(0,1fr)_180px] items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-b-0 hover:bg-slate-50 ${
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
                        <span className="font-medium text-slate-800">{imageSourceOptionLabel(option, t)}</span>
                        <span className="min-w-0 truncate font-mono text-slate-500">{appImage || t("settings.systemUpdate.autoDetect")}</span>
                        <span
                          className={`min-w-0 text-right ${
                            speed?.ok ? "text-emerald-600" : speed ? "text-red-600" : "text-slate-400"
                          }`}
                          title={speed ? formatImageVersion(speed, timeZone, t) : ""}
                        >
                          {speed ? (
                            speed.ok ? (
                              <span className="flex min-w-0 flex-col items-end leading-tight">
                                <span>{speed.ms}ms</span>
                                <span className="max-w-full truncate text-[10px] text-slate-500">
                                  {formatImageVersion(speed, timeZone, t)}
                                </span>
                              </span>
                            ) : t("settings.systemUpdate.failed")
                          ) : option.value === "auto" ? t("settings.systemUpdate.auto") : t("settings.systemUpdate.notTested")}
                        </span>
                      </label>
                    );
                  })}
                </div>

                {imageSourceDraft.source === "custom" ? (
                  <div className="mt-2 space-y-2">
                    <div className="grid gap-2 md:grid-cols-[104px_1fr]">
                      <div className="text-xs text-slate-500">{t("settings.systemUpdate.appImage")}</div>
                      <input
                        value={imageSourceDraft.customAppImage}
                        required
                        onChange={(event) => {
                          const value = event.target.value;
                          setImageSourceDraft((draft) => ({
                            ...draft,
                            customAppImage: value,
                            customUpdaterImage: deriveUpdaterImage(value),
                          }));
                        }}
                        disabled={savingImageSource || updating}
                        className="h-8 rounded-md border border-slate-200 px-2 text-sm text-slate-700 outline-none focus:border-blue-400 disabled:opacity-50"
                        placeholder="registry.example.com/frankluise5220/mmh:latest"
                      />
                    </div>
                    <div className="grid gap-2 md:grid-cols-[104px_1fr]">
                      <div className="text-xs text-slate-500">{t("settings.systemUpdate.updaterImage")}</div>
                      <div className="min-w-0 truncate font-mono text-xs text-slate-500">
                        {deriveUpdaterImage(imageSourceDraft.customAppImage) || t("settings.systemUpdate.notFilled")}
                      </div>
                    </div>
                    <div className="text-xs text-slate-400">{t("settings.systemUpdate.updaterDerived")}</div>
                  </div>
                ) : null}

                <div className="mt-1 min-h-4 text-xs text-slate-500">
                  {imageSourceMessage || t("settings.systemUpdate.speedTestHint")}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-xs text-red-600">{t("settings.systemUpdate.fetchInfoFailed")}</div>
        )}
      </section>

      {(updating || updateDone) && steps.length > 0 ? (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="mb-3 text-sm font-medium text-slate-800">{t("settings.systemUpdate.updateProgress")}</div>

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
                    {s.status === "running" ? t("settings.systemUpdate.inProgress") : ""}
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

          {dockerManaged && (updating || consoleLines.length > 0) ? (
            <div className="mt-4">
              <UpdateConsole lines={consoleLines} running={updating} t={t} />
            </div>
          ) : null}

          {updateDone ? (
            <div className="mt-4">
              {updateOk ? (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                  <div className="text-sm font-medium text-emerald-800">{t("settings.systemUpdate.updateComplete")}</div>
                  <button
                    onClick={() => window.location.reload()}
                    className="ml-auto h-8 rounded-md bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-700"
                  >
                    {t("settings.systemUpdate.reloadPage")}
                  </button>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                  <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-red-800">{t("settings.systemUpdate.updateFailed")}</div>
                    {updateError ? <div className="mt-1 break-all text-xs text-red-600">{updateError}</div> : null}
                  </div>
                  <button
                    onClick={() => window.location.reload()}
                    className="ml-auto h-8 shrink-0 rounded-md border border-red-300 px-3 text-xs text-red-700 hover:bg-red-100"
                  >
                    {t("settings.systemUpdate.reloadPage")}
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** `[2026-10-27T01:07:41.638Z] 拉取应用镜像` → timestamp + message. */
function splitConsoleLine(line: string) {
  const match = /^\[([^\]]+)\]\s?([\s\S]*)$/.exec(line);
  return match ? { time: match[1], text: match[2] } : { time: "", text: line };
}

/** Cheap log highlighting: command echo, step boundaries, failures, warnings. */
function consoleLineClass(text: string) {
  if (text.startsWith("$ ")) return "text-cyan-300";
  if (text.startsWith("开始")) return "text-sky-300";
  if (/^完成|更新完成|已就绪|已保存|已回滚/.test(text)) return "text-emerald-300";
  if (/失败|错误|fatal/i.test(text)) return "text-red-300";
  if (/警告|warn/i.test(text)) return "text-amber-300";
  return "text-slate-300";
}

/**
 * Terminal window for the host updater log.
 *
 * `docker pull` emits its progress as CR-separated frames; the updater replays
 * them with terminal semantics (CR repaints the current line) so what arrives is
 * a clean line list. The window adds what a raw <pre> could not: a viewport that
 * stops auto-following while the operator scrolls back, and an expanded mode for
 * long runs.
 */
function UpdateConsole({
  lines,
  running,
  t,
}: {
  lines: string[];
  running: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || !follow) return;
    node.scrollTop = node.scrollHeight;
  }, [lines, follow, expanded]);

  useEffect(() => {
    if (!expanded) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setExpanded(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  function handleScroll() {
    const node = viewportRef.current;
    if (!node) return;
    // Auto-scroll only while the operator is already at the bottom: scrolling
    // up to read an earlier command must not be yanked back by the next line.
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
    setFollow(atBottom);
  }

  function scrollToBottom() {
    const node = viewportRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    setFollow(true);
  }

  async function copyLog() {
    if (!lines.length) return;
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied (insecure context); the log stays visible.
    }
  }

  const header = (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-slate-700/80 bg-slate-800/80 px-3">
      <span className={`h-2 w-2 shrink-0 rounded-full ${running ? "animate-pulse bg-emerald-400" : "bg-slate-500"}`} />
      <span className="text-xs font-medium text-slate-200">{t("settings.systemUpdate.console")}</span>
      <span className="text-[11px] text-slate-400">
        {t("settings.systemUpdate.consoleLineCount", { count: lines.length })}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        {!follow ? (
          <button
            type="button"
            onClick={scrollToBottom}
            className="rounded border border-slate-600 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-700"
          >
            {t("settings.systemUpdate.consoleBottom")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setFollow(!follow)}
          className={`rounded border px-2 py-0.5 text-[11px] ${
            follow
              ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
              : "border-slate-600 text-slate-300 hover:bg-slate-700"
          }`}
        >
          {t("settings.systemUpdate.consoleFollow")}
        </button>
        <button
          type="button"
          onClick={copyLog}
          disabled={!lines.length}
          className="rounded border border-slate-600 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {copied ? t("settings.systemUpdate.consoleCopied") : t("settings.systemUpdate.consoleCopy")}
        </button>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="rounded border border-slate-600 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-700"
        >
          {expanded ? t("settings.systemUpdate.consoleCollapse") : t("settings.systemUpdate.consoleExpand")}
        </button>
      </div>
    </div>
  );

  const viewport = (
    <div
      ref={viewportRef}
      onScroll={handleScroll}
      className={`min-h-0 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11px] leading-relaxed ${
        expanded ? "flex-1" : "h-72"
      }`}
    >
      {lines.length ? (
        lines.map((line, index) => {
          const { time, text } = splitConsoleLine(line);
          return (
            <div key={index} className="flex gap-2">
              {time ? <span className="shrink-0 text-slate-500">{time}</span> : null}
              <span className={`min-w-0 ${consoleLineClass(text)}`}>{text}</span>
            </div>
          );
        })
      ) : (
        <div className="text-slate-500">{t("settings.systemUpdate.consoleEmpty")}</div>
      )}
    </div>
  );

  if (expanded) {
    return (
      <div className="fixed inset-0 z-[60] flex flex-col bg-slate-950/70 p-3 sm:p-6">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-2xl">
          {header}
          {viewport}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-slate-700 bg-slate-900">
      {header}
      {viewport}
    </div>
  );
}
