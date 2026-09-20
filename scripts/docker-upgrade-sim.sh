#!/usr/bin/env bash
#
# docker-upgrade-sim.sh - real Docker upgrade-path simulation for MMH images.
#
# Background (migration-failure-ledger section 23, 2026-09-20 incident):
#   The shared dev/production Postgres is always already at the latest
#   schema, so restarting a container locally never exercises the real
#   old-DB -> new-image upgrade path. This harness reproduces it:
#     1. scratch Postgres container on a throwaway network + volume
#     2. seed it with the schema a *published base image* itself ships
#        (the base image's own prisma CLI + prisma/schema.prisma)
#     3. boot the *target* image's real entrypoint against that database
#     4. assert the startup schema sync actually worked:
#        - entrypoint reached "starting app..." (no REFUSING TO START)
#        - /api/health returns 200
#        - _mmh_schema_meta.schema_version == target package.json version
#          (the marker is only written after a successful db push)
#        - every base table:column still exists (no silent drops)
#        - a second container start reports a no-op push and stays healthy
#     5. full teardown
#
# Usage:
#   docker-upgrade-sim.sh <target-image-tag> [base-image-tag ...]
#   TARGET_TAG=0.1.63 BASE_TAGS="0.1.62 0.1.52" docker-upgrade-sim.sh
#
# Tags are GHCR *image* tags (no leading v), e.g. 0.1.63 not v0.1.63.
# Without arguments, BASE_TAGS defaults to 0.1.52 (official upgrade floor).
#
# Environment overrides:
#   MMH_IMAGE_REPO  default ghcr.io/frankluise5220/mmh
#   MMH_TARGET_IMAGE  full image name for the target when it is not a GHCR
#                     tag of MMH_IMAGE_REPO (e.g. a locally built image for
#                     a pre-release pre-run). Skips the target pull; the
#                     image must already exist locally.
#   PG_IMAGE        default postgres:15-alpine
#   SIM_KEEP=1      keep failed case containers/network/volumes for inspection
#   APP_WAIT_S      entrypoint wait budget, default 300
#   HEALTH_WAIT_S   /api/health wait budget, default 180
#   PG_WAIT_S       postgres ready wait budget, default 120
#
# Exit code: 0 when every case PASSes, 1 otherwise, 2 on usage errors.

set -u
export LC_ALL=C

MMH_IMAGE_REPO="${MMH_IMAGE_REPO:-ghcr.io/frankluise5220/mmh}"
MMH_TARGET_IMAGE="${MMH_TARGET_IMAGE:-}"
PG_IMAGE="${PG_IMAGE:-postgres:15-alpine}"
APP_WAIT_S="${APP_WAIT_S:-300}"
HEALTH_WAIT_S="${HEALTH_WAIT_S:-180}"
PG_WAIT_S="${PG_WAIT_S:-120}"

if [ "$#" -ge 1 ]; then
  TARGET_TAG="$1"
  shift
  BASE_TAGS="$*"
else
  TARGET_TAG="${TARGET_TAG:-}"
  BASE_TAGS="${BASE_TAGS:-0.1.52}"
fi

usage() {
  cat >&2 <<'EOF'
Usage: docker-upgrade-sim.sh <target-image-tag> [base-image-tag ...]
   or: TARGET_TAG=0.1.63 BASE_TAGS="0.1.62 0.1.52" docker-upgrade-sim.sh

Tags are GHCR image tags without a leading v (0.1.63, not v0.1.63).
EOF
  exit 2
}

[ -n "$TARGET_TAG" ] || usage
[ -n "$BASE_TAGS" ] || BASE_TAGS="0.1.52"

# Full reference of the target image. Defaults to the GHCR tag; the
# override exists so a locally built image can be simulated before the
# release build exists (CI never sets it, so CI behavior is unchanged).
TARGET_IMAGE="$MMH_TARGET_IMAGE"
[ -n "$TARGET_IMAGE" ] || TARGET_IMAGE="$MMH_IMAGE_REPO:$TARGET_TAG"

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mmh-upgrade-sim.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

declare -A CASE_RESULT=()
declare -A CASE_REASON=()
ORDERED_LABELS=()

slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/[^a-z0-9]/-/g' -e 's/--*/-/g' -e 's/^-//' -e 's/-$//'
}

set_result() { # $1 label $2 PASS|FAIL $3 reason
  CASE_RESULT["$1"]="$2"
  [ -n "${3:-}" ] && CASE_REASON["$1"]="$3"
}

