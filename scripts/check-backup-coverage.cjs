#!/usr/bin/env node
/**
 * Backup coverage audit (release gate).
 *
 * Catches the recurring failure mode behind the bond gap (2026-10-01) and the
 * reimbursement gap (2026-10-01): a model is added to prisma/schema.prisma, ships
 * to production, but nobody remembers to wire it into src/lib/server/backup.ts.
 * The result is silent data loss on export plus dangling foreign keys on restore.
 *
 * The old verify-backup-completeness.cjs could not catch this: it only asserts
 * that things someone already added are still present. It passes while a brand
 * new table is completely absent. This audit inverts that: it enumerates the
 * schema, derives which models are household-scoped, and requires each one to be
 * wired into every backup/restore path. A new table therefore turns the gate red
 * on the same commit that introduces it, instead of losing user data later.
 *
 * What it checks, for every household-scoped model:
 *   1. export    - prisma.<delegate>.findMany / optionalPrismaFindMany(prisma, "<delegate>"
 *   2. clear     - tx.<delegate>.deleteMany  / optionalPrismaDeleteMany(tx, "<delegate>"
 *   3. write     - tx.<delegate>,            / tx.<delegate>.createMany
 *   4. parser    - the payload collection is read back with ensureArray /
 *                  ensureLiabilityArray
 *
 * Models that are intentionally not part of a household snapshot (global config,
 * caches, security tokens, audit trails) must be listed in INTENTIONAL_EXCLUSIONS
 * with a written reason, so omitting a table is always a deliberate, reviewable act.
 *
 * Usage: node scripts/check-backup-coverage.cjs   (wired as check:backup-coverage)
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const backup = fs.readFileSync(path.join(root, "src", "lib", "server", "backup.ts"), "utf8");

/**
 * Models that are deliberately excluded from a household snapshot.
 * key = model name, value = why it is safe to leave out.
 * Adding a model here is a decision, not a shortcut: every entry claims the data
 * is either global, reproducible, or deliberately not restorable.
 */
const INTENTIONAL_EXCLUSIONS = new Map(
  Object.entries({
    Household:
      "The household row itself is the restore target, not snapshot content (rebuilt/renamed by the restore flow).",
    User:
      "Restored only for system backups via the fallbackAdmin path; household members are rebuilt from the target instance.",
    UserSettings: "Tied to User rows, which are not part of a household snapshot.",
    PasswordResetToken: "Security token; restore explicitly clears it instead of importing it.",
    RegistrationCode: "Invite/registration codes are instance-scoped, never part of a household snapshot.",
    SponsorTipIntent: "Instance-scoped sponsor state, not household data.",
    UndoOperation: "Undo history is session-local; restore explicitly clears it.",
    MmhSchemaMeta: "Schema bookkeeping owned by the migration runner.",
    BenchmarkCache: "Derived cache, rebuilt on demand.",
    FundNavCache: "Derived cache, rebuilt on demand.",
    FundProfile: "Fund reference data fetched from the vendor API, rebuilt on demand.",
    StockPriceCache: "Derived cache, rebuilt on demand.",
    FundQueryApi: "Global vendor credentials, exported separately and never household-scoped on restore.",
    SystemSetting: "Global instance settings, exported/restored outside the household scope.",
    AccessKey: "Global API keys, exported/restored outside the household scope.",
    AiChannel: "Global AI provider config, exported/restored outside the household scope.",
    AiModel: "Global AI model config, exported/restored outside the household scope.",
    ApprovedCurrency: "Global currency catalogue, exported/restored outside the household scope.",
    CustomCurrencyRequest: "Global currency requests, exported/restored outside the household scope.",
  }),
);

// Payload collection names that share no prefix with their Prisma delegate.
// Everything else is matched by prefix against the collections parseBackupPayload
// actually reads, so pluralisation (alias -> aliases, batch -> batches, category
// -> categories) never has to be guessed and a brand new model still gets checked.
const PAYLOAD_KEY_OVERRIDES = new Map(Object.entries({ TxRecord: "transactions" }));

// ---------------------------------------------------------------------------
// 1. Parse prisma/schema.prisma into models + relation graph.
// ---------------------------------------------------------------------------
const models = new Map();
for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
  const [, name, body] = match;
  const fields = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@")) continue;
    const field = trimmed.match(/^(\w+)\s+([A-Za-z_]\w*)(\[\])?(\?)?/);
    if (!field) continue;
    fields.push({ name: field[1], type: field[2], isList: Boolean(field[3]), isOptional: Boolean(field[4]) });
  }
  models.set(name, { name, fields });
}
if (models.size === 0) {
  console.error("Backup coverage audit FAILED: could not parse any model from prisma/schema.prisma.");
  process.exit(1);
}

// A field is a relation when its type is another model.
for (const model of models.values()) {
  model.relations = model.fields.filter((field) => models.has(field.type)).map((field) => field.type);
  model.hasHouseholdId = model.fields.some((field) => field.name === "householdId");
}

