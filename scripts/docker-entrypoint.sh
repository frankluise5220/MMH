#!/bin/sh
set -eu

PGHOST="${PGHOST:-postgres}"
PGUSER="${POSTGRES_USER:-mmh-fs}"
PGDATABASE="${POSTGRES_DB:-mmh}"

until pg_isready -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE"; do
  echo "[mmh] waiting for postgres..."
  sleep 1
done

echo "[mmh] postgres ready, checking database schema..."

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
