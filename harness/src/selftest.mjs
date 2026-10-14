#!/usr/bin/env node
/**
 * 离线自检：不联网、不调模型，验证全链路。
 *   分诊 → 落盘 → 状态回流 → 索引重建 → 配置分层 → 配置保存 → 页面渲染
 * 用法：node src/selftest.mjs
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.mjs";
import { triageItem, DEFAULT_CONSTRAINTS } from "./triage.mjs";
import { writeTask, reconcileTaskStages, rebuildIndex, renderTaskMarkdown, buildIndex, needsHumanTriage } from "./taskfile.mjs";
import { loadConfig, saveConfigPatch, buildConfigView } from "./config.mjs";
import { renderPage, renderLogin } from "./ui.mjs";
import { authEnabled, isAuthenticated, verifyPassword, sessionCookieHeader, clearCookieHeader, sessionToken, usingDefaultPassword } from "./auth.mjs";
import { DEFAULT_UI_PASSWORD, AUTH_DISABLED_SENTINEL } from "./schema.mjs";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 在临时目录里加载配置（隔离真实的 data/ 与 .env）。 */
async function makeConfig(baseDir) {
  const cfg = await loadConfig({
    dataDir: path.join(baseDir, "data"),
    tasksDir: path.join(baseDir, "tasks"),
  });
  cfg.dryRun = false;
  cfg.ai = { ...cfg.ai, baseUrl: "", apiKey: "", model: "", timeoutMs: 5000, maxCallsPerCycle: 10 };
  return cfg;
}

