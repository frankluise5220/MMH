#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const failures = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function read(file) {
  if (!fs.existsSync(file)) {
    failures.push(`Missing ${path.relative(root, file)}`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

const buildScript = read(path.join(root, "scripts", "build-fnos-native-package.cjs"));
const appBuildScript = read(path.join(root, "scripts", "build-fnos-native-app.cjs"));
const schemaScript = read(path.join(root, "scripts", "generate-native-sqlite-schema.cjs"));
const prismaConfig = read(path.join(root, "prisma.config.ts"));
const dbClient = read(path.join(root, "src", "lib", "db", "prisma.ts"));
const nativeSchema = path.join(root, "prisma", "schema.native.prisma");
const stageDir = path.join(root, "release-artifacts", "fnos-native", "mmh-native-fpk");
const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");

expect(/provider = "sqlite"/.test(schemaScript), "Native schema generator must switch datasource provider to sqlite.");
expect(/@db\\\./.test(schemaScript), "Native schema generator must strip PostgreSQL native column annotations.");
expect(/PRISMA_SCHEMA_PATH/.test(prismaConfig), "Prisma config must allow selecting the native schema.");
expect(/PrismaBetterSqlite3/.test(dbClient), "Database client must support the SQLite adapter.");
expect(/connectionString\.startsWith\("file:"\)/.test(dbClient), "Database client must route file: URLs to SQLite.");
expect(/FNOS_NATIVE_NODE_TARBALL/.test(buildScript), "Native FPK build must require an explicit Linux Node runtime input.");
expect(/process\.platform === "linux"/.test(buildScript), "Native FPK release builds must be guarded to Linux/fnOS.");
expect(/DATABASE_URL="file:\$DATA_DEST\/mmh\.db"/.test(buildScript), "Native start script must store SQLite data in the fnOS data directory.");
expect(/schema\.native\.prisma/.test(appBuildScript), "Native app build must generate and build against the native schema.");
expect(!/docker-project/.test(buildScript), "Native FPK build must not declare Docker resources.");
expect(/better-sqlite3/.test(buildScript), "Native FPK build must explicitly include the SQLite native runtime dependency.");

if (fs.existsSync(stageDir)) {
  for (const envFile of [".env", ".env.local", ".env.production", ".env.development"]) {
    expect(!fs.existsSync(path.join(stageDir, "app", "server", envFile)), `Native stage must not include ${envFile}.`);
  }
}

if (fs.existsSync(nativeSchema)) {
  const validate = spawnSync(process.execPath, [prismaCli, "validate", "--schema", nativeSchema], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  expect(validate.status === 0, `Native Prisma schema should validate.\n${validate.stderr || validate.stdout || validate.error?.message}`);
}

if (failures.length > 0) {
  console.error("FNOS native package verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("FNOS native package verification passed.");
