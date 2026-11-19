// fnOS 启动失败说明页（构建时拷进 app/server/scripts/）。
//
// 触发条件只有一个：init-sqlite.cjs 以 78 退出，也就是账本里存在当前 payload
// 不认识的迁移——典型的降级场景（账本被 0.1.86 写过，装回来的是 0.1.77）。
// 这时真正的服务一个字节都起不来，用户从应用中心点开只有网关 502，唯一的线索
// 是 SSH 才能看到的 mmh.log。这个进程就顶在原访问入口上，把 STARTUP-ERROR.txt
// 的中文原因直接渲染成一张只读页面。
//
// 它刻意不读写账本、不加载 Next、不写 mmh.pid：status_app 因此仍然报告「未启动」
// 并把原因指向日志，应用中心不会把这张错误页当成正常运行的服务。
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

function resolveDataDir() {
  const explicit = (process.env.MMH_DATA_DIR || "").trim();
  if (explicit) return explicit;
  const databaseUrl = (process.env.DATABASE_URL || "").trim();
  if (databaseUrl.startsWith("file:")) {
    return path.dirname(databaseUrl.slice("file:".length));
  }
  return path.join(__dirname, "..", "data");
}

const FALLBACK_REASON = [
  "MMH 未能启动：账本数据库是由更新版本的 MMH 写入的，当前安装的程序版本太旧。",
  "",
  "请在飞牛应用中心把 MMH 升级到提示要求的版本后，重新点启动。",
  "账本数据没有被改动；启动日志：/vol1/@appcenter/mmh/cmd/main log 50",
].join("\n");

function readReason() {
  const target = path.join(resolveDataDir(), "STARTUP-ERROR.txt");
  try {
    const text = fs.readFileSync(target, "utf8").trim();
    if (text) return text;
  } catch (error) {
    // 说明页本身不能因为读不到原因就挂掉，下面退回通用文案。
  }
  return FALLBACK_REASON;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPage(reason) {
  const body = [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>MMH 未启动</title>",
    "<style>",
    "body{margin:0;padding:32px 20px;background:#f7f7f8;color:#1f2328;font:15px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}",
    ".card{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px 30px;box-shadow:0 8px 24px rgba(15,23,42,.06)}",
    "h1{margin:0 0 10px;font-size:20px}",
    ".tag{display:inline-block;margin-bottom:18px;padding:2px 10px;border-radius:999px;background:#fef2f2;color:#b91c1c;font-size:12px;font-weight:600}",
    "pre{margin:0;padding:16px;background:#f9fafb;border:1px solid #eef0f2;border-radius:10px;white-space:pre-wrap;word-break:break-word;font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}",
    ".hint{margin:18px 0 0;color:#6b7280;font-size:13px}",
    "</style></head><body><div class=\"card\">",
    "<h1>MMH 未启动</h1>",
    '<span class="tag">服务未运行</span>',
    "<pre>" + escapeHtml(reason) + "</pre>",
    '<p class="hint">这张页面由启动保护生成，不会读写你的账本。按上面的提示升级到要求的版本后，点应用中心的「启动」即可恢复。</p>',
    "</div></body></html>",
  ].join("\n");
  return body;
}

const page = renderPage(readReason());

const requestHandler = (req, res) => {
  if (req.url && req.url.split("?")[0] === "/healthz") {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ status: "startup-failed", reason: "schema-newer-than-payload" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(page);
};

function log(message) {
  console.log("[startup-error-page] " + message);
}

function socketIsServed(socketPath) {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    const finish = (alive) => {
      probe.destroy();
      resolve(alive);
    };
    probe.once("connect", () => finish(true));
    probe.once("error", () => finish(false));
    probe.setTimeout(1000, () => finish(false));
  });
}

async function clearStaleGatewaySocket(socketPath) {
  let stats;
  try {
    stats = fs.lstatSync(socketPath);
  } catch (error) {
    return;
  }
  if (!stats.isSocket()) {
    log("WARNING: " + socketPath + " 存在但不是 socket，保持原样不改动");
    return;
  }
  if (await socketIsServed(socketPath)) {
    log("WARNING: " + socketPath + " 仍有进程在服务，不覆盖");
    return;
  }
  fs.rmSync(socketPath, { force: true });
  log("已清理残留的网关 socket " + socketPath);
}

async function listen(server, options, label) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      log("Listening on " + label);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options);
  });
}

async function main() {
  const appDest = (process.env.TRIM_APPDEST || "").trim();
  const gatewaySocketPath =
    (process.env.MMH_GATEWAY_SOCKET_PATH || "").trim() || (appDest ? path.join(appDest, "app.sock") : "");

  if (gatewaySocketPath) {
    await clearStaleGatewaySocket(gatewaySocketPath);
    const gatewayServer = http.createServer(requestHandler);
    try {
      await listen(gatewayServer, { path: gatewaySocketPath }, "socket " + gatewaySocketPath);
    } catch (error) {
      log("网关 socket 绑定失败：" + (error && error.message ? error.message : String(error)));
    }
  }

  const localPort = Number.parseInt(process.env.MMH_LOCAL_TCP_PORT || "0", 10);
  const localHost = process.env.MMH_LOCAL_TCP_HOST || "0.0.0.0";
  if (Number.isInteger(localPort) && localPort > 0) {
    const localServer = http.createServer(requestHandler);
    try {
      await listen(localServer, { port: localPort, host: localHost }, "tcp " + localHost + ":" + localPort);
    } catch (error) {
      log("本地端口 " + localPort + " 不可用，仅保留网关入口");
    }
  }

  if (!gatewaySocketPath && !(Number.isInteger(localPort) && localPort > 0)) {
    throw new Error("既没有网关 socket 也没有本地端口，说明页无处可听");
  }
}

main().catch((error) => {
  log("启动失败：" + (error && error.stack ? error.stack : String(error)));
  process.exit(1);
});
