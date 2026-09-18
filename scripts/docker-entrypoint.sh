#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  if ! command -v gosu >/dev/null 2>&1; then
    echo "[mmh] gosu is missing; refusing to run the app process as root."
    exit 78
  fi
  mkdir -p /app/data
  if ! chown -R node:node /app/data; then
    echo "[mmh] failed to make /app/data writable by the node user."
    exit 78
  fi
  exec gosu node "$0" "$@"
fi

PGHOST="${PGHOST:-postgres}"
PGUSER="${POSTGRES_USER:-mmh-fs}"
PGDATABASE="${POSTGRES_DB:-mmh}"
PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
export PGPASSWORD

psql_mmh() {
  psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" "$@"
}

mmh_log() {
  echo "[mmh] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

memory_limit_to_mb() {
  value="$(printf '%s' "${1:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  [ -n "$value" ] && [ "$value" != "max" ] || return 1
  case "$value" in
    *gb|*g)
      number="${value%gb}"
      number="${number%g}"
      ;;
    *mb|*m)
      number="${value%mb}"
      number="${number%m}"
      ;;
    *kb|*k)
      number="${value%kb}"
      number="${number%k}"
      ;;
    *b)
      number="${value%b}"
      ;;
    *[!0-9]*)
      return 1
      ;;
    *)
      number="$value"
      ;;
  esac
  case "$number" in
    ""|*[!0-9]*) return 1 ;;
  esac
  case "$value" in
    *gb|*g) echo $((number * 1024)) ;;
    *kb|*k) echo $((number / 1024)) ;;
    *b) echo $((number / 1048576)) ;;
    *) echo "$number" ;;
  esac
}

detect_runtime_memory_limit_mb() {
  if runtime_limit="$(memory_limit_to_mb "${MMH_APP_MEMORY_LIMIT:-}")" && [ "$runtime_limit" -gt 0 ]; then
    echo "$runtime_limit"
    return 0
  fi

  host_total_mb=""
  if [ -r /proc/meminfo ]; then
    host_total_kb="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo 2>/dev/null || true)"
    case "$host_total_kb" in
      ""|*[!0-9]*) ;;
      *) host_total_mb=$((host_total_kb / 1024)) ;;
    esac
  fi

  for limit_file in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do
    if [ -r "$limit_file" ]; then
      raw_limit="$(cat "$limit_file" 2>/dev/null | tr -d '[:space:]')"
      case "$raw_limit" in
        ""|max|*[!0-9]*) ;;
        *)
          cgroup_limit_mb=$((raw_limit / 1048576))
          if [ "$cgroup_limit_mb" -gt 0 ] && { [ -z "$host_total_mb" ] || [ "$cgroup_limit_mb" -le $((host_total_mb * 2)) ]; }; then
            echo "$cgroup_limit_mb"
            return 0
          fi
          ;;
      esac
    fi
  done

  if [ -n "$host_total_mb" ] && [ "$host_total_mb" -gt 0 ]; then
    echo "$host_total_mb"
    return 0
  fi

  echo 0
}

recommended_node_old_space_mb() {
  runtime_limit_mb="$(detect_runtime_memory_limit_mb)"
  case "$runtime_limit_mb" in
    ""|*[!0-9]*|0) echo 768 ;;
    *)
      if [ "$runtime_limit_mb" -lt 1280 ]; then
        echo 384
      elif [ "$runtime_limit_mb" -lt 3072 ]; then
        echo 768
      elif [ "$runtime_limit_mb" -lt 6144 ]; then
        echo 1024
      else
        echo 1536
      fi
      ;;
  esac
}

apply_node_memory_limit() {
  MMH_NODE_MAX_OLD_SPACE_MB="${MMH_NODE_MAX_OLD_SPACE_MB:-auto}"
  case "$MMH_NODE_MAX_OLD_SPACE_MB" in
    auto|AUTO|Auto)
      MMH_NODE_MAX_OLD_SPACE_MB="$(recommended_node_old_space_mb)"
      ;;
    ""|*[!0-9]*)
      mmh_log "WARNING: invalid MMH_NODE_MAX_OLD_SPACE_MB; falling back to auto."
      MMH_NODE_MAX_OLD_SPACE_MB="$(recommended_node_old_space_mb)"
      ;;
  esac

  case "${NODE_OPTIONS:-}" in
    *--max-old-space-size*|*--max_old_space_size*)
      ;;
    *)
      NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$MMH_NODE_MAX_OLD_SPACE_MB"
      ;;
  esac

  export MMH_NODE_MAX_OLD_SPACE_MB NODE_OPTIONS
}

