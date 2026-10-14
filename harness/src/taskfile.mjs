/**
 * 任务文件产出 —— 这是整个服务对外唯一的「契约」。
 *
 * 目录结构（tasks/ 由 volume 挂载给第三方 harness 读取）：
 *   tasks/
 *     README.md                 契约说明（服务启动时自动写入）
 *     index.json                全部任务的机读索引（每轮重建）
 *     pending/<id>/task.md      任务规格（Markdown + YAML front-matter）
 *     pending/<id>/task.json    同一任务的机读结构
 *     pending/<id>/assets/*     截图等附件
 *     claimed/<id>/...          harness 认领后自行移动到这里
 *     done/<id>/...             harness 完成后移动到这里
 *     skipped/<id>/...          分诊判定为非 bug，记录备查
 *
 * 服务只负责写 pending/ 与 skipped/，并扫描 claimed/ done/ 反推状态；
 * 不删除、不移动 harness 自己的文件。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { log } from "./log.mjs";
import { ensureDir, nowIso, writeFileAtomic, writeJsonAtomic, yamlList, yamlScalar, pathExists, chmodBestEffort } from "./util.mjs";
import { DEFAULT_CONSTRAINTS } from "./triage.mjs";

/** 交接目录权限：第三方 harness 可能以任意身份运行，必须能读、能移、能写。 */
export const HANDOFF_DIR_MODE = 0o777;

export const TASK_STAGES = ["pending", "claimed", "done", "skipped"];

/** 分诊结果决定任务落到哪个阶段目录。 */
export function stageForVerdict(verdict) {
  if (verdict === "bug" || verdict === "unclear") return "pending";
  return "skipped";
}

/**
 * 是否需要人工先过一遍，再交给修复 harness 动手。
 *
 * 判据（满足任一即需要）：
 *  - `triageSource === "fallback"`：模型压根没被调用，verdict 是规则猜的；
 *  - `verdict === "unclear"`：模型自己也没把握；
 *  - `confidence < 0.5`。
 *
 * ⚠️ front-matter、task.json、index.json 三处必须同口径 —— 只留这一个判据函数，
 * 别再各处手写一遍（曾经的写法是只认 `verdict === "unclear"`，而 GitHub 来源在
 * 规则兜底里恒判 bug，于是「没配模型 + confidence 0.2 + 正文写着需人工确认」的任务
 * 反而被标成不需要人工）。
 */
export function needsHumanTriage(task) {
  if (task.triageSource === "fallback") return true;
  if (task.verdict === "unclear") return true;
  return Number(task.confidence ?? 0) < 0.5;
}

const SKIP_REASON = {
  suggestion: "分诊判定为功能建议，非缺陷，不进入修复队列",
  question: "分诊判定为提问/咨询，非缺陷",
  sponsor: "分诊判定为赞助对账，非缺陷",
  duplicate: "分诊判定为重复报错",
};

function renderFrontMatter(task) {
  const lines = [
    "---",
    `id: ${yamlScalar(task.id)}`,
    `source: ${yamlScalar(task.source)}`,
    `external_id: ${yamlScalar(task.externalId)}`,
    `source_url: ${yamlScalar(task.sourceUrl ?? "")}`,
    `repo: ${yamlScalar(task.repo)}`,
    `base_branch: ${yamlScalar(task.baseBranch)}`,
    `workspace_hint: ${yamlScalar(task.workspaceHint ?? "")}`,
    `kind: ${yamlScalar(task.kind)}`,
    `verdict: ${yamlScalar(task.verdict)}`,
    `confidence: ${task.confidence}`,
    `priority: ${yamlScalar(task.priority)}`,
    `needs_human_triage: ${needsHumanTriage(task) ? "true" : "false"}`,
    `status: ${yamlScalar(task.status)}`,
    `created_at: ${yamlScalar(task.createdAt)}`,
    `model: ${yamlScalar(task.model ?? "")}`,
    `triage_source: ${yamlScalar(task.triageSource ?? "")}`,
  ];
  if (task.author) lines.push(`author: ${yamlScalar(task.author)}`);
  if (task.appVersion) lines.push(`app_version: ${yamlScalar(task.appVersion)}`);
  if (task.labels?.length) {
    lines.push("labels:");
    lines.push(yamlList(task.labels, 2));
  }
  lines.push("suspected_files:");
  lines.push(yamlList(task.suspectedFiles ?? [], 2));
  if (task.attachments?.length) {
    lines.push("attachments:");
    lines.push(yamlList(task.attachments.map((a) => a.file), 2));
  }
  lines.push("constraints:");
  lines.push(yamlList(task.constraints ?? DEFAULT_CONSTRAINTS, 2));
  lines.push("---");
  return lines.join("\n");
}

