/**
 * System update API.
 *
 * GET: returns the current version, deployment target, remote version, and whether an update is needed.
 * POST ?mode=update: Docker deployments delegate to the host updater (pull the app/updater images and recreate the containers).
 * Non-Docker (source) deployments run git fetch + fast-forward merge, then install dependencies, generate Prisma, sync the database, and build.
 * POST ?mode=rebuild: does not pull code; only reinstalls dependencies, generates Prisma, syncs the database, and builds.
 *
 * Response format:
 * - GET: { ok, deploymentTarget, isDocker, isFnos, isSynology, updateMode, localVersion, localReleaseNotes, localReleaseNotesI18n, localCommit, localCommitMsg, localCommitDate, remoteVersion, remoteCommit, remoteCommitMsg, needsUpdate, canCheckUpdate }
 * - POST: text/event-stream; each data is { step, status, output? }, ending with { type: "done", ok, error?, restartRequired }
 */
import { NextRequest, NextResponse } from "next/server";
import { exec, execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

/** System update runs git pull, dependency install, database changes, and builds; only admins may trigger it. */
async function requireAdmin(): Promise<NextResponse | null> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "仅管理员可操作" }, { status: 403 });
  }
  return null;
}

type VersionInfo = {
  localCommit: string;
  localCommitFull: string;
  localCommitMsg: string;
  localCommitDate: string;
  remoteName: string;
  remoteBranch: string;
  remoteUrl: string;
  remoteVersion: string;
  remoteCommit: string;
  remoteCommitMsg: string;
  remoteCommitDate: string;
  needsUpdate: boolean;
  canCheckUpdate: boolean;
  githubUrl: string;
  githubVersion: string;
  githubCommit: string;
  githubCommitMsg: string;
  githubCommitDate: string;
  githubCanCheck: boolean;
  githubFetchError?: string;
  fetchError?: string;
  versionSource: "git" | "env";
};

type GitHubVersionInfo = Pick<
  VersionInfo,
  "githubUrl" | "githubVersion" | "githubCommit" | "githubCommitMsg" | "githubCommitDate" | "githubCanCheck" | "githubFetchError"
>;

type ImageSourceConfig = {
  source: string;
  appImage: string;
  updaterImage: string;
  customAppImage: string;
  customUpdaterImage: string;
  options: Array<{ value: string; label: string; appImage?: string; updaterImage?: string }>;
};

let updateRunning = false;
const DEFAULT_GITHUB_REPO_URL = "https://github.com/frankluise5220/MMH.git";
const GITHUB_REPO_API_URL = "https://api.github.com/repos/frankluise5220/MMH";
const IMAGE_FALLBACK_ORDER = ["fnvps", "dockerproxy", "nju", "ghcr", "daocloud", "custom"];
const STANDARD_IMAGE_SOURCE_ORDER = IMAGE_FALLBACK_ORDER.filter((source) => source !== "custom");
const UPDATER_DEFAULT_TIMEOUT_MS = 5_000;
const VERSION_CHECK_TIMEOUT_MS = 5_000;
const IMAGE_VERSION_CHECK_TIMEOUT_MS = 6_000;

function getUpdaterConfig() {
  const url = String(process.env.MMH_UPDATER_URL ?? "").trim();
  const token = String(process.env.MMH_UPDATE_TOKEN ?? "").trim();
  return { url, token, enabled: Boolean(url && token) };
}

/** Actionable guidance shown when the host updater cannot be reached due to missing configuration. */
function getUpdaterSetupHint() {
  return "未配置宿主机更新执行器：请在 docker-compose.yml 同目录的 .env 中设置 MMH_UPDATE_TOKEN（任意长随机字符串，app 与 updater 两个容器取值需一致），然后执行 docker compose up -d app updater 使配置生效，再回到本页重试。";
}

async function callUpdater(path: string, init?: RequestInit, timeoutMs = UPDATER_DEFAULT_TIMEOUT_MS) {
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

function isDockerEnvironment(): boolean {
  if (existsSync("/.dockerenv")) return true;
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
    if (cgroup.includes("docker") || cgroup.includes("kubepods")) return true;
  } catch {
    // /proc is unavailable on non-Linux hosts.
  }
  return process.env.DOCKER_CONTAINER === "true";
}

