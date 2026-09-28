#!/usr/bin/env node
/**
 * §8 migration-coverage audit (release gate).
 *
 * Catches the recurring failure mode that broke 0.1.60: a schema object exists in
 * prisma/schema.prisma and in the packaged Docker image (via db push) but is missing
 * from the fnOS/Synology embedded MIGRATIONS list — upgraded SQLite users crash on
 * missing columns/tables.
 *
 * What it checks:
 * 1. Every committed migration directory has a non-empty migration.sql (UTF-8, LF, no BOM).
 * 2. Every MIGRATIONS version registered in build-fnos-package.cjs exists in
 *    prisma/migrations (the shared stage feeds fnOS AND Synology).
 * 3. authVersion column regression guard (the 0.1.60 gap that motivated this audit):
 *    schema.prisma User.authVersion must have a matching MIGRATIONS entry.
 * 4. Every schema column NOT created by prisma migrate (added later by hand in the schema)
 *    is covered: for a fixed list of "release-critical" columns added post-0.1.52, assert
 *    the MIGRATIONS entry exists. (Generic full-column inference is not feasible because
 *    db push covers most columns; the audit pins the ones that broke upgrades.)
 *
 * Usage: node scripts/check-schema-migration-coverage.cjs   (wired as check:migration-coverage)
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const fnosBuild = fs.readFileSync(path.join(root, "scripts", "build-fnos-package.cjs"), "utf8");
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(`Migration coverage audit: ${message}`);
}

// 1. Every migration directory has a valid migration.sql
for (const entry of fs.readdirSync(migrationsDir)) {
  const sqlPath = path.join(migrationsDir, entry, "migration.sql");
  if (!fs.existsSync(sqlPath)) {
    failures.push(`Migration coverage audit: ${entry}/migration.sql is missing.`);
    continue;
  }
  const buf = fs.readFileSync(sqlPath);
  if (buf.length === 0) failures.push(`Migration coverage audit: ${entry}/migration.sql is empty.`);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    failures.push(`Migration coverage audit: ${entry}/migration.sql has a UTF-8 BOM (must be BOM-less UTF-8).`);
  }
  if (buf.includes(Buffer.from("\r\n"))) {
    failures.push(`Migration coverage audit: ${entry}/migration.sql contains CRLF (must be LF).`);
  }
}

// 2. MIGRATIONS versions registered in the fnOS build must exist in prisma/migrations.
//    MIGRATIONS versions are feature slugs (e.g. 20260812_account_note) while prisma migration
//    dirs use add_* naming (e.g. 20260812_add_account_note); match on the date prefix plus a
//    keyword overlap, and treat an existing dir as the source of truth for the SQL file.
//    Migration floor: 0.1.52 (tagged 2026-09-04) is the oldest version any user can upgrade
//    from, so on 2026-09-18 every prisma/migrations directory that already existed at v0.1.52
//    was removed. MIGRATIONS entries dated on/before 20260904 intentionally have no matching
//    directory anymore (the 0.1.52 SQLite upgrade path and the schema-downgrade guard still
//    require them in the fnOS MIGRATIONS list). Post-0.1.52 entries must still match one.
const registeredVersions = [...fnosBuild.matchAll(/version:\s*"(\d{8}_[a-z0-9_]+)"/g)].map((m) => m[1]);
if (registeredVersions.length === 0) {
  failures.push("Migration coverage audit: no MIGRATIONS versions found in build-fnos-package.cjs.");
}
const migrationFloorDate = "20260904"; // v0.1.52 was tagged 2026-09-04; post-floor dirs start at 20260905.
const isPreFloorVersion = (version) => version.slice(0, 8) <= migrationFloorDate;
const migrationDirs = fs.readdirSync(migrationsDir);
// Some MIGRATIONS entries are fnOS-only programmatic repairs with no prisma/migrations
// counterpart (e.g. rebuilding a SQLite FK constraint). They are self-contained in the build
// script, so the audit only requires a matching migration directory when one plausibly exists.
const fnosOnlyMigrationVersions = new Set(
  [...fnosBuild.matchAll(/version:\s*"(\d{8}_[a-z0-9_]+)"[\s\S]{0,200}?apply\(db\) \{\s*\n\s+([a-zA-Z0-9_]+)\(/g)]
    .filter(([, , helper]) => /^(rebuild|repair|migrateLegacy|apply)/.test(helper) && !/addColumnIfMissing|createTable|addColumn/.test(fnosBuild.slice(fnosBuild.indexOf(helper), fnosBuild.indexOf(helper) + 400)))
    .map(([, version]) => version),
);
for (const version of registeredVersions) {
  const datePrefix = version.slice(0, 8);
  const keywords = version
    .slice(9)
    .split("_")
    .filter((word) => !["add", "the", "of", "fix"].includes(word));
  const match = migrationDirs.find((entry) => {
    if (!entry.startsWith(datePrefix)) return false;
    const lower = entry.toLowerCase();
    return keywords.some((keyword) => lower.includes(keyword));
  });
  if (!match) {
    if (isPreFloorVersion(version)) continue;
    if (fnosOnlyMigrationVersions.has(version)) continue;
    failures.push(`Migration coverage audit: MIGRATIONS registers "${version}" but no prisma/migrations directory matches it (date prefix ${datePrefix}).`);
    continue;
  }
  const sql = fs.readFileSync(path.join(migrationsDir, match, "migration.sql"), "utf8");
  if (!sql.trim()) failures.push(`Migration coverage audit: ${match}/migration.sql is empty but registered in MIGRATIONS as ${version}.`);
}

// 3. Release-critical columns: schema declares them, MIGRATIONS must register them.
//    Each entry: [table, column, migrationDirName, migrationVersion]
const releaseCriticalColumns = [
  ["User", "authVersion", "20260913_add_user_auth_version", "20260913_user_auth_version"],
  ["Account", "balanceRecomputedAt", "20260922_add_account_balance_recomputed_at", "20260922_add_account_balance_recomputed_at"],
  ["transactions", "depositInterestPayoutFrequency", "20260911_add_deposit_interest_payout", "20260911_add_deposit_interest_payout"],
  ["deposit_transactions", "interestPayoutFrequency", "20260911_add_deposit_interest_payout", "20260911_add_deposit_interest_payout"],
  ["WealthProduct", "productType", "20260917_add_wealth_bond_fields", "20260917_wealth_bond_fields"],
];
for (const [table, column, migrationDir, migrationVersion] of releaseCriticalColumns) {
  const schemaHasIt = schema.includes(` ${column} `) || schema.includes(`${column} `);
  const buildRegistersIt = fnosBuild.includes(migrationVersion);
  if (schemaHasIt && !buildRegistersIt) {
    failures.push(`Migration coverage audit: schema.prisma declares ${table}.${column} but MIGRATIONS does not register ${migrationVersion}.`);
  }
  const sqlPath = path.join(migrationsDir, migrationDir, "migration.sql");
  if (!fs.existsSync(sqlPath)) {
    failures.push(`Migration coverage audit: expected migration ${migrationDir} is missing.`);
  } else {
    const sql = fs.readFileSync(sqlPath, "utf8");
    if (!sql.includes(column)) {
      failures.push(`Migration coverage audit: ${migrationDir}/migration.sql does not mention column ${column}.`);
    }
  }
}

if (failures.length > 0) {
  console.error("Schema migration coverage audit FAILED:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Schema migration coverage audit passed.");
