/**
 * 更新执行器（updater）、部署形态与「有没有新版本」的唯一实现。
 *
 * 这里放三件事：怎么跟宿主机 updater 说话、当前是什么部署形态、以及通知栏要的
 * 轻量版本判定。设置页的系统更新接口和通知栏的检查都从这里取，避免第二套判定漂移。
 *
 * 为什么还要 `loadUpdateNotice`：通知栏只需要「有没有新版本」，它不该拉 Release
 * 正文、读更新器配置清单、跑 git ls-remote——那是设置页 GET 的成本。这里按部署
 * 形态只做一次最小判定，并在进程内缓存，供通知栏低频轮询：
 *
 * - Docker：调 updater `/speed` 比对本地与远端镜像 digest（拿不到 digest 退回 commit）
 * - fnOS / 群晖 / 源码 / Windows 桌面：比对 GitHub `/releases/latest` 的 tag 版本号
 *   与运行中的 `package.json` 版本号，只提示、不执行任何更新
 *
 * 后四者的远端信源相同（都是同一条发布流程产出的 Release tag），所以共用一套判定；
 * 四者的差异只体现在「点进去怎么更新」，那是设置页文案的事。
 */
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

export const IMAGE_FALLBACK_ORDER = ["fnvps", "dockerproxy", "nju", "ghcr", "daocloud", "custom"];
export const STANDARD_IMAGE_SOURCE_ORDER = IMAGE_FALLBACK_ORDER.filter((source) => source !== "custom");
export const UPDATER_DEFAULT_TIMEOUT_MS = 5_000;
export const VERSION_CHECK_TIMEOUT_MS = 5_000;
export const IMAGE_VERSION_CHECK_TIMEOUT_MS = 6_000;

const GITHUB_REPO_API_URL = "https://api.github.com/repos/frankluise5220/MMH";

export type ImageSourceConfig = {
  source: string;
  appImage: string;
  updaterImage: string;
  customAppImage: string;
  customUpdaterImage: string;
  options: Array<{ value: string; label: string; appImage?: string; updaterImage?: string }>;
};

export type DeploymentTarget = "docker" | "fnos" | "synology" | "windows" | "standalone";

export function getUpdaterConfig() {
  const url = String(process.env.MMH_UPDATER_URL ?? "").trim();
  const token = String(process.env.MMH_UPDATE_TOKEN ?? "").trim();
  return { url, token, enabled: Boolean(url && token) };
}

/** Actionable guidance shown when the host updater cannot be reached due to missing configuration. */
export function getUpdaterSetupHint() {
  return "未配置宿主机更新执行器：请在 docker-compose.yml 同目录的 .env 中设置 MMH_UPDATE_TOKEN（任意长随机字符串，app 与 updater 两个容器取值需一致），然后执行 docker compose up -d app updater 使配置生效，再回到本页重试。";
}

export async function callUpdater(path: string, init?: RequestInit, timeoutMs = UPDATER_DEFAULT_TIMEOUT_MS) {
  const { url, token } = getUpdaterConfig();
  if (!url || !token) {
    throw new Error(getUpdaterSetupHint());
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null) as any;
    if (!res.ok) {
      const detail = String(data?.error ?? `更新执行器请求失败：${res.status}`);
      throw new Error(res.status === 401 ? `${detail}（鉴权失败：请检查 .env 中 MMH_UPDATE_TOKEN 是否与 updater 容器所用 token 一致，改后需 docker compose up -d app updater）` : detail);
    }
    return data;
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      throw new Error("更新执行器响应超时");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function isDockerEnvironment(): boolean {
  if (existsSync("/.dockerenv")) return true;
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
    if (cgroup.includes("docker") || cgroup.includes("kubepods")) return true;
  } catch {
    // /proc is unavailable on non-Linux hosts.
  }
  return process.env.DOCKER_CONTAINER === "true";
}

export function getDeploymentTarget(): DeploymentTarget {
  const target = String(process.env.MMH_DEPLOY_TARGET ?? "").trim().toLowerCase();
  // 飞牛 / 群晖的启动脚本会显式导出 MMH_DEPLOY_TARGET，而这种安装包也可能被
  // 装进容器化环境（此时 /.dockerenv 同样存在）。显式声明优先，否则包版会被
  // 误判成 Docker 镜像部署，既拿不到应用中心的管理文案，也用错了版本检查分支。
  if (target === "fnos") return "fnos";
  if (target === "synology") return "synology";
  if (isDockerEnvironment()) return "docker";
  // Windows desktop (Electron shell sets MMH_DEPLOY_TARGET=windows). It has no
  // git checkout and must never fall into the git/Docker update paths: its
  // updates come from electron-updater, driven by the settings page through the
  // preload bridge (下载 → 更新窗口 → 重启).
  if (target === "windows") return "windows";
  return "standalone";
}

