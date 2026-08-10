import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

const VERIFIED_KEY = "mmh_access_password_verified";
const CACHE_TTL = 5_000;
const LOOKUP_TIMEOUT_MS = 1_200;

const PUBLIC_PATHS = [
  "/login",
  "/api/v1/ai/chat",
  "/api/v1/ai/import",
  "/api/v1/ai/models",
  "/api/v1/auth",
  "/api/v1/settings/catalog",
  "/api/v1/settings/system",
  "/api/v1/test-prompt",
  "/test-results",
  "/_next",
  "/favicon",
  "/manifest",
  "/sw.js",
  "/branding",
];

let allowedOriginsCache: string[] | null = null;
let allowedOriginsCacheTime = 0;
let originCheckEnabledCache: boolean | null = null;
let originCheckEnabledCacheTime = 0;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([operation.catch(() => null), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function normalizeAllowedHostname(value: string) {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.split(":")[0]?.trim().toLowerCase() ?? "";
  }
}

function isAllowedHostname(hostname: string, allowedList: string[]): boolean {
  const normalized = normalizeAllowedHostname(hostname);
  if (!normalized) return false;
  return allowedList.some((item) => {
    const allowed = normalizeAllowedHostname(item);
    if (!allowed) return false;
    if (allowed.startsWith("*.")) return normalized.endsWith(allowed.slice(1));
    return normalized === allowed;
  });
}

async function isOriginCheckEnabled(): Promise<boolean> {
  if (originCheckEnabledCache !== null && Date.now() - originCheckEnabledCacheTime < CACHE_TTL) {
    return originCheckEnabledCache;
  }

  const row = await withTimeout(
    prisma.systemSetting.findUnique({ where: { key: "origin_check_enabled" } }),
    LOOKUP_TIMEOUT_MS,
  );
  originCheckEnabledCache = row?.value === "true";
  originCheckEnabledCacheTime = Date.now();
  return originCheckEnabledCache;
}

async function getAllowedOrigins(): Promise<string[]> {
  if (allowedOriginsCache && Date.now() - allowedOriginsCacheTime < CACHE_TTL) {
    return allowedOriginsCache;
  }

  const row = await withTimeout(
    prisma.systemSetting.findUnique({ where: { key: "allowed_dev_origins" } }),
    LOOKUP_TIMEOUT_MS,
  );

  try {
    const extra: string[] = row?.value ? JSON.parse(row.value) : [];
    const normalized = extra.map(normalizeAllowedHostname).filter(Boolean);
    allowedOriginsCache = Array.from(new Set(normalized));
  } catch (error) {
    console.error("[proxy] getAllowedOrigins failed or timed out:", error);
    allowedOriginsCache = [];
  }

  allowedOriginsCacheTime = Date.now();
  return allowedOriginsCache;
}

function splitHeaderValues(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractForwardedHosts(value: string | null): string[] {
  return splitHeaderValues(value)
    .flatMap((entry) => entry.split(";").map((part) => part.trim()))
    .filter((part) => part.toLowerCase().startsWith("host="))
    .map((part) => part.slice("host=".length).replace(/^"|"$/g, ""));
}

function extractRequestHostnames(req: NextRequest): string[] {
  const candidates: string[] = [];
  candidates.push(...extractForwardedHosts(req.headers.get("forwarded")));
  candidates.push(...splitHeaderValues(req.headers.get("x-forwarded-host")));

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      candidates.push(new URL(origin).hostname);
    } catch {
      // Ignore malformed Origin; the Host headers still decide access.
    }
  }

  const host = req.headers.get("host");
  if (host) candidates.push(host);
  if (req.nextUrl.hostname) candidates.push(req.nextUrl.hostname);

  return Array.from(new Set(candidates.map(normalizeAllowedHostname).filter(Boolean)));
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const enabled = await isOriginCheckEnabled();
  if (enabled) {
    const allowed = await getAllowedOrigins();
    const hostnames = extractRequestHostnames(req);
    const hasDisallowedHost =
      allowed.length > 0 &&
      (hostnames.length === 0 || hostnames.some((hostname) => !isAllowedHostname(hostname, allowed)));
    if (hasDisallowedHost) {
      console.error("[proxy] Access denied - hostnames:", hostnames, "allowed:", allowed);
      return new NextResponse("Access Denied - 请联系管理员将您的域名或 IP 添加到访问白名单中", { status: 403 });
    }
  }

  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  const hasApiCredential =
    !!req.headers.get("x-api-key") ||
    (req.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ");
  if (pathname.startsWith("/api/") && hasApiCredential) {
    return NextResponse.next();
  }

  const verified = req.cookies.get(VERIFIED_KEY)?.value;
  if (verified === "ok") {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.delete("error");
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
