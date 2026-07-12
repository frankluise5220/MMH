import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

const VERIFIED_KEY = "mmh_access_password_verified";
const CACHE_TTL = 60_000;
const LOOKUP_TIMEOUT_MS = 1_200;

const PUBLIC_PATHS = [
  "/login",
  "/api/v1/ai/chat",
  "/api/v1/ai/import",
  "/api/v1/ai/models",
  "/api/v1/auth",
  "/api/v1/settings/system",
  "/api/v1/test-prompt",
  "/test-results",
  "/_next",
  "/favicon",
];

const DEFAULT_ORIGINS = ["127.0.0.1", "localhost"];

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

function isAllowedHostname(hostname: string, allowedList: string[]): boolean {
  return allowedList.includes(hostname);
}

async function isOriginCheckEnabled(): Promise<boolean> {
  if (originCheckEnabledCache !== null && Date.now() - originCheckEnabledCacheTime < CACHE_TTL) {
    return originCheckEnabledCache;
  }

  const row = await withTimeout(
    prisma.systemSetting.findUnique({ where: { key: "origin_check_enabled" } }),
    LOOKUP_TIMEOUT_MS,
  );
  originCheckEnabledCache = row?.value !== "false";
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
    const normalized = extra.map((origin) => (origin.includes(":") ? origin.split(":")[0] : origin));
    allowedOriginsCache = [...DEFAULT_ORIGINS, ...normalized];
  } catch (error) {
    console.error("[proxy] getAllowedOrigins failed or timed out:", error);
    allowedOriginsCache = DEFAULT_ORIGINS;
  }

  allowedOriginsCacheTime = Date.now();
  return allowedOriginsCache;
}

function extractHostname(req: NextRequest): string | null {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).hostname;
    } catch {
      return null;
    }
  }

  const host = req.headers.get("host");
  if (host) {
    return host.split(":")[0] ?? null;
  }

  return req.nextUrl.hostname || null;
}

const ORIGIN_BYPASS_PATHS = ["/login", "/api/v1/auth", "/api/v1/settings/system"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  const hasApiCredential =
    !!req.headers.get("x-api-key") ||
    (req.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ");
  if (pathname.startsWith("/api/") && hasApiCredential) {
    return NextResponse.next();
  }

  if (!ORIGIN_BYPASS_PATHS.some((path) => pathname.startsWith(path))) {
    const enabled = await isOriginCheckEnabled();
    if (enabled) {
      const hostname = extractHostname(req);
      if (hostname) {
        const allowed = await getAllowedOrigins();
        if (!isAllowedHostname(hostname, allowed)) {
          console.error("[proxy] Access denied - hostname:", hostname, "allowed:", allowed);
          return new NextResponse("Access Denied - 请联系管理员将您的域名或 IP 添加到访问白名单中", { status: 403 });
        }
      }
    }
  }

  const verified = req.cookies.get(VERIFIED_KEY)?.value;
  if (verified === "ok") {
    return NextResponse.next();
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.delete("error");
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