async function main() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "mmh-harness-selftest-"));
  const cfg = await makeConfig(base);
  console.log(`临时目录: ${base}\n`);

  console.log("[1] 规则兜底分诊（无模型）");
  const ghItem = {
    source: "github",
    externalId: "999",
    taskId: "GH-999",
    processKey: "github:999@2026-10-13T00:00:00Z",
    title: "基金赎回界面小bug",
    body: "赎回时金额校验没生效，输入负数也能提交。",
    url: "https://github.com/frankluise5220/MMH/issues/999",
    author: "tester",
    meta: { labels: ["bug"], appVersion: "0.1.71" },
    comments: [{ author: "owner", body: "复现了，赎回页确实没校验。" }],
    attachments: [],
  };
  const spec = await triageItem(cfg, ghItem);
  check("verdict 为 bug", spec.verdict === "bug", spec.verdict);
  check("triageSource 为 fallback", spec.triageSource === "fallback", spec.triageSource);
  check("constraints 使用默认硬约束", spec.constraints.length === DEFAULT_CONSTRAINTS.length);

  console.log("\n[2] 落盘任务文件");
  const task = await writeTask(cfg, ghItem, spec);
  const taskDir = path.join(cfg.tasksDir, "pending", "GH-999");
  const md = await fsp.readFile(path.join(taskDir, "task.md"), "utf8");
  const json = JSON.parse(await fsp.readFile(path.join(taskDir, "task.json"), "utf8"));
  check("task.md 已生成", md.length > 200);
  check("front-matter 以 --- 开头", md.startsWith("---\n"));
  check("front-matter 已闭合", md.split("---").length >= 3);
  check("包含 id 字段", /^id: GH-999$/m.test(md));
  check("包含硬约束原文", md.includes("只修改代码，不要执行 git commit"));
  check("task.json 与 task.md 同 id", json.id === "GH-999");
  check("stage 为 pending", task.stage === "pending", task.stage);
  check("dir 指向 pending/GH-999", task.dir === "pending/GH-999", task.dir);

  console.log("\n[2b] needsHumanTriage 单一判据");
  check("front-matter 标记需人工复核", /^needs_human_triage: true$/m.test(md));
  check("task.json 同样标记需人工复核", json.needsHumanTriage === true);
  check(
    "兜底分诊 → 需人工（即使 verdict=bug / confidence 高）",
    needsHumanTriage({ triageSource: "fallback", verdict: "bug", confidence: 0.9 }) === true,
  );
  check(
    "verdict=unclear → 需人工",
    needsHumanTriage({ triageSource: "model", verdict: "unclear", confidence: 0.9 }) === true,
  );
  check(
    "低置信度 → 需人工",
    needsHumanTriage({ triageSource: "model", verdict: "bug", confidence: 0.3 }) === true,
  );
  check(
    "模型高置信度 bug → 不需人工",
    needsHumanTriage({ triageSource: "model", verdict: "bug", confidence: 0.9 }) === false,
  );

  console.log("\n[3] 邮件条目：分诊过滤 + 任务落盘");
  const mailItem = {
    source: "imap",
    externalId: "<abc@qq.com>",
    taskId: "MAIL-abc",
    processKey: "imap:<abc@qq.com>",
    title: "[MMH Feedback] 希望支持导出 PDF",
    body: "User: frank\nType: Suggestion\n\n希望账单能导出 PDF。",
    url: "",
    author: "frank <fu_b@qq.com>",
    meta: { user: "frank", type: "Suggestion", appVersion: "0.1.71" },
    comments: [],
    attachments: [],
  };
  const mailSpec = await triageItem(cfg, mailItem);
  check("邮件兜底判定非 bug", mailSpec.verdict !== "bug", mailSpec.verdict);
  const mailTask = await writeTask(cfg, mailItem, mailSpec);
  check("非 bug 落到 skipped", mailTask.stage === "skipped", mailTask.stage);

  console.log("\n[4] 状态库读写与去重");
  const store = new Store(cfg.stateFile);
  await store.load();
  store.createTask(task);
  store.createTask(mailTask);
  store.markProcessed(ghItem.processKey, { taskId: "GH-999" });
  await store.save();
  const reloaded = new Store(cfg.stateFile);
  await reloaded.load();
  check("任务持久化", Object.keys(reloaded.state.tasks).length === 2);
  check("处理记录持久化", reloaded.isProcessed(ghItem.processKey) === true);
  check("未处理条目判否", reloaded.isProcessed("github:1@x") === false);

  console.log("\n[5] 状态回流（harness 移动目录 → 状态变更）");
  await fsp.mkdir(path.join(cfg.tasksDir, "claimed"), { recursive: true });
  await fsp.rename(taskDir, path.join(cfg.tasksDir, "claimed", "GH-999"));
  await reconcileTaskStages(cfg, reloaded);
  check("claimed 状态已回流", reloaded.state.tasks["GH-999"].status === "claimed", reloaded.state.tasks["GH-999"].status);
  check("claimedAt 已记录", Boolean(reloaded.state.tasks["GH-999"].claimedAt));
  check("dir 已跟随移动", reloaded.state.tasks["GH-999"].dir === "claimed/GH-999", reloaded.state.tasks["GH-999"].dir);

  console.log("\n[6] 索引重建");
  const index = await rebuildIndex(cfg, reloaded);
  check("index.json 已写出", await fsp.stat(path.join(cfg.tasksDir, "index.json")).then(() => true).catch(() => false));
  check("counts 统计 claimed=1", index.counts.claimed === 1, JSON.stringify(index.counts));
  check("index 任务数 = 2", index.tasks.length === 2, String(index.tasks.length));
  check("index 含 taskFile 相对路径", index.tasks.some((t) => t.taskFile === "claimed/GH-999/task.md"));
  check("buildIndex 为纯函数（与 rebuildIndex 同口径）", buildIndex(cfg, reloaded).tasks.length === 2);
  check(
    "index 与 front-matter 的 needsHumanTriage 同口径",
    index.tasks.find((t) => t.id === "GH-999")?.needsHumanTriage === needsHumanTriage(reloaded.state.tasks["GH-999"]),
  );
  check("磁盘存在时不标记 missingOnDisk", index.tasks.every((t) => !t.missingOnDisk));

  // 状态库与磁盘漂移：手工删掉任务目录后，索引不能继续指向死路径。
  await fsp.rm(path.join(cfg.tasksDir, "claimed", "GH-999"), { recursive: true, force: true });
  const drifted = await rebuildIndex(cfg, reloaded);
  check(
    "任务目录被删后索引标记 missingOnDisk",
    drifted.tasks.find((t) => t.id === "GH-999")?.missingOnDisk === true,
  );
  await fsp.mkdir(path.join(cfg.tasksDir, "claimed", "GH-999"), { recursive: true });
  await fsp.writeFile(path.join(cfg.tasksDir, "claimed", "GH-999", "task.md"), "restored", "utf8");

  console.log("\n[7] 渲染确定性");
  const renderedA = renderTaskMarkdown(task);
  const renderedB = renderTaskMarkdown(task);
  check("同一任务两次渲染一致", renderedA === renderedB);

  console.log("\n[8] 配置分层：config.json > 环境变量 > .env > 默认值");
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  await fsp.writeFile(
    cfg.configFile,
    JSON.stringify({ GITHUB_REPO: "custom/repo", HARNESS_POLL_INTERVAL_MS: "600000" }),
    "utf8",
  );
  const layered = await loadConfig({ dataDir: cfg.dataDir, tasksDir: cfg.tasksDir });
  check("config.json 覆盖了仓库", layered.github.repo === "custom/repo", layered.github.repo);
  check("来源标注为 config", layered.sources.GITHUB_REPO === "config", layered.sources.GITHUB_REPO);
  check("config.json 覆盖了轮询间隔", layered.pollIntervalMs === 600000, String(layered.pollIntervalMs));
  check("未覆盖项回落到默认值", ["default", "file", "env"].includes(layered.sources.GITHUB_COMMENTS_MAX), layered.sources.GITHUB_COMMENTS_MAX);

  await fsp.rm(cfg.configFile, { force: true });
  const unlayered = await loadConfig({ dataDir: cfg.dataDir, tasksDir: cfg.tasksDir });
  check("删掉覆盖后回落", unlayered.github.repo === "frankluise5220/MMH", unlayered.github.repo);
  check("来源不再标注 config", unlayered.sources.GITHUB_REPO !== "config", unlayered.sources.GITHUB_REPO);

  console.log("\n[9] 配置保存 / 清除 / 校验");
  const saveOk = await saveConfigPatch(layered, { GITHUB_REPO: "another/repo", HARNESS_POLL_INTERVAL_MS: "120000" });
  check("合法补丁保存成功", saveOk.ok === true, JSON.stringify(saveOk.errors ?? []));
  check(
    "keys 只含本次补丁动过的键（页面「已保存 N 项」用）",
    Array.isArray(saveOk.keys) && saveOk.keys.length === 2 && saveOk.keys.includes("GITHUB_REPO"),
    JSON.stringify(saveOk.keys),
  );
  const afterSave = await loadConfig({ dataDir: cfg.dataDir, tasksDir: cfg.tasksDir });
  check("保存后生效", afterSave.github.repo === "another/repo", afterSave.github.repo);

  const mode = (await fsp.stat(cfg.configFile)).mode & 0o777;
  if (process.platform === "win32") {
    console.log(`  skip config.json 权限断言（Windows 无 POSIX 权限位，实测 ${mode.toString(8)}；容器内为 600）`);
  } else {
    check("config.json 权限为 600", mode === 0o600, mode.toString(8));
  }

  const saveBad = await saveConfigPatch(afterSave, { HARNESS_PORT: "99999" });
  check("超范围数字被拒", saveBad.ok === false, JSON.stringify(saveBad.errors));
  const saveNaN = await saveConfigPatch(afterSave, { HARNESS_POLL_INTERVAL_MS: "abc" });
  check("非数字被拒", saveNaN.ok === false, JSON.stringify(saveNaN.errors));
  const saveUnknown = await saveConfigPatch(afterSave, { NOT_A_FIELD: "x" });
  check("未知键被拒", saveUnknown.ok === false, JSON.stringify(saveUnknown.errors));

  const stillValid = await loadConfig({ dataDir: cfg.dataDir, tasksDir: cfg.tasksDir });
  check("校验失败时整批不写入", stillValid.github.repo === "another/repo", stillValid.github.repo);

  await saveConfigPatch(stillValid, { GITHUB_REPO: "" });
  const afterClear = await loadConfig({ dataDir: cfg.dataDir, tasksDir: cfg.tasksDir });
  check("空值 = 清除覆盖", afterClear.github.repo === "frankluise5220/MMH", afterClear.github.repo);

  console.log("\n[10] 配置视图与页面渲染");
  const view = buildConfigView(afterClear);
  check("配置视图含 5 个分组", view.groups.length === 5, String(view.groups.length));
  const tokenField = view.groups
    .find((g) => g.id === "github")
    .fields.find((f) => f.env === "GITHUB_TOKEN");
  check("密钥字段不回传明文", tokenField.value === "" && tokenField.type === "password");
  const portField = view.groups.find((g) => g.id === "runtime").fields.find((f) => f.env === "HARNESS_PORT");
  check("端口字段标记需重启", portField.needsRestart === true);

  const html = renderPage();
  check("页面为完整 HTML", html.startsWith("<!doctype html>"));
  check("页面含配置接口调用", html.includes("/api/config"));
  check("页面含任务看板接口", html.includes("/api/tasks"));
  check("页面含日志接口", html.includes("/api/logs"));
  check("页面无外部资源依赖", !/src=["']https?:/.test(html) && !/<link[^>]+href=["']https?:/.test(html));
  check("页面无残留模板占位", !html.includes("${"));
  check("未启用鉴权时无退出入口", !html.includes('href="/logout"'));
  check("启用鉴权时有退出入口", renderPage({ authEnabled: true }).includes('href="/logout"'));
  check(
    "仍用初始密码时页面提醒改密",
    renderPage({ authEnabled: true, usingDefaultPassword: true }).includes("初始密码"),
  );
  check(
    "已改密码后不再提醒",
    !renderPage({ authEnabled: true, usingDefaultPassword: false }).includes("仍在使用"),
  );

  console.log("\n[11] 访问鉴权");
  const defaultPass = await loadConfig({ dataDir: cfg.dataDir, tasksDir: cfg.tasksDir });
  check("默认密码为 mmh12345", defaultPass.ui.password === DEFAULT_UI_PASSWORD, defaultPass.ui.password);
  check("默认即启用鉴权（留空不等于关闭）", authEnabled(defaultPass) === true);
  check("初始密码可登录", verifyPassword(defaultPass, DEFAULT_UI_PASSWORD) === true);
  check("初始密码下提示改密", usingDefaultPassword(defaultPass) === true);

  const disabled = { ...defaultPass, ui: { password: AUTH_DISABLED_SENTINEL } };
  check("密码显式设为 - 时关闭鉴权", authEnabled(disabled) === false);
  check("关闭鉴权时请求直接放行", isAuthenticated(disabled, { headers: {} }) === true);
  check("关闭鉴权时不下发 cookie", sessionCookieHeader(disabled) === null);

  const withPass = { ...defaultPass, ui: { password: "s3cret-pw" } };
  check("自定义密码启用鉴权", authEnabled(withPass) === true);
  check("自定义密码下不再提示改密", usingDefaultPassword(withPass) === false);
  check("正确密码通过", verifyPassword(withPass, "s3cret-pw") === true);
  check("错误密码不通过", verifyPassword(withPass, "wrong") === false);
  check("空密码不通过", verifyPassword(withPass, "") === false);
  check("无 cookie 时拒绝", isAuthenticated(withPass, { headers: {} }) === false);
  const cookie = sessionCookieHeader(withPass);
  check("cookie 含 HttpOnly", cookie.includes("HttpOnly"));
  check("cookie 含 SameSite=Lax", cookie.includes("SameSite=Lax"));
  const cookieValue = cookie.split(";")[0];
  check("带正确 cookie 时放行", isAuthenticated(withPass, { headers: { cookie: cookieValue } }) === true);
  check("伪造 cookie 被拒", isAuthenticated(withPass, { headers: { cookie: "mmh_harness_session=deadbeef" } }) === false);
  check("会话令牌由密码派生（改密码即失效）", sessionToken(withPass) !== sessionToken({ ui: { password: "other" } }));
  check("清除 cookie 立即过期", clearCookieHeader().includes("Max-Age=0"));

  const loginHtml = renderLogin({ error: "密码不正确" });
  check("登录页为完整 HTML", loginHtml.startsWith("<!doctype html>"));
  check("登录页含表单", loginHtml.includes('action="/login"') && loginHtml.includes('name="password"'));
  check("登录页回显错误", loginHtml.includes("密码不正确"));
  check("登录页不依赖 JS 提交", !loginHtml.includes("<script"));

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  await fsp.rm(base, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("自检异常：", error);
  process.exit(1);
});