apply_node_memory_limit

generate_secret() {
  if command -v node >/dev/null 2>&1; then
    node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n'
    return 0
  fi
  return 1
}

ensure_session_secret() {
  if [ -n "${MMH_SESSION_SECRET:-}" ]; then
    case "$MMH_SESSION_SECRET" in
      CHANGE_ME*)
        echo "[mmh] MMH_SESSION_SECRET is a placeholder; set a strong random value or leave it empty for automatic generation." >&2
        exit 78
        ;;
    esac
    if [ "${#MMH_SESSION_SECRET}" -lt 32 ]; then
      echo "[mmh] MMH_SESSION_SECRET must contain at least 32 characters." >&2
      exit 78
    fi
    return 0
  fi
  secret_file="/app/data/mmh-session-secret.txt"
  if [ -f "$secret_file" ]; then
    MMH_SESSION_SECRET="$(tr -d '[:space:]' < "$secret_file")"
  fi
  case "${MMH_SESSION_SECRET:-}" in
    CHANGE_ME*)
      MMH_SESSION_SECRET=""
      ;;
  esac
  if [ -n "${MMH_SESSION_SECRET:-}" ] && [ "${#MMH_SESSION_SECRET}" -lt 32 ]; then
    MMH_SESSION_SECRET=""
  fi
  if [ -z "${MMH_SESSION_SECRET:-}" ]; then
    umask 077
    MMH_SESSION_SECRET="$(generate_secret)"
    printf '%s\n' "$MMH_SESSION_SECRET" > "$secret_file"
  fi
  chmod 600 "$secret_file" 2>/dev/null || true
  export MMH_SESSION_SECRET
}

# Legacy SQL-file compat migrations were inlined into run_compat_migrations on
# 2026-09-18 when pre-0.1.52 prisma/migrations were pruned. Kept for images
# built before that date and for any future file-based compat migration:
run_sql_file() {
  file="$1"
  if [ ! -f "$file" ]; then
    mmh_log "WARNING: missing compatibility migration $file; continuing so MMH stays available."
    return 0
  fi
  mmh_log "applying $file"
  if ! psql_mmh -v ON_ERROR_STOP=1 -f "$file"; then
    mmh_log "WARNING: compatibility migration $file failed; continuing so MMH stays available."
  fi
}

fallback_debt_agreement_records() {
  mmh_log "applying DebtAgreement fallback: retaining legacy records without conflicting constraints..."
  if psql_mmh -v ON_ERROR_STOP=1 <<'SQL'; then
    ALTER TABLE "DebtAgreement" DROP CONSTRAINT IF EXISTS "DebtAgreement_accountId_fkey";
    ALTER TABLE "DebtAgreement" DROP CONSTRAINT IF EXISTS "DebtAgreement_entryId_fkey";
    DROP INDEX IF EXISTS "DebtAgreement_accountId_key";
    DROP INDEX IF EXISTS "DebtAgreement_entryId_key";
    ALTER TABLE "DebtAgreement" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
    ALTER TABLE "DebtAgreement" ALTER COLUMN "accountId" DROP NOT NULL;
    ALTER TABLE "DebtAgreement" DROP COLUMN IF EXISTS "entryId";
SQL
    mmh_log "DebtAgreement fallback applied: records retained, conflicting constraints removed."
  else
    mmh_log "WARNING: DebtAgreement fallback cleanup failed; records were not deleted, but schema constraints may remain."
  fi
}

