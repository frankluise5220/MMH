import { NextRequest, NextResponse } from "next/server";

const LOGIN_PATH = "/login";
const USERNAME_COOKIE = "mmh_username";
const VERIFIED_COOKIE = "mmh_access_password_verified";

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

export function proxy(req: NextRequest) {
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
