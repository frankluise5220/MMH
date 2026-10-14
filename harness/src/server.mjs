/**
 * 配置页 + 运维接口（node:http，零依赖）。
 *
 * 路由：
 *   GET  /                       配置页（需登录，若已设密码）
 *   GET  /login  POST /login     登录 / 提交密码
 *   GET  /logout                 退出登录
 *   GET  /healthz                健康检查（免鉴权，Docker HEALTHCHECK 用）
 *   GET  /api/status             运行状态
 *   GET  /api/config             配置视图（密钥只回掩码）
 *   POST /api/config             保存配置补丁到 data/config.json
 *   POST /api/config/test        连接自测 { target: github|imap|ai }
 *   GET  /api/tasks              任务索引（与 tasks/index.json 同口径）
 *   GET  /api/tasks/<id>         任务详情（含 task.md 原文与附件清单）
 *   GET  /api/tasks/<id>/asset/<name>  附件文件
 *   POST /api/rescan             立即触发一轮扫描
 *   GET  /api/logs?lines=N       最近日志
 *
 * 鉴权：默认密码 mmh12345 即启用；显式设为 "-" 才关闭（适合只绑回环）。
 * 启用时除 /login、/healthz 外一律要求会话 cookie。
 * 路径参数一律白名单校验，防目录穿越。
 */

import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import { log, recentLogs, setLogLevel } from "./log.mjs";
import { describeConfig, saveConfigPatch, buildConfigView } from "./config.mjs";
import { buildIndex } from "./taskfile.mjs";
import { TESTERS } from "./tests.mjs";
import { renderPage, renderLogin } from "./ui.mjs";
import { authEnabled, isAuthenticated, verifyPassword, sessionCookieHeader, clearCookieHeader, usingDefaultPassword } from "./auth.mjs";

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** 免鉴权路径：登录页与健康检查（供 Docker 探活）。 */
const PUBLIC_PATHS = new Set(["/login", "/healthz"]);

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