function renderBody(task) {
  const spec = task.spec ?? {};
  const out = [`# ${task.title}`, ""];

  out.push("## 任务说明", "", spec.summary || "（模型未给出摘要，见下方原始内容）", "");

  if (spec.repro?.length) {
    out.push("## 复现步骤", "");
    spec.repro.forEach((step, i) => out.push(`${i + 1}. ${step}`));
    out.push("");
  }

  if (spec.expected || spec.actual) {
    out.push("## 期望行为", "", spec.expected || "（未明确）", "");
    out.push("## 实际行为", "", spec.actual || "（未明确）", "");
  }

  if (spec.suspectedFiles?.length) {
    out.push("## 疑似涉及文件", "");
    spec.suspectedFiles.forEach((f) => out.push(`- \`${f}\``));
    out.push("");
  }

  if (task.attachments?.length) {
    out.push("## 附件", "");
    task.attachments.forEach((a) => out.push(`- \`${a.file}\`${a.note ? ` — ${a.note}` : ""}`));
    out.push("");
  }

  if (spec.acceptance?.length) {
    out.push("## 验收标准", "");
    spec.acceptance.forEach((a) => out.push(`- [ ] ${a}`));
    out.push("");
  }

  out.push("## 硬约束", "");
  (task.constraints ?? DEFAULT_CONSTRAINTS).forEach((c) => out.push(`- ${c}`));
  out.push("");

  if (spec.notes) {
    out.push("## 补充提示", "", spec.notes, "");
  }

  out.push("## 原始报错内容", "", "```text", task.rawBody ?? "", "```", "");

  if (task.comments?.length) {
    out.push("## 相关评论", "");
    task.comments.forEach((c) => out.push(`**${c.author ?? "?"}**：`, "", c.body ?? "", ""));
  }

  out.push("## 来源", "");
  if (task.sourceUrl) out.push(`- 链接：${task.sourceUrl}`);
  out.push(`- 来源类型：${task.source === "github" ? "GitHub Issue" : "用户反馈邮件"}`);
  out.push(`- 标识：${task.externalId}`);
  if (task.author) out.push(`- 提交者：${task.author}`);
  if (task.appVersion) out.push(`- App 版本：${task.appVersion}`);
  out.push(`- 生成时间：${task.createdAt}`);
  out.push(`- 生成模型：${task.model || "(未使用模型)"}`);
  out.push("");

  return out.join("\n");
}

export function renderTaskMarkdown(task) {
  return `${renderFrontMatter(task)}\n\n${renderBody(task)}`;
}

/** 把源附件从 data/assets 复制到任务目录。 */
async function materializeAttachments(cfg, taskDir, attachments) {
  const out = [];
  if (!attachments?.length) return out;
  const assetsDir = path.join(taskDir, "assets");
  await ensureDir(assetsDir);
  for (const att of attachments) {
    try {
      const from = path.join(cfg.assetsDir, att.storedAs);
      if (!(await pathExists(from))) continue;
      const to = path.join(assetsDir, att.filename);
      await fsp.copyFile(from, to);
      out.push({ file: `assets/${att.filename}`, note: att.note ?? "", contentType: att.contentType ?? "" });
    } catch (error) {
      log.warn(`附件复制失败 ${att.filename}: ${error.message}`);
    }
  }
  return out;
}

/**
 * 写一个任务到磁盘，返回落库用的 task 记录。
 * dryRun=true 时只返回记录，不落盘。
 */
