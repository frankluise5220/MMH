#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { describePathAliases, resolvePathAlias } = require("./codex-path-aliases.cjs");

function printHelp() {
  console.error(`Usage:
  node scripts/codex-git.cjs <git-args...>

PowerShell-safe Git wrapper for Codex/debug sessions.
It forwards arguments to git with shell:false and expands path aliases before
Git receives them.

Path aliases:
${describePathAliases()}

Examples:
  npm run codex:git -- diff -- sidebar/page.tsx
  npm run codex:git -- diff --stat -- sidebar/settings/email/page.tsx
  npm run codex:git -- add -- sidebar/page.tsx
`);
}

const rawArgs = process.argv.slice(2);

if (rawArgs.length === 0 || rawArgs.includes("--help") || rawArgs.includes("-h")) {
  printHelp();
  process.exit(rawArgs.length === 0 ? 2 : 0);
}

const gitArgs = rawArgs.map(resolvePathAlias);
const result = spawnSync("git", gitArgs, { stdio: "inherit", shell: false });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
