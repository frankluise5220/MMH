import http from "node:http";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";

const port = Number(process.env.MMH_UPDATER_PORT || 7788);
const token = String(process.env.MMH_UPDATE_TOKEN || "").trim();
const workdir = process.env.MMH_WORKDIR || "/workspace";
const composeProject = process.env.MMH_COMPOSE_PROJECT || "mmh";
const composeFile = process.env.MMH_COMPOSE_FILE || `${workdir}/docker-compose.yml`;
const taskStateFile = `${workdir}/.mmh-update-task.json`;
const usedImagesFile = `${workdir}/.mmh-used-images.json`;
const ghcrImage = "ghcr.io/frankluise5220/mmh:latest";
const daocloudImage = "ghcr.m.daocloud.io/frankluise5220/mmh:latest";
const dockerproxyImage = "ghcr.dockerproxy.net/frankluise5220/mmh:latest";
const njuImage = "ghcr.nju.edu.cn/frankluise5220/mmh:latest";
const fnvpsImage = "fnapp.floatingice.win:5000/frankluise5220/mmh:latest";
const ghcrUpdaterImage = "ghcr.io/frankluise5220/mmh-updater:latest";
const daocloudUpdaterImage = "ghcr.m.daocloud.io/frankluise5220/mmh-updater:latest";
const dockerproxyUpdaterImage = "ghcr.dockerproxy.net/frankluise5220/mmh-updater:latest";
const njuUpdaterImage = "ghcr.nju.edu.cn/frankluise5220/mmh-updater:latest";
const fnvpsUpdaterImage = "fnapp.floatingice.win:5000/frankluise5220/mmh-updater:latest";
const quotedWorkdir = JSON.stringify(workdir);

// Pre-update snapshot location. Lives inside the bind-mounted workdir so the
// host can inspect it, and it is never deleted automatically: it is the only
// way back when a rollback fails.
const rollbackRoot = `${workdir}/.mmh-rollback`;
// Stable tag that always points at the app image an update replaced. Rolling
// back by restoring .env alone is not enough - `docker compose pull` has
// already moved the `:latest` tag in .env onto the new build.
const rollbackImageTag = "mmh-rollback:previous";
// Deterministic name for the staging database used by the restore swap, so a
// leftover from a crashed rollback is cleaned up by the next attempt.
const rollbackSwapSuffix = "_rollback_swap";

const imageSources = {
  ghcr: { name: "GHCR", app: ghcrImage, updater: ghcrUpdaterImage },
  dockerproxy: { name: "dockerproxy", app: dockerproxyImage, updater: dockerproxyUpdaterImage },
  nju: { name: "NJU", app: njuImage, updater: njuUpdaterImage },
  daocloud: { name: "DaoCloud", app: daocloudImage, updater: daocloudUpdaterImage },
  fnvps: { name: "FN VPS", app: fnvpsImage, updater: fnvpsUpdaterImage },
};

const autoImageSourceOrder = ["fnvps", "dockerproxy", "nju", "ghcr", "daocloud"];

let task = {
  running: false,
  status: "idle",
  currentStep: "",
  logs: [],
  error: "",
  rollback: null,
  startedAt: null,
  updatedAt: null,
};

// Host-side workdir of the updater container, resolved at startup so compose
// relative bind mounts (e.g. ./data) are evaluated against real host paths.
// currentUpdaterImage is the image the updater container itself runs, used as
// the helper container image for host-path compose execution.
let hostWorkdir = "";
let currentUpdaterImage = "";

async function resolveHostWorkdir() {
  try {
    const source = await captureDocker([
      "inspect",
      "mmh-updater",
      "--format",
      "{{range .Mounts}}{{if eq .Destination \"/workspace\"}}{{.Source}}{{end}}{{end}}",
    ]);
    if (source && source.startsWith("/")) hostWorkdir = source;
  } catch {
    hostWorkdir = "";
  }
  try {
    const image = await captureDocker(["inspect", "mmh-updater", "--format", "{{.Config.Image}}"]);
    if (image) currentUpdaterImage = image;
  } catch {
    currentUpdaterImage = "";
  }
}

async function persistTask() {
  await writeFile(taskStateFile, JSON.stringify(task), "utf8");
}

async function readRecentPersistedTask() {
  try {
    const saved = JSON.parse(await readFile(taskStateFile, "utf8"));
    const updatedAt = Date.parse(String(saved?.updatedAt || ""));
    const isRecent = Number.isFinite(updatedAt) && Date.now() - updatedAt < 60 * 60 * 1000;
    // "rolledback" must survive too: the updater container may be recreated
    // while the page is still waiting for the outcome of a failed update.
    if (!isRecent || !["completed", "failed", "rolledback"].includes(saved?.status)) return null;
    return { ...saved, running: false };
  } catch {
    return null;
  }
}

function now() {
  return new Date().toISOString();
}