migrate_debt_agreement_rekey() {
  debt_agreement_table="$(psql_mmh -tAc "SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'DebtAgreement') THEN '1' ELSE '0' END" | tr -d '[:space:]')"
  if [ "$debt_agreement_table" != "1" ]; then
    return 0
  fi

  legacy_entry_id="$(psql_mmh -tAc "SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'DebtAgreement' AND column_name = 'entryId') THEN '1' ELSE '0' END" | tr -d '[:space:]')"
  if [ "$legacy_entry_id" != "1" ]; then
    return 0
  fi

  mmh_log "migrating legacy DebtAgreement.entryId to accountId..."
  if ! psql_mmh -v ON_ERROR_STOP=1 <<'SQL'; then
    ALTER TABLE "DebtAgreement" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
    UPDATE "DebtAgreement" d
       SET "accountId" = t."accountId"
      FROM "transactions" t
     WHERE d."entryId" = t."id"
       AND d."accountId" IS NULL;
    ALTER TABLE "DebtAgreement" DROP CONSTRAINT IF EXISTS "DebtAgreement_entryId_fkey";
    DROP INDEX IF EXISTS "DebtAgreement_entryId_key";
    ALTER TABLE "DebtAgreement" DROP COLUMN IF EXISTS "entryId";
    ALTER TABLE "DebtAgreement" ADD CONSTRAINT "DebtAgreement_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    CREATE UNIQUE INDEX IF NOT EXISTS "DebtAgreement_accountId_key" ON "DebtAgreement"("accountId");
    CREATE INDEX IF NOT EXISTS "DebtAgreement_householdId_dueDate_idx" ON "DebtAgreement"("householdId", "dueDate");
SQL
    mmh_log "WARNING: legacy DebtAgreement rekey failed; applying record-preserving fallback..."
    fallback_debt_agreement_records
  fi
  mmh_log "legacy DebtAgreement rekey complete."
}

run_compat_migrations() {
  legacy_statement_category_rules="$(
    psql_mmh -tAc "SELECT CASE WHEN to_regclass('public.statement_category_rules') IS NULL THEN '0' ELSE '1' END" | tr -d '[:space:]'
  )"

  if [ "$legacy_statement_category_rules" = "1" ]; then
    mmh_log "migrating legacy statement category rules..."
    # Inlined from prisma/migrations/20260813_{add_statement_recognition_rules,
    # z_cleanup_statement_category_rule_institutions,zz_unify_statement_learning_rules},
    # which were removed when the migration floor moved to 0.1.52 (2026-09-18).
    # Docker images built before 2026-09-18 rely on the prisma/migrations copies.
    if ! psql_mmh -v ON_ERROR_STOP=1 <<'SQL'; then
CREATE TABLE IF NOT EXISTS "statement_recognition_rules" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "transactionType" TEXT NOT NULL DEFAULT 'any',
  "keyword" TEXT NOT NULL,
  "normalizedKeyword" TEXT NOT NULL,
  "categoryId" TEXT,
  "categoryName" TEXT,
  "institutionId" TEXT,
  "institutionName" TEXT,
  "fieldName" TEXT,
  "source" TEXT NOT NULL DEFAULT 'system_default',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "hitCount" INTEGER NOT NULL DEFAULT 0,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "statement_recognition_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "statement_recognition_rules_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "statement_recognition_rules_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "statement_recognition_rules_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

ALTER TABLE "statement_recognition_rules"
  ADD COLUMN IF NOT EXISTS "fieldName" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "statement_recognition_rules_householdId_targetType_transactionType_normalizedKeyword_key"
  ON "statement_recognition_rules"("householdId", "targetType", "transactionType", "normalizedKeyword");

CREATE INDEX IF NOT EXISTS "statement_recognition_rules_householdId_targetType_idx"
  ON "statement_recognition_rules"("householdId", "targetType");

CREATE INDEX IF NOT EXISTS "statement_recognition_rules_categoryId_idx"
  ON "statement_recognition_rules"("categoryId");

CREATE INDEX IF NOT EXISTS "statement_recognition_rules_institutionId_idx"
  ON "statement_recognition_rules"("institutionId");

CREATE INDEX IF NOT EXISTS "statement_recognition_rules_isActive_idx"
  ON "statement_recognition_rules"("isActive");

UPDATE "statement_category_rules"
SET
  "counterpartyInstitutionName" = NULL,
  "paymentChannelName" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "source" = 'system_default'
  AND ("counterpartyInstitutionName" IS NOT NULL OR "paymentChannelName" IS NOT NULL);

