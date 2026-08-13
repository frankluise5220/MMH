#!/bin/sh
set -eu

PGHOST="${PGHOST:-postgres}"
PGUSER="${POSTGRES_USER:-mmh-fs}"
PGDATABASE="${POSTGRES_DB:-mmh}"
PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
export PGPASSWORD

psql_mmh() {
  psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" "$@"
}

run_sql_file() {
  file="$1"
  if [ ! -f "$file" ]; then
    echo "[mmh] missing compatibility migration: $file"
    exit 78
  fi
  psql_mmh -v ON_ERROR_STOP=1 -f "$file"
}

run_compat_migrations() {
  legacy_statement_category_rules="$(
    psql_mmh -tAc "SELECT CASE WHEN to_regclass('public.statement_category_rules') IS NULL THEN '0' ELSE '1' END" | tr -d '[:space:]'
  )"

  if [ "$legacy_statement_category_rules" = "1" ]; then
    echo "[mmh] migrating legacy statement category rules..."
    run_sql_file "prisma/migrations/20260813_add_statement_recognition_rules/migration.sql"
    run_sql_file "prisma/migrations/20260813_z_cleanup_statement_category_rule_institutions/migration.sql"
    run_sql_file "prisma/migrations/20260813_zz_unify_statement_learning_rules/migration.sql"
    echo "[mmh] legacy statement category rules migrated."
  fi
}

until pg_isready -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE"; do
  echo "[mmh] waiting for postgres..."
  sleep 1
done

echo "[mmh] postgres ready, checking database schema..."

run_compat_migrations

PUSH_OUTPUT="$(mktemp)"
if ./node_modules/.bin/prisma db push >"$PUSH_OUTPUT" 2>&1; then
  cat "$PUSH_OUTPUT"
  rm -f "$PUSH_OUTPUT"
  echo "[mmh] prisma setup complete, starting app..."
  exec node server.js
fi

cat "$PUSH_OUTPUT"

if grep -Eq "accept-data-loss|data loss|dropped_variants|will be dropped|invalid input value for enum" "$PUSH_OUTPUT"; then
  echo "[mmh] database schema sync refused because it may delete or rewrite existing data."
  echo "[mmh] This usually means the app image is older than the database. Pull the newest image from GHCR or switch away from a stale mirror."
  rm -f "$PUSH_OUTPUT"
  exit 78
fi

rm -f "$PUSH_OUTPUT"
echo "[mmh] prisma db push failed."
exit 1