// Household-scoped = owns a householdId, or reaches one through relations.
// (e.g. ReimbursementItem has no householdId but hangs off Reimbursement.)
const scoped = new Set();
for (const model of models.values()) if (model.hasHouseholdId) scoped.add(model.name);
let grew = true;
while (grew) {
  grew = false;
  for (const model of models.values()) {
    if (scoped.has(model.name)) continue;
    if (model.relations.some((target) => scoped.has(target))) {
      scoped.add(model.name);
      grew = true;
    }
  }
}
scoped.delete("Household");

// ---------------------------------------------------------------------------
// 2. Assert each scoped model is wired into export / clear / write.
// ---------------------------------------------------------------------------
const failures = [];
const covered = [];
const excluded = [];

const delegateOf = (model) => model[0].toLowerCase() + model.slice(1);

const has = (pattern) => new RegExp(pattern).test(backup);

for (const name of [...scoped].sort()) {
  const delegate = delegateOf(name);
  const esc = delegate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (INTENTIONAL_EXCLUSIONS.has(name)) {
    excluded.push(name);
    continue;
  }

  const missing = [];
  const exported =
    has(`prisma\\.${esc}\\.findMany`) ||
    has(`optionalPrismaFindMany[^(]*\\(\\s*prisma,\\s*"${esc}"`);
  if (!exported) missing.push("export");

  const cleared =
    has(`tx\\.${esc}\\.deleteMany`) ||
    has(`optionalPrismaDeleteMany[^(]*\\(\\s*tx,\\s*"${esc}"`) ||
    has(`getOptionalPrismaDelegate[^(]*\\(\\s*tx,\\s*"${esc}"`);
  if (!cleared) missing.push("clear");

  const written =
    has(`tx\\.${esc},`) ||
    has(`tx\\.${esc}\\.createMany`) ||
    has(`optionalPrismaCreateMany[^(]*\\(\\s*tx,\\s*"${esc}"`) ||
    has(`getOptionalPrismaDelegate[^(]*\\(\\s*tx,\\s*"${esc}"`);
  if (!written) missing.push("write");

  if (missing.length > 0) {
    failures.push(
      `Backup coverage audit: household-scoped model ${name} (table ${name.toLowerCase()}) is missing from backup.ts [${missing.join(", ")}]. ` +
        `Wire it into src/lib/server/backup.ts, or add it to INTENTIONAL_EXCLUSIONS in scripts/check-backup-coverage.cjs with a reason.`,
    );
  } else {
    covered.push(name);
  }
}

// ---------------------------------------------------------------------------
// 3. Guard the exclusions list itself: a stale entry hides a real gap.
// ---------------------------------------------------------------------------
for (const name of INTENTIONAL_EXCLUSIONS.keys()) {
  if (!models.has(name)) {
    failures.push(
      `Backup coverage audit: INTENTIONAL_EXCLUSIONS lists "${name}", which no longer exists in prisma/schema.prisma. Remove the stale entry.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Guard the parser side: every exported collection must be read back.
// ---------------------------------------------------------------------------
// `ensureArray` reads a collection verbatim; `ensureLiabilityArray` (2026-10-06
// 口径定版) additionally maps legacy debt* field names onto liability semantics.
// Both prove the collection is read back by parseBackupPayload.
const parserKeys = new Set(
  [...backup.matchAll(/(\w+):\s*ensure(?:Liability)?Array/g)].map((match) => match[1]),
);
for (const name of covered) {
  const delegate = delegateOf(name);
  const override = PAYLOAD_KEY_OVERRIDES.get(name);
  // The collection is the plural of the delegate (category -> categories,
  // counterparty -> counterparties, batch -> batches, Day -> Days), so match on
  // the stem and accept only a plural suffix. The stem drops a trailing "y" only
  // after a consonant, and "fundTransactionCashFlows" therefore cannot stand in
  // for "fundTransactions".
  const stem = delegate.toLowerCase().replace(/([^aeiou])y$/, "$1");
  const readBack = override
    ? parserKeys.has(override)
    : [...parserKeys].some((key) => {
        const lower = key.toLowerCase();
        if (!lower.startsWith(stem)) return false;
        return /^(s|es|ies)?$/.test(lower.slice(stem.length));
      });
  if (!readBack) {
    failures.push(
      `Backup coverage audit: ${name} is exported and imported but parseBackupPayload never reads its collection back with ensureArray, ` +
        `so an old backup without that collection would crash the restore.`,
    );
  }
}

if (failures.length > 0) {
  console.error("Backup coverage audit FAILED:");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    `\nScoped models: ${scoped.size} | covered: ${covered.length} | intentionally excluded: ${excluded.length}`,
  );
  process.exit(1);
}

console.log(
  `Backup coverage audit passed. ${covered.length} household-scoped models covered, ` +
    `${excluded.length} intentionally excluded (global/cache/token), ${scoped.size} total.`,
);