function getDeploymentTarget(): "docker" | "fnos" | "synology" | "windows" | "standalone" {
  if (isDockerEnvironment()) return "docker";
  const target = String(process.env.MMH_DEPLOY_TARGET ?? "").trim().toLowerCase();
  if (target === "fnos") return "fnos";
  if (target === "synology") return "synology";
  // Windows desktop (Electron shell sets MMH_DEPLOY_TARGET=windows). It has no
  // git checkout and must never fall into the git/Docker update paths: its
  // updates come from electron-updater, driven by the settings page through the
  // preload bridge (下载 → 更新窗口 → 重启).
  if (target === "windows") return "windows";
  return "standalone";
}

type LocalPackageJson = {
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
function readLocalPackageJson(projectRoot: string): LocalPackageJson {
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

/**
 * The in-app「本版说明」text (设置 → 系统更新).
 *
 * It is the **shared** update note — `mmhFnosManifestChangelog`, the very string
 * the stores render — not the GitHub Release body: `mmhReleaseNotes` also carries
 * the install / upgrade instructions, which do not belong inside the app.
 * Packages built before 2026-10-15 only carry `mmhReleaseNotes`, so fall back to
 * it rather than blanking the panel.
 */
function getPackageReleaseNotes(pkg: { mmhFnosManifestChangelog?: unknown; mmhReleaseNotes?: unknown; releaseNotes?: unknown }) {
  const candidates = [pkg.mmhFnosManifestChangelog, pkg.mmhReleaseNotes, pkg.releaseNotes];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

/** The only languages `mmhReleaseNotesI18n` may carry; anything else is ignored instead of surfaced. */
const RELEASE_NOTES_LANGUAGES = ["zh-CN", "en-US", "ja-JP"] as const;

/**
 * Optional per-language release notes (`package.json.mmhReleaseNotesI18n`).
 *
 * Only the three UI languages are read and only non-empty strings are kept, so a
 * malformed or half-filled object can never render an empty "本版说明" panel:
 * an empty result stays `undefined` and the client falls back to the Chinese
 * shared update note (`mmhFnosManifestChangelog`).
 */
function getPackageReleaseNotesI18n(pkg: { mmhReleaseNotesI18n?: unknown }) {
  const raw = pkg.mmhReleaseNotesI18n;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const result: Partial<Record<(typeof RELEASE_NOTES_LANGUAGES)[number], string>> = {};
  for (const language of RELEASE_NOTES_LANGUAGES) {
    const value = source[language];
    const text = typeof value === "string" ? value.trim() : "";
    if (text) result[language] = text;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * 远端「本版说明」：Docker / 源码部署里的 package.json 是**构建时**固化的一份，
 * 用户改了 Release 正文再发布，镜像里那份不会变（除非重建镜像）。所以按当前运行
 * 版本去 GitHub 取一次 Release 正文、抽出「本次更新」两节覆盖本地文本：改完正文
 * 点发布，自托管实例最迟几分钟后就显示新说明。
 *
 * 失败一律静默回落本地文本：容器常常没有外网或访问 GitHub 很慢，超时 2.5 秒，
 * 不能为此拖住设置页。`MMH_RELEASE_NOTES_REMOTE=off` 可彻底关掉这次请求。
 */
const RELEASE_NOTES_TTL_MS = 5 * 60 * 1000;
// 取不到时不要每分钟重试一次：外网不通的容器每次都要等满超时，设置页会被拖慢。
const RELEASE_NOTES_EMPTY_TTL_MS = 10 * 60 * 1000;
const RELEASE_NOTES_TIMEOUT_MS = 2500;
const RELEASE_NOTES_REPO =
  String(process.env.MMH_RELEASE_REPO ?? "").trim() || "frankluise5220/MMH";
const releaseNotesCache = new Map<string, { at: number; text: string }>();

/** 与 `scripts/sync-notes-from-release.cjs` 的 NOTE_GROUPS 保持一致：只有这两节进商店/应用内文案。 */
const RELEASE_NOTE_GROUPS = ["功能改进", "Bug 修复"];

/**
 * 从 Release 正文抽出 `## 本次更新` 里的 `### 功能改进` / `### Bug 修复` 两节，
 * 输出形态与 `package.json.mmhReleaseNotesI18n["zh-CN"]` 完全相同（客户端按 `###` 渲染小标题）。
 */
function pickUpdateSections(body: string): string {
  const kept: string[] = [];
  let inUpdateSection = false;
  let collecting = false;
  for (const line of body.split(/\r?\n/)) {
    const section = line.match(/^##\s+(.+?)\s*$/);
    if (section) {
      inUpdateSection = section[1].trim() === "本次更新";
      collecting = false;
      continue;
    }
    if (!inUpdateSection) continue;
    const group = line.match(/^###\s+(.+?)\s*$/);
    if (group) {
      const name = group[1].trim();
      collecting = RELEASE_NOTE_GROUPS.includes(name);
      if (collecting) {
        if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
        kept.push(`### ${name}`);
      }
      continue;
    }
    if (!collecting) continue;
    // 标题与首个条目之间的空行、以及连续空行都不留：正典形态是
    // `### 组名\n- 条目…\n\n### 下一组`，多出来的空行会让客户端渲染出多余间距。
    const last = kept[kept.length - 1] ?? "";
    if (!line.trim() && (/^### /.test(last) || !last.trim())) continue;
    kept.push(line.trimEnd());
  }
  return kept.join("\n").trim();
}

/** 按版本取远端正文里的更新两节；取不到（离线、404、超时）返回空串，由调用方回落本地。 */
async function fetchReleaseNotesFromGitHub(version: string): Promise<string> {
  if (!version || version === "unknown" || /^(dev|main)$/i.test(version)) return "";
  if (String(process.env.MMH_RELEASE_NOTES_REMOTE ?? "").trim().toLowerCase() === "off") return "";
  const cached = releaseNotesCache.get(version);
  if (cached) {
    const ttl = cached.text ? RELEASE_NOTES_TTL_MS : RELEASE_NOTES_EMPTY_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.text;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELEASE_NOTES_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${RELEASE_NOTES_REPO}/releases/tags/v${version}`,
      {
        headers: { accept: "application/vnd.github+json", "user-agent": "mmh-release-notes" },
        cache: "no-store",
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      releaseNotesCache.set(version, { at: Date.now(), text: "" });
      return "";
    }
    const data = (await res.json()) as { body?: unknown };
    const text = pickUpdateSections(String(data.body ?? ""));
    releaseNotesCache.set(version, { at: Date.now(), text });
    return text;
  } catch {
    releaseNotesCache.set(version, { at: Date.now(), text: "" });
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function safeGitName(value: string | undefined, fallback: string) {
  const v = String(value ?? "").trim();
  if (!v || v.startsWith("-")) return fallback;
  return /^[A-Za-z0-9._/-]+$/.test(v) ? v : fallback;
}

function getGitTarget() {
  const remote = safeGitName(process.env.MMH_GIT_REMOTE, "origin");
  const branch = safeGitName(process.env.MMH_GIT_BRANCH, "main");
  return { remote, branch, ref: `${remote}/${branch}` };
}

function getLocalGitInfo(projectRoot: string) {
  const envCommit = String(process.env.APP_COMMIT ?? "").trim();
  const envCommitMsg = String(process.env.APP_COMMIT_MESSAGE ?? "").trim();
  const envCommitDate = String(process.env.APP_COMMIT_DATE ?? "").trim();
  if (envCommit) {
    return {
      localCommit: envCommit.slice(0, 7),
      localCommitFull: envCommit,
      localCommitMsg: envCommitMsg,
      localCommitDate: envCommitDate,
      versionSource: "env" as const,
    };
  }
  if (!existsSync(join(projectRoot, ".git"))) {
    return { localCommit: "unknown", localCommitFull: "unknown", localCommitMsg: "", localCommitDate: "", versionSource: "env" as const };
  }
  try {
    return {
      localCommit: execSync("git rev-parse --short HEAD", { cwd: projectRoot, encoding: "utf-8" }).trim(),
      localCommitFull: execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf-8" }).trim(),
      localCommitMsg: execSync("git log -1 --format=%s", { cwd: projectRoot, encoding: "utf-8" }).trim(),
      localCommitDate: execSync("git log -1 --format=%ci", { cwd: projectRoot, encoding: "utf-8" }).trim(),
      versionSource: "git" as const,
    };
  } catch {
    return { localCommit: "unknown", localCommitFull: "unknown", localCommitMsg: "", localCommitDate: "", versionSource: "git" as const };
  }
}

function readCommand(projectRoot: string, cmd: string) {
  return execSync(cmd, { cwd: projectRoot, encoding: "utf-8" }).trim();
}

function readCommandWithTimeout(projectRoot: string, cmd: string, timeout: number) {
  return execSync(cmd, { cwd: projectRoot, encoding: "utf-8", timeout }).trim();
}

function commandErrorMessage(error: unknown) {
  const e = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString();
  const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString();
  return (stderr || stdout || e.message || "未知错误").trim();
}

async function fetchGitHubJson<T>(path: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_REPO_API_URL}${path}`, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub request failed: ${res.status}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

function versionFromReleaseTag(tagName: string) {
  return tagName.trim().replace(/^v/i, "");
}

function parseReleaseVersion(value: string) {
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

function compareReleaseVersions(
  a: { parts: number[] },
  b: { parts: number[] },
) {
  for (let index = 0; index < 3; index += 1) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function latestReleaseTagFromLsRemote(output: string) {
  const tags = new Map<string, { tagName: string; version: string; parts: number[]; commit: string }>();
  for (const line of output.split(/\r?\n/)) {
    const [commit = "", ref = ""] = line.trim().split(/\s+/);
    const peeled = ref.endsWith("^{}");
    const tagName = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
    const parsed = parseReleaseVersion(tagName);
    if (!commit || !parsed) continue;
    const current = tags.get(tagName);
    if (!current || peeled) {
      tags.set(tagName, { tagName, version: parsed.version, parts: parsed.parts, commit });
    }
  }
  return [...tags.values()].sort((a, b) => compareReleaseVersions(b, a))[0] ?? null;
}

function githubVersionInfoFromRelease(params: {
  version: string;
  commit: string;
  commitMsg?: string;
  commitDate?: string;
}): GitHubVersionInfo {
  return {
    githubUrl: DEFAULT_GITHUB_REPO_URL,
    githubVersion: params.version,
    githubCommit: params.commit ? params.commit.slice(0, 7) : "unknown",
    githubCommitMsg: params.commitMsg ?? "",
    githubCommitDate: params.commitDate ?? "",
    githubCanCheck: Boolean(params.commit),
  };
}

async function getGitHubVersionInfo(projectRoot: string): Promise<GitHubVersionInfo> {
  let releaseFetchError: unknown = null;
  try {
    const release = await fetchGitHubJson<{
      tag_name?: string;
      target_commitish?: string;
      published_at?: string;
    }>("/releases/latest");
    const tagName = String(release.tag_name ?? "").trim();
    if (!tagName) throw new Error("Latest GitHub release has no tag");

    let commit = "";
    let commitMsg = "";
    let commitDate = String(release.published_at ?? "");
    try {
      const data = await fetchGitHubJson<{
        sha?: string;
        commit?: { message?: string; committer?: { date?: string } };
      }>(`/commits/${encodeURIComponent(tagName)}`);
      commit = String(data.sha ?? "").trim();
      commitMsg = String(data.commit?.message ?? "").split("\n")[0] ?? "";
      commitDate = String(data.commit?.committer?.date ?? commitDate);
    } catch {
      const target = String(release.target_commitish ?? "").trim();
      commit = /^[a-f0-9]{40}$/i.test(target) ? target : "";
    }

    return githubVersionInfoFromRelease({
      version: versionFromReleaseTag(tagName),
      commit,
      commitMsg,
      commitDate,
    });
  } catch (error) {
    releaseFetchError = error;
  }

  try {
    const refs = readCommandWithTimeout(
      projectRoot,
      `git ls-remote --tags ${DEFAULT_GITHUB_REPO_URL} "refs/tags/v*"`,
      VERSION_CHECK_TIMEOUT_MS,
    );
    const latest = latestReleaseTagFromLsRemote(refs);
    if (latest) {
      return githubVersionInfoFromRelease({
        version: latest.version,
        commit: latest.commit,
      });
    }
    throw new Error("No formal release tags found");
  } catch (tagError) {
    return {
      githubUrl: DEFAULT_GITHUB_REPO_URL,
      githubVersion: "",
      githubCommit: "unknown",
      githubCommitMsg: "",
      githubCommitDate: "",
      githubCanCheck: false,
      githubFetchError: [releaseFetchError, tagError]
        .map(commandErrorMessage)
        .filter(Boolean)
        .join("; "),
    };
  }
}

function getPackageVersionAtRef(projectRoot: string, ref: string) {
  try {
    const pkg = JSON.parse(readCommand(projectRoot, `git show ${ref}:package.json`)) as { version?: string };
    return String(pkg.version || "").trim();
  } catch {
    return "";
  }
}

async function getGitVersionInfo(projectRoot: string): Promise<VersionInfo> {
  const { remote, branch, ref } = getGitTarget();
  const local = getLocalGitInfo(projectRoot);
  const github = await getGitHubVersionInfo(projectRoot);
  let remoteUrl = String(process.env.MMH_UPDATE_SOURCE_URL ?? "").trim();

  if (isDockerEnvironment() || local.versionSource === "env") {
    remoteUrl = remoteUrl || DEFAULT_GITHUB_REPO_URL;
    const githubCommit = github.githubCommit;
    const canCheck = github.githubCanCheck && githubCommit !== "unknown" && local.localCommit !== "unknown";
    const localComparable = local.localCommitFull !== "unknown" ? local.localCommitFull.slice(0, 7) : local.localCommit;

    return {
      ...local,
      ...github,
      remoteName: "github",
      remoteBranch: "latest",
      remoteUrl,
      remoteVersion: github.githubVersion,
      remoteCommit: githubCommit,
      remoteCommitMsg: github.githubCommitMsg,
      remoteCommitDate: github.githubCommitDate,
      needsUpdate: canCheck ? localComparable !== githubCommit : false,
      canCheckUpdate: canCheck,
      fetchError: undefined,
    };
  }

  try {
    if (!remoteUrl) {
      remoteUrl = readCommand(projectRoot, `git remote get-url ${remote}`);
    }
  } catch {
    remoteUrl = remoteUrl || "";
  }

  try {
    execSync(`git fetch ${remote} ${branch}`, { cwd: projectRoot, encoding: "utf-8", timeout: 15000 });
    const remoteCommit = readCommand(projectRoot, `git rev-parse --short ${ref}`);
    const remoteVersion = getPackageVersionAtRef(projectRoot, ref) || github.githubVersion;
    const remoteCommitMsg = readCommand(projectRoot, `git log -1 --format=%s ${ref}`);
    const remoteCommitDate = readCommand(projectRoot, `git log -1 --format=%ci ${ref}`);
    const localFull = readCommand(projectRoot, "git rev-parse HEAD");
    const remoteFull = readCommand(projectRoot, `git rev-parse ${ref}`);

    return {
      ...local,
      ...github,
      remoteName: remote,
      remoteBranch: branch,
      remoteUrl,
      remoteVersion,
      remoteCommit,
      remoteCommitMsg,
      remoteCommitDate,
      needsUpdate: localFull !== remoteFull,
      canCheckUpdate: true,
    };
  } catch (error) {
    return {
      ...local,
      ...github,
      remoteName: remote,
      remoteBranch: branch,
      remoteUrl,
      remoteVersion: github.githubVersion,
      remoteCommit: "unknown",
      remoteCommitMsg: "",
      remoteCommitDate: "",
      needsUpdate: false,
      canCheckUpdate: false,
      fetchError: commandErrorMessage(error),
    };
  }
}

function getComparableShortCommit(value: string | undefined) {
  const commit = String(value ?? "").trim();
  if (!commit || commit === "unknown") return "";
  return commit.slice(0, 7);
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
  if (configuredSource && configuredSource !== "auto") {
    return { customAppImage, timeoutMs: IMAGE_VERSION_CHECK_TIMEOUT_MS };
  }
  return { customAppImage, timeoutMs: IMAGE_VERSION_CHECK_TIMEOUT_MS };
}

function getImageVersionFetchError(imageSourceConfig: ImageSourceConfig | null) {
  const sourceText = getImageVersionSourceOrder(imageSourceConfig).join("、");
  return `镜像版本检查失败或超时，已按顺序尝试：${sourceText}`;
}

async function getImageVersionFallback(
  base: VersionInfo,
  imageSourceConfig: ImageSourceConfig | null,
): Promise<Partial<VersionInfo> | null> {
  if (!getUpdaterConfig().enabled) return null;
  const configuredSource = imageSourceConfig?.source || "auto";
  const sourceOrder = getImageVersionSourceOrder(imageSourceConfig);

  try {
    const data = await callUpdater("/speed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(getImageVersionCheckBody(imageSourceConfig)),
    }, IMAGE_VERSION_CHECK_TIMEOUT_MS + 2_000);
    const results = Array.isArray(data?.results) ? data.results as ImageVersionSpeedResult[] : [];

    const resultBySource = new Map(results.map((result) => [String(result.source || ""), result]));
    const selected = sourceOrder
      .map((source) => resultBySource.get(source))
      .find((result) => result?.ok && (result.version?.revision || result.version?.commit || result.version?.digest));
    if (!selected) return null;

    const revision = String(selected.version?.revision || selected.version?.commit || "").trim();
    const remoteDigest = String(selected.version?.digest || "").trim();
    const remoteDigestShort = String(
      selected.version?.digestShort || remoteDigest.replace(/^sha256:/, "").slice(0, 12),
    ).trim();
    const localImageVersion = data?.localVersion as ImageVersionSpeedResult["version"] | undefined;
    const localDigest = String(localImageVersion?.digest || "").trim();
    const remoteCommit = getComparableShortCommit(revision) || remoteDigestShort;
    const localCommit = getComparableShortCommit(base.localCommitFull || base.localCommit);
    if (!remoteCommit || (!localCommit && !localDigest)) return null;
    const needsUpdate = remoteDigest && localDigest
      ? remoteDigest !== localDigest
      : localCommit !== remoteCommit;

    return {
      remoteName: `image:${selected.source || configuredSource}`,
      remoteBranch: "latest",
      remoteUrl: selected.image || imageSourceConfig?.appImage || "",
      remoteVersion: String(selected.version?.version || "").trim(),
      remoteCommit,
      remoteCommitMsg: String(selected.version?.message || (revision ? "镜像版本" : "镜像摘要")).split("\n")[0],
      remoteCommitDate: String(selected.version?.created || ""),
      needsUpdate,
      canCheckUpdate: true,
      fetchError: undefined,
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if (auth) return auth;
  try {
    const { searchParams } = new URL(req.url);
    const checkRemote = searchParams.get("check") === "1";
    const projectRoot = process.cwd();
    const pkg = readLocalPackageJson(projectRoot);
    const localVersion = typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "unknown";
    const localReleaseNotes = getPackageReleaseNotes(pkg);
    let localReleaseNotesI18n = getPackageReleaseNotesI18n(pkg);
    let imageSourceConfig: ImageSourceConfig | null = null;
    const deploymentTarget = getDeploymentTarget();
    const dockerEnvironment = deploymentTarget === "docker";
    const fnosEnvironment = deploymentTarget === "fnos";
    const synologyEnvironment = deploymentTarget === "synology";
    const windowsEnvironment = deploymentTarget === "windows";
    const managedPackageEnvironment = fnosEnvironment || synologyEnvironment;
    // 包管理之外（Docker 镜像 / 源码部署 / Windows 桌面）的正文是构建期固化的，
    // 发布后再改 Release 正文不会进安装包，所以按运行版本取一次远端正文覆盖；
    // 取不到就用本地那份。
    if (dockerEnvironment || windowsEnvironment || deploymentTarget === "standalone") {
      const remoteReleaseNotes = await fetchReleaseNotesFromGitHub(localVersion);
      if (remoteReleaseNotes) {
        localReleaseNotesI18n = { ...(localReleaseNotesI18n ?? {}), "zh-CN": remoteReleaseNotes };
      }
    }
    const updaterEnabled = getUpdaterConfig().enabled;
    // The image source config comes from the local updater; load it whenever the
    // updater is reachable so the settings panel is available on first load,
    // not only after a remote version check.
    if (dockerEnvironment && updaterEnabled) {
      try {
        const data = await callUpdater("/config", undefined, 3_000);
        imageSourceConfig = data.config ?? null;
      } catch {
        imageSourceConfig = null;
      }
    }
    const local = getLocalGitInfo(projectRoot);
    const localOnlyVersionInfo: VersionInfo = {
      ...local,
      remoteName: "",
      remoteBranch: "",
      remoteUrl: "",
      remoteVersion: "",
      remoteCommit: "unknown",
      remoteCommitMsg: "",
      remoteCommitDate: "",
      needsUpdate: false,
      canCheckUpdate: false,
      githubUrl: DEFAULT_GITHUB_REPO_URL,
      githubVersion: "",
      githubCommit: "unknown",
      githubCommitMsg: "",
      githubCommitDate: "",
      githubCanCheck: false,
      fetchError: undefined,
    };

    let versionInfo = localOnlyVersionInfo;
    if (checkRemote && dockerEnvironment) {
      const imageFallback = updaterEnabled
        ? await getImageVersionFallback(localOnlyVersionInfo, imageSourceConfig)
        : null;
      if (imageFallback) {
        versionInfo = {
          ...localOnlyVersionInfo,
          ...imageFallback,
        };
      } else if (updaterEnabled) {
        versionInfo = {
          ...localOnlyVersionInfo,
          fetchError: getImageVersionFetchError(imageSourceConfig),
        };
      } else {
        const github = await getGitHubVersionInfo(projectRoot);
        const githubCommit = github.githubCommit;
        const localComparable = local.localCommitFull !== "unknown" ? local.localCommitFull.slice(0, 7) : local.localCommit;
        const canCheck = github.githubCanCheck && githubCommit !== "unknown" && localComparable !== "unknown";
        versionInfo = {
          ...localOnlyVersionInfo,
          ...github,
          remoteName: "github",
          remoteBranch: "latest",
          remoteUrl: DEFAULT_GITHUB_REPO_URL,
          remoteVersion: github.githubVersion,
          remoteCommit: githubCommit,
          remoteCommitMsg: github.githubCommitMsg,
          remoteCommitDate: github.githubCommitDate,
          needsUpdate: canCheck ? localComparable !== githubCommit : false,
          canCheckUpdate: canCheck,
          fetchError: github.githubFetchError,
        };
      }
    } else if (checkRemote && windowsEnvironment) {
      // The Windows build has no git checkout to compare against: its remote
      // version lives in the update feed's latest.yml and is judged by the
      // Electron main process, which reports through the preload bridge. Doing
      // a git ls-remote / GitHub commit comparison here would only produce a
      // permanent "无法确认远端版本" on a machine that updates fine.
      versionInfo = { ...localOnlyVersionInfo, fetchError: undefined };
    } else if (checkRemote && !managedPackageEnvironment) {
      versionInfo = await getGitVersionInfo(projectRoot);
    }

    return NextResponse.json({
      ok: true,
      deploymentTarget,
      isDocker: dockerEnvironment,
      isFnos: fnosEnvironment,
      isSynology: synologyEnvironment,
      isWindows: windowsEnvironment,
      updateMode: windowsEnvironment ? "desktop" : managedPackageEnvironment ? deploymentTarget : "git",
      updaterEnabled,
      imageSourceConfig,
      localVersion,
      localReleaseNotes,
      localReleaseNotesI18n,
      ...versionInfo,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: e instanceof Error ? e.message : "查询失败" }, { status: 500 });
  }
}

function sseEvent(encoder: TextEncoder, data: Record<string, unknown>) {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function runStep(projectRoot: string, cmd: string, timeout: number): Promise<{ ok: boolean; code?: string; output: string }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd: projectRoot, encoding: "utf-8", timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, code: "STEP_FAILED", output: stderr?.trim() || err.message });
      else resolve({ ok: true, output: stdout?.trim() || "完成" });
    });
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if (auth) return auth;

  const { searchParams } = new URL(req.url);
  const deploymentTarget = getDeploymentTarget();
  if (deploymentTarget === "fnos") {
    return NextResponse.json(
      { ok: false, code: "FNOS_UPDATE_NOT_SUPPORTED", error: "飞牛版请通过飞牛应用中心更新 MMH 应用包" },
      { status: 409 },
    );
  }
  if (deploymentTarget === "synology") {
    return NextResponse.json(
      { ok: false, code: "SYNOLOGY_UPDATE_NOT_SUPPORTED", error: "Synology DSM package builds must be updated through Package Center or by installing a newer SPK." },
      { status: 409 },
    );
  }
  // The Windows build updates through electron-updater (下载 → 更新窗口 → 重启),
  // never by pulling source and rebuilding: the staged app has no git checkout,
  // no dev dependencies and no build toolchain. Refusing here also guarantees a
  // stale tab can never start `git fetch` / `npm install` inside an install dir.
  if (deploymentTarget === "windows") {
    return NextResponse.json(
      {
        ok: false,
        code: "WINDOWS_UPDATE_NOT_SUPPORTED",
        error: "Windows 桌面版请在「设置 → 系统更新」使用桌面更新（检查更新 → 下载 → 重启应用），不支持在应用内拉取源码更新。",
      },
      { status: 409 },
    );
  }

  if (updateRunning) {
    return NextResponse.json({ ok: false, code: "UPDATE_ALREADY_RUNNING", error: "系统更新正在执行，请稍后再试" }, { status: 409 });
  }

  if (searchParams.get("status") === "1") {
    try {
      return NextResponse.json(await callUpdater("/status"));
    } catch (e) {
      return NextResponse.json({ ok: false, code: "UPDATE_STATUS_QUERY_FAILED", error: e instanceof Error ? e.message : "查询更新状态失败" }, { status: 500 });
    }
  }

  if (searchParams.get("config") === "1") {
    if (req.method !== "POST") {
      return NextResponse.json({ ok: false, code: "METHOD_NOT_ALLOWED", error: "method not allowed" }, { status: 405 });
    }
    try {
      const body = await req.json().catch(() => ({}));
      return NextResponse.json(await callUpdater("/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
    } catch (e) {
      return NextResponse.json({ ok: false, code: "IMAGE_SOURCE_SAVE_FAILED", error: e instanceof Error ? e.message : "保存镜像源失败" }, { status: 500 });
    }
  }

  if (searchParams.get("speed") === "1") {
    try {
      const body = await req.json().catch(() => ({}));
      return NextResponse.json(await callUpdater("/speed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
    } catch (e) {
      return NextResponse.json({ ok: false, code: "SPEED_TEST_FAILED", error: e instanceof Error ? e.message : "测速失败" }, { status: 500 });
    }
  }

  const mode = searchParams.get("mode") === "rebuild" ? "rebuild" : "update";
  const projectRoot = process.cwd();
  const dockerMode = isDockerEnvironment();
  if (dockerMode) {
    try {
      return NextResponse.json(await callUpdater("/update", { method: "POST" }), { status: 202 });
    } catch (e) {
      return NextResponse.json({ ok: false, code: "UPDATE_START_FAILED", error: e instanceof Error ? e.message : "启动更新失败" }, { status: 500 });
    }
  }
  const { remote, branch, ref } = getGitTarget();

  const allSteps: { step: string; cmd: string; timeout: number }[] = [
    { step: "拉取代码", cmd: `git fetch ${remote} ${branch} && git merge --ff-only ${ref}`, timeout: 60000 },
    { step: "安装依赖", cmd: "npm install --include=dev", timeout: 120000 },
    { step: "生成 Prisma Client", cmd: "npx prisma generate", timeout: 30000 },
    { step: "同步数据库", cmd: "npx prisma db push", timeout: 30000 },
    { step: "构建项目", cmd: "npm run build", timeout: 180000 },
  ];
  const steps = mode === "rebuild" ? allSteps.slice(1) : allSteps;
  const encoder = new TextEncoder();

  updateRunning = true;
  const stream = new ReadableStream({
    async start(controller) {
      let hasError = false;
      let errorMsg = "";

      try {
        for (const s of steps) {
          if (hasError) break;
          controller.enqueue(sseEvent(encoder, { step: s.step, status: "running" }));
          const result = await runStep(projectRoot, s.cmd, s.timeout);
          if (result.ok) {
            controller.enqueue(sseEvent(encoder, { step: s.step, status: "completed", output: result.output }));
          } else {
            controller.enqueue(sseEvent(encoder, { step: s.step, status: "failed", output: result.output }));
            hasError = true;
            errorMsg = `${s.step} 失败: ${result.output}`;
          }
        }

        controller.enqueue(sseEvent(encoder, { type: "done", ok: !hasError, error: errorMsg, restartRequired: dockerMode && !hasError }));
        controller.close();

        if (dockerMode && !hasError) {
          setTimeout(() => process.exit(0), 1500);
        }
      } finally {
        updateRunning = false;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