function pushLog(line) {
  task.logs.push(`[${now()}] ${line}`);
  if (task.logs.length > 300) task.logs = task.logs.slice(-300);
  task.updatedAt = now();
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function authorized(req) {
  if (!token) return false;
  return req.headers.authorization === `Bearer ${token}`;
}

function run(command, step, options = {}) {
  return new Promise((resolve, reject) => {
    task.currentStep = step;
    pushLog(`开始：${step}`);
    const child = spawn("sh", ["-lc", `git config --global --add safe.directory ${quotedWorkdir} >/dev/null 2>&1 || true; ${command}`], { cwd: workdir });
    child.stdout.on("data", (chunk) => pushLog(chunk.toString().trim()));
    child.stderr.on("data", (chunk) => pushLog(chunk.toString().trim()));
    child.on("close", (code) => {
      if (code === 0) {
        pushLog(`完成：${step}`);
        resolve();
      } else {
        const message = `${step}失败，退出码 ${code}`;
        if (options.allowFailure) {
          pushLog(`${message}，继续执行`);
          resolve();
          return;
        }
        reject(new Error(message));
      }
    });
    child.on("error", reject);
  });
}

function composeCommand(args) {
  // The updater container resolves compose relative paths (e.g. ./data) against
  // its own working dir. When the container runs in /workspace mode, that yields
  // /workspace/data, which does not exist on the host, so bind mounts fail.
  // Detect the host workdir and run compose through a helper container mounted
  // at the host path instead, so relative bind mounts resolve to real host paths.
  if (hostWorkdir && currentUpdaterImage && composeFile.startsWith(`${workdir}/`)) {
    const relativeCompose = composeFile.slice(workdir.length + 1) || "docker-compose.yml";
    const hostComposeFile = `${hostWorkdir}/${relativeCompose}`;
    const inner = [
      `mkdir -p ${JSON.stringify(`${hostWorkdir}/data`)};`,
      "docker compose",
      `-p ${composeProject}`,
      `-f ${JSON.stringify(hostComposeFile)}`,
      args,
    ].join(" ");
    return [
      "docker run",
      "--rm",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      `${JSON.stringify(hostWorkdir)}:${JSON.stringify(hostWorkdir)}`,
      "-w",
      JSON.stringify(hostWorkdir),
      "--entrypoint",
      "sh",
      currentUpdaterImage,
      "-lc",
      JSON.stringify(inner),
    ].join(" ");
  }
  return `docker compose -p ${composeProject} -f "${composeFile}" ${args}`;
}

function syncDeployFilesCommand() {
  return [
    `if [ -f /updater/deploy/docker-compose.yml ]; then`,
    `cp /updater/deploy/docker-compose.yml ${quotedWorkdir}/docker-compose.yml;`,
    `cp /updater/deploy/postgres-entrypoint.sh ${quotedWorkdir}/postgres-entrypoint.sh;`,
    `chmod +x ${quotedWorkdir}/postgres-entrypoint.sh;`,
    `echo "已从更新器镜像同步部署文件";`,
    `elif [ -d ${quotedWorkdir}/.git ]; then`,
    `git config --global --add safe.directory ${quotedWorkdir} >/dev/null 2>&1 || true;`,
    `git -C ${quotedWorkdir} pull --ff-only;`,
    `else echo "未发现 Git 仓库或内置部署文件，跳过部署文件同步"; fi`,
  ].join(" ");
}

async function updateEnvImageSource(appImage, updaterImage) {
  await updateEnvValues({
    MMH_APP_IMAGE: appImage,
    MMH_UPDATER_IMAGE: updaterImage,
  });
}

// The updater image lives in the same registry as the app image with the repo
// name `mmh-updater`, so the custom source only needs the app image address.
function deriveUpdaterImage(appImage) {
  const value = String(appImage || "").trim();
  if (!value) return "";
  return value.replace(/\/(mmh)(?=[:@]|$)/, "/mmh-updater");
}

async function readEnvValues() {
  const envPath = `${workdir}/.env`;
  let text = "";
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    return {};
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return values;
}

async function updateEnvValues(values) {
  const envPath = `${workdir}/.env`;
  let text = "";
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    text = "";
  }

  const setLine = (source, key, value) => {
    const line = `${key}="${value}"`;
    if (source.match(new RegExp(`^${key}=`, "m"))) {
      return source.replace(new RegExp(`^${key}=.*$`, "m"), line);
    }
    return `${source.trimEnd()}\n${line}\n`;
  };

  for (const [key, value] of Object.entries(values)) {
    text = setLine(text, key, String(value ?? ""));
  }
  await writeFile(envPath, text);
}

async function getImageSourceConfig() {
  const env = await readEnvValues();
  const source = env.MMH_IMAGE_SOURCE || "auto";
  const customAppImage = env.CUSTOM_MMH_APP_IMAGE || "";
  const customUpdaterImage = env.CUSTOM_MMH_UPDATER_IMAGE || "";
  return {
    source,
    appImage: env.MMH_APP_IMAGE || "",
    updaterImage: env.MMH_UPDATER_IMAGE || "",
    customAppImage,
    customUpdaterImage,
    options: [
      { value: "auto", label: "自动选择", appImage: "", updaterImage: "" },
      ...Object.entries(imageSources).map(([value, sourceConfig]) => ({
        value,
        label: sourceConfig.name,
        appImage: sourceConfig.app,
        updaterImage: sourceConfig.updater,
      })),
      { value: "custom", label: "自定义", appImage: customAppImage, updaterImage: customUpdaterImage },
    ],
  };
}

async function saveImageSourceConfig(input) {
  const source = String(input?.source || "auto").trim();
  const customAppImage = String(input?.customAppImage || "").trim();
  const customUpdaterImage = String(input?.customUpdaterImage || "").trim();
  const values = { MMH_IMAGE_SOURCE: source };

  if (source === "custom") {
    if (!customAppImage) {
      throw new Error("自定义镜像源需要填写应用镜像地址");
    }
    const updaterImage = customUpdaterImage || deriveUpdaterImage(customAppImage);
    values.CUSTOM_MMH_APP_IMAGE = customAppImage;
    values.CUSTOM_MMH_UPDATER_IMAGE = updaterImage;
    values.MMH_APP_IMAGE = customAppImage;
    values.MMH_UPDATER_IMAGE = updaterImage;
  } else if (source !== "auto") {
    const selected = imageSources[source];
    if (!selected) throw new Error(`未知镜像源: ${source}`);
    values.MMH_APP_IMAGE = selected.app;
    values.MMH_UPDATER_IMAGE = selected.updater;
  }

  await updateEnvValues(values);
  return getImageSourceConfig();
}

