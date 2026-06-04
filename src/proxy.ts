import { NextRequest, NextResponse } from "next/server";

const VERIFIED_KEY = "wiseme_access_password_verified";

const PUBLIC_PATHS = [
  "/login",
  "/api/v1/ai/chat",
  "/api/v1/ai/import",
  "/api/v1/ai/models",
  "/api/v1/auth",
  "/_next",
  "/favicon",
];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const verified = req.cookies.get(VERIFIED_KEY)?.value;
  if (verified === "ok") {
    return NextResponse.next();
  }

  // 未验证，重定向到登录页
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.delete("error");
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
