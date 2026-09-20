#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const entrypoint = fs.readFileSync(path.join(root, "scripts", "docker-entrypoint.sh"), "utf8");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const rootCompose = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
const nasCompose = fs.readFileSync(path.join(root, "deploy", "nas", "docker-compose.yml"), "utf8");
const nasEnvExample = fs.readFileSync(path.join(root, "deploy", "nas", "env.example"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker-build.yml"), "utf8");
const healthRoute = fs.readFileSync(path.join(root, "src", "app", "api", "health", "route.ts"), "utf8");
const prismaDb = fs.readFileSync(path.join(root, "src", "lib", "db", "prisma.ts"), "utf8");
const prismaSchema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const standaloneStart = fs.readFileSync(path.join(root, "scripts", "start-standalone.cjs"), "utf8");
const systemUpdateRoute = fs.readFileSync(path.join(root, "src", "app", "api", "v1", "settings", "system-update", "route.ts"), "utf8");
const updaterServer = fs.readFileSync(path.join(root, "scripts", "mmh-updater-server.mjs"), "utf8");
const failures = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

expect(/gosu/.test(dockerfile), "Dockerfile must install gosu so the runtime can drop root privileges.");
expect(/COPY --chown=node:node --from=build/.test(dockerfile), "Dockerfile must copy app files as node-owned files.");
expect(/ensure_session_secret/.test(entrypoint), "Docker entrypoint must generate and persist MMH_SESSION_SECRET when it is not configured.");

expect(/_mmh_schema_meta/.test(entrypoint) && /refuse_if_schema_newer/.test(entrypoint), "Docker entrypoint must run the schema downgrade protection check before touching the database schema.");
expect(/REFUSING TO START/.test(entrypoint) && /exit 78/.test(entrypoint), "Docker entrypoint must refuse to start when the database schema is newer than the image.");
expect(
  /model MmhSchemaMeta/.test(prismaSchema) && /@@map\("_mmh_schema_meta"\)/.test(prismaSchema),
  "prisma/schema.prisma must declare the _mmh_schema_meta table; 'prisma db push' silently drops tables it does not own, which broke the downgrade-protection marker in 0.1.60-0.1.63.",
);
expect(/record_schema_version "\$\(get_build_version\)"/.test(entrypoint), "Docker entrypoint must record the image schema version after a successful schema sync.");
expect(
  /attempt=1/.test(entrypoint) && /while \[ "\$attempt" -le 3 \]/.test(entrypoint) && entrypoint.includes("record_schema_version"),
  "Docker entrypoint must retry the schema meta table ensure and version record (a transient DB timeout on 2026-09-14 silently disabled downgrade protection on a production deployment).",
);
const schemaGuardIndex = entrypoint.indexOf("refuse_if_schema_newer\nrun_compat_migrations");
const dbPushIndex = entrypoint.indexOf("prisma db push >");
expect(schemaGuardIndex >= 0 && dbPushIndex >= 0 && schemaGuardIndex < dbPushIndex, "Docker entrypoint must check for a newer database schema before any schema sync runs.");

const nodeLimitCallIndex = entrypoint.indexOf("\napply_node_memory_limit\n");
const prismaPushIndex = entrypoint.indexOf("prisma db push");
expect(/ENV MMH_NODE_MAX_OLD_SPACE_MB=auto/.test(dockerfile), "Dockerfile must default the Node old-space limit to auto.");
expect(/ENV PG_POOL_MAX=4/.test(dockerfile), "Dockerfile must default the app database pool to a NAS-friendly size.");
expect(
  /apply_node_memory_limit/.test(entrypoint) &&
    /MMH_NODE_MAX_OLD_SPACE_MB="\$\{MMH_NODE_MAX_OLD_SPACE_MB:-auto\}"/.test(entrypoint) &&
    /recommended_node_old_space_mb/.test(entrypoint) &&
    /detect_runtime_memory_limit_mb/.test(entrypoint) &&
    /--max-old-space-size=\$MMH_NODE_MAX_OLD_SPACE_MB/.test(entrypoint) &&
    nodeLimitCallIndex >= 0 &&
    prismaPushIndex >= 0 &&
    nodeLimitCallIndex < prismaPushIndex,
  "Docker entrypoint must apply the Node old-space guardrail before Prisma schema sync and app start.",
);
for (const [name, compose] of [
  ["repo docker-compose.yml", rootCompose],
  ["NAS docker-compose.yml", nasCompose],
]) {
  expect(/mem_limit:\s*\$\{MMH_APP_MEMORY_LIMIT:-1536m\}/.test(compose), `${name} must cap mmh-app memory by default.`);
  expect(/MMH_APP_MEMORY_LIMIT:\s*\$\{MMH_APP_MEMORY_LIMIT:-1536m\}/.test(compose), `${name} must pass the app memory limit into the health diagnostics.`);
  expect(/MMH_NODE_MAX_OLD_SPACE_MB:\s*\$\{MMH_NODE_MAX_OLD_SPACE_MB:-auto\}/.test(compose), `${name} must expose the auto Node old-space limit.`);
  expect(/PG_POOL_MAX:\s*\$\{PG_POOL_MAX:-4\}/.test(compose), `${name} must expose a NAS-friendly PostgreSQL pool size.`);
  expect(
    /healthcheck:/.test(compose) &&
      /\/api\/health/.test(compose) &&
      /start_period:\s*90s/.test(compose),
    `${name} must define an app healthcheck against /api/health with a startup grace period.`,
  );
}
for (const [name, compose] of [
  ["repo docker-compose.yml", rootCompose],
  ["NAS docker-compose.yml", nasCompose],
]) {
  expect(/^name:\s*mmh\s*$/m.test(compose), `${name} must pin the Compose project name to mmh.`);
}
expect(/COMPOSE_PROJECT_NAME="mmh"/.test(nasEnvExample), "NAS env.example must pin COMPOSE_PROJECT_NAME to mmh.");
expect(/MMH_COMPOSE_PROJECT="mmh"/.test(nasEnvExample), "NAS env.example must pin MMH_COMPOSE_PROJECT to mmh.");
expect(/MMH_APP_MEMORY_LIMIT="1536m"/.test(nasEnvExample), "NAS env.example must expose the Docker app memory limit.");
expect(/MMH_NODE_MAX_OLD_SPACE_MB="auto"/.test(nasEnvExample), "NAS env.example must expose the auto Node old-space limit.");
expect(/PG_POOL_MAX="4"/.test(nasEnvExample), "NAS env.example must expose the PostgreSQL pool size.");
expect(
  /process\.memoryUsage/.test(healthRoute) &&
    /getHeapStatistics/.test(healthRoute) &&
    /totalmem/.test(healthRoute) &&
    /freemem/.test(healthRoute) &&
    /constrainedMemory/.test(healthRoute) &&
    /getConfiguredPgPoolMax/.test(healthRoute) &&
    /runtime:\s*runtimeDiagnostics\(\)/.test(healthRoute) &&
    /status:\s*db === "ok" \? 200 : 503/.test(healthRoute),
  "/api/health must report runtime memory diagnostics without failing readiness solely on memory pressure.",
);
expect(
  /const defaultNodeMaxOldSpaceMb = "auto"/.test(standaloneStart) &&
    /recommendedNodeMaxOldSpaceMb/.test(standaloneStart) &&
    /processConstrainedMemoryMb/.test(standaloneStart) &&
    /os\.totalmem/.test(standaloneStart),
  "Standalone start must derive the Node old-space limit from process or host memory when set to auto.",
);
expect(
  /export function getConfiguredPgPoolMax/.test(prismaDb) &&
    /Number\.isInteger\(configured\) && configured > 0/.test(prismaDb) &&
    /max:\s*getConfiguredPgPoolMax\(\)/.test(prismaDb),
  "Prisma PostgreSQL pool size must use a validated NAS-friendly default when PG_POOL_MAX is absent or invalid.",
);

expect(
  /'consumer'::\\"LoanType\\"/.test(entrypoint) && /'home'::\\"LoanType\\"/.test(entrypoint),
  "Docker Account.loanType backfill must cast CASE branches to the PostgreSQL LoanType enum.",
);

expect(
  /"kind\\" = 'loan'::\\"AccountKind\\"/.test(entrypoint) && /"kind\\" = 'settlement'::\\"AccountKind\\"/.test(entrypoint),
  "Docker account-kind compatibility updates must cast AccountKind enum values explicitly.",
);

expect(
  /"institutionId\\" = NULL/.test(entrypoint) &&
    /WHERE \\"kind\\" = 'loan'::\\"AccountKind\\" AND \\"counterpartyId\\" IS NOT NULL/.test(entrypoint),
  "Docker settlement-account cleanup must normalize every legacy counterparty loan account and clear institution links.",
);

expect(
  /migrate_debt_agreement_rekey/.test(entrypoint) &&
    /ADD COLUMN IF NOT EXISTS "accountId"/.test(entrypoint) &&
    /DROP COLUMN IF EXISTS "entryId"/.test(entrypoint),
  "Docker entrypoint must rekey legacy DebtAgreement.entryId to accountId before db push so schema sync never refuses on the rekey.",
);

expect(
  /fallback_debt_agreement_records/.test(entrypoint) &&
    /records retained, conflicting constraints removed/.test(entrypoint) &&
    /DROP INDEX IF EXISTS "DebtAgreement_accountId_key"/.test(entrypoint),
  "Docker entrypoint must preserve DebtAgreement records and strip conflicting constraints when the rekey fails.",
);

expect(
  /PUSH_ATTEMPTS=5/.test(entrypoint) &&
    /retrying in 3s/.test(entrypoint) &&
    /ERROR: prisma db push failed after retries; refusing to start/.test(entrypoint) &&
    /ERROR: database schema sync would modify existing data; refusing to start/.test(entrypoint) &&
    /exit 78/.test(entrypoint) &&
    !/starting anyway so MMH stays available/.test(entrypoint),
  "Docker entrypoint must retry prisma db push and then fail loudly when schema sync fails, so the app never runs against a stale schema.",
);

expect(
  /schema already at \$build_version; skipping prisma db push/.test(entrypoint) &&
    /drop_empty_prisma_copy_tables/.test(entrypoint) &&
    entrypoint.indexOf("drop_empty_prisma_copy_tables") < entrypoint.indexOf("schema already at $build_version; skipping prisma db push."),
  "Docker entrypoint must drop empty Prisma leftover copy tables even when the schema version already matches.",
);

expect(
  /leaving nonempty Prisma leftover table/.test(entrypoint) &&
    /refusing to drop it/.test(entrypoint) &&
    /nonempty Prisma leftover copy tables exist; refusing to run schema sync/.test(entrypoint) &&
    /MMH will not start until those leftover tables are reviewed/.test(entrypoint) &&
    !/DROP TABLE IF EXISTS \$\{table\};[\s\S]*row_count/.test(entrypoint.replace(/if \[ "\$row_count" = "0" \]; then[\s\S]*DROP TABLE IF EXISTS \$\{table\};/, "")),
  "Docker entrypoint must never drop nonempty Prisma leftover copy tables, and must refuse to start while they remain.",
);

expect(
  /ensure_auth_version_column/.test(entrypoint) &&
    /ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "authVersion"/.test(entrypoint) &&
    entrypoint.indexOf("ensure_auth_version_column") > entrypoint.indexOf("run_compat_migrations") &&
    entrypoint.indexOf("ensure_auth_version_column") < entrypoint.indexOf("prisma db push >"),
  "Docker entrypoint must ensure User.authVersion after compatibility migrations and before schema sync.",
);

expect(
  /push_would_change_existing_data/.test(entrypoint) &&
    /not retrying/.test(entrypoint) &&
    /would change existing data; not retrying/.test(entrypoint),
  "Docker entrypoint must not retry prisma db push when the plan would change or drop existing data.",
);

expect(/npm run check:docker/.test(workflow), "Docker image workflow must run check:docker before publishing images.");
expect(/tags:\s*\n\s*-\s*"v\*"/.test(workflow), "Docker image workflow must run on v* tag pushes.");
expect(/type=raw,value=latest,enable=\$\{\{\s*startsWith\(github\.ref,\s*'refs\/tags\/v'\)\s*\}\}/.test(workflow), "Docker workflow must publish latest only from v* release tags.");
expect(/type=semver,pattern=\{\{version\}\},enable=\$\{\{\s*startsWith\(github\.ref,\s*'refs\/tags\/v'\)\s*\}\}/.test(workflow), "Docker workflow must publish the version tag only from v* release tags.");
expect(/type=raw,value=main,enable=\$\{\{\s*endsWith\(github\.ref,\s*'\/heads\/main'\)\s*\}\}/.test(workflow), "Docker workflow must publish main snapshots without moving latest.");

expect(
  /\/releases\/latest/.test(systemUpdateRoute) &&
    /git ls-remote --tags/.test(systemUpdateRoute) &&
    /IMAGE_FALLBACK_ORDER = \["fnvps", "dockerproxy", "nju", "ghcr", "daocloud", "custom"\]/.test(systemUpdateRoute) &&
    !/raw\.githubusercontent\.com\/frankluise5220\/MMH\/main\/package\.json/.test(systemUpdateRoute) &&
    !/refs\/heads\/main/.test(systemUpdateRoute),
  "Docker update version checks must use the latest GitHub Release/tag and image mirrors, not the main branch.",
);

expect(
  /const autoImageSourceOrder = \["fnvps", "dockerproxy", "nju", "ghcr", "daocloud"\]/.test(updaterServer) &&
    updaterServer.indexOf("if [ -f /updater/deploy/docker-compose.yml ]; then") >= 0 &&
    updaterServer.indexOf("git -C ${quotedWorkdir} pull --ff-only;") >
      updaterServer.indexOf("if [ -f /updater/deploy/docker-compose.yml ]; then"),
  "Docker updater must prefer release-bundled deploy files before falling back to git pull.",
);

expect(
  /\.mmh-used-images\.json/.test(updaterServer) &&
    /recordRunningMmhImages/.test(updaterServer) &&
    /recordPulledImages/.test(updaterServer) &&
    /imageIdsToRemove/.test(updaterServer) &&
    /docker rmi/.test(updaterServer) &&
    !/docker image prune/.test(updaterServer) &&
    !/docker rmi -f/.test(updaterServer) &&
    /未能确认新镜像 ID，跳过历史镜像清理/.test(updaterServer),
  "Docker updater must record MMH image IDs and delete only those historical IDs after a successful update, never prune all unused host images.",
);

if (failures.length > 0) {
  console.error("Docker entrypoint check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Docker entrypoint check passed.");