function getImageForSpeedTest(source, env, customAppImage) {
  if (source === "custom") return customAppImage || env.CUSTOM_MMH_APP_IMAGE || "";
  return imageSources[source]?.app || "";
}

function shortDigest(digest) {
  return String(digest || "").replace(/^sha256:/, "").slice(0, 12);
}

function isSafeImageId(id) {
  return /^(sha256:)?[0-9a-f]{12,64}$/i.test(String(id || "").trim());
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

async function readUsedImages() {
  try {
    const saved = JSON.parse(await readFile(usedImagesFile, "utf8"));
    return Array.isArray(saved?.images) ? saved.images : [];
  } catch {
    return [];
  }
}

async function rememberUsedImages(entries) {
  const byId = new Map();
  for (const item of await readUsedImages()) {
    if (!isSafeImageId(item?.id)) continue;
    byId.set(item.id, {
      id: item.id,
      refs: uniqueStrings(item.refs),
      recordedAt: item.recordedAt || now(),
    });
  }
  for (const item of entries || []) {
    if (!isSafeImageId(item?.id)) continue;
    const prev = byId.get(item.id) || { id: item.id, refs: [], recordedAt: now() };
    byId.set(item.id, {
      id: item.id,
      refs: uniqueStrings([...(prev.refs || []), ...(item.refs || [])]),
      recordedAt: prev.recordedAt || now(),
    });
  }
  const images = [...byId.values()].slice(-40);
  await writeFile(usedImagesFile, JSON.stringify({ images }, null, 2), "utf8");
  return images;
}

async function inspectImageRecord(refOrId) {
  const target = String(refOrId || "").trim();
  if (!target) return null;
  try {
    const inspectText = await captureDocker([
      "image",
      "inspect",
      target,
      "--format",
      "{{.Id}}|{{json .RepoTags}}|{{json .RepoDigests}}",
    ]);
    const [id, tagsJson, digestsJson] = inspectText.split("|");
    if (!isSafeImageId(id)) return null;
    return {
      id,
      refs: uniqueStrings([target, ...(JSON.parse(tagsJson || "[]")), ...(JSON.parse(digestsJson || "[]"))]),
    };
  } catch {
    return null;
  }
}

async function inspectContainerImageRecord(name) {
  try {
    const imageId = await captureDocker(["inspect", name, "--format", "{{.Image}}"]);
    const record = await inspectImageRecord(imageId);
    if (record) return record;
    return isSafeImageId(imageId) ? { id: imageId, refs: [] } : null;
  } catch {
    return null;
  }
}

async function recordRunningMmhImages() {
  const entries = [];
  for (const name of ["mmh-app", "mmh-updater"]) {
    const record = await inspectContainerImageRecord(name);
    if (record) entries.push(record);
  }
  if (entries.length) await rememberUsedImages(entries);
  return entries;
}

async function recordPulledImages(selectedImages) {
  const entries = [];
  for (const ref of [selectedImages?.appImage, selectedImages?.updaterImage]) {
    const record = await inspectImageRecord(ref);
    if (record) entries.push(record);
  }
  if (entries.length) await rememberUsedImages(entries);
  return entries;
}

function imageIdsToRemove(history, keepIds) {
  const keep = new Set([...keepIds].filter((id) => isSafeImageId(id)));
  return uniqueStrings((history || []).map((item) => item?.id)).filter((id) => isSafeImageId(id) && !keep.has(id));
}

function removeRecordedImagesCommand(imageIds) {
  const ids = (imageIds || []).filter((id) => isSafeImageId(id));
  if (!ids.length) return "";
  return ids.map((id) => `docker rmi ${JSON.stringify(id)} >/dev/null 2>&1 || true`).join("; ");
}

function captureDocker(args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("docker", args, { cwd: workdir });
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `docker 退出码 ${code}`));
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function getLocalAppImageVersion() {
  try {
    const inspectText = await captureDocker([
      "inspect",
      "mmh-app",
      "--format",
      "{{json .Config.Labels}}|{{.Image}}",
    ]);
    const separator = inspectText.lastIndexOf("|");
    const labels = separator >= 0 ? JSON.parse(inspectText.slice(0, separator) || "{}") : {};
    const imageId = separator >= 0 ? inspectText.slice(separator + 1).trim() : "";
    const repoDigestsText = imageId
      ? await captureDocker(["image", "inspect", imageId, "--format", "{{json .RepoDigests}}"])
      : "[]";
    const repoDigests = JSON.parse(repoDigestsText || "[]");
    const digest = String(repoDigests.find((value) => String(value).includes("@sha256:")) || "").split("@")[1] || "";
    const revision = String(labels?.["org.opencontainers.image.revision"] || "");
    return {
      digest,
      digestShort: shortDigest(digest),
      revision,
      commit: revision.slice(0, 7),
      created: String(labels?.["org.opencontainers.image.created"] || ""),
      message: String(labels?.["org.opencontainers.image.description"] || "").split("\n")[0] || "",
      version: String(labels?.["org.opencontainers.image.version"] || ""),
    };
  } catch {
    return { digest: "", digestShort: "", revision: "", commit: "", created: "", message: "", version: "" };
  }
}

