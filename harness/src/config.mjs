/**
 * 配置加载与保存。
 *
 * 分层优先级（逐键，非整体）：
 *   data/config.json  >  进程环境变量  >  harness/.env  >  schema 默认值
 *
 * 为什么 config.json 最高：配置页是主要配置面，用户在页面上填的值必须立刻生效。
 * 环境变量 / .env 仍然有用 —— 它们充当「首次种子」，也是 gitops 场景的硬编码入口；
 * 想清掉页面覆盖，在页面上点「清除覆盖」即可（等价于从 config.json 删掉该键）。
 *
 * 不依赖 dotenv：自己解析，保持零依赖。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_GROUPS, allFields, fieldByEnv, coerce, validate, maskSecret } from "./schema.mjs";
import { readJson, writeJsonAtomic } from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HARNESS_ROOT = path.resolve(HERE, "..");

const FIELD_BY_ENV = fieldByEnv();

/** 解析 KEY=VALUE 形式的 .env（支持 # 注释、单双引号包裹值）。 */
function parseEnvFile(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = parseEnvFile(path.join(HARNESS_ROOT, ".env"));

/** 仅用于容器路径这类「不可在页面上改」的基础设置。 */
function pickBase(key, fallback = "") {
  const fromProc = process.env[key];
  if (fromProc !== undefined && fromProc !== "") return fromProc;
  if (fileEnv[key] !== undefined && fileEnv[key] !== "") return fileEnv[key];
  return fallback;
}

function resolveDir(value, fallbackRelative) {
  const raw = value || fallbackRelative;
  return path.isAbsolute(raw) ? raw : path.resolve(HARNESS_ROOT, raw);
}

export function configFileFor(dataDir) {
  return path.join(dataDir, "config.json");
}

async function readConfigJson(file) {
  const loaded = await readJson(file, null);
  return loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded : {};
}

/** 逐键解析，返回原始字符串与来源。 */
function resolveValue(envKey, configJson) {
  const field = FIELD_BY_ENV.get(envKey);
  const fallback = field?.default === undefined ? "" : String(field.default);

  const fromConfig = configJson[envKey];
  if (fromConfig !== undefined && String(fromConfig) !== "") return { raw: String(fromConfig), source: "config" };

  const fromProc = process.env[envKey];
  if (fromProc !== undefined && fromProc !== "") return { raw: String(fromProc), source: "env" };

  const fromFile = fileEnv[envKey];
  if (fromFile !== undefined && fromFile !== "") return { raw: String(fromFile), source: "file" };

  return { raw: fallback, source: "default" };
}

/**
 * 加载配置。返回的对象同时带 `sources`（env 键 → 来源）与 `raw`（env 键 → 原始值），
 * 供配置页展示「这个值从哪来」。
 *
 * @param {{dataDir?:string, tasksDir?:string}} overrides 覆盖容器路径（自检用，页面不改这两个）
 */
export async function loadConfig(overrides = {}) {
  const dataDir = overrides.dataDir ?? resolveDir(pickBase("HARNESS_DATA_DIR", ""), "data");
  const tasksDir = overrides.tasksDir ?? resolveDir(pickBase("HARNESS_TASKS_DIR", ""), "tasks");
  const configFile = configFileFor(dataDir);
  const configJson = await readConfigJson(configFile);

  const raw = {};
  const sources = {};
  for (const field of allFields()) {
    const resolved = resolveValue(field.env, configJson);
    raw[field.env] = resolved.raw;
    sources[field.env] = resolved.source;
  }

  const get = (envKey) => coerce(FIELD_BY_ENV.get(envKey), raw[envKey]);

  return {
    port: get("HARNESS_PORT"),
    pollIntervalMs: Math.max(30_000, get("HARNESS_POLL_INTERVAL_MS")),
    firstRun: get("HARNESS_FIRST_RUN") === "now" ? "now" : "backfill",
    dryRun: Boolean(get("HARNESS_DRY_RUN")),
    logLevel: get("HARNESS_LOG_LEVEL") || "info",
    workspaceHint: get("HARNESS_WORKSPACE_HINT"),

    ui: {
      password: get("HARNESS_UI_PASSWORD"),
    },

    dataDir,
    tasksDir,
    configFile,
    stateFile: path.join(dataDir, "state.json"),
    assetsDir: path.join(dataDir, "assets"),

    github: {
      token: get("GITHUB_TOKEN"),
      repo: get("GITHUB_REPO"),
      apiBase: get("GITHUB_API_BASE"),
      labels: get("GITHUB_LABELS"),
      commentsMax: get("GITHUB_COMMENTS_MAX"),
    },

    imap: {
      host: get("IMAP_HOST"),
      port: get("IMAP_PORT"),
      secure: Boolean(get("IMAP_SECURE")),
      user: get("IMAP_USER"),
      pass: get("IMAP_PASS"),
      mailbox: get("IMAP_MAILBOX"),
      subjectFilter: get("IMAP_SUBJECT_FILTER"),
      markSeen: Boolean(get("IMAP_MARK_SEEN")),
    },

    ai: {
      baseUrl: get("AI_BASE_URL"),
      apiKey: get("AI_API_KEY"),
      model: get("AI_MODEL"),
      timeoutMs: get("AI_TIMEOUT_MS"),
      maxCallsPerCycle: Math.max(1, get("AI_MAX_CALLS_PER_CYCLE")),
    },

    sources,
    raw,
  };
}

/**
 * 保存配置页提交的补丁。
 *   - 值为空字符串 / null → 删除该键的覆盖（回落到环境变量或默认值）
 *   - 未知键 → 报错
 *   - 类型非法 → 报错，且**整批不写入**（避免半套配置生效）
 */
export async function saveConfigPatch(cfg, patch) {
  const current = await readConfigJson(cfg.configFile);
  const next = { ...current };
  const errors = [];
  // 只记「本次补丁真正动过的键」—— 页面拿它显示「已保存 N 项」，
  // 若返回 config.json 的全部键，用户只改 1 项也会看到「已保存 4 项」。
  const touched = [];

  for (const [envKey, value] of Object.entries(patch ?? {})) {
    const field = FIELD_BY_ENV.get(envKey);
    if (!field) {
      errors.push(`未知配置项：${envKey}`);
      continue;
    }
    if (value === null || value === undefined || String(value).trim() === "") {
      delete next[envKey];
      touched.push(envKey);
      continue;
    }
    const error = validate(field, value);
    if (error) {
      errors.push(error);
      continue;
    }
    next[envKey] = String(value);
    touched.push(envKey);
  }

  if (errors.length) return { ok: false, errors };

  // 权限 600 从临时文件起就生效 —— 避免 rename 之前有一段「密钥可被其他用户读到」的窗口。
  await writeJsonAtomic(cfg.configFile, next, { mode: 0o600 });
  try {
    fs.chmodSync(cfg.configFile, 0o600);
  } catch {
    /* 非属主时忽略 */
  }
  return { ok: true, keys: touched, totalKeys: Object.keys(next) };
}

/**
 * 生成给配置页的数据结构。
 * **密钥永不回传浏览器**：只给 `{ isSet, masked }`，编辑即整体覆盖。
 */
export function buildConfigView(cfg) {
  const groups = CONFIG_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    description: group.description,
    fields: group.fields.map((field) => {
      const source = cfg.sources?.[field.env] ?? "default";
      const rawValue = cfg.raw?.[field.env] ?? "";
      const base = {
        env: field.env,
        label: field.label,
        type: field.type,
        hint: field.hint ?? "",
        needsRestart: Boolean(field.needsRestart),
        options: field.options ?? [],
        min: field.min,
        max: field.max,
        source,
        overridden: source === "config",
      };
      if (field.type === "password") {
        return { ...base, isSet: rawValue !== "", masked: maskSecret(rawValue), value: "" };
      }
      return { ...base, value: rawValue };
    }),
  }));

  return { groups, configFile: cfg.configFile };
}

/** 打印配置摘要（脱敏），用于启动日志与部署排错。 */
export function describeConfig(cfg) {
  const mask = (v) => (v ? `***${String(v).slice(-4)}` : "(未配置)");
  return [
    `运行时: port=${cfg.port} poll=${cfg.pollIntervalMs}ms firstRun=${cfg.firstRun} dryRun=${cfg.dryRun}`,
    `访问控制: ${cfg.ui?.password ? "已启用（需登录）" : "未启用（不需要登录）"}`,
    `目录: data=${cfg.dataDir} tasks=${cfg.tasksDir}`,
    `GitHub: repo=${cfg.github.repo} token=${mask(cfg.github.token)} labels=${cfg.github.labels.join("|") || "(全部)"}`,
    `IMAP: host=${cfg.imap.host || "(未配置)"} user=${cfg.imap.user || "(未配置)"} filter=${cfg.imap.subjectFilter.join("|") || "(全部)"} markSeen=${cfg.imap.markSeen}`,
    `模型: base=${cfg.ai.baseUrl || "(未配置)"} model=${cfg.ai.model || "(未配置)"} key=${mask(cfg.ai.apiKey)}`,
  ].join("\n  ");
}
