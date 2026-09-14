/**
 * API: /api/health
 *
 * Unauthenticated liveness + readiness probe for Docker healthchecks and
 * uptime monitors. Deliberately outside /api/v1 and exempt from auth: it
 * reports whether the process is up, whether the database answers a trivial
 * query, and lightweight runtime pressure signals for diagnostics.
 *
 * GET  200 { ok, status, version, time, db, uptimeSeconds, runtime } when ready
 * GET  503 { ok: false, status: "degraded", ... }                    when the DB probe fails
 */
import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import path from "node:path";
import { getHeapStatistics } from "node:v8";
import { NextResponse } from "next/server";
import { getConfiguredPgPoolMax, prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DB_PROBE_TIMEOUT_MS = 3000;
const BYTES_PER_MB = 1024 * 1024;
const MEMORY_WARNING_RATIO = 0.85;
const MEMORY_CRITICAL_RATIO = 0.95;

let cachedVersion: string | null = null;

type RuntimePressure = "ok" | "warning" | "critical";
type ProcessMemoryApi = typeof process & {
  availableMemory?: () => number;
  constrainedMemory?: () => number;
};

function appVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    cachedVersion = typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

async function probeDatabase(): Promise<"ok" | "unavailable"> {
  const deadline = Date.now() + DB_PROBE_TIMEOUT_MS;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("DB_PROBE_TIMEOUT")), Math.max(0, deadline - Date.now()));
      }),
    ]);
    return "ok";
  } catch {
    return "unavailable";
  }
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function bytesToMb(bytes: number): number {
  return roundToTenth(bytes / BYTES_PER_MB);
}

function parseMemoryLimitMb(value: string | undefined): number | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;

  const match = /^(\d+(?:\.\d+)?)(b|kb|k|mb|m|gb|g)?$/.exec(trimmed);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = match[2] ?? "mb";
  if (unit === "b") return roundToTenth(amount / BYTES_PER_MB);
  if (unit === "kb" || unit === "k") return roundToTenth(amount / 1024);
  if (unit === "gb" || unit === "g") return roundToTenth(amount * 1024);
  return roundToTenth(amount);
}

function processMemoryApiValueMb(name: "availableMemory" | "constrainedMemory"): number | null {
  const fn = (process as ProcessMemoryApi)[name];
  if (typeof fn !== "function") return null;
  const bytes = fn();
  return Number.isFinite(bytes) && bytes > 0 ? bytesToMb(bytes) : null;
}

function ratioOrNull(used: number, limit: number | null): number | null {
  if (!limit || limit <= 0) return null;
  return used / limit;
}

function roundedRatio(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

function pressureForRatio(value: number | null): RuntimePressure {
  if (value === null) return "ok";
  if (value >= MEMORY_CRITICAL_RATIO) return "critical";
  if (value >= MEMORY_WARNING_RATIO) return "warning";
  return "ok";
}

function maxPressure(values: RuntimePressure[]): RuntimePressure {
  if (values.includes("critical")) return "critical";
  if (values.includes("warning")) return "warning";
  return "ok";
}

function runtimeDiagnostics() {
  const memory = process.memoryUsage();
  const heapStats = getHeapStatistics();
  const heapLimitMb = bytesToMb(heapStats.heap_size_limit);
  const rssMb = bytesToMb(memory.rss);
  const totalMemoryMb = bytesToMb(totalmem());
  const freeMemoryMb = bytesToMb(freemem());
  const appMemoryLimitMb = parseMemoryLimitMb(process.env.MMH_APP_MEMORY_LIMIT);
  const constrainedMemoryMb = processMemoryApiValueMb("constrainedMemory");
  const processAvailableMemoryMb = processMemoryApiValueMb("availableMemory");
  const rssLimitMb = appMemoryLimitMb ?? constrainedMemoryMb;
  const heapRatio = ratioOrNull(memory.heapUsed, heapStats.heap_size_limit);
  const rssRatio = ratioOrNull(rssMb, rssLimitMb);
  const rssToSystemTotalRatio = ratioOrNull(rssMb, totalMemoryMb);
  const pressure = maxPressure([
    pressureForRatio(heapRatio),
    pressureForRatio(rssRatio),
    pressureForRatio(rssToSystemTotalRatio),
  ]);

  return {
    nodeVersion: process.version,
    pid: process.pid,
    limits: {
      appMemoryLimitMb,
      effectiveProcessMemoryLimitMb: rssLimitMb,
      nodeOldSpaceMb: parseMemoryLimitMb(process.env.MMH_NODE_MAX_OLD_SPACE_MB),
      pgPoolMax: getConfiguredPgPoolMax(),
    },
    system: {
      totalMemoryMb,
      freeMemoryMb,
      constrainedMemoryMb,
      processAvailableMemoryMb,
    },
    memory: {
      pressure,
      rssMb,
      heapUsedMb: bytesToMb(memory.heapUsed),
      heapTotalMb: bytesToMb(memory.heapTotal),
      heapLimitMb,
      externalMb: bytesToMb(memory.external),
      arrayBuffersMb: bytesToMb(memory.arrayBuffers),
      ratios: {
        heapUsedToLimit: roundedRatio(heapRatio),
        rssToEffectiveLimit: roundedRatio(rssRatio),
        rssToSystemTotal: roundedRatio(rssToSystemTotalRatio),
      },
    },
  };
}

export async function GET() {
  const db = await probeDatabase();
  const body = {
    ok: db === "ok",
    status: db === "ok" ? "ok" : "degraded",
    version: appVersion(),
    time: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    db,
    runtime: runtimeDiagnostics(),
  };
  return NextResponse.json(body, {
    status: db === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