function extractImageVersion(manifestText) {
  try {
    const data = JSON.parse(manifestText);
    const descriptor = Array.isArray(data) ? data[0] : data;
    const labels = descriptor?.image?.config?.Labels
      ?? descriptor?.Image?.config?.Labels
      ?? descriptor?.Descriptor?.annotations
      ?? descriptor?.OCIManifest?.annotations
      ?? descriptor?.OCIv1Manifest?.annotations
      ?? descriptor?.SchemaV2Manifest?.config?.Labels
      ?? descriptor?.Config?.Labels
      ?? {};
    const digest = descriptor?.manifest?.digest
      ?? descriptor?.Manifest?.digest
      ?? descriptor?.Descriptor?.digest
      ?? descriptor?.Descriptor?.Digest
      ?? descriptor?.OCIManifest?.config?.digest
      ?? descriptor?.OCIv1Manifest?.config?.digest
      ?? descriptor?.SchemaV2Manifest?.config?.digest
      ?? descriptor?.Ref;
    const revision = labels["org.opencontainers.image.revision"] || "";
    const created = labels["org.opencontainers.image.created"] || descriptor?.image?.created || "";
    const message = labels["org.opencontainers.image.description"] || "";
    const version = labels["org.opencontainers.image.version"] || "";
    return {
      digest: String(digest || ""),
      digestShort: shortDigest(digest),
      revision: String(revision || ""),
      commit: String(revision || "").slice(0, 7),
      created: String(created || ""),
      message: String(message || "").split("\n")[0] || "",
      version: String(version || ""),
    };
  } catch {
    return { digest: "", digestShort: "", revision: "", commit: "", created: "", message: "", version: "" };
  }
}

function normalizeTimeoutMs(input, fallback = 12000) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), 3000), 15000);
}

function testImageManifest(source, image, timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (!image) {
      resolve({ source, ok: false, error: "未填写镜像地址" });
      return;
    }

    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("docker", [
      "buildx",
      "imagetools",
      "inspect",
      image,
      "--format",
      "{{json .}}",
    ], { cwd: workdir });
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      const ms = Date.now() - startedAt;
      resolve({
        source,
        image,
        ok: code === 0,
        ms,
        version: code === 0 ? extractImageVersion(stdout) : undefined,
        error: code === 0 ? "" : (stderr.trim().split(/\r?\n/).slice(-1)[0] || `退出码 ${code}`),
      });
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      resolve({ source, image, ok: false, ms: Date.now() - startedAt, error: error.message });
    });
  });
}

async function testImageSourceSpeed(input) {
  const env = await readEnvValues();
  const requestedSource = String(input?.source || "").trim();
  const customAppImage = String(input?.customAppImage || "").trim();
  const timeoutMs = normalizeTimeoutMs(input?.timeoutMs);
  const sources = requestedSource
    ? [requestedSource]
    : [...Object.keys(imageSources), "custom"];

  const [results, localVersion] = await Promise.all([
    Promise.all(sources.map((source) => {
      const image = getImageForSpeedTest(source, env, customAppImage);
      return testImageManifest(source, image, timeoutMs);
    })),
    getLocalAppImageVersion(),
  ]);
  return { results, localVersion };
}

async function chooseImageSource() {
  const config = await getImageSourceConfig();

  if (config.source === "custom") {
    if (!config.customAppImage) {
      throw new Error("自定义镜像源需要填写应用镜像地址");
    }
    const updaterImage = config.customUpdaterImage || deriveUpdaterImage(config.customAppImage);
    pushLog("使用自定义镜像源");
    await updateEnvImageSource(config.customAppImage, updaterImage);
    return { appImage: config.customAppImage, updaterImage };
  }

  const selected = config.source !== "auto" ? imageSources[config.source] : null;
  if (config.source !== "auto" && !selected) {
    throw new Error(`未知镜像源: ${config.source}`);
  }
  const candidates = config.source === "auto"
    ? autoImageSourceOrder.map((key) => imageSources[key])
    : [
        selected,
        ...autoImageSourceOrder
          .filter((key) => key !== config.source)
          .map((key) => imageSources[key]),
      ].filter(Boolean);

  task.currentStep = "检测镜像源";
  pushLog("检测镜像源");
  for (const source of candidates) {
    pushLog(`检测 ${source.name} 镜像源`);
    const ok = await inspectImageSource(source);
    if (ok) {
      pushLog(`使用 ${source.name} 镜像源`);
      await updateEnvImageSource(source.app, source.updater);
      return { appImage: source.app, updaterImage: source.updater };
    }
    pushLog(`${source.name} 镜像源不可用，尝试下一个`);
  }

  pushLog("镜像源检测失败，保留当前 .env 配置");
  return { appImage: config.appImage, updaterImage: config.updaterImage };
}

function inspectImageSource(source, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn("docker", ["manifest", "inspect", source.app], { cwd: workdir, stdio: "ignore" });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(false);
    }, timeoutMs);

    child.on("close", (code) => finish(code === 0));
    child.on("error", () => finish(false));
  });
}

