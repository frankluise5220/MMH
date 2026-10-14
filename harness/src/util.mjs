/**
 * 通用工具：目录/文件读写、时间、字符串、YAML 安全输出。
 * 刻意不引入第三方依赖，保证在群晖容器里零编译、零 native 依赖。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * 尽力设置权限。任务交接目录必须是「第三方 harness 能以任意身份操作」的，
 * 所以显式放开；chmod 失败（如非属主）不致命，只记不抛。
 */
export function chmodBestEffort(target, mode) {
  try {
    fs.chmodSync(target, mode);
    return true;
  } catch {
    return false;
  }
}

export async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file, fallback = null) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 原子写：先写临时文件再 rename，避免容器被杀时留下半截 JSON。 */
export async function writeJsonAtomic(file, value, options = {}) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const writeOptions = options.mode ? { mode: options.mode } : undefined;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, writeOptions);
  await fsp.rename(tmp, file);
}

export async function writeFileAtomic(file, content) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, file);
}

export async function writeBinaryAtomic(file, buffer) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, file);
}

/** 文件名安全化：仅保留 [A-Za-z0-9._-]，其余折叠为 '-'。 */
export function slug(value, maxLength = 60) {
  const cleaned = String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (cleaned || "item").slice(0, maxLength);
}

/** YAML 标量安全输出：需要时加双引号并转义。 */
export function yamlScalar(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (text === "") return '""';
  if (/^[A-Za-z0-9_./@:+ -]+$/.test(text) && !/^[-?]/.test(text) && !/[:#]\s/.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

/** 输出 YAML 列表（每项一行，'- ' 前缀），用于 front-matter。 */
export function yamlList(values, indent = 0) {
  const pad = " ".repeat(indent);
  if (!values || values.length === 0) return `${pad}[]`;
  return values
    .map((v) => `${pad}- ${yamlScalar(v)}`)
    .join("\n");
}

/**
 * 从模型回复里抠出 JSON。容忍 ```json 围栏与前后解释文字。
 * 解析失败返回 null，由调用方走兜底。
 */
export function extractJson(text) {
  if (!text) return null;
  let raw = String(text).trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  try {
    return JSON.parse(raw);
  } catch {
    // 退一步：截取第一个 { 到最后一个 }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function truncate(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（已截断，原长 ${s.length} 字符）`;
}

export function toArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (value === null || value === undefined || value === "") return [];
  return [String(value)];
}

export function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}
