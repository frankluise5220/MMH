import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const port = Number(process.env.MMH_UPDATER_PORT || 7788);
const token = String(process.env.MMH_UPDATE_TOKEN || "").trim();
const workdir = process.env.MMH_WORKDIR || "/workspace";
const composeProject = process.env.MMH_COMPOSE_PROJECT || "mmh";
const ghcrImage = "ghcr.io/frankluise5220/mmh:latest";
const daocloudImage = "ghcr.m.daocloud.io/frankluise5220/mmh:latest";
const dockerproxyImage = "ghcr.dockerproxy.net/frankluise5220/mmh:latest";
const njuImage = "ghcr.nju.edu.cn/frankluise5220/mmh:latest";
const ghcrUpdaterImage = "ghcr.io/frankluise5220/mmh-updater:latest";
const daocloudUpdaterImage = "ghcr.m.daocloud.io/frankluise5220/mmh-updater:latest";
const dockerproxyUpdaterImage = "ghcr.dockerproxy.net/frankluise5220/mmh-updater:latest";
const njuUpdaterImage = "ghcr.nju.edu.cn/frankluise5220/mmh-updater:latest";

const imageSources = {
  ghcr: { name: "GHCR", app: ghcrImage, updater: ghcrUpdaterImage },
  dockerproxy: { name: "dockerproxy", app: dockerproxyImage, updater: dockerproxyUpdaterImage },
  nju: { name: "NJU", app: njuImage, updater: njuUpdaterImage },
  daocloud: { name: "DaoCloud", app: daocloudImage, updater: daocloudUpdaterImage },
};

const autoImageSourceOrder = ["dockerproxy", "nju", "ghcr", "daocloud"];

let task = {
  running: false,
  status: "idle",
  currentStep: "",
  logs: [],
  error: "",
  startedAt: null,
  updatedAt: null,
};

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

function run(command, step) {
  return new Promise((resolve, reject) => {
    task.currentStep = step;
    pushLog(`开始：${step}`);
    const child = spawn("sh", ["-lc", command], { cwd: workdir });
    child.stdout.on("data", (chunk) => pushLog(chunk.toString().trim()));
    child.stderr.on("data", (chunk) => pushLog(chunk.toString().trim()));
    child.on("close", (code) => {
      if (code === 0) {
        pushLog(`完成：${step}`);
        resolve();
      } else {
        reject(new Error(`${step}失败，退出码 ${code}`));
      }
    });
    child.on("error", reject);
  });
}

async function updateEnvImageSource(appImage, updaterImage) {
  await updateEnvValues({
    MMH_APP_IMAGE: appImage,
    MMH_UPDATER_IMAGE: updaterImage,
  });
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
      { value: "auto", label: "自动选择", appImage: env.MMH_APP_IMAGE || "", updaterImage: env.MMH_UPDATER_IMAGE || "" },
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
    if (!customAppImage) throw new Error("自定义镜像源需要填写应用镜像地址");
    values.CUSTOM_MMH_APP_IMAGE = customAppImage;
    values.CUSTOM_MMH_UPDATER_IMAGE = customUpdaterImage;
    values.MMH_APP_IMAGE = customAppImage;
    values.MMH_UPDATER_IMAGE = customUpdaterImage || imageSources.ghcr.updater;
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

function testImageManifest(source, image) {
  return new Promise((resolve) => {
    if (!image) {
      resolve({ source, ok: false, error: "未填写镜像地址" });
      return;
    }

    const startedAt = Date.now();
    let stderr = "";
    let settled = false;
    const child = spawn("docker", ["manifest", "inspect", image], { cwd: workdir });
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGTERM");
    }, 12000);

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
  const sources = requestedSource
    ? [requestedSource]
    : [...Object.keys(imageSources), "custom"];

  const results = [];
  for (const source of sources) {
    const image = getImageForSpeedTest(source, env, customAppImage);
    results.push(await testImageManifest(source, image));
  }
  return results;
}

async function chooseImageSource() {
  const config = await getImageSourceConfig();

  if (config.source === "custom") {
    if (!config.customAppImage) throw new Error("自定义镜像源需要填写应用镜像地址");
    const updaterImage = config.customUpdaterImage || imageSources.ghcr.updater;
    pushLog("使用自定义镜像源");
    await updateEnvImageSource(config.customAppImage, updaterImage);
    return;
  }

  if (config.source !== "auto") {
    const selected = imageSources[config.source];
    if (!selected) throw new Error(`未知镜像源: ${config.source}`);
    pushLog(`使用 ${selected.name} 镜像源`);
    await updateEnvImageSource(selected.app, selected.updater);
    return;
  }

  const candidates = autoImageSourceOrder.map((key) => imageSources[key]);

  pushLog("检测镜像源");
  for (const source of candidates) {
    const ok = await new Promise((resolve) => {
      const child = spawn("sh", ["-lc", `timeout 8 docker manifest inspect ${source.app} >/dev/null 2>&1`], { cwd: workdir });
      child.on("close", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
    });
    if (ok) {
      pushLog(`使用 ${source.name} 镜像源`);
      await updateEnvImageSource(source.app, source.updater);
      return;
    }
  }

  pushLog("镜像源检测失败，保留当前 .env 配置");
}

async function startUpdate() {
  if (task.running) return false;
  task = {
    running: true,
    status: "running",
    currentStep: "准备更新",
    logs: [],
    error: "",
    startedAt: now(),
    updatedAt: now(),
  };

  void (async () => {
    try {
      await run('if [ -d .git ]; then git config --global --add safe.directory "$PWD" && git pull --ff-only || echo "代码仓库同步失败，继续拉取镜像"; else echo "未发现 .git，跳过代码仓库更新"; fi', "同步部署文件");
      await chooseImageSource();
      await run(`docker compose -p ${composeProject} pull app updater`, "拉取软件镜像");
      task.status = "restarting";
      task.currentStep = "重启服务";
      pushLog("即将重启服务");
      setTimeout(() => {
        void (async () => {
          try {
            await run(`docker compose -p ${composeProject} up -d app`, "重启服务");
            task.status = "completed";
            task.running = false;
            task.currentStep = "完成";
            pushLog("更新完成");
          } catch (error) {
            task.status = "failed";
            task.running = false;
            task.error = error instanceof Error ? error.message : String(error);
            pushLog(task.error);
          }
        })();
      }, 5000);
    } catch (error) {
      task.status = "failed";
      task.running = false;
      task.error = error instanceof Error ? error.message : String(error);
      pushLog(task.error);
    }
  })();

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
        .then((results) => sendJson(res, 200, { ok: true, results }))
        .catch((error) => sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }));
    });
    return;
  }

  if (req.method === "GET" && req.url === "/status") {
    sendJson(res, 200, { ok: true, task });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[mmh-updater] listening on ${port}`);
});
