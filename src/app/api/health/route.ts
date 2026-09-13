/**
 * API: /api/health
 *
 * Unauthenticated liveness + readiness probe for Docker healthchecks and
 * uptime monitors. Deliberately outside /api/v1 and exempt from auth: it only
 * reports whether the process is up and the database answers a trivial query.
 *
 * GET  200 { ok, status, version, time, db, uptimeSeconds }  when healthy
 * GET  503 { ok: false, status: "degraded", ... }            when the DB probe fails
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DB_PROBE_TIMEOUT_MS = 3000;

let cachedVersion: string | null = null;

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

export async function GET() {
  const db = await probeDatabase();
  const body = {
    ok: db === "ok",
    status: db === "ok" ? "ok" : "degraded",
    version: appVersion(),
    time: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    db,
  };
  return NextResponse.json(body, {
    status: db === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