cleanup_case() { # $1 app $2 pg $3 net $4 vol [$5 extra disposable container]
  docker rm -f "$1" >/dev/null 2>&1 || true
  docker rm -f "$2" >/dev/null 2>&1 || true
  [ -n "${5:-}" ] && docker rm -f "$5" >/dev/null 2>&1 || true
  docker network rm "$3" >/dev/null 2>&1 || true
  docker volume rm "$4" >/dev/null 2>&1 || true
}

wait_pg_ready() { # $1 pg container
  local i=0
  while [ "$i" -lt "$PG_WAIT_S" ]; do
    docker exec "$1" pg_isready -U mmh -d mmh >/dev/null 2>&1 && return 0
    sleep 2
    i=$((i + 2))
  done
  return 1
}

app_healthy() { # $1 app container
  docker exec "$1" node -e "fetch('http://127.0.0.1:7777/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

wait_health() { # $1 app container
  local i=0
  while [ "$i" -lt "$HEALTH_WAIT_S" ]; do
    app_healthy "$1" && return 0
    sleep 3
    i=$((i + 3))
  done
  return 1
}

list_db_objects() { # $1 pg container
  docker exec "$1" psql -U mmh -d mmh -tAc \
    "SELECT table_name||':'||column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY 1"
}

# Runs one simulation case. $1 label, $2 seed image tag or "empty".
# Returns 0 on PASS, 1 on FAIL (reason in CASE_REASON).
run_case() {
  local label="$1" seed="$2"
  local prefix="mmhsim-$(slug "$TARGET_TAG")-$(slug "$label")-$$"
  local app="$prefix-app" pg="$prefix-pg" net="$prefix-net" vol="$prefix-vol"
  local reason="" rc=0

  ORDERED_LABELS+=("$label")
  log "=== case: $label (seed=$seed target=$TARGET_TAG) ==="

  docker network create "$net" >/dev/null 2>&1 \
    || { reason="docker network create failed"; rc=1; }

  if [ "$rc" -eq 0 ]; then
    docker run -d --name "$pg" --network "$net" \
      -e POSTGRES_USER=mmh -e POSTGRES_PASSWORD=mmh -e POSTGRES_DB=mmh \
      "$PG_IMAGE" >/dev/null 2>&1 \
      || { reason="postgres container start failed"; rc=1; }
  fi

  if [ "$rc" -eq 0 ] && ! wait_pg_ready "$pg"; then
    docker logs "$pg" > "$WORK/$label.pg.log" 2>&1 || true
    reason="postgres did not become ready within ${PG_WAIT_S}s"
    rc=1
  fi

  if [ "$rc" -eq 0 ] && [ "$seed" != "empty" ]; then
    log "case $label: pulling base image $MMH_IMAGE_REPO:$seed"
    docker pull "$MMH_IMAGE_REPO:$seed" > "$WORK/$label.pull-base.log" 2>&1 \
      || { reason="pulling base image $seed failed (see pull log)"; rc=1; }

    if [ "$rc" -eq 0 ]; then
      log "case $label: generating base schema with the base image's own prisma"
      # prisma.config.ts in the image loads dotenv 17, which prints an
      # "injected env" banner to stdout; strip it so the dump is pure SQL.
      # Env flags must come before the image name, otherwise docker passes
      # them to the entrypoint as arguments. The dummy DATABASE_URL satisfies
      # prisma.config.ts (datasource.url) although migrate diff does not
      # connect.
      if ! docker run --rm --entrypoint ./node_modules/.bin/prisma \
            -e DOTENV_CONFIG_QUIET=true \
            -e DATABASE_URL='postgresql://mmh:mmh@localhost:5432/mmh?schema=public' \
            "$MMH_IMAGE_REPO:$seed" \
            migrate diff --from-empty --to-schema prisma/schema.prisma --script \
            > "$WORK/$label.base-schema.raw" 2> "$WORK/$label.base-schema.err"; then
        reason="base image prisma migrate diff failed: $(tail -n 2 "$WORK/$label.base-schema.err" | tr '\n' ' ')"
        rc=1
      elif ! grep -av "injected env" "$WORK/$label.base-schema.raw" > "$WORK/$label.base-schema.sql" || [ ! -s "$WORK/$label.base-schema.sql" ]; then
        reason="base image produced an unusable schema dump"
        rc=1
      elif ! docker exec -i "$pg" psql -U mmh -d mmh -v ON_ERROR_STOP=1 \
               < "$WORK/$label.base-schema.sql" > "$WORK/$label.seed-psql.log" 2>&1; then
        reason="seeding psql failed: $(tail -n 2 "$WORK/$label.seed-psql.log" | tr '\n' ' ')"
        rc=1
      fi
    fi

    if [ "$rc" -eq 0 ]; then
      list_db_objects "$pg" > "$WORK/$label.base-objects.txt" \
        || { reason="base object capture failed"; rc=1; }
      log "case $label: seeded $(wc -l < "$WORK/$label.base-objects.txt" | tr -d ' ') table:column objects"
    fi

    if [ "$rc" -eq 0 ]; then
      # Recreate the pre-Prisma legacy table (never part of any
      # schema.prisma) with one row so the target's inlined compat
      # migration is actually exercised: it must migrate the row away
      # and DROP the table. type='transfer' is excluded from the
      # income/expense CTE, so no FK rows are needed. Captured after
      # base-objects so its legitimate removal is not flagged.
      cat > "$WORK/$label.legacy.sql" <<'LEGACY_SQL'
CREATE TABLE IF NOT EXISTS "statement_category_rules" (
  "id" TEXT PRIMARY KEY,
  "householdId" TEXT,
  "type" TEXT,
  "matchText" TEXT,
  "normalizedText" TEXT,
  "categoryId" TEXT,
  "categoryName" TEXT,
  "source" TEXT,
  "counterpartyInstitutionName" TEXT,
  "paymentChannelName" TEXT,
  "hitCount" INTEGER,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3)
);
INSERT INTO "statement_category_rules" ("id", "householdId", "type", "source")
VALUES ('legacy-scr-1', 'hh-sim', 'transfer', 'user');
LEGACY_SQL
      if ! docker exec -i "$pg" psql -U mmh -d mmh -v ON_ERROR_STOP=1 \
               < "$WORK/$label.legacy.sql" > "$WORK/$label.legacy-psql.log" 2>&1; then
        reason="legacy statement_category_rules seeding failed: $(tail -n 2 "$WORK/$label.legacy-psql.log" | tr '\n' ' ')"
        rc=1
      else
        log "case $label: legacy statement_category_rules table + row installed"
      fi
    fi
  fi

  if [ "$rc" -eq 0 ]; then
    if [ -n "$MMH_TARGET_IMAGE" ]; then
      log "case $label: using local target image $TARGET_IMAGE"
    else
      log "case $label: pulling target image $TARGET_IMAGE"
      docker pull "$TARGET_IMAGE" > "$WORK/$label.pull-target.log" 2>&1 \
        || { reason="pulling target image $TARGET_IMAGE failed (see pull log)"; rc=1; }
    fi
  fi

  local target_version=""
  if [ "$rc" -eq 0 ]; then
    target_version="$(docker run --rm --entrypoint node "$TARGET_IMAGE" \
      -p "require('./package.json').version" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$target_version" ] || { reason="cannot read package.json version from target image"; rc=1; }
  fi

  if [ "$rc" -eq 0 ]; then
    docker volume create "$vol" >/dev/null 2>&1 || { reason="docker volume create failed"; rc=1; }
  fi

  if [ "$rc" -eq 0 ]; then
    log "case $label: booting target image v$target_version"
    docker run -d --name "$app" --network "$net" \
      -e DATABASE_URL="postgresql://mmh:mmh@${pg}:5432/mmh?schema=public" \
      -e PGHOST="$pg" \
      -e POSTGRES_DB=mmh -e POSTGRES_USER=mmh -e POSTGRES_PASSWORD=mmh -e PGPASSWORD=mmh \
      -e DOCKER_CONTAINER=true -e NODE_ENV=production -e MMH_UPDATE_TOKEN=sim \
      -v "$vol:/app/data" \
      "$TARGET_IMAGE" >/dev/null 2>&1 \
      || { reason="app container start failed"; rc=1; }
  fi

  if [ "$rc" -eq 0 ]; then
    local state="timeout" i=0 status case_log
    while [ "$i" -lt "$APP_WAIT_S" ]; do
      status="$(docker inspect -f '{{.State.Status}}' "$app" 2>/dev/null || echo missing)"
      if [ "$status" != "running" ]; then state="exited"; break; fi
      case_log="$(docker logs "$app" 2>&1 || true)"
      if printf '%s\n' "$case_log" | grep -q "REFUSING TO START"; then state="refused"; break; fi
      if printf '%s\n' "$case_log" | grep -q "starting app\.\.\."; then state="booted"; break; fi
      sleep 3
      i=$((i + 3))
    done
    docker logs "$app" > "$WORK/$label.boot.log" 2>&1 || true
    if [ "$state" != "booted" ]; then
      reason="entrypoint terminal state '$state' (not 'booted'); [mmh] tail: $(grep -a '\[mmh\]' "$WORK/$label.boot.log" | tail -n 6 | tr '\n' '|')"
      rc=1
    fi
  fi

  if [ "$rc" -eq 0 ] && ! wait_health "$app"; then
    reason="/api/health not OK within ${HEALTH_WAIT_S}s after boot"
    rc=1
  fi

  if [ "$rc" -eq 0 ]; then
    local marker
    marker="$(docker exec "$pg" psql -U mmh -d mmh -tAc \
      "SELECT value FROM \"_mmh_schema_meta\" WHERE key='schema_version'" 2>/dev/null | tr -d '[:space:]')"
    if [ "$marker" != "$target_version" ]; then
      reason="schema marker '${marker:-<absent>}' != target version '$target_version'"
      rc=1
    else
      log "case $label: schema marker recorded as $marker"
    fi
  fi

  if [ "$rc" -eq 0 ] && [ "$seed" != "empty" ]; then
    list_db_objects "$pg" > "$WORK/$label.after-objects.txt" \
      || { reason="post-upgrade object capture failed"; rc=1; }

    if [ "$rc" -eq 0 ]; then
      sort "$WORK/$label.base-objects.txt" > "$WORK/$label.base-objects.sorted"
      sort "$WORK/$label.after-objects.txt" > "$WORK/$label.after-objects.sorted"
      local dropped
      dropped="$(comm -23 "$WORK/$label.base-objects.sorted" "$WORK/$label.after-objects.sorted")"
      if [ -n "$dropped" ]; then
        reason="pre-existing objects missing after upgrade: $(printf '%s' "$dropped" | head -c 400 | tr '\n' ' ')"
        rc=1
      else
        log "case $label: no pre-existing table:column dropped"
      fi
    fi

    if [ "$rc" -eq 0 ]; then
      local legacy_present
      legacy_present="$(docker exec "$pg" psql -U mmh -d mmh -tAc \
        "SELECT to_regclass('public.statement_category_rules') IS NOT NULL" 2>/dev/null | tr -d '[:space:]')"
      if [ "$legacy_present" = "t" ]; then
        reason="legacy statement_category_rules table still present after compat migration"
        rc=1
      else
        log "case $label: legacy statement_category_rules removed by compat migration"
      fi
    fi
  fi

  # Golden superset check: seed a throwaway postgres with the target's own
  # from-empty schema (the full schema a successful push would produce) and
  # assert every one of its table:column objects exists in the upgraded
  # database. Catches a silently failed push (stale schema) that the
  # base-objects check above cannot see.
  local golden=""
  if [ "$rc" -eq 0 ]; then
    log "case $label: golden superset check (target's own from-empty schema)"
    if ! docker run --rm --entrypoint ./node_modules/.bin/prisma \
          -e DOTENV_CONFIG_QUIET=true \
          -e DATABASE_URL='postgresql://mmh:mmh@localhost:5432/mmh?schema=public' \
          "$TARGET_IMAGE" \
          migrate diff --from-empty --to-schema prisma/schema.prisma --script \
          > "$WORK/$label.target-schema.raw" 2> "$WORK/$label.target-schema.err"; then
      reason="target image prisma migrate diff failed: $(tail -n 2 "$WORK/$label.target-schema.err" | tr '\n' ' ')"
      rc=1
    elif ! grep -av "injected env" "$WORK/$label.target-schema.raw" > "$WORK/$label.target-schema.sql" || [ ! -s "$WORK/$label.target-schema.sql" ]; then
      reason="target image produced an unusable schema dump"
      rc=1
    fi
  fi

  if [ "$rc" -eq 0 ]; then
    golden="$prefix-golden"
    if ! docker run -d --name "$golden" --network "$net" \
          -e POSTGRES_USER=mmh -e POSTGRES_PASSWORD=mmh -e POSTGRES_DB=mmh \
          "$PG_IMAGE" >/dev/null 2>&1; then
      reason="golden postgres container start failed"
      rc=1
    elif ! wait_pg_ready "$golden"; then
      docker logs "$golden" > "$WORK/$label.golden.pg.log" 2>&1 || true
      reason="golden postgres did not become ready within ${PG_WAIT_S}s"
      rc=1
    elif ! docker exec -i "$golden" psql -U mmh -d mmh -v ON_ERROR_STOP=1 \
             < "$WORK/$label.target-schema.sql" > "$WORK/$label.golden-psql.log" 2>&1; then
      reason="golden schema seeding failed: $(tail -n 2 "$WORK/$label.golden-psql.log" | tr '\n' ' ')"
      rc=1
    fi
  fi

  if [ "$rc" -eq 0 ] && [ -n "$golden" ]; then
    if ! list_db_objects "$golden" > "$WORK/$label.golden-objects.txt"; then
      reason="golden object capture failed"
      rc=1
    elif ! list_db_objects "$pg" > "$WORK/$label.final-objects.txt"; then
      reason="final object capture failed"
      rc=1
    fi
  fi

  if [ "$rc" -eq 0 ] && [ -n "$golden" ]; then
    sort "$WORK/$label.golden-objects.txt" > "$WORK/$label.golden-objects.sorted"
    sort "$WORK/$label.final-objects.txt" > "$WORK/$label.final-objects.sorted"
    local missing
    missing="$(comm -23 "$WORK/$label.golden-objects.sorted" "$WORK/$label.final-objects.sorted")"
    if [ -n "$missing" ]; then
      reason="target schema objects missing after upgrade (schema push likely failed silently): $(printf '%s' "$missing" | head -c 400 | tr '\n' ' ')"
      rc=1
    else
      log "case $label: full target schema present ($(wc -l < "$WORK/$label.golden-objects.sorted" | tr -d ' ') objects)"
    fi
  fi

  local since_ts=""
  if [ "$rc" -eq 0 ]; then
    log "case $label: second boot (idempotency check)"
    since_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    docker stop "$app" >/dev/null 2>&1 || true
    docker start "$app" >/dev/null 2>&1 || { reason="second docker start failed"; rc=1; }
  fi

  if [ "$rc" -eq 0 ]; then
    local state2="timeout" i=0 status
    while [ "$i" -lt "$APP_WAIT_S" ]; do
      status="$(docker inspect -f '{{.State.Status}}' "$app" 2>/dev/null || echo missing)"
      if [ "$status" != "running" ]; then state2="exited"; break; fi
      if docker logs --since "$since_ts" "$app" 2>&1 | grep -q "skipping prisma db push"; then
        state2="noop"; break
      fi
      sleep 3
      i=$((i + 3))
    done
    if [ "$state2" != "noop" ]; then
      reason="second boot did not report a no-op push (state '$state2')"
      rc=1
    fi
  fi

  if [ "$rc" -eq 0 ] && ! wait_health "$app"; then
    reason="/api/health not OK within ${HEALTH_WAIT_S}s after second boot"
    rc=1
  fi

  if [ "$rc" -eq 0 ]; then
    log "=== case: $label PASS ==="
  else
    log "=== case: $label FAIL: $reason ==="
  fi

  if [ "$rc" -ne 0 ] && [ -n "${SIM_KEEP:-}" ]; then
    log "case $label: SIM_KEEP=1 - leaving $app / $pg / $net / $vol for inspection"
  else
    cleanup_case "$app" "$pg" "$net" "$vol" "$golden"
  fi

  set_result "$label" "$([ "$rc" -eq 0 ] && echo PASS || echo FAIL)" "$reason"
  return "$rc"
}