async function scheduleUpdaterRecreate(updaterImage, staleImageIds = []) {
  const workspaceSource = await captureDocker([
    "inspect",
    "mmh-updater",
    "--format",
    "{{range .Mounts}}{{if eq .Destination \"/workspace\"}}{{.Source}}{{end}}{{end}}",
  ]);
  // The updater may run in host-path mode (no /workspace mount). Fall back to
  // a mount whose destination equals the configured workdir.
  const hostWorkdirForRecreate =
    workspaceSource && workspaceSource.startsWith("/")
      ? workspaceSource
      : await captureDocker([
          "inspect",
          "mmh-updater",
          "--format",
          `{{range .Mounts}}{{if eq .Destination ${JSON.stringify(workdir)}}}{{.Source}}{{end}}{{end}}`,
        ]).catch(() => "");
  if (!hostWorkdirForRecreate || !hostWorkdirForRecreate.startsWith("/")) {
    throw new Error("无法确定更新目录在宿主机上的路径");
  }
  const composeRelativePath = composeFile.startsWith(`${workdir}/`)
    ? composeFile.slice(workdir.length + 1)
    : "docker-compose.yml";
  const hostComposeFile = `${hostWorkdirForRecreate}/${composeRelativePath}`;

  return new Promise((resolve, reject) => {
    if (!updaterImage) {
      reject(new Error("未找到更新执行器镜像地址"));
      return;
    }
    const helperName = `mmh-updater-reloader-${Date.now()}`;
    const commands = [
      "sleep 3",
      `docker compose -p ${composeProject} -f ${JSON.stringify(hostComposeFile)} up -d --no-deps --force-recreate updater`,
    ];
    const removeCmd = removeRecordedImagesCommand(staleImageIds);
    if (removeCmd) commands.push(removeCmd);
    const recreateCommand = commands.join("; ");
    const child = spawn("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      helperName,
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      `${hostWorkdirForRecreate}:${hostWorkdirForRecreate}`,
      "-w",
      hostWorkdirForRecreate,
      "--entrypoint",
      "sh",
      updaterImage,
      "-lc",
      recreateCommand,
    ], { cwd: workdir });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `启动更新执行器重建任务失败，退出码 ${code}`));
    });
    child.on("error", reject);
  });
}

// Default readiness budget. Overridable so a rollback drill (which deliberately
// ships a broken image) does not have to sit through the full six minutes, and
// so unusually slow hosts can raise it.
function defaultReadyTimeoutMs() {
  const configured = Number(process.env.MMH_UPDATE_READY_TIMEOUT_MS || "");
  if (Number.isFinite(configured) && configured >= 5000) return Math.min(configured, 30 * 60 * 1000);
  return 6 * 60 * 1000;
}

async function waitForAppReady(timeoutMs = defaultReadyTimeoutMs()) {
  const appUrl = "http://app:7777/";
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(appUrl, { signal: controller.signal, cache: "no-store" });
      clearTimeout(timer);
      // 任意 <500 的响应都说明应用已开始对外服务（首页、登录页、未授权提示等都算）。
      if (res.status < 500) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `应用在 ${Math.round(timeoutMs / 60000)} 分钟内未能启动完成（最后状态：${lastError || "无响应"}）。` +
      "镜像可能已经拉取成功，请在宿主机执行 sudo docker compose logs --tail 50 app 查看原因。",
  );
}

// ---------------------------------------------------------------------------
// Pre-update snapshot and rollback (app + database together)
//
// A failed image update used to be terminal: the app container had already been
// recreated on the new image, and the database had already been migrated
// forward by the `prisma db push` inside docker-entrypoint.sh. Rolling the image
// back alone is NOT enough - refuse_if_schema_newer() exits 78 when
// `_mmh_schema_meta.schema_version` is newer than the image version, so an
// app-only rollback crash-loops forever under `restart: unless-stopped`. The
// snapshot below captures the running image ID, the deploy files, and a full
// pg_dump, so a failure can restore the application AND the database together.
// ---------------------------------------------------------------------------

async function fileExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function snapshotDirOnHost(dir) {
  if (hostWorkdir && dir.startsWith(`${workdir}/`)) {
    return `${hostWorkdir}/${dir.slice(workdir.length + 1)}`;
  }
  return dir;
}

async function resolveDbContainer() {
  const candidates = [
    ["compose", "-p", composeProject, "-f", composeFile, "ps", "-q", "postgres"],
    ["ps", "--filter", "name=^/?mmh-db$", "--format", "{{.ID}}"],
  ];
  for (const args of candidates) {
    try {
      const found = (await captureDocker(args, 8000))
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean)[0];
      if (found) return found;
    } catch {}
  }
  return "";
}

