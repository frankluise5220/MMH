import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const port = Number(process.env.MMH_UPDATER_PORT || 7788);
const token = String(process.env.MMH_UPDATE_TOKEN || "").trim();
const workdir = process.env.MMH_WORKDIR || "/workspace";
const ghcrImage = "ghcr.io/frankluise5220/mmh:latest";
const daocloudImage = "ghcr.m.daocloud.io/frankluise5220/mmh:latest";
const dockerproxyImage = "ghcr.dockerproxy.net/frankluise5220/mmh:latest";
const njuImage = "ghcr.nju.edu.cn/frankluise5220/mmh:latest";
const ghcrUpdaterImage = "ghcr.io/frankluise5220/mmh-updater:latest";
const daocloudUpdaterImage = "ghcr.m.daocloud.io/frankluise5220/mmh-updater:latest";
const dockerproxyUpdaterImage = "ghcr.dockerproxy.net/frankluise5220/mmh-updater:latest";
const njuUpdaterImage = "ghcr.nju.edu.cn/frankluise5220/mmh-updater:latest";

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
  const envPath = `${workdir}/.env`;
  let text = "";
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    return;
  }
  const setLine = (source, key, value) => {
    const line = `${key}="${value}"`;
    if (source.match(new RegExp(`^${key}=`, "m"))) {
      return source.replace(new RegExp(`^${key}=.*$`, "m"), line);
    }
    return `${source.trimEnd()}\n${line}\n`;
  };
  text = setLine(text, "MMH_APP_IMAGE", appImage);
  text = setLine(text, "MMH_UPDATER_IMAGE", updaterImage);
  await writeFile(envPath, text);
}

async function chooseImageSource() {
  const candidates = [
    { name: "dockerproxy", app: dockerproxyImage, updater: dockerproxyUpdaterImage },
    { name: "NJU", app: njuImage, updater: njuUpdaterImage },
    { name: "GHCR", app: ghcrImage, updater: ghcrUpdaterImage },
    { name: "DaoCloud", app: daocloudImage, updater: daocloudUpdaterImage },
  ];

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
      await run('if [ -d .git ]; then git pull --ff-only; else echo "未发现 .git，跳过代码仓库更新"; fi', "同步部署文件");
      await chooseImageSource();
      await run("docker compose pull app updater", "拉取软件镜像");
      task.status = "restarting";
      task.currentStep = "重启服务";
      pushLog("即将重启服务");
      setTimeout(() => {
        void (async () => {
          try {
            await run("docker compose up -d app", "重启服务");
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

  if (req.method === "GET" && req.url === "/status") {
    sendJson(res, 200, { ok: true, task });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[mmh-updater] listening on ${port}`);
});
