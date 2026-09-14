const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const nextDir = path.join(rootDir, ".next");
const standaloneDir = path.join(nextDir, "standalone");
const standaloneNextDir = path.join(standaloneDir, ".next");
const serverFile = path.join(standaloneDir, "server.js");
const buildIdFile = path.join(nextDir, "BUILD_ID");
const markerFile = path.join(standaloneNextDir, "runtime-sync.json");
const defaultNodeMaxOldSpaceMb = "auto";
const bytesPerMb = 1024 * 1024;

function bytesToMb(bytes) {
  return Math.floor(bytes / bytesPerMb);
}

function parseMemoryLimitMb(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  if (!trimmed || trimmed === "auto" || trimmed === "max") return null;
  const match = /^(\d+)(b|kb|k|mb|m|gb|g)?$/.exec(trimmed);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = match[2] || "mb";
  if (unit === "b") return Math.floor(amount / bytesPerMb);
  if (unit === "kb" || unit === "k") return Math.floor(amount / 1024);
  if (unit === "gb" || unit === "g") return amount * 1024;
  return amount;
}

function processConstrainedMemoryMb() {
  if (typeof process.constrainedMemory !== "function") return null;
  const bytes = process.constrainedMemory();
  return Number.isFinite(bytes) && bytes > 0 ? bytesToMb(bytes) : null;
}

function recommendedNodeMaxOldSpaceMb(env) {
  const runtimeLimitMb =
    parseMemoryLimitMb(env.MMH_APP_MEMORY_LIMIT) ?? processConstrainedMemoryMb() ?? bytesToMb(os.totalmem());
  if (!Number.isFinite(runtimeLimitMb) || runtimeLimitMb <= 0) return "768";
  if (runtimeLimitMb < 1280) return "384";
  if (runtimeLimitMb < 3072) return "768";
  if (runtimeLimitMb < 6144) return "1024";
  return "1536";
}

function resolveNodeMaxOldSpaceMb(env) {
  const configured = String(env.MMH_NODE_MAX_OLD_SPACE_MB || defaultNodeMaxOldSpaceMb).trim();
  if (!configured || configured.toLowerCase() === "auto") return recommendedNodeMaxOldSpaceMb(env);
  if (/^\d+$/.test(configured) && Number(configured) > 0) return configured;
  console.warn("[mmh] Invalid MMH_NODE_MAX_OLD_SPACE_MB; falling back to auto.");
  return recommendedNodeMaxOldSpaceMb(env);
}

function withDefaultNodeOptions(env) {
  const maxOldSpaceMb = resolveNodeMaxOldSpaceMb(env);
  const nodeOptions = env.NODE_OPTIONS || "";
  const hasOldSpaceLimit =
    nodeOptions.includes("--max-old-space-size") || nodeOptions.includes("--max_old_space_size");

  return {
    ...env,
    MMH_NODE_MAX_OLD_SPACE_MB: maxOldSpaceMb,
    NODE_OPTIONS: hasOldSpaceLimit
      ? nodeOptions
      : `${nodeOptions ? `${nodeOptions} ` : ""}--max-old-space-size=${maxOldSpaceMb}`,
  };
}

function ensureBuildArtifacts() {
  if (!fs.existsSync(serverFile) || !fs.existsSync(buildIdFile)) {
    console.error("[mmh] Missing standalone build output. Run `npm run build` first.");
    process.exit(1);
  }
}

function readBuildId() {
  return fs.readFileSync(buildIdFile, "utf8").trim();
}

function readMarker() {
  if (!fs.existsSync(markerFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(markerFile, "utf8"));
  } catch {
    return null;
  }
}

function syncDirectory(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

function syncRuntimeAssets() {
  const buildId = readBuildId();
  const marker = readMarker();
  const staticSrc = path.join(nextDir, "static");
  const staticDest = path.join(standaloneNextDir, "static");
  const publicSrc = path.join(rootDir, "public");
  const publicDest = path.join(standaloneDir, "public");
  const publicExists = fs.existsSync(publicSrc);

  const alreadySynced =
    marker?.buildId === buildId &&
    fs.existsSync(staticDest) &&
    (!publicExists || fs.existsSync(publicDest));

  if (alreadySynced) {
    return;
  }

  syncDirectory(staticSrc, staticDest);
  if (publicExists) {
    syncDirectory(publicSrc, publicDest);
  }

  fs.mkdirSync(standaloneNextDir, { recursive: true });
  fs.writeFileSync(
    markerFile,
    JSON.stringify(
      {
        buildId,
        syncedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function startStandaloneServer() {
  const env = withDefaultNodeOptions({
    ...process.env,
    NODE_ENV: "production",
    PORT: process.env.PORT || "7777",
    HOSTNAME: process.env.HOSTNAME || "0.0.0.0",
    PG_POOL_MAX: process.env.PG_POOL_MAX || "4",
  });

  const child = spawn(process.execPath, ["server.js"], {
    cwd: standaloneDir,
    env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

ensureBuildArtifacts();
syncRuntimeAssets();
startStandaloneServer();
