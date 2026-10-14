#!/usr/bin/env node
/**
 * MMH Bug Harness —— 常驻检测服务入口。
 *
 * 职责（刻意做窄）：
 *   采集 GitHub issue + 反馈邮箱未读邮件
 *   → 用指定模型分诊并撰写规范任务规格
 *   → 落到 tasks/ 目录，供第三方 harness 读取执行
 *
 * 本服务不拉仓库、不跑构建、不碰 git —— 所以能在内存紧张的群晖上长期常驻。
 *
 * 用法：
 *   node src/index.mjs          常驻（轮询 + 配置页 + HTTP 接口）
 *   node src/index.mjs --once   只跑一轮后退出（用于部署验证 / cron）
 */

import path from "node:path";
import { loadConfig, describeConfig } from "./config.mjs";
import { log, setLogLevel } from "./log.mjs";
import { ensureDir, nowIso, writeFileAtomic, chmodBestEffort } from "./util.mjs";
import { Store } from "./store.mjs";
import { collectGithub } from "./collectors/github.mjs";
import { collectImap, markImapSeen } from "./collectors/imap.mjs";
import { triageItem } from "./triage.mjs";
import { writeTask, reconcileTaskStages, rebuildIndex, HANDOFF_DIR_MODE } from "./taskfile.mjs";
import { startServer } from "./server.mjs";
import { TASKS_CONTRACT_MD, TASKS_README_FILENAME } from "./contract.mjs";

const once = process.argv.includes("--once");

async function prepareDirs(cfg) {
  await ensureDir(cfg.dataDir);
  await ensureDir(cfg.assetsDir);
  await ensureDir(cfg.tasksDir);
  // 交接目录必须对第三方 harness 完全开放（它可能以任意 uid 运行）。
  chmodBestEffort(cfg.tasksDir, HANDOFF_DIR_MODE);
  for (const stage of ["pending", "claimed", "done", "skipped"]) {
    const dir = path.join(cfg.tasksDir, stage);
    await ensureDir(dir);
    chmodBestEffort(dir, HANDOFF_DIR_MODE);
  }
  const readme = path.join(cfg.tasksDir, TASKS_README_FILENAME);
  await writeFileAtomic(readme, TASKS_CONTRACT_MD);
  chmodBestEffort(readme, 0o644);
}

/** 跑一轮完整流水线。永不抛错 —— 单轮失败不能拖垮常驻进程。 */
async function runCycle(cfg, store) {
  const cycleStarted = nowIso();
  log.info("—— 开始一轮扫描 ——");

  const collected = [];
  collected.push(...(await collectGithub(cfg, store)));
  collected.push(...(await collectImap(cfg, store)));

  let created = 0;
  let skipped = 0;
  let calls = 0;
  const seenUids = [];

  for (const item of collected) {
    if (calls >= cfg.ai.maxCallsPerCycle) {
      log.warn(`本轮模型调用已达上限 ${cfg.ai.maxCallsPerCycle}，剩余 ${collected.length - calls} 个条目顺延到下一轮`);
      break;
    }
    calls += 1;
    const spec = await triageItem(cfg, item);
    const task = await writeTask(cfg, item, spec);

    if (cfg.dryRun) {
      log.info(`[dry-run] 不落库：${task.id}`);
    } else {
      store.createTask(task);
      store.markProcessed(item.processKey, { taskId: task.id, verdict: spec.verdict });
    }

    if (task.stage === "pending") created += 1;
    else skipped += 1;

    if (item.source === "imap" && item.uid) seenUids.push(item.uid);
  }

  if (!cfg.dryRun) {
    await markImapSeen(cfg, seenUids);
    await reconcileTaskStages(cfg, store);
  }

  const index = await rebuildIndex(cfg, store);
  if (!cfg.dryRun) await store.save();

  log.info(
    `—— 本轮结束 —— 采集 ${collected.length}，生成任务 ${created}，过滤 ${skipped}，` +
      `模型调用 ${calls}，累计 ${JSON.stringify(index.counts)}`,
  );
  return { cycleStarted, collected: collected.length, created, skipped, calls };
}

async function main() {
  let cfg = await loadConfig();
  setLogLevel(cfg.logLevel);

  log.info("MMH Bug Harness 启动");
  log.info(`配置摘要:\n  ${describeConfig(cfg)}`);

  await prepareDirs(cfg);

  const store = new Store(cfg.stateFile);
  await store.load();
  log.info(`状态库已加载：${Object.keys(store.state.tasks).length} 个历史任务，${Object.keys(store.state.processed).length} 条处理记录`);

  if (once) {
    try {
      await runCycle(cfg, store);
      process.exit(0);
    } catch (error) {
      log.error(`单轮执行失败：${error.stack ?? error.message}`);
      process.exit(1);
    }
  }

  // runtime 是配置页与主循环之间的共享状态。
  // cfg 每次重新解析 —— 页面保存后下一轮立即生效，无需重启容器。
  const runtime = {
    running: false,
    lastCycleAt: null,
    lastCycleError: null,
    trigger: null,
    getConfig: () => cfg,
    getStore: () => store,
    isRunning: () => runtime.running,
    async reloadConfig() {
      const previousPort = cfg.port;
      cfg = await loadConfig();
      if (cfg.port !== previousPort) {
        log.warn(`端口从 ${previousPort} 改为 ${cfg.port}：HTTP 监听不会热切换，请重启容器`);
      }
      return cfg;
    },
    requestCycle() {
      if (runtime.trigger) runtime.trigger();
    },
  };

  const server = startServer(runtime);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`收到 ${signal}，正在退出…`);
    if (!runtime.getConfig().dryRun) {
      try {
        await store.save();
      } catch (error) {
        log.error(`退出前保存状态失败：${error.message}`);
      }
    }
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  // 主循环：等待「轮询间隔」或「立即扫描」信号，二者先到先执行。
  let pendingTrigger = null;
  runtime.trigger = () => {
    if (pendingTrigger) pendingTrigger();
  };

  while (!stopping) {
    const current = runtime.getConfig();
    runtime.running = true;
    try {
      await runCycle(current, store);
      runtime.lastCycleAt = nowIso();
      runtime.lastCycleError = null;
    } catch (error) {
      runtime.lastCycleError = error.message;
      log.error(`本轮异常（不影响后续轮次）：${error.stack ?? error.message}`);
    } finally {
      runtime.running = false;
    }

    // 每轮重新读取间隔：页面上改完，等这一轮结束就按新间隔跑。
    const interval = runtime.getConfig().pollIntervalMs;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, interval);
      pendingTrigger = () => {
        clearTimeout(timer);
        pendingTrigger = null;
        log.info("收到立即扫描请求");
        resolve();
      };
    });
    pendingTrigger = null;
  }
}

main().catch((error) => {
  log.error(`致命错误：${error.stack ?? error.message}`);
  process.exit(1);
});
