/**
 * 状态库：单文件 JSON，记录「已处理条目」与「已产出任务」。
 *
 * 设计取舍：刻意不用 SQLite —— 群晖容器里避免任何 native 依赖，
 * 且本服务的状态量级（百级条目）用 JSON 完全够用。写入走原子替换。
 */

import path from "node:path";
import { nowIso, readJson, writeJsonAtomic, ensureDir } from "./util.mjs";

const STATE_VERSION = 1;

function emptyState() {
  return {
    version: STATE_VERSION,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastGithubPollAt: null,
    lastImapPollAt: null,
    processed: {},
    tasks: {},
  };
}

export class Store {
  constructor(stateFile) {
    this.stateFile = stateFile;
    this.state = emptyState();
    this._dirty = false;
  }

  async load() {
    await ensureDir(path.dirname(this.stateFile));
    const loaded = await readJson(this.stateFile, null);
    if (loaded && typeof loaded === "object" && loaded.version === STATE_VERSION) {
      this.state = { ...emptyState(), ...loaded };
      this.state.processed = loaded.processed ?? {};
      this.state.tasks = loaded.tasks ?? {};
    } else if (loaded) {
      // 版本不匹配：保留任务，重置处理游标（会重跑一轮，但幂等由 externalId 兜底）。
      this.state = { ...emptyState(), tasks: loaded.tasks ?? {} };
    }
    return this.state;
  }

  async save() {
    this.state.updatedAt = nowIso();
    await writeJsonAtomic(this.stateFile, this.state);
    this._dirty = false;
  }

  markDirty() {
    this._dirty = true;
  }

  get dirty() {
    return this._dirty;
  }

  /** 去重判据：source + externalId + revision 的组合键是否处理过。 */
  isProcessed(key) {
    return Boolean(this.state.processed[key]);
  }

  markProcessed(key, info) {
    this.state.processed[key] = { at: nowIso(), ...info };
    this.markDirty();
  }

  /** 该条目此前是否已生成过任务（用于「跳过」时也记账，避免反复调用模型）。 */
  findTaskBySource(source, externalId) {
    return Object.values(this.state.tasks).find(
      (t) => t.source === source && String(t.externalId) === String(externalId),
    ) ?? null;
  }

  createTask(task) {
    this.state.tasks[task.id] = task;
    this.markDirty();
    return task;
  }

  updateTask(id, patch) {
    const existing = this.state.tasks[id];
    if (!existing) return null;
    this.state.tasks[id] = { ...existing, ...patch, updatedAt: nowIso() };
    this.markDirty();
    return this.state.tasks[id];
  }

  listTasks() {
    return Object.values(this.state.tasks).sort((a, b) =>
      String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
    );
  }

  counts() {
    const out = {};
    for (const task of Object.values(this.state.tasks)) {
      out[task.status] = (out[task.status] ?? 0) + 1;
    }
    return out;
  }
}

/** 稳定的条目 ID：GH-22 / MAIL-<slug>。 */
export function makeTaskId(source, externalId) {
  if (source === "github") return `GH-${externalId}`;
  return `MAIL-${externalId}`;
}

/** 去重键。GitHub 用 number@updated_at（issue 被编辑/新评论会重新入队）。 */
export function githubProcessKey(issue) {
  return `github:${issue.number}@${issue.updated_at}`;
}

export function imapProcessKey(messageId) {
  return `imap:${messageId}`;
}