function dbCredentials(env) {
  return {
    user: String(env?.POSTGRES_USER || "").trim() || "mmh-fs",
    database: String(env?.POSTGRES_DB || "").trim() || "mmh",
  };
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function readSchemaVersionMarker(container, credentials) {
  try {
    const value = await captureDocker([
      "exec",
      container,
      "psql",
      "-tAc",
      "SELECT value FROM \"_mmh_schema_meta\" WHERE key = 'schema_version'",
      "-U",
      credentials.user,
      "-d",
      credentials.database,
    ], 8000);
    return value.trim();
  } catch {
    return "";
  }
}

async function takePreUpdateSnapshot() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = `${rollbackRoot}/${stamp}`;
  // Escape hatch for hosts where pg_dump cannot run (exotic database image).
  // Read from .env so it works without editing the compose file.
  const env = await readEnvValues();
  const allowNoSnapshot = /^(1|true|yes)$/i.test(String(env.MMH_UPDATE_ALLOW_NO_SNAPSHOT || "").trim());
  const credentials = dbCredentials(env);
  const snapshot = {
    stamp,
    dir,
    hostDir: snapshotDirOnHost(dir),
    createdAt: now(),
    appImageId: "",
    schemaVersion: "",
    database: credentials.database,
    composeBackedUp: false,
    envBackedUp: false,
    dbDumped: false,
  };

  pushLog(`更新前快照目录：${snapshot.hostDir}`);
  await run(`mkdir -p ${JSON.stringify(dir)}`, "创建回滚快照目录");

  snapshot.appImageId = await captureDocker(["inspect", "mmh-app", "--format", "{{.Image}}"], 8000).catch(() => "");
  if (snapshot.appImageId) {
    pushLog(`上一版本应用镜像：${snapshot.appImageId}`);
  } else {
    pushLog("警告：未找到 mmh-app 容器，无法记录上一版本镜像；回滚时只能恢复数据库，应用镜像需要手动指定。");
  }

  await run(
    `if [ -f ${JSON.stringify(composeFile)} ]; then cp -f ${JSON.stringify(composeFile)} ${JSON.stringify(`${dir}/docker-compose.yml`)}; fi`,
    "备份 docker-compose.yml",
    { allowFailure: true },
  );
  snapshot.composeBackedUp = await fileExists(`${dir}/docker-compose.yml`);

  await run(
    `if [ -f ${JSON.stringify(`${workdir}/.env`)} ]; then cp -f ${JSON.stringify(`${workdir}/.env`)} ${JSON.stringify(`${dir}/.env`)}; fi`,
    "备份 .env",
    { allowFailure: true },
  );
  snapshot.envBackedUp = await fileExists(`${dir}/.env`);

  const container = await resolveDbContainer();
  if (!container) {
    if (!allowNoSnapshot) {
      throw new Error(
        "找不到数据库容器，无法创建更新前快照，本次更新已在拉取镜像前中止。"
          + "请先确认 postgres 容器正在运行；如确认要在没有数据库快照的情况下继续更新，"
          + "请在 .env 中设置 MMH_UPDATE_ALLOW_NO_SNAPSHOT=1 后重试。",
      );
    }
    pushLog("警告：找不到数据库容器；按 MMH_UPDATE_ALLOW_NO_SNAPSHOT=1 继续更新，本次没有数据库快照。");
    return snapshot;
  }

  const dumpPath = `${dir}/db.dump`;
  pushLog(`导出数据库快照（容器 ${container}，库 ${credentials.database}）`);
  try {
    await run(
      `docker exec ${JSON.stringify(container)} pg_dump -Fc -U ${JSON.stringify(credentials.user)} -d ${JSON.stringify(credentials.database)} > ${JSON.stringify(dumpPath)}`,
      "导出数据库快照",
    );
    await run(
      `if [ -s ${JSON.stringify(dumpPath)} ] && [ "$(head -c 5 ${JSON.stringify(dumpPath)})" = "PGDMP" ]; then echo "数据库快照校验通过"; else echo "数据库快照为空或格式不正确"; exit 1; fi`,
      "校验数据库快照",
    );
    snapshot.dbDumped = true;
    snapshot.schemaVersion = await readSchemaVersionMarker(container, credentials);
    pushLog(`数据库快照已就绪（schema_version=${snapshot.schemaVersion || "未记录"}）`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!allowNoSnapshot) {
      throw new Error(
        `数据库快照失败，本次更新已在拉取镜像前中止：${detail}。`
          + "请先确认数据库容器健康、宿主机磁盘空间充足；如确认要在没有数据库快照的情况下继续更新，"
          + "请在 .env 中设置 MMH_UPDATE_ALLOW_NO_SNAPSHOT=1 后重试。",
      );
    }
    pushLog(`警告：数据库快照失败；按 MMH_UPDATE_ALLOW_NO_SNAPSHOT=1 继续更新：${detail}`);
  }
  return snapshot;
}

async function restoreDatabaseFromSnapshot(snapshot) {
  const container = await resolveDbContainer();
  if (!container) throw new Error("找不到数据库容器，无法恢复数据库");
  const credentials = dbCredentials(await readEnvValues());
  const dumpPath = `${snapshot.dir}/db.dump`;
  const swapDatabase = `${credentials.database}${rollbackSwapSuffix}`;
  if (!snapshot.dbDumped) {
    pushLog("警告：本次更新没有数据库快照，跳过数据库恢复；库与应用可能不再匹配，旧镜像可能被 schema 版本门拦下。");
    return false;
  }

  // pg_restore -l only reads the archive directory; it proves the dump is
  // parseable before anything on the live database is touched.
  await run(
    `docker exec -i ${JSON.stringify(container)} pg_restore -l < ${JSON.stringify(dumpPath)} > /dev/null`,
    "校验数据库快照可读",
  );

  // Restore into a staging database and only swap it in after the import
  // succeeds, so a failed pg_restore can never leave an empty live database.
  await run(
    `docker exec ${JSON.stringify(container)} dropdb --if-exists -U ${JSON.stringify(credentials.user)} ${quoteIdentifier(swapDatabase)}`,
    "清理回滚临时库",
  );
  await run(
    `docker exec ${JSON.stringify(container)} createdb -U ${JSON.stringify(credentials.user)} -O ${JSON.stringify(credentials.user)} ${quoteIdentifier(swapDatabase)}`,
    "创建回滚临时库",
  );
  await run(
    `docker exec ${JSON.stringify(container)} psql -v ON_ERROR_STOP=1 -U ${JSON.stringify(credentials.user)} -d ${quoteIdentifier(swapDatabase)} -c ${JSON.stringify(`CREATE SCHEMA IF NOT EXISTS public; GRANT ALL ON SCHEMA public TO ${quoteIdentifier(credentials.user)}; CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; CREATE EXTENSION IF NOT EXISTS "pgcrypto";`)}`,
    "准备回滚临时库",
  );
  await run(
    `docker exec -i ${JSON.stringify(container)} pg_restore --no-owner --no-privileges -U ${JSON.stringify(credentials.user)} -d ${quoteIdentifier(swapDatabase)} < ${JSON.stringify(dumpPath)}`,
    "导入数据库快照",
  );

  const restoredTables = await captureDocker([
    "exec",
    container,
    "psql",
    "-tAc",
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
    "-U",
    credentials.user,
    "-d",
    swapDatabase,
  ], 8000).catch(() => "0");
  if (!Number(restoredTables.trim() || 0)) {
    throw new Error(`回滚临时库 ${swapDatabase} 导入后没有任何表，快照可能不完整；线上数据库未被改动。`);
  }
  pushLog(`回滚临时库已导入 ${restoredTables.trim()} 张表，准备切换`);

  await run(
    `docker exec ${JSON.stringify(container)} dropdb --force -U ${JSON.stringify(credentials.user)} ${quoteIdentifier(credentials.database)}`,
    "回滚：删除当前数据库",
  );
  try {
    await run(
      `docker exec ${JSON.stringify(container)} psql -v ON_ERROR_STOP=1 -U ${JSON.stringify(credentials.user)} -d postgres -c ${JSON.stringify(`ALTER DATABASE ${quoteIdentifier(swapDatabase)} RENAME TO ${quoteIdentifier(credentials.database)}`)}`,
      "回滚：切换回快照数据库",
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `数据库已删除但重命名失败：${detail}。快照已导入到数据库 ${swapDatabase}，`
        + `请在宿主机执行 docker exec ${container} psql -U ${credentials.user} -d postgres -c 'ALTER DATABASE ${quoteIdentifier(swapDatabase)} RENAME TO ${quoteIdentifier(credentials.database)}' 完成切换。`,
    );
  }
  pushLog(`数据库已回滚到更新前状态（${credentials.database}）`);
  return true;
}

