/**
 * 极简分级日志。输出到 stdout（容器日志由 docker 收集），
 * 同时维护一个内存环形缓冲，供配置页的「运维」页签展示最近日志。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel = LEVELS.info;

const RING_SIZE = 500;
const ring = [];

export function setLogLevel(name) {
  const next = LEVELS[String(name || "").toLowerCase()];
  if (next) currentLevel = next;
}

function emit(level, args) {
  if (LEVELS[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const message = args
    .map((a) => {
      if (a instanceof Error) return a.stack ?? a.message;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");

  ring.push({ ts, level, message });
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

  const line = `${ts} [${level.toUpperCase().padEnd(5)}]`;
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  sink(line, ...args);
}

export const log = {
  debug: (...a) => emit("debug", a),
  info: (...a) => emit("info", a),
  warn: (...a) => emit("warn", a),
  error: (...a) => emit("error", a),
};

/** 取最近 n 条日志（新的在后）。 */
export function recentLogs(n = 200) {
  const count = Math.max(1, Math.min(RING_SIZE, Number(n) || 200));
  return ring.slice(-count);
}