export type LocalPackageJson = {
  version?: unknown;
  /**
   * The shared update note: the fnOS App Center 「版本说明」, the soft-store
   * `changelog`, the FnDepot entry and the Synology「新增功能」panel all render
   * this same single-line string. The in-app「本版说明」panel shows it too, so a
   * version's in-app note and its store note can never drift apart.
   */
  mmhFnosManifestChangelog?: unknown;
  /**
   * The long Markdown release body (three blocks, including the install /
   * upgrade instructions). It belongs to the GitHub Release 正文 only — the
   * in-app panel deliberately does not use it.
   */
  mmhReleaseNotes?: unknown;
  releaseNotes?: unknown;
  mmhReleaseNotesI18n?: unknown;
};

/**
 * Read the runtime `package.json` (version + release notes) from the app root.
 *
 * `process.cwd()` is correct for dev, Docker and the standalone/Windows layouts,
 * but the package-managed layouts start the bundled `server.js` from a parent
 * directory: the Synology start-stop script launches
 * `node <target>/app/server/server.js` without changing directory, and the fnOS
 * start script itself accepts both `<app>` and `<app>/server` as the process cwd
 * when it looks for a surviving server (`build-fnos-package.cjs`). A cwd-only
 * read therefore misses the file and blanks out both the local version and 本版说明
 * on those deployments, so fall back to the directory of the running entry script.
 */
export function readLocalPackageJson(projectRoot: string): LocalPackageJson {
  const candidates = [join(projectRoot, "package.json")];
  const entryScript = String(process.argv[1] ?? "").trim();
  if (entryScript) candidates.push(join(dirname(entryScript), "package.json"));
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      return JSON.parse(readFileSync(candidate, "utf-8")) as LocalPackageJson;
    } catch {
      // Try the next candidate instead of failing the whole update check.
    }
  }
  return {};
}

/** 运行中的版本号；读不到时返回 `unknown`（调用方据此判定「无法比较」）。 */
export function readLocalPackageVersion(projectRoot: string = process.cwd()): string {
  const pkg = readLocalPackageJson(projectRoot);
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  return version || "unknown";
}

export function versionFromReleaseTag(tagName: string) {
  return tagName.trim().replace(/^v/i, "");
}

export function parseReleaseVersion(value: string) {
  const version = versionFromReleaseTag(value);
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  // Ignore old calendar/test tags such as v2026.08.05 when the GitHub API is
  // unreachable and we have to fall back to raw tag listing.
  if (parts[0]! > 99) return null;
  return { version, parts };
}

