#!/usr/bin/env node

const path = require("node:path");

require("dotenv/config");

const { PrismaClient, Prisma } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

function printHelp() {
  console.error(`Usage:
  node scripts/codex-prisma-run.cjs <query-file.cjs> [args...]

The query file must export an async function:
  module.exports = async ({ prisma, Prisma, args }) => {
    const rows = await prisma.account.findMany({ take: 5 });
    console.log(JSON.stringify(rows, null, 2));
  };

Use this instead of long node -e commands in PowerShell. Put temporary query
files under ignored names such as _tmp_query.cjs or .tmp-query.cjs.
`);
}

async function main() {
  const [queryFile, ...args] = process.argv.slice(2);
  if (!queryFile || queryFile === "--help" || queryFile === "-h") {
    printHelp();
    process.exit(queryFile ? 0 : 2);
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const queryPath = path.resolve(process.cwd(), queryFile);
  const runQuery = require(queryPath);
  if (typeof runQuery !== "function") {
    throw new Error(`${queryFile} must export a function`);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: ["error"] });

  try {
    await runQuery({ prisma, Prisma, args });
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
