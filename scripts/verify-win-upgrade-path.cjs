#!/usr/bin/env node
/**
 * Windows 桌面端升级路径校验（行为级，白名单之外）。
 *
 * 0.1.81 的事故模式：schema 新增了 `bond_transactions.instrumentKind`，但
 * `init-sqlite.cjs` 的 `applyRuntimeMigrations` 忘了回填。发行包已经上传，老用户覆盖
 * 安装后债券/逆回购页 `no such column`。当时的 `check:win` 全绿，因为静态断言只钉了
 * 手写白名单里那几列。
 *
 * 本脚本不再维护任何白名单：
 *   1. 用「上一个已发布版本」（package.json version 之下最高的 v* tag）的
 *      `prisma/schema.native.prisma` 生成一份真实的旧库结构并建库；
 *   2. 把当前 `scripts/build-win-desktop.cjs` 里生成的 init-sqlite.cjs 跑两次（幂等）；
 *   3. 按当前 schema 生成的完整结构 SQL 逐表逐列断言。
 *
 * 结果是「只要新列没回填，这个脚本必然失败」，不需要有人记得去登记断言。
 * 打包前还有一层同名硬门禁（scripts/build-win-desktop.cjs），漏列根本打不出安装包。
 *
 * 用法：
 *   node scripts/verify-win-upgrade-path.cjs [--base-tag v0.1.80] [--keep]
 *   环境变量 MMH_UPGRADE_BASE_TAG 可覆盖基线（CI 无 tag 时显式指定）。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// better-sqlite3 是原生模块，ABI 必须与当前 Node 一致。不匹配时本脚本跳过，
// 但 Windows 打包脚本里用的是 stage 自己的 better-sqlite3，那里是硬失败。
try {
  const Database = require(path.join(root, "node_modules", "better-sqlite3"));
  new Database(":memory:").close();
} catch (error) {
  if (error && error.code === "ERR_DLOPEN_FAILED") {
    console.log(
      "Windows upgrade path check skipped: better-sqlite3 ABI mismatch (" +
        process.version +
        "). The packaging step (scripts/build-win-desktop.cjs) still enforces it.",
    );
    process.exit(0);
  }
  throw error;
}

const lib = require("./lib/win-upgrade-sim.cjs");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const keep = process.argv.includes("--keep");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmh-win-upgrade-check-"));
const cleanup = () => {
  if (!keep) fs.rmSync(workDir, { recursive: true, force: true });
};

const failures = [];
const fail = (message) => failures.push(message);

try {
  // 1. 基线：严格小于当前版本号的最高 tag。
  const baseTag = lib.resolveBaseTag({ root, version: pkg.version, override: argValue("--base-tag") });
  if (!baseTag) {
    fail(
      `cannot resolve an upgrade baseline below ${pkg.version}: no matching git tag. ` +
        "Run `git fetch --tags`, or set MMH_UPGRADE_BASE_TAG / pass --base-tag.",
    );
    throw new Error("no baseline");
  }
  if (lib.versionParts(baseTag) === null) fail(`baseline tag "${baseTag}" is not a vX.Y.Z tag`);

  // 2. 当前全量结构（与打包时同一条 prisma migrate diff 命令）。
  const nativeInitPath = path.join(workDir, "native-init.sql");
  lib.generateStructureSql({
    root,
    schemaPath: path.join(root, "prisma", "schema.native.prisma"),
    outPath: nativeInitPath,
  });

  // 3. 当前 init-sqlite.cjs：与打包脚本同源求值，避免校验的是另一份代码。
  const buildScript = fs.readFileSync(path.join(root, "scripts", "build-win-desktop.cjs"), "utf8");
  const marker = 'path.join(stageAppDir, "scripts", "init-sqlite.cjs"),';
  const markerIndex = buildScript.indexOf(marker);
  const start = markerIndex < 0 ? -1 : buildScript.indexOf("`", markerIndex + marker.length);
  const end = start < 0 ? -1 : buildScript.indexOf('`,\n  "utf8",', start);
  if (start < 0 || end < 0) {
    fail("init-sqlite template not found in scripts/build-win-desktop.cjs");
    throw new Error("template missing");
  }
  const initScriptPath = path.join(workDir, "init-sqlite.cjs");
  fs.writeFileSync(initScriptPath, new Function("return `" + buildScript.slice(start + 1, end) + "`")(), "utf8");

  // 4. 真实升级 + 全列断言。
  const result = lib.simulateUpgrade({
    root,
    baseTag,
    initScriptPath,
    nativeInitPath,
    nodeModulesPath: path.join(root, "node_modules"),
    workDir: path.join(workDir, "sim"),
    keep,
  });

  console.log(
    `[upgrade] baseline ${result.baseTag} (${result.baseTableCount} tables) -> ` +
      `current ${pkg.version} (${result.expectedTableCount} tables / ${result.expectedColumnCount} columns)`,
  );

  if (result.missingTables.length > 0) {
    fail(
      `${result.missingTables.length} table(s) missing after upgrading a ${result.baseTag} database:\n` +
        result.missingTables.map((table) => `    ${table}`).join("\n"),
    );
  }
  if (result.missingColumns.length > 0) {
    fail(
      `${result.missingColumns.length} column(s) missing after upgrading a ${result.baseTag} database:\n` +
        result.missingColumns.map((column) => `    ${column}`).join("\n") +
        '\n  -> add addColumnIfMissing(db, "<table>", "<column>", "<definition>") to applyRuntimeMigrations\n' +
        "     in scripts/build-win-desktop.cjs (native-init.sql only creates missing tables).",
    );
  }
} catch (error) {
  if (!failures.length && error && error.message) fail(error.message);
} finally {
  cleanup();
}

if (failures.length > 0) {
  console.error("Windows upgrade path check failed:");
  for (const failure of failures) console.error(" - " + failure);
  process.exit(1);
}

console.log("Windows upgrade path check passed.");
