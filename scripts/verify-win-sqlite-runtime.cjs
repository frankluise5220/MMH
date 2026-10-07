#!/usr/bin/env node

// Windows 桌面端 SQLite 升级路径的行为验证：
// 从 scripts/build-win-desktop.cjs 里取出生成的 init-sqlite.cjs，在一份「旧桌面库」
// （没有 LoanCategory 表、Account 没有 loanCategoryId、AccessKey 没有 scope）上真实执行，
// 断言列补齐、四个内置类别播种、存量贷款映射与幂等。
//
// better-sqlite3 是原生模块，必须用与它编译时一致的 Node（仓库里通常是 Node 20/22）。
// ABI 不匹配时本脚本直接跳过（退出 0），静态断言由 verify-win-desktop.cjs 兜住。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

let Database;
try {
  Database = require("better-sqlite3");
  // 原生模块的 ABI 错误是懒抛出的：require 会成功，第一次 new Database 才失败。
  new Database(":memory:").close();
} catch (error) {
  if (error && error.code === "ERR_DLOPEN_FAILED") {
    console.log("Windows SQLite runtime check skipped: better-sqlite3 ABI mismatch (" + process.version + ").");
    process.exit(0);
  }
  throw error;
}

const root = path.resolve(__dirname, "..");
const buildScript = fs.readFileSync(path.join(root, "scripts", "build-win-desktop.cjs"), "utf8");
const marker = 'path.join(stageAppDir, "scripts", "init-sqlite.cjs"),';
const markerIndex = buildScript.indexOf(marker);
const start = buildScript.indexOf("`", markerIndex + marker.length);
const end = buildScript.indexOf('`,\n  "utf8",', start);
if (markerIndex < 0 || start < 0 || end < 0) {
  console.error("Windows SQLite runtime check failed: init-sqlite template not found in build-win-desktop.cjs");
  process.exit(1);
}
// 与构建脚本同源：模板字面量按同样方式求值，避免校验的是另一份代码。
const generated = new Function("return `" + buildScript.slice(start + 1, end) + "`")();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmh-win-sqlite-"));
const appDir = path.join(tmp, "app");
const dataDir = path.join(tmp, "data");
fs.mkdirSync(path.join(appDir, "scripts"), { recursive: true });
fs.mkdirSync(path.join(appDir, "prisma"), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(appDir, "scripts", "init-sqlite.cjs"), generated, "utf8");

// 全新安装结构（新版）：存量库分支只用它来建缺失的表。
fs.writeFileSync(
  path.join(appDir, "prisma", "native-init.sql"),
  [
    'CREATE TABLE "Household" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL);',
    'CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY, "householdId" TEXT NOT NULL, "kind" TEXT NOT NULL, "loanType" TEXT, "isConsumerLoan" BOOLEAN NOT NULL DEFAULT false, "loanCategoryId" TEXT);',
    'CREATE TABLE "LoanCategory" ("id" TEXT NOT NULL PRIMARY KEY, "householdId" TEXT NOT NULL, "name" TEXT NOT NULL, "baseType" TEXT NOT NULL, "sortOrder" INTEGER NOT NULL DEFAULT 0, "isSystem" BOOLEAN NOT NULL DEFAULT false, "isActive" BOOLEAN NOT NULL DEFAULT true, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);',
    'CREATE TABLE "AccessKey" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "key" TEXT NOT NULL, "scope" TEXT NOT NULL DEFAULT \'write\');',
  ].join("\n"),
  "utf8",
);

// 旧库：缺 LoanCategory 表、缺 Account.loanCategoryId、缺 AccessKey.scope。
const legacy = new Database(path.join(dataDir, "mmh.db"));
legacy.exec('CREATE TABLE "Household" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL)');
legacy.exec('CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY, "householdId" TEXT NOT NULL, "kind" TEXT NOT NULL, "loanType" TEXT, "isConsumerLoan" BOOLEAN NOT NULL DEFAULT false)');
legacy.exec('CREATE TABLE "AccessKey" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "key" TEXT NOT NULL)');
legacy.exec('CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "householdId" TEXT, "fnosUid" TEXT)');
legacy.exec('CREATE TABLE "UserSettings" ("id" TEXT NOT NULL PRIMARY KEY)');
legacy.prepare('INSERT INTO "Household" ("id","name") VALUES (?,?)').run("hh1", "旧账簿");
legacy.prepare('INSERT INTO "Account" ("id","householdId","kind","loanType","isConsumerLoan") VALUES (?,?,?,?,?)').run("acc_home", "hh1", "loan", "home", 0);
legacy.prepare('INSERT INTO "Account" ("id","householdId","kind","loanType","isConsumerLoan") VALUES (?,?,?,?,?)').run("acc_consumer", "hh1", "loan", "consumer", 1);
legacy.prepare('INSERT INTO "Account" ("id","householdId","kind","loanType","isConsumerLoan") VALUES (?,?,?,?,?)').run("acc_bank", "hh1", "bank", null, 0);
legacy.prepare('INSERT INTO "AccessKey" ("id","name","key") VALUES (?,?,?)').run("k1", "old", "secret");
legacy.close();

const failures = [];
function expect(condition, message) {
  if (!condition) failures.push(message);
}

const nodeModules = path.join(root, "node_modules");
const runInit = () =>
  execFileSync(process.execPath, [path.join(appDir, "scripts", "init-sqlite.cjs")], {
    env: { ...process.env, MMH_DATA_DIR: dataDir, NODE_PATH: nodeModules },
    stdio: "ignore",
  });

runInit();

const db = new Database(path.join(dataDir, "mmh.db"));
const columnsOf = (table) => db.prepare('PRAGMA table_info("' + table + '")').all().map((row) => row.name);

expect(columnsOf("Account").includes("loanCategoryId"), "Account.loanCategoryId must be backfilled on upgraded databases.");
expect(columnsOf("AccessKey").includes("scope"), "AccessKey.scope must be backfilled on upgraded databases.");

const categories = db.prepare('SELECT "id","baseType","name","isSystem" FROM "LoanCategory" ORDER BY "baseType"').all();
expect(categories.length === 4, "Built-in loan categories must be seeded exactly once (got " + categories.length + ").");
expect(
  categories.every((row) => row.id === "lc_hh1_" + row.baseType && row.isSystem === 1),
  "Built-in loan categories must use deterministic lc_<householdId>_<baseType> ids and isSystem = 1.",
);

const categoryOf = (id) => db.prepare('SELECT "loanCategoryId" FROM "Account" WHERE "id" = ?').get(id).loanCategoryId;
expect(categoryOf("acc_home") === "lc_hh1_home", "Existing home-loan accounts must map to lc_hh1_home.");
expect(categoryOf("acc_consumer") === "lc_hh1_consumer", "Existing consumer-loan accounts must map to lc_hh1_consumer.");
expect(categoryOf("acc_bank") === null, "Non-loan accounts must not be assigned a loan category.");
expect(
  db.prepare('SELECT "scope" FROM "AccessKey" WHERE "id" = ?').get("k1").scope === "write",
  "Access keys created before scope existed must keep write access.",
);

runInit();
expect(
  db.prepare('SELECT COUNT(*) AS n FROM "LoanCategory"').get().n === 4,
  "Re-running the init script must stay idempotent (still 4 categories).",
);
db.close();
fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length > 0) {
  console.error("Windows SQLite runtime check failed:");
  for (const failure of failures) console.error(" - " + failure);
  process.exit(1);
}

console.log("Windows SQLite runtime check passed.");
