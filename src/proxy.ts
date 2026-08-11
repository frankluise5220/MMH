import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import {
  extractAccessHostnames,
  isAccessHostnameAllowed,
  parseAllowedAccessList,
} from "@/lib/access-whitelist";

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

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

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

  allowedOriginsCache = parseAllowedAccessList(row?.value);

  allowedOriginsCacheTime = Date.now();
  return allowedOriginsCache;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const enabled = await isOriginCheckEnabled();
  if (enabled) {
    const allowed = await getAllowedOrigins();
    const hostnames = extractAccessHostnames(req.headers, req.nextUrl.hostname);
    const hasDisallowedHost =
      hostnames.length === 0 || hostnames.some((hostname) => !isAccessHostnameAllowed(hostname, allowed));
    if (hasDisallowedHost) {
      console.error("[proxy] Access denied - hostnames:", hostnames, "allowed:", allowed);
      return new NextResponse("Access Denied - 请联系管理员将您访问的域名或 IP 添加到访问白名单中", { status: 403 });
    }
  }

  if (isPublicPath(pathname)) {
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