# --- preflight ---------------------------------------------------------------
command -v docker >/dev/null 2>&1 || { echo "ERROR: docker CLI not found" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "ERROR: docker daemon not reachable" >&2; exit 2; }

if [ -n "$MMH_TARGET_IMAGE" ]; then
  docker image inspect "$TARGET_IMAGE" >/dev/null 2>&1 \
    || { echo "ERROR: target image $TARGET_IMAGE not found locally" >&2; exit 2; }
fi

log "MMH Docker upgrade simulation"
log "image repo : $MMH_IMAGE_REPO"
log "target image: $TARGET_IMAGE"
log "target tag : $TARGET_TAG"
log "base tags  : $BASE_TAGS"
log "pg image   : $PG_IMAGE"

BASES=()
for t in $BASE_TAGS; do
  [ "$t" = "$TARGET_TAG" ] && continue
  case " ${BASES[*]:-} " in
    *" $t "*) continue ;;
  esac
  BASES+=("$t")
done

OVERALL=0
for t in ${BASES[@]+"${BASES[@]}"}; do
  if ! run_case "upgrade-from-$t" "$t"; then OVERALL=1; fi
done
if ! run_case "fresh-install" "empty"; then OVERALL=1; fi

# --- report -------------------------------------------------------------------
echo
printf '%-32s %s\n' "CASE" "RESULT"
printf '%-32s %s\n' "----" "------"
for label in ${ORDERED_LABELS[@]+"${ORDERED_LABELS[@]}"}; do
  printf '%-32s %s\n' "$label" "${CASE_RESULT[$label]}"
  if [ "${CASE_RESULT[$label]}" = "FAIL" ]; then
    printf '%-32s %s\n' "" "reason: ${CASE_REASON[$label]:-unknown}"
  fi
done
echo "SIM_DONE overall=$OVERALL"
exit "$OVERALL"
