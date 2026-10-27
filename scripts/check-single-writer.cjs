/**
 * Dev-only guard: one state, many writers.
 *
 * 明细分页那轮重构暴露的问题是通用的：某个状态（分页、筛选、AI 模型、侧栏折叠）
 * 在好几个地方各自写一份，读代码的人以为只有一个写入口，实际有 3~5 个，漂移后
 * 谁都不知道该信哪个。这里把「写入点」按 key 聚合起来看：
 *
 *   storage  localStorage / sessionStorage.setItem(k, ...)
 *   cookie   document.cookie = `k=...` / persist("k", ...) / setCookieValue(K, ...)
 *   url      x.searchParams.set("k", ...) / params.set("k", ...)
 *
 * 判定（不追求零误报，只保证每条都有行号可人工复核）：
 *   - 同一个 key 出现在 >= 2 个文件里写  -> 高置信：跨文件双写
 *   - 同一个 key 在同一个文件里 >= 2 处写 -> 候选：可能是封装 + 调用点
 *
 * 用法：node scripts/check-single-writer.cjs [--strict]
 *   --strict 时只要存在跨文件双写就退出码 1（给 CI / pre-commit 用）。
 */
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const ROOT = path.join(PROJECT_ROOT, "src");
const STRICT = process.argv.includes("--strict");
const WITH_STATE = process.argv.includes("--state");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT);
const rel = (file) => path.relative(PROJECT_ROOT, file).replace(/\\/g, "/");

/**
 * 常量表：NAME -> 字面量。同名但不同值的一律丢掉（宁可少解析，不可认错 key）。
 */
