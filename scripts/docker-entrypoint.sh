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
    run_sql_file "prisma/migrations/20260813_add_statement_recognition_rules/migration.sql"
    run_sql_file "prisma/migrations/20260813_z_cleanup_statement_category_rule_institutions/migration.sql"
    run_sql_file "prisma/migrations/20260813_zz_unify_statement_learning_rules/migration.sql"
    mmh_log "legacy statement category rules migrated."
  fi

  migrate_debt_agreement_rekey
}

until pg_isready -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE"; do
  mmh_log "waiting for postgres..."
  sleep 1
done

mmh_log "postgres ready, checking database schema..."

ensure_session_secret
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