export function compareReleaseVersions(a: { parts: number[] }, b: { parts: number[] }) {
  for (let index = 0; index < 3; index += 1) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

type ImageVersionSpeedResult = {
  source?: string;
  image?: string;
  ok?: boolean;
  error?: string;
  version?: {
    digest?: string;
    digestShort?: string;
    revision?: string;
    commit?: string;
    created?: string;
    message?: string;
    version?: string;
  };
};

/**
 * 通知栏要的「有没有新版本」。
 *
 * `canCheck` 与 `available` 必须分开：`canCheck=false` 表示这台机器根本没法比
 * （没配更新器、读不到本地版本、远端取不到），客户端据此保持沉默，绝不能把
 * 「查不到」当成「没有更新」，更不能当成「有更新」。
 */
export type UpdateNotice = {
  /** 判定为有更新。 */
  available: boolean;
  /** 这次检查是否真的比对成功（false 时 available 恒为 false）。 */
  canCheck: boolean;
  deploymentTarget: DeploymentTarget;
  /** 本地镜像标签 / package.json 里的版本号，拿不到时为空串。 */
  localVersion: string;
  /** 远端 latest 指向的版本号，可能为空（镜像没有 version 标签）。 */
  remoteVersion: string;
  remoteCommit: string;
  /** 判定依据：image（镜像 digest） / release（GitHub Release tag）。 */
  source: "image" | "release";
  checkedAt: number;
  fetchError?: string;
};

const NOTICE_TTL_MS = 30 * 60 * 1000;
/** 失败也缓存，但短一些：网络抖动不该让通知栏每次轮询都去摸一遍镜像源。 */
const NOTICE_FAILURE_TTL_MS = 5 * 60 * 1000;

let noticeCache: { at: number; notice: UpdateNotice } | null = null;
let inFlight: Promise<UpdateNotice> | null = null;

function getImageVersionSourceOrder(imageSourceConfig: ImageSourceConfig | null) {
  const configuredSource = imageSourceConfig?.source || "auto";
  const customAppImage = imageSourceConfig?.customAppImage || "";
  if (configuredSource === "custom") return ["custom"];
  if (configuredSource && configuredSource !== "auto") {
    return [configuredSource, ...STANDARD_IMAGE_SOURCE_ORDER.filter((source) => source !== configuredSource)];
  }
  return customAppImage ? [...STANDARD_IMAGE_SOURCE_ORDER, "custom"] : STANDARD_IMAGE_SOURCE_ORDER;
}

function getImageVersionCheckBody(imageSourceConfig: ImageSourceConfig | null) {
  const configuredSource = imageSourceConfig?.source || "auto";
  const customAppImage = imageSourceConfig?.customAppImage || "";
  if (configuredSource === "custom") {
    return { source: "custom", customAppImage, timeoutMs: IMAGE_VERSION_CHECK_TIMEOUT_MS };
  }
  return { customAppImage, timeoutMs: IMAGE_VERSION_CHECK_TIMEOUT_MS };
}

function getComparableShortCommit(value: string | undefined) {
  const commit = String(value ?? "").trim();
  if (!commit || commit === "unknown") return "";
  return commit.slice(0, 7);
}

function unavailableNotice(
  deploymentTarget: DeploymentTarget,
  source: "image" | "release",
  fetchError: string,
): UpdateNotice {
  return {
    available: false,
    canCheck: false,
    deploymentTarget,
    localVersion: "",
    remoteVersion: "",
    remoteCommit: "",
    source,
    checkedAt: Date.now(),
    fetchError,
  };
}

/**
 * Docker：镜像 digest 比对。
 *
 * `available` 的判据与设置页 `getImageVersionFallback` 一致：远端 manifest 的 digest
 * 与本地镜像 digest 不等就是有更新；拿不到 digest 时退回 commit 比较。两条都不成立
 * 就返回 canCheck=false（无法判定），绝不能因为「远端取到了」就当成有更新。
 */
async function checkImageUpdateNotice(): Promise<UpdateNotice> {
  const target: DeploymentTarget = "docker";
  if (!getUpdaterConfig().enabled) {
    return unavailableNotice(target, "image", "未配置更新执行器");
  }
  let imageSourceConfig: ImageSourceConfig | null = null;
  try {
    const data = await callUpdater("/config", undefined, 3_000);
    imageSourceConfig = data?.config ?? null;
  } catch {
    imageSourceConfig = null;
  }
  const sourceOrder = getImageVersionSourceOrder(imageSourceConfig);

  let data: any;
  try {
    data = await callUpdater(
      "/speed",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(getImageVersionCheckBody(imageSourceConfig)),
      },
      IMAGE_VERSION_CHECK_TIMEOUT_MS + 2_000,
    );
  } catch (error) {
    return unavailableNotice(target, "image", error instanceof Error ? error.message : String(error));
  }

  const results = Array.isArray(data?.results) ? (data.results as ImageVersionSpeedResult[]) : [];
  const resultBySource = new Map(results.map((result) => [String(result.source || ""), result]));
  const selected = sourceOrder
    .map((source) => resultBySource.get(source))
    .find((result) => result?.ok && (result.version?.revision || result.version?.commit || result.version?.digest));
  if (!selected) {
    // 失败原因要能直接指向「网络」还是「镜像」，否则用户只会看到「检查失败」。
    // DNS 故障（NAS 的 resolv.conf 失效、53 端口被拦）在实测里最长见：
    // updater 报 `dial tcp: lookup <host> on 127.0.0.11:53: i/o timeout`。
    const attempted = sourceOrder.map((source) => resultBySource.get(source)).filter(Boolean);
    const rawError = String(attempted.find((result) => result?.error)?.error || "").trim();
    const dnsFailed = /lookup |no such host|i\/o timeout|server misbehaving|name resolution|ECONNREFUSED/i.test(rawError);
    const summary = dnsFailed
      ? "无法解析更新源域名（这台机器的 DNS 不可用）：请先恢复 NAS / 路由器的 DNS 解析，或在 docker-compose.yml 给 updater 加 extra_hosts 指向镜像站 IP 后重启该容器，再重试。"
      : `镜像版本检查失败或超时，已按顺序尝试：${sourceOrder.join("、")}`;
    const detail = rawError ? `${summary}（原始错误：${rawError.slice(0, 200)}）` : summary;
    return unavailableNotice(target, "image", detail);
  }

  const remoteVersionObj = selected.version ?? {};
  const remoteDigest = String(remoteVersionObj.digest || "").trim();
  const remoteDigestShort = String(
    remoteVersionObj.digestShort || remoteDigest.replace(/^sha256:/, "").slice(0, 12),
  ).trim();
  const localVersionObj = (data?.localVersion ?? {}) as ImageVersionSpeedResult["version"];
  const localDigest = String(localVersionObj?.digest || "").trim();
  const localCommit = getComparableShortCommit(
    process.env.APP_COMMIT || localVersionObj?.revision || localVersionObj?.commit,
  );
  const remoteCommit =
    getComparableShortCommit(remoteVersionObj.revision || remoteVersionObj.commit) || remoteDigestShort;

  const canCheck = Boolean(remoteCommit) && Boolean(localCommit || localDigest);
  const available = canCheck
    ? remoteDigest && localDigest
      ? remoteDigest !== localDigest
      : localCommit !== remoteCommit
    : false;

  return {
    available,
    canCheck,
    deploymentTarget: target,
    localVersion: String(localVersionObj?.version || "").trim(),
    remoteVersion: String(remoteVersionObj.version || "").trim(),
    remoteCommit,
    source: "image",
    checkedAt: Date.now(),
  };
}