export async function writeTask(cfg, item, spec) {
  const stage = stageForVerdict(spec.verdict);
  const now = nowIso();
  const taskId = item.taskId;

  const task = {
    id: taskId,
    source: item.source,
    externalId: item.externalId,
    sourceUrl: item.url ?? "",
    repo: cfg.github.repo,
    baseBranch: "main",
    workspaceHint: cfg.workspaceHint,
    title: spec.title || item.title,
    kind: spec.kind,
    verdict: spec.verdict,
    confidence: spec.confidence,
    priority: spec.priority,
    status: stage === "pending" ? "pending" : "skipped",
    stage,
    skipReason: stage === "skipped" ? (SKIP_REASON[spec.verdict] ?? "分诊判定非缺陷") : "",
    model: spec.model,
    triageSource: spec.triageSource,
    author: item.author ?? "",
    appVersion: item.meta?.appVersion ?? "",
    labels: item.meta?.labels ?? [],
    suspectedFiles: spec.suspectedFiles ?? [],
    constraints: spec.constraints ?? DEFAULT_CONSTRAINTS,
    rawBody: item.body ?? "",
    comments: item.comments ?? [],
    createdAt: now,
    updatedAt: now,
    claimedBy: null,
    claimedAt: null,
    finishedAt: null,
  };

  task.spec = spec;

  if (cfg.dryRun) {
    log.info(`[dry-run] 将生成任务 ${taskId} → ${stage}/ (${spec.verdict}/${spec.priority}) ${task.title}`);
    task.attachments = [];
    task.dir = path.posix.join(stage, taskId);
    return task;
  }

  const taskDir = path.join(cfg.tasksDir, stage, taskId);
  await ensureDir(taskDir);
  chmodBestEffort(taskDir, HANDOFF_DIR_MODE);
  task.attachments = await materializeAttachments(cfg, taskDir, item.attachments ?? []);

  await writeFileAtomic(path.join(taskDir, "task.md"), renderTaskMarkdown(task));
  await writeJsonAtomic(path.join(taskDir, "task.json"), {
    ...task,
    needsHumanTriage: needsHumanTriage(task),
    spec,
  });

  task.dir = path.posix.join(stage, taskId);
  log.info(`已生成任务 ${taskId} → tasks/${task.dir} (${spec.verdict}/${spec.priority}) ${task.title}`);
  return task;
}

/** 扫描 claimed/ done/，反推任务状态（harness 移动文件即视为状态变更）。 */
export async function reconcileTaskStages(cfg, store) {
  for (const stage of ["claimed", "done"]) {
    const stageDir = path.join(cfg.tasksDir, stage);
    let entries = [];
    try {
      entries = await fsp.readdir(stageDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const task = store.state.tasks[id];
      if (!task) continue;
      if (task.status === stage) continue;
      // dir 必须跟着走：第三方 harness 靠 index.json 里的 taskFile 定位文件。
      const patch = { status: stage, stage, dir: path.posix.join(stage, id) };
      if (stage === "claimed" && !task.claimedAt) patch.claimedAt = nowIso();
      if (stage === "done" && !task.finishedAt) patch.finishedAt = nowIso();
      store.updateTask(id, patch);
      log.info(`任务 ${id} 状态 → ${stage}`);
    }
  }
}

/** 构建 index 对象（纯函数，不落盘）—— HTTP 接口与文件写出共用同一口径。 */
export function buildIndex(cfg, store) {
  const tasks = store.listTasks().map((t) => ({
    id: t.id,
    title: t.title,
    source: t.source,
    externalId: t.externalId,
    sourceUrl: t.sourceUrl,
    kind: t.kind,
    verdict: t.verdict,
    priority: t.priority,
    confidence: t.confidence,
    status: t.status,
    stage: t.stage,
    needsHumanTriage: needsHumanTriage(t),
    suspectedFiles: t.suspectedFiles ?? [],
    dir: t.dir,
    taskFile: t.dir ? `${t.dir}/task.md` : null,
    createdAt: t.createdAt,
    claimedAt: t.claimedAt,
    finishedAt: t.finishedAt,
    model: t.model,
    skipReason: t.skipReason || undefined,
  }));

  return {
    generatedAt: nowIso(),
    repo: cfg.github.repo,
    baseBranch: "main",
    counts: store.counts(),
    tasks,
  };
}

/** 重建 tasks/index.json（供 harness 一次读取全部任务）。 */
export async function rebuildIndex(cfg, store) {
  const index = buildIndex(cfg, store);

  // 索引来自内存状态库，任务文件在磁盘上 —— 两者会漂移：例如有人手工
  // `rm -rf tasks/pending/*` 却没停服务（内存里仍认为任务存在），或 volume 挂载没生效。
  // 不核对的话，index.json 会把指向不存在文件的 taskFile 路径发给第三方 harness。
  // 这里逐个核对并标记，消费者可据此跳过。
  for (const entry of index.tasks) {
    if (!entry.dir) continue;
    const mdPath = path.join(cfg.tasksDir, entry.dir, "task.md");
    if (!(await pathExists(mdPath))) {
      entry.missingOnDisk = true;
      log.warn(
        `索引条目 ${entry.id} 在磁盘上找不到 ${entry.taskFile}（状态库仍记录它）—— ` +
          `若刚手工删过任务目录，请重启服务让状态库重建；已标记 missingOnDisk`,
      );
    }
  }

  if (!cfg.dryRun) {
    await writeJsonAtomic(path.join(cfg.tasksDir, "index.json"), index);
    await ensureDir(path.join(cfg.tasksDir, "pending"));
  }
  return index;
}
