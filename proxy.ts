import { NextRequest, NextResponse } from "next/server";

const LOGIN_PATH = "/login";
const USERNAME_COOKIE = "mmh_username";
const VERIFIED_COOKIE = "mmh_access_password_verified";
const ALLOWED_HOSTS_ENV = "MMH_ALLOWED_HOSTS";

const PUBLIC_PREFIXES = [
  "/api/v1/auth",
  "/_next",
  "/favicon.ico",
  "/file.svg",
  "/globe.svg",
  "/next.svg",
  "/vercel.svg",
  "/window.svg",
];

function isPublicPath(pathname: string) {
  if (pathname === LOGIN_PATH) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function normalizeHost(value: string | null) {
  const raw = value?.split(",")[0]?.trim().toLowerCase() ?? "";
  if (!raw) return "";
  if (raw.startsWith("[")) return raw.slice(1, raw.indexOf("]"));
  return raw.split(":")[0] ?? "";
}

function parseAllowedHosts() {
  return (process.env[ALLOWED_HOSTS_ENV] ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hostMatchesPattern(host: string, pattern: string) {
  if (pattern === host) return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return false;
}

function isAllowedHost(req: NextRequest) {
  const allowedHosts = parseAllowedHosts();
  if (allowedHosts.length === 0) return true;

  const forwardedHost = normalizeHost(req.headers.get("x-forwarded-host"));
  const directHost = normalizeHost(req.headers.get("host"));
  const requestHost = forwardedHost || directHost;
  if (!requestHost) return false;

  return allowedHosts.some((pattern) => hostMatchesPattern(requestHost, pattern));
}

export function proxy(req: NextRequest) {
  if (!isAllowedHost(req)) {
    return new NextResponse("Host is not allowed", { status: 421 });
  }

  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const username = req.cookies.get(USERNAME_COOKIE)?.value?.trim();
  const verified = req.cookies.get(VERIFIED_COOKIE)?.value === "ok";
  if (username && verified) return NextResponse.next();

  if (pathname.startsWith("/api/v1/settings/")) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }

  if (pathname.startsWith("/api/")) return NextResponse.next();

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = LOGIN_PATH;
  loginUrl.searchParams.set("next", `${pathname}${req.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
