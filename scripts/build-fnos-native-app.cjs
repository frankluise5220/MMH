#!/usr/bin/env node

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const nativeSchema = path.join(root, "prisma", "schema.native.prisma");
const pgSchema = path.join(root, "prisma", "schema.prisma");

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      ...env,
    },
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

run(process.execPath, [path.join(root, "scripts", "generate-native-sqlite-schema.cjs")], {});
run("npx", ["prisma", "generate", "--schema", nativeSchema], {
  DATABASE_URL: "file:./native-build.db",
  PRISMA_SCHEMA_PATH: nativeSchema,
});
run("npm", ["run", "build"], {
  DATABASE_URL: "file:./native-build.db",
  PRISMA_SCHEMA_PATH: nativeSchema,
  MMH_DEPLOY_TARGET: "fnos-native",
});
run("npx", ["prisma", "generate", "--schema", pgSchema], {});
