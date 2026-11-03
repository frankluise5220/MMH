#!/usr/bin/env node
/**
 * Windows 桌面端「存量库升级」的共享实现。
 *
 * 桌面版不走 `prisma migrate deploy`：全新安装整份执行 `prisma/native-init.sql`，
 * 存量库只按它「建缺失的表」，再跑 `init-sqlite.cjs` 里手写的列回填
 * （`applyRuntimeMigrations`）。所以任何新列只要忘了写进那段模板，老用户升级后就是
 * `no such column`，生产构建下表现为 "Server Components render" 通用报错。
 * 0.1.81 就是这样漏掉了 `bond_transactions.instrumentKind`：包在 13:33 打好并发布，
 * 补列的提交 14:57 才进仓库。
 *
 * 本模块提供唯一一套「上一个发布版本的真实结构 → 当前 init 脚本 → 全列断言」的实现，
 * 由两处共用，避免逻辑各自漂移：
 *   - scripts/verify-win-upgrade-path.cjs（`npm run check:win`）
 *   - scripts/build-win-desktop.cjs（打包前的硬门禁：漏列直接打不出包）
 *
 * 断言不是白名单：期望集合由当前 `prisma/schema.native.prisma` 生成的完整结构 SQL 解析，
 * 因此任何新表/新列都自动纳入检查，不需要有人记得登记。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

// 结构解析的自我保护阈值。prisma 的输出格式一旦变化，解析结果会变小甚至为空，
// 而「期望集合小」会让下面的断言变成空转（全部通过）。宁可显式失败。
const MIN_EXPECTED_TABLES = 50;
const MIN_EXPECTED_COLUMNS = 800;
const MIN_BASE_TABLES = 40;

/** prisma CLI 是 JS 入口，用当前 Node 直接跑，避免 shell/编码问题。 */
function prismaCliPath(root) {
  return path.join(root, "node_modules", "prisma", "build", "index.js");
}

/** `migrate diff --output` 在 Windows 上更认正斜杠路径。 */
function toArgvPath(value) {
  return String(value).replace(/\\/g, "/");
}

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] || 0;
    const b = right[index] || 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function listReleaseTags(root) {
  try {
    const stdout = execFileSync("git", ["tag", "--list", "v*"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 22,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 升级基线 = 版本号严格小于当前 package.json version 的最高 tag。
 *
 * 当前版本已发布（tag 与 version 相等）时仍然取上一个版本：0.1.81 修好重发也要验证
 * `0.1.80 → 0.1.81` 这条路径，否则「已发版后补的漏列」永远测不到。
 */
function resolveBaseTag({ root, version, override }) {
  const explicit = override || process.env.MMH_UPGRADE_BASE_TAG;
  if (explicit && String(explicit).trim()) return String(explicit).trim();

  const current = versionParts(version);
  if (!current) throw new Error(`cannot parse package.json version "${version}" as x.y.z`);

  let best = null;
  for (const tag of listReleaseTags(root)) {
    const parts = versionParts(tag);
    if (!parts) continue;
    if (compareVersions(parts, current) >= 0) continue;
    if (!best || compareVersions(parts, versionParts(best)) > 0) best = tag;
  }
  return best;
}

/** 取某个 git 版本里的文件内容（Buffer，避免编码/BOM 被 PowerShell 改写）。 */
function readGitFile(root, ref, filePath) {
  return execFileSync("git", ["show", `${ref}:${filePath}`], {
    cwd: root,
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 用 prisma migrate diff 把一份 schema 变成「空库 → 该 schema」的完整 SQLite 结构 SQL。 */
function generateStructureSql({ root, schemaPath, outPath }) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      prismaCliPath(root),
      "migrate",
      "diff",
      "--from-empty",
      "--to-schema",
      toArgvPath(schemaPath),
      "--script",
      "--output",
      toArgvPath(outPath),
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(
      `prisma migrate diff failed for ${schemaPath}:\n${result.stderr || result.stdout || ""}`.trim(),
    );
  }
  if (!fs.existsSync(outPath)) throw new Error(`prisma migrate diff produced no file at ${outPath}`);
  return outPath;
}

/**
 * 从结构 SQL 里解析 table -> Set<column>。
 *
 * 只认 prisma 生成的固定形态（`CREATE TABLE "X" (` + 四空格缩进的 `"col" TYPE ...` + `);`），
 * 表级约束行不以引号开头，天然被排除。名字里的引号按 SQLite 习惯双写，这里还原成单写。
 */
function parseCreateTables(sql) {
  const tables = new Map();
  let current = null;
  for (const line of sql.split(/\r?\n/)) {
    const open = /^CREATE TABLE (?:IF NOT EXISTS )?"((?:[^"]|"")+)"\s*\($/.exec(line);
    if (open) {
      current = new Set();
      tables.set(open[1].replace(/""/g, '"'), current);
      continue;
    }
    if (!current) continue;
    if (/^\);\s*$/.test(line) || /^\)\s*$/.test(line)) {
      current = null;
      continue;
    }
    const column = /^\s+"((?:[^"]|"")+)"\s+/.exec(line);
    if (column) current.add(column[1].replace(/""/g, '"'));
  }
  return tables;
}

function readSqlFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function tableColumns(db, table) {
  return db
    .prepare('PRAGMA table_info("' + table.replace(/"/g, '""') + '")')
    .all()
    .map((row) => row.name);
}

function tableExists(db, table) {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

/**
 * 真实跑一遍升级：老库结构 → 当前 init-sqlite.cjs → 全列断言。
 *
 * @param {object} options
 * @param {string} options.root 仓库根
 * @param {string} options.baseTag 基线 tag，例如 v0.1.80
 * @param {string} options.initScriptPath 当前 init-sqlite.cjs 的绝对路径
 * @param {string} options.nativeInitPath 当前全量结构 SQL（native-init.sql）的绝对路径
 * @param {string} [options.nodeModulesPath] 提供 better-sqlite3 的 node_modules
 * @param {string} [options.workDir] 复用的临时目录，缺省自建
 * @param {boolean} [options.keep] 保留临时目录便于排查
 * @returns {{baseTag: string, baseTableCount: number, expectedTableCount: number,
 *   expectedColumnCount: number, missingTables: string[], missingColumns: string[],
 *   workDir: string, cleaned: boolean}}
 */
function simulateUpgrade(options) {
  const {
    root,
    baseTag,
    initScriptPath,
    nativeInitPath,
    nodeModulesPath = path.join(root, "node_modules"),
  } = options;
  const Database = require(path.join(nodeModulesPath, "better-sqlite3"));

  if (!baseTag) throw new Error("simulateUpgrade requires a baseTag");
  if (!fs.existsSync(initScriptPath)) throw new Error(`init script not found: ${initScriptPath}`);
  if (!fs.existsSync(nativeInitPath)) throw new Error(`native-init.sql not found: ${nativeInitPath}`);

  const workDir = options.workDir || fs.mkdtempSync(path.join(os.tmpdir(), "mmh-win-upgrade-"));
  const dataDir = path.join(workDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  // 1. 上一个发布版本的真实结构：tag 里的 schema.native.prisma -> 空库结构 SQL。
  const baseSchemaPath = path.join(workDir, "base-schema.prisma");
  const baseSqlPath = path.join(workDir, "base-structure.sql");
  const baseSchema = readGitFile(root, baseTag, "prisma/schema.native.prisma");
  fs.writeFileSync(baseSchemaPath, baseSchema);
  generateStructureSql({ root, schemaPath: baseSchemaPath, outPath: baseSqlPath });
  const baseStructureSql = readSqlFile(baseSqlPath);
  const baseTables = parseCreateTables(baseStructureSql);
  if (baseTables.size < MIN_BASE_TABLES) {
    throw new Error(
      `parsed baseline structure for ${baseTag} looks too small (${baseTables.size} tables); ` +
        "prisma migrate diff output format probably changed",
    );
  }

  // 2. 用老结构建出真实的旧库。
  const dbPath = path.join(dataDir, "mmh.db");
  const legacy = new Database(dbPath);
  try {
    legacy.exec(baseStructureSql);
  } finally {
    legacy.close();
  }

  // 3. 跑当前 init-sqlite.cjs。APP 布局与打包后一致：<app>/scripts/init-sqlite.cjs +
  //    <app>/prisma/native-init.sql，脚本按 __dirname/.. 定位结构文件。
  const appDir = path.join(workDir, "app");
  fs.mkdirSync(path.join(appDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(appDir, "prisma"), { recursive: true });
  const stagedInit = path.join(appDir, "scripts", "init-sqlite.cjs");
  const stagedNativeInit = path.join(appDir, "prisma", "native-init.sql");
  fs.copyFileSync(initScriptPath, stagedInit);
  fs.copyFileSync(nativeInitPath, stagedNativeInit);
  // init-sqlite.cjs 用 require("better-sqlite3")，靠 NODE_PATH 指回仓库。
  const runInit = () =>
    execFileSync(process.execPath, [stagedInit], {
      env: { ...process.env, MMH_DATA_DIR: dataDir, NODE_PATH: nodeModulesPath },
      stdio: "pipe",
      encoding: "utf8",
    });
  runInit();
  // 幂等：第二次启动必须同样成功（用户每次开 app 都会跑这一段）。
  runInit();

  // 4. 期望集合来自当前结构 SQL，不是白名单：新表新列自动纳入。
  const expectedTables = parseCreateTables(readSqlFile(stagedNativeInit));
  let expectedColumnCount = 0;
  for (const columns of expectedTables.values()) expectedColumnCount += columns.size;
  if (expectedTables.size < MIN_EXPECTED_TABLES || expectedColumnCount < MIN_EXPECTED_COLUMNS) {
    throw new Error(
      "parsed current structure looks too small (" +
        expectedTables.size +
        " tables / " +
        expectedColumnCount +
        " columns); prisma migrate diff output format probably changed",
    );
  }

  const missingTables = [];
  const missingColumns = [];
  const db = new Database(dbPath, { readonly: true });
  try {
    for (const [table, expectedColumns] of expectedTables) {
      if (!tableExists(db, table)) {
        missingTables.push(table);
        continue;
      }
      const actual = new Set(tableColumns(db, table));
      for (const column of expectedColumns) {
        if (!actual.has(column)) missingColumns.push(`${table}.${column}`);
      }
    }
  } finally {
    db.close();
  }

  const keep = Boolean(options.keep);
  if (!keep) fs.rmSync(workDir, { recursive: true, force: true });

  return {
    baseTag,
    baseTableCount: baseTables.size,
    expectedTableCount: expectedTables.size,
    expectedColumnCount,
    missingTables,
    missingColumns,
    workDir,
    cleaned: !keep,
  };
}

module.exports = {
  compareVersions,
  generateStructureSql,
  listReleaseTags,
  parseCreateTables,
  prismaCliPath,
  readGitFile,
  resolveBaseTag,
  simulateUpgrade,
  toArgvPath,
  versionParts,
};