WITH legacy_category_rules AS (
  SELECT
    'recog_legacy_' || "id" AS "id",
    "householdId",
    "type",
    TRIM(
      CASE
        WHEN POSITION('有限责任公司' IN "matchText") > 0 THEN SUBSTRING("matchText" FROM 1 FOR POSITION('有限责任公司' IN "matchText") - 1)
        WHEN POSITION('股份有限公司' IN "matchText") > 0 THEN SUBSTRING("matchText" FROM 1 FOR POSITION('股份有限公司' IN "matchText") - 1)
        WHEN POSITION('集团有限公司' IN "matchText") > 0 THEN SUBSTRING("matchText" FROM 1 FOR POSITION('集团有限公司' IN "matchText") - 1)
        WHEN POSITION('有限公司' IN "matchText") > 0 THEN SUBSTRING("matchText" FROM 1 FOR POSITION('有限公司' IN "matchText") - 1)
        ELSE "matchText"
      END
    ) AS "keyword",
    TRIM(
      CASE
        WHEN POSITION('有限责任公司' IN "normalizedText") > 0 THEN SUBSTRING("normalizedText" FROM 1 FOR POSITION('有限责任公司' IN "normalizedText") - 1)
        WHEN POSITION('股份有限公司' IN "normalizedText") > 0 THEN SUBSTRING("normalizedText" FROM 1 FOR POSITION('股份有限公司' IN "normalizedText") - 1)
        WHEN POSITION('集团有限公司' IN "normalizedText") > 0 THEN SUBSTRING("normalizedText" FROM 1 FOR POSITION('集团有限公司' IN "normalizedText") - 1)
        WHEN POSITION('有限公司' IN "normalizedText") > 0 THEN SUBSTRING("normalizedText" FROM 1 FOR POSITION('有限公司' IN "normalizedText") - 1)
        ELSE "normalizedText"
      END
    ) AS "normalizedKeyword",
    "categoryId",
    "categoryName",
    "source",
    CASE WHEN "source" = 'system_default' THEN 100 ELSE 230 END AS "priority",
    "hitCount",
    "lastSeenAt",
    "createdAt",
    "updatedAt"
  FROM "statement_category_rules"
  WHERE "type" IN ('income', 'expense')
    AND "categoryName" IS NOT NULL
    AND "matchText" IS NOT NULL
    AND "normalizedText" IS NOT NULL
)
INSERT INTO "statement_recognition_rules" (
  "id", "householdId", "targetType", "transactionType", "keyword", "normalizedKeyword",
  "categoryId", "categoryName", "institutionId", "institutionName", "fieldName", "source", "priority",
  "isActive", "hitCount", "lastSeenAt", "createdAt", "updatedAt"
)
SELECT
  "id", "householdId", 'category', "type", "keyword", "normalizedKeyword",
  "categoryId", "categoryName", NULL, NULL, NULL, "source", "priority",
  true, "hitCount", "lastSeenAt", "createdAt", "updatedAt"
FROM legacy_category_rules
WHERE "keyword" <> ''
  AND "normalizedKeyword" <> ''
ON CONFLICT ("householdId", "targetType", "transactionType", "normalizedKeyword")
DO UPDATE SET
  "categoryId" = EXCLUDED."categoryId",
  "categoryName" = EXCLUDED."categoryName",
  "source" = EXCLUDED."source",
  "priority" = GREATEST("statement_recognition_rules"."priority", EXCLUDED."priority"),
  "isActive" = true,
  "hitCount" = "statement_recognition_rules"."hitCount" + EXCLUDED."hitCount",
  "lastSeenAt" = GREATEST(COALESCE("statement_recognition_rules"."lastSeenAt", EXCLUDED."lastSeenAt"), COALESCE(EXCLUDED."lastSeenAt", "statement_recognition_rules"."lastSeenAt")),
  "updatedAt" = CURRENT_TIMESTAMP,
  "keyword" = EXCLUDED."keyword";