async function rollbackUpdate(snapshot) {
  const hostDir = snapshot.hostDir || snapshotDirOnHost(snapshot.dir);
  if (!snapshot.appImageId) {
    // Rolling the database back without a pinned application image would leave
    // a newer image running against an older schema, which the entrypoint then
    // migrates forward again on the next start. Refuse rather than half-roll.
    throw new Error(
      "没有记录到上一版本应用镜像（mmh-app 容器不存在或 docker inspect 失败），无法同时回滚应用；"
        + `为避免库与应用版本不一致，本次未改动数据库。请按 ${hostDir} 中的快照手动恢复。`,
    );
  }
  task.currentStep = "回滚：停止应用";
  pushLog("回滚：先停止应用，释放数据库连接");
  await run(composeCommand("stop app"), "回滚：停止应用", { allowFailure: true });

  task.currentStep = "回滚：恢复数据库";
  pushLog("回滚：恢复数据库（应用与数据库必须同时回退，否则旧镜像会被 schema 版本门拦成 exit 78）");
  const dbRestored = await restoreDatabaseFromSnapshot(snapshot);

  task.currentStep = "回滚：恢复部署文件";
  if (snapshot.envBackedUp) {
    await run(
      `cp -f ${JSON.stringify(`${snapshot.dir}/.env`)} ${JSON.stringify(`${workdir}/.env`)}`,
      "回滚：恢复 .env",
    );
  }
  if (snapshot.composeBackedUp) {
    await run(
      `cp -f ${JSON.stringify(`${snapshot.dir}/docker-compose.yml`)} ${JSON.stringify(composeFile)}`,
      "回滚：恢复 docker-compose.yml",
    );
  }

  await run(
    `docker tag ${JSON.stringify(snapshot.appImageId)} ${JSON.stringify(rollbackImageTag)}`,
    "回滚：标记上一版本镜像",
  );
  // Point the compose image variable at the pinned tag: the .env backup alone
  // would name `:latest`, which the pull step already moved onto the new build.
  await updateEnvValues({ MMH_APP_IMAGE: rollbackImageTag });
  pushLog(`回滚：应用镜像已钉回 ${rollbackImageTag}（${snapshot.appImageId}）`);

  task.currentStep = "回滚：启动上一版本应用";
  await run(composeCommand("up -d --no-deps --force-recreate app"), "回滚：启动上一版本应用");
  pushLog("回滚：等待应用启动完成...");
  await waitForAppReady(3 * 60 * 1000);
  return { dbRestored };
}

async function failUpdate(message, snapshot, appRecreateStarted) {
  pushLog(message);
  task.error = message;

  // Only roll back once the app container has actually been recreated. Before
  // that point neither the running image nor the database has been modified, so
  // stopping a healthy app to rewrite its database would be worse than the
  // original failure.
  if (!snapshot || !appRecreateStarted) {
    task.status = "failed";
    task.running = false;
    task.currentStep = "失败";
    if (snapshot) {
      pushLog(`本次失败发生在应用容器重建之前，应用与数据库均未被改动；快照保留在 ${snapshot.hostDir}。`);
      task.rollback = {
        attempted: false,
        reason: "应用容器尚未重建，无需回滚",
        snapshotDir: snapshot.hostDir,
        at: now(),
      };
    }
    await persistTask().catch(() => {});
    return;
  }

  task.status = "rollingback";
  pushLog("更新失败，开始回滚：应用 + 数据库");
  const rollback = {
    attempted: true,
    at: now(),
    snapshotDir: snapshot.hostDir,
    appRestored: false,
    dbRestored: false,
    error: "",
  };
  try {
    const result = await rollbackUpdate(snapshot);
    rollback.appRestored = Boolean(snapshot.appImageId);
    rollback.dbRestored = result.dbRestored;
    task.status = "rolledback";
    task.currentStep = "已回滚";
    pushLog("回滚完成：已恢复更新前的应用与数据库，系统回到更新前状态。");
  } catch (error) {
    rollback.error = error instanceof Error ? error.message : String(error);
    task.status = "failed";
    task.currentStep = "回滚失败";
    pushLog(`回滚失败：${rollback.error}`);
    pushLog(`更新前快照保留在 ${snapshot.hostDir}，可在宿主机按以下顺序手动恢复：`);
    pushLog(`  1) docker compose -p ${composeProject} stop app`);
    pushLog(`  2) 恢复数据库：docker exec <postgres 容器> pg_restore --no-owner --no-privileges -U <POSTGRES_USER> -d <POSTGRES_DB> < ${snapshot.hostDir}/db.dump`);
    pushLog(`  3) 把 ${snapshot.hostDir} 下的 .env 与 docker-compose.yml 复制回安装目录`);
    pushLog(`  4) docker compose -p ${composeProject} up -d --no-deps --force-recreate app`);
  }
  task.rollback = rollback;
  task.running = false;
  await persistTask().catch(() => {});
}