const constTable = new Map();
const conflicted = new Set();
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const re = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(["'`])([^"'`$\n]*)\2/g;
  for (const m of text.matchAll(re)) {
    if (constTable.has(m[1]) && constTable.get(m[1]) !== m[3]) conflicted.add(m[1]);
    else constTable.set(m[1], m[3]);
  }
}
for (const name of conflicted) constTable.delete(name);

function resolveKey(expr) {
  const t = expr.trim();
  let m = /^(["'])([^"']*)\1$/.exec(t);
  if (m) return m[2];
  m = /^`([^`$]*)`$/.exec(t);
  if (m) return m[1];
  m = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.exec(t);
  if (m) {
    const name = t.split(".").pop();
    if (constTable.has(name)) return constTable.get(name);
    // 解析不到的常量用 ⟨名字⟩ 兜底：同一常量名在多处写，仍然算同一个 key。
    // 小写标识符是 `query.set(key, value)` 这种转发，没有固定 key，跳过。
    return /^[A-Z][A-Z0-9_]*$/.test(name) ? `\u27e8${name}\u27e9` : null;
  }
  m = /^`([A-Za-z0-9_.\-]+)=/.exec(t);
  if (m) return m[1];
  return null;
}

function cookieNameFrom(rhs) {
  const t = rhs.trim();
  let m = /^`([A-Za-z0-9_.\-]+)=/.exec(t);
  if (m) return m[1];
  m = /^(["'])([A-Za-z0-9_.\-]+)=/.exec(t);
  if (m) return m[2];
  return null;
}

const writers = new Map();

function add(kind, key, file, line, text) {
  if (!key) return;
  const id = `${kind}\u0000${key}`;
  if (!writers.has(id)) writers.set(id, { kind, key, hits: [] });
  writers.get(id).hits.push({ file: rel(file), line, text: text.trim().slice(0, 150) });
}

const PATTERNS = [
  { kind: "storage", re: /(?:window\.)?(?:localStorage|sessionStorage)\.setItem\(\s*([^,]+),/ },
  { kind: "cookie", re: /\bpersist\(\s*(["'][^"']+["'])\s*,/ },
  { kind: "cookie", re: /\bsetCookieValue\(\s*([A-Za-z_$][\w$]*)\s*,/ },
  { kind: "url", re: /\b\w*(?:searchParams|params|query)\.set\(\s*([^,]+),/ },
];
const COOKIE_ASSIGN = /document\.cookie\s*=\s*(.+)$/;

for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const lineNo = index + 1;
    for (const { kind, re } of PATTERNS) {
      const m = re.exec(line);
      if (m) add(kind, resolveKey(m[1]), file, lineNo, line);
    }
    const assign = COOKIE_ASSIGN.exec(line);
    if (assign) add("cookie", cookieNameFrom(assign[1]), file, lineNo, line);
  });
}

const groups = [...writers.values()]
  .filter((g) => g.hits.length >= 2)
  .map((g) => ({ ...g, fileCount: new Set(g.hits.map((h) => h.file)).size }))
  .sort((a, b) => b.fileCount - a.fileCount || b.hits.length - a.hits.length);

/**
 * URL 参数天然按页面作用域：reports 的 `view` 和 funds 的 `view` 不是同一个状态，
 * 跨文件同名不代表双写。所以 URL 只报「同一个文件里写多次」（那才是同一个状态被
 * 好几条代码路径改），storage / cookie 才是真正的跨文件全局 key。
 */
const crossFile = groups.filter((g) => g.kind !== "url" && g.fileCount >= 2);

/**
 * 有意双写的白名单。
 *
 * 只收「cookie 不是数据库镜像」的纯设备状态：数据库里没有对应列（AGENTS.md 允许
 * 这类设置留在本地），cookie 只在用户操作时由 appPreferences 写一次；根 layout 的
 * 内联脚本负责 cookie 被清 / 过期后从 localStorage 补回来，是这条路径唯一的恢复手段。
 *
 * 带 DB 镜像的 key（sidebar_group_by 等）不许放进来：它们每次加载都会被
 * PreferencesSync 用数据库值覆盖，内联脚本再补一遍是纯多余的写入。
 */
const ALLOWED_CROSS_FILE = new Set([
  "sidebar_collapsed",
  "sidebar_owner_filter",
  "mmh_ai_panel_collapsed",
]);

const unallowedCrossFile = crossFile.filter((group) => !ALLOWED_CROSS_FILE.has(group.key));
const sameFile = groups.filter((g) =>
  g.kind === "url" ? g.hits.length >= 2 && g.fileCount === 1 : g.fileCount === 1,
);

function printGroup(group) {
  const where = group.kind === "url" ? "URL 参数" : group.kind === "cookie" ? "cookie" : "storage";
  console.log(`  ${where}  ${group.key}  (${group.fileCount} 文件 / ${group.hits.length} 处)`);
  for (const hit of group.hits.slice(0, 5)) {
    console.log(`    ${hit.file}:${hit.line}`);
    console.log(`      ${hit.text}`);
  }
  if (group.hits.length > 5) console.log(`    …另外 ${group.hits.length - 5} 处`);
}

console.log(`single-writer guard: 扫描 ${files.length} 个文件`);

if (crossFile.length) {
  console.log(`\n跨文件同 key 写入（高置信，${crossFile.length} 组）`);
  crossFile.forEach(printGroup);
} else {
  console.log("\n跨文件同 key 写入：无");
}

if (sameFile.length) {
  console.log(`\n同文件多写（候选，${sameFile.length} 组）`);
  sameFile.forEach(printGroup);
}

console.log(
  `\n合计：跨文件 ${crossFile.length} 组（白名单 ${crossFile.length - unallowedCrossFile.length} 组），同文件 ${sameFile.length} 组`,
);

/**
 * React state 层：`useState` 的 setter 被调用几次。
 *
 * 这条没法自动定性 —— 一个 setter 被 5 个不同回调调用，可能本来就是 5 个独立的
 * 交互，也可能是同一个状态散在 5 条路径上。所以默认不跑，`--state` 才输出，只
 * 用来拉一份「值得看一眼」的名单。
 */
if (WITH_STATE) {
  const rows = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    for (const decl of text.matchAll(
      /const\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*useState\s*[<(]/g,
    )) {
      const setter = decl[2];
      const callRe = new RegExp(`\\b${setter}\\(`);
      const hits = [];
      lines.forEach((line, index) => {
        if (callRe.test(line)) {
          hits.push({ file: rel(file), line: index + 1, text: line.trim().slice(0, 150) });
        }
      });
      if (hits.length >= 4) rows.push({ state: decl[1], setter, hits });
    }
  }
  rows.sort((a, b) => b.hits.length - a.hits.length);
  // 通用 UI 状态（错误提示、loading、开关）天生到处 set，排除后名单才有人看。
  const UI_NOISE = /^(error|err|message|msg|loading|busy|open|visible|saving|submitting|saved|success|notice|hint|debug|preview|active|hover|focus|is\w+|has\w+|show\w+)$/;
  const filtered = rows.filter((row) => !UI_NOISE.test(row.state));
  console.log(
    `\nuseState setter 多处调用（候选，Top ${Math.min(filtered.length, 12)} / ${filtered.length}）`,
  );
  for (const row of filtered.slice(0, 12)) {
    console.log(`  ${row.state}  (${row.hits.length} 处 setter 调用)`);
    for (const hit of row.hits.slice(0, 6)) console.log(`    ${hit.file}:${hit.line}`);
    if (row.hits.length > 6) console.log(`    …另外 ${row.hits.length - 6} 处`);
  }
}

if (STRICT && unallowedCrossFile.length) {
  console.log(`\n--strict：${unallowedCrossFile.length} 组跨文件双写未列入白名单`);
  process.exit(1);
}