CREATE TEMP TABLE "_mmh_statement_keyword_cleanup" AS
SELECT
  "id",
  "householdId",
  "targetType",
  "transactionType",
  TRIM(
    CASE
      WHEN POSITION('有限责任公司' IN "keyword") > 0 THEN SUBSTRING("keyword" FROM 1 FOR POSITION('有限责任公司' IN "keyword") - 1)
      WHEN POSITION('股份有限公司' IN "keyword") > 0 THEN SUBSTRING("keyword" FROM 1 FOR POSITION('股份有限公司' IN "keyword") - 1)
      WHEN POSITION('集团有限公司' IN "keyword") > 0 THEN SUBSTRING("keyword" FROM 1 FOR POSITION('集团有限公司' IN "keyword") - 1)
      WHEN POSITION('有限公司' IN "keyword") > 0 THEN SUBSTRING("keyword" FROM 1 FOR POSITION('有限公司' IN "keyword") - 1)
      ELSE "keyword"
    END
  ) AS "keyword",
  TRIM(
    CASE
      WHEN POSITION('有限责任公司' IN "normalizedKeyword") > 0 THEN SUBSTRING("normalizedKeyword" FROM 1 FOR POSITION('有限责任公司' IN "normalizedKeyword") - 1)
      WHEN POSITION('股份有限公司' IN "normalizedKeyword") > 0 THEN SUBSTRING("normalizedKeyword" FROM 1 FOR POSITION('股份有限公司' IN "normalizedKeyword") - 1)
      WHEN POSITION('集团有限公司' IN "normalizedKeyword") > 0 THEN SUBSTRING("normalizedKeyword" FROM 1 FOR POSITION('集团有限公司' IN "normalizedKeyword") - 1)
      WHEN POSITION('有限公司' IN "normalizedKeyword") > 0 THEN SUBSTRING("normalizedKeyword" FROM 1 FOR POSITION('有限公司' IN "normalizedKeyword") - 1)
      ELSE "normalizedKeyword"
    END
  ) AS "normalizedKeyword",
  "hitCount"
FROM "statement_recognition_rules"
WHERE "keyword" LIKE '%有限公司%'
   OR "normalizedKeyword" LIKE '%有限公司%';

UPDATE "statement_recognition_rules" AS target
SET
  "hitCount" = target."hitCount" + source."hitCount",
  "updatedAt" = CURRENT_TIMESTAMP
FROM "_mmh_statement_keyword_cleanup" AS source
WHERE target."householdId" = source."householdId"
  AND target."targetType" = source."targetType"
  AND target."transactionType" = source."transactionType"
  AND target."normalizedKeyword" = source."normalizedKeyword"
  AND target."id" <> source."id";

DELETE FROM "statement_recognition_rules" AS original
USING "_mmh_statement_keyword_cleanup" AS source
WHERE original."id" = source."id"
  AND EXISTS (
    SELECT 1
    FROM "statement_recognition_rules" AS target
    WHERE target."householdId" = source."householdId"
      AND target."targetType" = source."targetType"
      AND target."transactionType" = source."transactionType"
      AND target."normalizedKeyword" = source."normalizedKeyword"
      AND target."id" <> source."id"
  );

UPDATE "statement_recognition_rules" AS target
SET
  "keyword" = source."keyword",
  "normalizedKeyword" = source."normalizedKeyword",
  "updatedAt" = CURRENT_TIMESTAMP
FROM "_mmh_statement_keyword_cleanup" AS source
WHERE target."id" = source."id"
  AND source."keyword" <> ''
  AND source."normalizedKeyword" <> '';

DROP TABLE "_mmh_statement_keyword_cleanup";

DROP TABLE IF EXISTS "statement_category_rules";
SQL
    mmh_log "legacy statement category rules migrated."
    else
      mmh_log "WARNING: legacy statement category rules migration failed; continuing so MMH stays available."
    fi
  fi

  migrate_debt_agreement_rekey
}

until pg_isready -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE"; do
  mmh_log "waiting for postgres..."
  sleep 1
done

mmh_log "postgres ready, checking database schema..."

ensure_session_secret

# Downgrade protection: refuse to start when the database was last written by
# a newer MMH image. Running an older binary against a newer schema makes
# "prisma db push" drop the newer columns and lose data.
ensure_schema_meta_table() {
  attempt=1
  while [ "$attempt" -le 3 ]; do
    if psql_mmh -v ON_ERROR_STOP=1 -c 'CREATE TABLE IF NOT EXISTS "_mmh_schema_meta" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL);' >/dev/null 2>&1; then
      return 0
    fi
    mmh_log "WARNING: schema meta table ensure attempt $attempt failed; retrying in 2s..."
    sleep 2
    attempt=$((attempt + 1))
  done
  mmh_log "WARNING: could not ensure _mmh_schema_meta table after retries; skipping schema downgrade protection check."
  return 1
}