async function runUpdatePipeline() {
  let snapshot = null;
  let appRecreateStarted = false;
  try {
    await resolveHostWorkdir();
    await recordRunningMmhImages().catch(() => []);
    // Snapshot before the deploy files are overwritten by the release-bundled
    // copies below, otherwise we would back up the new compose file instead of
    // the one that is currently running.
    snapshot = await takePreUpdateSnapshot();
    await run(syncDeployFilesCommand(), "同步部署文件", { allowFailure: true });
    const selectedImages = await chooseImageSource();
    await run(composeCommand("pull updater app"), "拉取应用镜像");
    const pulledImages = await recordPulledImages(selectedImages).catch(() => []);

    task.status = "restarting";
    task.currentStep = "重启服务";
    pushLog("即将重启服务");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    appRecreateStarted = true;
    await run(composeCommand("up -d --no-deps --force-recreate app"), "重启服务");
    pushLog("等待应用启动完成...");
    await waitForAppReady();

    task.status = "completed";
    task.running = false;
    task.currentStep = "完成";
    pushLog("更新完成");
    const newImageIds = uniqueStrings(pulledImages.map((item) => item.id));
    // Keep the replaced image as well: it is the rollback target, and the
    // cleanup below would otherwise delete it moments after a success.
    const keepIds = uniqueStrings([...newImageIds, snapshot?.appImageId || ""]);
    const staleImageIds = newImageIds.length ? imageIdsToRemove(await readUsedImages(), keepIds) : [];
    if (!newImageIds.length) {
      pushLog("未能确认新镜像 ID，跳过历史镜像清理");
    } else if (staleImageIds.length) {
      pushLog(`将清理 ${staleImageIds.length} 个历史 MMH 镜像`);
    }
    if (snapshot?.appImageId && newImageIds.length) {
      await run(
        `docker tag ${JSON.stringify(snapshot.appImageId)} ${JSON.stringify(rollbackImageTag)}`,
        "保留上一版本镜像",
        { allowFailure: true },
      );
      pushLog(`上一版本镜像保留为 ${rollbackImageTag}，需要时可回滚`);
    }
    await persistTask();
    await scheduleUpdaterRecreate(selectedImages.updaterImage, staleImageIds);
    pushLog("更新执行器将切换到所选镜像源");
  } catch (error) {
    await failUpdate(error instanceof Error ? error.message : String(error), snapshot, appRecreateStarted).catch(
      async (failError) => {
        // Nothing may leave task.running stuck at true: startUpdate() refuses
        // every later attempt while it is set, which would lock the host out of
        // web updates until the updater container is recreated by hand.
        pushLog(`处理更新失败时出错：${failError instanceof Error ? failError.message : String(failError)}`);
        task.status = "failed";
        task.running = false;
        task.currentStep = "失败";
        await persistTask().catch(() => {});
      },
    );
  }
}

async function startUpdate() {
  if (task.running) return false;
  task = {
    running: true,
    status: "running",
    currentStep: "准备更新",
    logs: [],
    error: "",
    rollback: null,
    startedAt: now(),
    updatedAt: now(),
  };
  // An unhandled rejection would terminate the updater process; the pipeline
  // catches its own errors, so this is the last-resort guard.
  void runUpdatePipeline().catch((error) => {
    task.status = "failed";
    task.running = false;
    task.currentStep = "失败";
    task.error = error instanceof Error ? error.message : String(error);
  });
  return true;
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  if (req.method === "POST" && req.url === "/update") {
    startUpdate().then((started) => {
      sendJson(res, started ? 202 : 409, { ok: started, task });
    });
    return;
  }

  if (req.method === "GET" && req.url === "/config") {
    getImageSourceConfig()
      .then((config) => sendJson(res, 200, { ok: true, config }))
      .catch((error) => sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }));
    return;
  }

  if (req.method === "POST" && req.url === "/config") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      let input = {};
      try {
        input = body ? JSON.parse(body) : {};
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid json" });
        return;
      }
      saveImageSourceConfig(input)
        .then((config) => sendJson(res, 200, { ok: true, config }))
        .catch((error) => sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }));
    });
    return;
  }

  if (req.method === "POST" && req.url === "/speed") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      let input = {};
      try {
        input = body ? JSON.parse(body) : {};
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid json" });
        return;
      }
      testImageSourceSpeed(input)
        .then(({ results, localVersion }) => sendJson(res, 200, { ok: true, results, localVersion }))
        .catch((error) => sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }));
    });
    return;
  }

  if (req.method === "GET" && req.url === "/status") {
    if (task.status !== "idle") {
      sendJson(res, 200, { ok: true, task });
      return;
    }
    readRecentPersistedTask()
      .then((savedTask) => sendJson(res, 200, { ok: true, task: savedTask || task }))
      .catch(() => sendJson(res, 200, { ok: true, task }));
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[mmh-updater] listening on ${port}`);
});
