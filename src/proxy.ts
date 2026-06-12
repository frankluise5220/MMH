import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

const VERIFIED_KEY = "wiseme_access_password_verified";

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

// 默认白名单（局域网段 + localhost）
const DEFAULT_ORIGINS = ["192.168.5.199", "192.168.2.199", "127.0.0.1", "localhost"];

function isAllowedHostname(hostname: string, allowedList: string[]): boolean {
  if (allowedList.includes(hostname)) return true;
  // 局域网段自动放行：10.*, 172.16-31.*, 192.168.*
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname)) return true;
  return false;
}

// 模块级缓存
let _allowedOrigins: string[] | null = null;
let _originsCacheTime = 0;
const CACHE_TTL = 60_000; // 60秒

async function getAllowedOrigins(): Promise<string[]> {
  if (_allowedOrigins && Date.now() - _originsCacheTime < CACHE_TTL) {
    return _allowedOrigins;
  }
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: "allowed_dev_origins" } });
    const extra: string[] = row?.value ? JSON.parse(row.value) : [];
    // 白名单可能存了带端口的值，统一提取 hostname
    const normalized = extra.map(e => e.includes(":") ? e.split(":")[0] : e);
    _allowedOrigins = [...DEFAULT_ORIGINS, ...normalized];
    _originsCacheTime = Date.now();
  } catch (e) {
    console.error("[proxy] getAllowedOrigins failed:", e);
    _allowedOrigins = DEFAULT_ORIGINS;
    _originsCacheTime = Date.now();
  }
  return _allowedOrigins;
}

/** 从 Origin 或 Host 头提取 hostname（去掉端口） */
function extractHostname(req: NextRequest): string | null {
  const origin = req.headers.get("origin");
  if (origin) {
    try { return new URL(origin).hostname; } catch {}
  }
  const host = req.headers.get("host");
  if (host) {
    // host 格式为 "hostname:port" 或纯 "hostname"，取冒号前部分
    return host.split(":")[0];
  }
  // 从请求 URL 本身提取（直接 IP 访问时 Origin/Host 可能缺失）
  return req.nextUrl.hostname || null;
}

// origin 校验放行路径（登录页和关键 API 必须放行）
const ORIGIN_BYPASS_PATHS = [
  "/login",
  "/api/v1/auth",
  "/api/v1/settings/system",
];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // origin 校验：不在白名单的域名拒绝访问（放行路径除外）
  if (!ORIGIN_BYPASS_PATHS.some((p) => pathname.startsWith(p))) {
    const hostname = extractHostname(req);
    if (hostname) {
      const allowed = await getAllowedOrigins();
      const isAllowed = isAllowedHostname(hostname, allowed);
      if (!isAllowed) {
        console.error("[proxy] Access Denied — hostname:", hostname, "allowed:", allowed);
        return new NextResponse("Access Denied", { status: 403 });
      }
    }
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