refuse_if_schema_newer() {
  build_version="$(node -p "require('./package.json').version" 2>/dev/null || true)"
  if [ -z "$build_version" ]; then
    mmh_log "WARNING: could not determine image version; skipping schema downgrade protection check."
    return 0
  fi
  if ! ensure_schema_meta_table; then
    return 0
  fi
  stored_version="$(psql_mmh -tAc "SELECT value FROM \"_mmh_schema_meta\" WHERE key = 'schema_version'" | tr -d '[:space:]')"
  if [ -z "$stored_version" ]; then
    mmh_log "no schema version marker found (fresh or pre-guard database); will record $build_version after schema sync."
    return 0
  fi
  newest="$(printf '%s\n%s\n' "$stored_version" "$build_version" | sort -V | tail -n 1)"
  if [ "$newest" = "$stored_version" ] && [ "$stored_version" != "$build_version" ]; then
    mmh_log "REFUSING TO START: the database was last written by MMH $stored_version, which is newer than this image ($build_version)."
    mmh_log "Running an older image against a newer schema can drop columns and lose data. Deploy an image >= $stored_version or restore a database backup."
    exit 78
  fi
}

record_schema_version() {
  recorded_version="$1"
  attempt=1
  while [ "$attempt" -le 3 ]; do
    if psql_mmh -v ON_ERROR_STOP=1 -c "INSERT INTO \"_mmh_schema_meta\" (\"key\", \"value\") VALUES ('schema_version', '$recorded_version') ON CONFLICT (\"key\") DO UPDATE SET \"value\" = EXCLUDED.\"value\";" >/dev/null 2>&1; then
      mmh_log "recorded schema version $recorded_version"
      return 0
    fi
    mmh_log "WARNING: schema version record attempt $attempt failed; retrying in 2s..."
    sleep 2
    attempt=$((attempt + 1))
  done
  mmh_log "WARNING: could not record schema version after retries; downgrade protection cannot trigger for this database."
  mmh_log "WARNING: without the marker a DOWN-graded image cannot be detected. Re-run this image or record it manually:"
  mmh_log "  INSERT INTO \"_mmh_schema_meta\" (\"key\", \"value\") VALUES ('schema_version', '$recorded_version');"
}

refuse_if_schema_newer
run_compat_migrations

PUSH_OUTPUT="$(mktemp)"
PUSH_OK=0
PUSH_ATTEMPTS=5
attempt=1
while [ "$attempt" -le "$PUSH_ATTEMPTS" ]; do
  if ./node_modules/.bin/prisma db push >"$PUSH_OUTPUT" 2>&1; then
    PUSH_OK=1
    break
  fi
  if [ "$attempt" -lt "$PUSH_ATTEMPTS" ]; then
    mmh_log "prisma db push attempt $attempt failed; retrying in 3s..."
    sleep 3
  fi
  attempt=$((attempt + 1))
done

cat "$PUSH_OUTPUT" 2>/dev/null || true

if [ "$PUSH_OK" = "1" ]; then
  if ! psql_mmh -v ON_ERROR_STOP=1 -c "UPDATE \"Account\" SET \"loanType\" = CASE WHEN \"isConsumerLoan\" = TRUE THEN 'consumer'::\"LoanType\" ELSE 'home'::\"LoanType\" END WHERE \"kind\" = 'loan'::\"AccountKind\" AND \"loanType\" IS NULL;"; then
    mmh_log "WARNING: account loanType backfill failed; continuing so MMH stays available."
  fi
  if ! psql_mmh -v ON_ERROR_STOP=1 -c "UPDATE \"Account\" SET \"kind\" = 'settlement'::\"AccountKind\", \"institutionId\" = NULL, \"loanType\" = NULL, \"isConsumerLoan\" = FALSE WHERE \"kind\" = 'loan'::\"AccountKind\" AND \"counterpartyId\" IS NOT NULL; UPDATE \"Account\" SET \"institutionId\" = NULL, \"loanType\" = NULL, \"isConsumerLoan\" = FALSE WHERE \"kind\" = 'settlement'::\"AccountKind\";"; then
    mmh_log "WARNING: settlement account backfill failed; continuing so MMH stays available."
  fi
  mmh_log "account-kind compatibility backfill complete."
  record_schema_version "$build_version"
else
  if grep -Eq "accept-data-loss|data loss|dropped_variants|will be dropped|invalid input value for enum" "$PUSH_OUTPUT"; then
    mmh_log "WARNING: database schema sync would modify existing data; starting anyway so MMH stays available. New schema features may be unavailable until resolved."
  else
    mmh_log "WARNING: prisma db push failed after retries; starting anyway so MMH stays available."
  fi
fi

rm -f "$PUSH_OUTPUT"
mmh_log "starting app..."
exec node server.js
