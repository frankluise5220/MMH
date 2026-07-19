#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

function printHelp() {
  console.error(`Usage:
  node scripts/codex-rg.cjs [--regex] [--ignore-case] <pattern> [path...]

PowerShell-safe ripgrep wrapper for Codex/debug sessions.
Default search is fixed-string, so patterns like type === "income" do not need
regex escaping. Always pass paths as separate arguments.
`);
}

const rawArgs = process.argv.slice(2);
let regex = false;
let ignoreCase = false;
const positional = [];

for (const arg of rawArgs) {
  if (arg === "--help" || arg === "-h") {
    printHelp();
    process.exit(0);
  }
  if (arg === "--regex") {
    regex = true;
    continue;
  }
  if (arg === "--ignore-case" || arg === "-i") {
    ignoreCase = true;
    continue;
  }
  positional.push(arg);
}

if (positional.length === 0) {
  printHelp();
  process.exit(2);
}

const [pattern, ...paths] = positional;
const rgArgs = ["-n"];
if (!regex) rgArgs.push("-F");
if (ignoreCase) rgArgs.push("-i");
rgArgs.push("-e", pattern);
if (paths.length > 0) rgArgs.push("--", ...paths);

const result = spawnSync("rg", rgArgs, { stdio: "inherit", shell: false });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
