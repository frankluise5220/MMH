import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { verifyPassword } from "@/lib/auth/password";
import {
  extractAccessHostnames,
  isAccessHostnameAllowed,
  parseAllowedAccessList,
} from "@/lib/access-whitelist";
import {
  HOUSEHOLD_COOKIE,
  USER_ID_COOKIE,
  USERNAME_COOKIE,
} from "@/lib/server/session-cookies";

const VERIFIED_KEY = "mmh_access_password_verified";
const LEGACY_ACCESS_PASSWORD_KEY = "access_password";
const CACHE_TTL = 5_000;
const LOOKUP_TIMEOUT_MS = 1_200;

const PUBLIC_PATHS = [
  "/login",
  "/api/v1/auth",
  "/api/v1/settings/catalog",
  "/api/v1/settings/system",
  "/_next",
  "/favicon",
  "/manifest",
  "/sw.js",
  "/branding",
];

const READ_ONLY_PREVIEW_PATHS = [
  "/api/v1/statement/parse",
  "/api/v1/fund/import",
  "/api/v1/stocks/import",
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

function getProvidedApiKey(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-api-key")?.trim() || null;
}

/**
 * Validate an X-Api-Key / Bearer credential the same way src/lib/server/api-auth.ts does:
 * bcrypt-compare against the admin user's password hash, with a legacy
 * plaintext `access_password` fallback. Without this check, merely *having* an
 * api-key header would bypass the auth gate.
 */
async function isValidApiKey(key: string): Promise<boolean> {
  const adminUser = await withTimeout(
    prisma.user.findFirst({
      where: { OR: [{ role: "admin" }, { isSystem: true }] },
      orderBy: [{ isSystem: "desc" }, { createdAt: "asc" }],
      select: { passwordHash: true },
    }),
    LOOKUP_TIMEOUT_MS,
  );
  if (adminUser?.passwordHash) {
    try {
      return await verifyPassword(key, adminUser.passwordHash);
    } catch {
      return false;
    }
  }
  const legacy = await withTimeout(
    prisma.systemSetting.findUnique({ where: { key: LEGACY_ACCESS_PASSWORD_KEY }, select: { value: true } }),
    LOOKUP_TIMEOUT_MS,
  );
  return !!legacy?.value && key === legacy.value;
}

async function isReadOnlySession(req: NextRequest): Promise<boolean> {
  const userId = req.cookies.get(USER_ID_COOKIE)?.value?.trim();
  const username = req.cookies.get(USERNAME_COOKIE)?.value?.trim();
  const householdId = req.cookies.get(HOUSEHOLD_COOKIE)?.value?.trim();

  const user = userId
    ? await withTimeout(
        prisma.user.findUnique({
          where: { id: userId },
          select: { role: true, isSystem: true },
        }),
        LOOKUP_TIMEOUT_MS,
      )
    : username
      ? await withTimeout(
          prisma.user.findFirst({
            where: {
              name: username,
              ...(householdId ? { householdId } : {}),
            },
            select: { role: true, isSystem: true },
            orderBy: { createdAt: "asc" },
          }),
          LOOKUP_TIMEOUT_MS,
        )
      : null;

  return user?.role === "viewer" && user.isSystem !== true;
}

function isAllowedReadOnlyMutation(req: NextRequest): boolean {
  const { pathname, searchParams } = req.nextUrl;
  if (
    pathname === "/api/v1/auth/logout" ||
    pathname === "/api/v1/auth/verify" ||
    pathname === "/api/v1/auth/password-reset/request" ||
    pathname === "/api/v1/auth/password-reset/confirm"
  ) {
    return true;
  }
  if (pathname === "/api/v1/households/switch") return true;
  if (pathname === "/api/v1/settings/backup") {
    const mode = searchParams.get("mode");
    return mode === "export" || mode === "table-export";
  }
  return READ_ONLY_PREVIEW_PATHS.includes(pathname);
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

  const verified = req.cookies.get(VERIFIED_KEY)?.value;
  if (verified === "ok") {
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.method !== "OPTIONS" &&
      !isAllowedReadOnlyMutation(req) &&
      await isReadOnlySession(req)
    ) {
      return NextResponse.json(
        { ok: false, code: "READ_ONLY", error: "Read-only users cannot modify data." },
        { status: 403 },
      );
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    const apiKey = getProvidedApiKey(req);
    if (apiKey && (await isValidApiKey(apiKey))) {
      return NextResponse.next();
    }
    return NextResponse.json({ ok: false, error: apiKey ? "API Key 无效" : "未登录" }, { status: 401 });
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.delete("error");
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