async function readRawBody(req, limitBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 同时接受 JSON 与表单编码（登录表单用后者）。 */
async function readAnyBody(req) {
  const raw = await readRawBody(req);
  if (!raw.trim()) return {};
  const contentType = String(req.headers["content-type"] ?? "");
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("请求体不是合法 JSON");
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/**
 * @param {object} runtime 由 index.mjs 提供：{ getConfig, getStore, requestCycle, isRunning, ... }
 */
export function startServer(runtime) {
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cfg = runtime.getConfig();
    const store = runtime.getStore();
    const pathname = url.pathname;

    const sendJson = (status, body, headers = {}) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...headers,
      });
      res.end(JSON.stringify(body, null, 2));
    };
    const sendHtml = (status, html, headers = {}) => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...headers,
      });
      res.end(html);
    };
    const redirect = (location, headers = {}) => {
      res.writeHead(302, { location, "cache-control": "no-store", ...headers });
      res.end();
    };

    try {
      /* ---------- 鉴权闸门 ---------- */
      const needsAuth = !PUBLIC_PATHS.has(pathname);
      if (needsAuth && !isAuthenticated(cfg, req)) {
        if (pathname.startsWith("/api/")) {
          return sendJson(401, { ok: false, error: "UNAUTHORIZED", message: "请先登录" });
        }
        return redirect("/login");
      }

      /* ---------- 登录 / 退出 ---------- */
      if (req.method === "GET" && pathname === "/login") {
        if (!authEnabled(cfg) || isAuthenticated(cfg, req)) return redirect("/");
        return sendHtml(200, renderLogin({ error: "" }));
      }

      if (req.method === "POST" && pathname === "/login") {
        if (!authEnabled(cfg)) return redirect("/");
        const body = await readAnyBody(req);
        const input = String(body?.password ?? "");
        if (!verifyPassword(cfg, input)) {
          log.warn("页面登录失败（密码不正确）");
          return sendHtml(401, renderLogin({ error: "密码不正确" }));
        }
        log.info("页面登录成功");
        return redirect("/", { "set-cookie": sessionCookieHeader(cfg) });
      }

      if (pathname === "/logout") {
        log.info("页面已退出登录");
        return redirect("/login", { "set-cookie": clearCookieHeader() });
      }

      /* ---------- 页面 ---------- */
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        return sendHtml(200, renderPage({ authEnabled: authEnabled(cfg), usingDefaultPassword: usingDefaultPassword(cfg) }));
      }

      /* ---------- 健康检查（Dockerfile HEALTHCHECK 依赖此路径） ---------- */
      if (req.method === "GET" && pathname === "/healthz") {
        return sendJson(200, {
          ok: true,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          lastGithubPollAt: store.state.lastGithubPollAt,
          lastImapPollAt: store.state.lastImapPollAt,
          counts: store.counts(),
          dryRun: cfg.dryRun,
          authEnabled: authEnabled(cfg),
          lastCycleAt: runtime.lastCycleAt,
          lastCycleError: runtime.lastCycleError,
        });
      }

      /* ---------- 状态 ---------- */
      if (req.method === "GET" && pathname === "/api/status") {
        return sendJson(200, {
          ok: true,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          lastCycleAt: runtime.lastCycleAt,
          lastCycleError: runtime.lastCycleError,
          lastGithubPollAt: store.state.lastGithubPollAt,
          lastImapPollAt: store.state.lastImapPollAt,
          counts: store.counts(),
          dryRun: cfg.dryRun,
          cycleRunning: runtime.isRunning(),
          summary: describeConfig(cfg),
          paths: { dataDir: cfg.dataDir, tasksDir: cfg.tasksDir, configFile: cfg.configFile },
        });
      }

      /* ---------- 配置 ---------- */
      if (req.method === "GET" && pathname === "/api/config") {
        return sendJson(200, { ok: true, ...buildConfigView(cfg) });
      }

      if (req.method === "POST" && pathname === "/api/config") {
        const body = await readAnyBody(req);
        const patch = body?.patch;
        if (!patch || typeof patch !== "object") return sendJson(400, { ok: false, error: "缺少 patch 对象" });

        const previousPassword = cfg.ui?.password ?? "";
        const result = await saveConfigPatch(cfg, patch);
        if (!result.ok) return sendJson(400, { ok: false, errors: result.errors });

        const fresh = await runtime.reloadConfig();
        setLogLevel(fresh.logLevel);

        const passwordChanged = (fresh.ui?.password ?? "") !== previousPassword;
        log.info(`配置已更新（${result.keys.length} 个键被页面覆盖）${passwordChanged ? "，访问密码已变更" : ""}`);

        // 密码变了 → 旧会话令牌立即失效，必须重新登录。
        // 这里主动清 cookie，否则页面会一直 401 转圈。
        const headers = passwordChanged ? { "set-cookie": clearCookieHeader() } : {};

        return sendJson(
          200,
          {
            ok: true,
            keys: result.keys,
            configFile: cfg.configFile,
            needsRestart: fresh.port !== cfg.port,
            passwordChanged,
            effective: describeConfig(fresh),
          },
          headers,
        );
      }

      if (req.method === "POST" && pathname === "/api/config/test") {
        const body = await readAnyBody(req);
        const target = String(body?.target ?? "");
        const tester = TESTERS[target];
        if (!tester) return sendJson(400, { ok: false, message: `未知测试目标：${target}` });
        log.info(`连接自测：${tester.label}`);
        const result = await tester.run(cfg);
        log.info(`连接自测结果（${tester.label}）：${result.ok ? "通过" : "失败"} — ${result.message}`);
        return sendJson(200, { ok: Boolean(result.ok), message: result.message, detail: result.detail ?? [] });
      }

      /* ---------- 任务 ---------- */
      if (req.method === "GET" && pathname === "/api/tasks") {
        return sendJson(200, { ok: true, ...buildIndex(cfg, store) });
      }

      const taskDetail = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (req.method === "GET" && taskDetail) {
        const id = decodeURIComponent(taskDetail[1]);
        if (!SAFE_ID.test(id)) return sendJson(400, { ok: false, error: "非法任务 ID" });
        const task = store.state.tasks[id];
        if (!task) return sendJson(404, { ok: false, error: `没有任务 ${id}` });

        let markdown = "";
        try {
          markdown = await fsp.readFile(path.join(cfg.tasksDir, task.dir, "task.md"), "utf8");
        } catch {
          markdown = "（task.md 不存在 —— 可能已被 harness 移走或删除）";
        }

        let assets = [];
        try {
          const entries = await fsp.readdir(path.join(cfg.tasksDir, task.dir, "assets"));
          assets = entries.filter((n) => SAFE_NAME.test(n)).map((n) => ({
            name: n,
            url: `/api/tasks/${encodeURIComponent(id)}/asset/${encodeURIComponent(n)}`,
          }));
        } catch {
          assets = [];
        }

        return sendJson(200, { ok: true, task, markdown, assets });
      }

      const taskAsset = pathname.match(/^\/api\/tasks\/([^/]+)\/asset\/([^/]+)$/);
      if (req.method === "GET" && taskAsset) {
        const id = decodeURIComponent(taskAsset[1]);
        const name = decodeURIComponent(taskAsset[2]);
        if (!SAFE_ID.test(id) || !SAFE_NAME.test(name)) return sendJson(400, { ok: false, error: "非法路径" });
        const task = store.state.tasks[id];
        if (!task) return sendJson(404, { ok: false, error: "任务不存在" });

        // 二次防线：解析后的绝对路径必须仍在 tasks 目录内。
        const file = path.resolve(cfg.tasksDir, task.dir, "assets", name);
        const root = path.resolve(cfg.tasksDir);
        if (!file.startsWith(root + path.sep)) return sendJson(403, { ok: false, error: "越界访问" });

        try {
          const data = await fsp.readFile(file);
          res.writeHead(200, { "content-type": MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream" });
          return res.end(data);
        } catch {
          return sendJson(404, { ok: false, error: "附件不存在" });
        }
      }

      /* ---------- 运维 ---------- */
      if (req.method === "POST" && pathname === "/api/rescan") {
        if (runtime.isRunning()) return sendJson(409, { ok: false, message: "一轮扫描正在进行中，请稍候" });
        runtime.requestCycle();
        return sendJson(202, { ok: true, message: "已触发立即扫描，稍后查看日志与任务看板" });
      }

      if (req.method === "GET" && pathname === "/api/logs") {
        const lines = Number.parseInt(url.searchParams.get("lines") ?? "200", 10);
        return sendJson(200, { ok: true, lines: recentLogs(lines) });
      }

      return sendJson(404, { ok: false, error: "not found" });
    } catch (error) {
      log.error(`HTTP 处理失败（${req.method} ${pathname}）：${error.message}`);
      return sendJson(500, { ok: false, error: error.message });
    }
  });

  // 监听端口在启动时确定一次；页面改端口需重启容器（页面上已标注）。
  const listenPort = runtime.getConfig().port;
  server.listen(listenPort, "0.0.0.0", () => {
    const hint = authEnabled(runtime.getConfig()) ? "（已启用访问密码）" : "（未设密码，无需登录）";
    log.info(`配置页已监听 0.0.0.0:${listenPort}${hint}`);
  });

  return server;
}