/** GitHub 最新 Release 的 tag（只请求一次 `/releases/latest`）。 */
async function fetchLatestReleaseTag(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_REPO_API_URL}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
    const data = (await res.json()) as { tag_name?: unknown };
    return String(data.tag_name ?? "");
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") throw new Error("GitHub 请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fnOS / 群晖 / 源码 / Windows 桌面：GitHub Release 版本号比对。
 *
 * 这四种部署都没有可比对的镜像 digest，共同信源只有「发布流程产出的 Release tag」，
 * 所以只比版本号：本地 `package.json` 版本 < 最新 tag 就是有更新。
 *
 * 为什么不查 commit：包管理版没有 .git，NAS 上不一定有 git 二进制，源码版跑
 * `git ls-remote` 又可能被墙卡满 5 秒。通知栏只值一次 GitHub API 的成本，
 * 「同版本但新 commit」这种开发态差异留给设置页的 git 分支处理。
 */
async function checkReleaseUpdateNotice(target: DeploymentTarget): Promise<UpdateNotice> {
  const localVersion = readLocalPackageVersion();
  let tagName = "";
  let fetchError: string | undefined;
  try {
    tagName = await fetchLatestReleaseTag();
    if (!versionFromReleaseTag(tagName)) throw new Error("GitHub 最新发布没有版本号");
  } catch (error) {
    fetchError = `无法获取 GitHub 最新版本：${error instanceof Error ? error.message : String(error)}`;
  }

  const remoteVersion = versionFromReleaseTag(tagName);
  const remoteParsed = parseReleaseVersion(remoteVersion);
  const localParsed = parseReleaseVersion(localVersion);
  const canCheck = Boolean(remoteParsed && localParsed);
  const available = Boolean(
    canCheck && localParsed && remoteParsed && compareReleaseVersions(remoteParsed, localParsed) > 0,
  );

  return {
    available,
    canCheck,
    deploymentTarget: target,
    localVersion: localVersion === "unknown" ? "" : localVersion,
    remoteVersion,
    remoteCommit: "",
    source: "release",
    checkedAt: Date.now(),
    fetchError:
      fetchError ??
      (canCheck ? undefined : `无法比较版本号（当前版本：${localVersion || "unknown"}）`),
  };
}

async function resolveUpdateNotice(): Promise<UpdateNotice> {
  const target = getDeploymentTarget();
  if (target === "docker") return checkImageUpdateNotice();
  return checkReleaseUpdateNotice(target);
}

/**
 * 通知栏入口：30 分钟内复用同一份结果（失败 5 分钟），并发请求合并成一次探测。
 *
 * 任何部署形态都会返回结果；`canCheck` 说明这次到底比没比出来，客户端据此决定
 * 是否要展示「有新版本」。
 */
export async function loadUpdateNotice(): Promise<UpdateNotice> {
  const now = Date.now();
  if (noticeCache) {
    const ttl = noticeCache.notice.fetchError ? NOTICE_FAILURE_TTL_MS : NOTICE_TTL_MS;
    if (now - noticeCache.at < ttl) return noticeCache.notice;
  }
  if (inFlight) return inFlight;
  inFlight = resolveUpdateNotice()
    .catch((error) =>
      unavailableNotice(
        getDeploymentTarget(),
        getDeploymentTarget() === "docker" ? "image" : "release",
        error instanceof Error ? error.message : String(error),
      ),
    )
    .then((notice) => {
      noticeCache = { at: Date.now(), notice };
      return notice;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
