import type { ResponseCookie } from "next/dist/compiled/@edge-runtime/cookies";

export const VERIFIED_COOKIE = "mmh_access_password_verified";
export const USERNAME_COOKIE = "mmh_username";
export const HOUSEHOLD_COOKIE = "householdId";
export const SESSION_DAYS_COOKIE = "mmh_session_days";

export const SESSION_COOKIES = [
  VERIFIED_COOKIE,
  USERNAME_COOKIE,
  HOUSEHOLD_COOKIE,
] as const;

type CookieRequestContext = {
  nextUrl?: { protocol?: string };
  headers?: { get(name: string): string | null };
};

function normalizeProtocol(protocol: string | null | undefined) {
  const value = protocol?.trim().toLowerCase();
  if (!value) return null;
  return value.endsWith(":") ? value : `${value}:`;
}

function requestProtocol(context?: CookieRequestContext | URL | string) {
  if (!context) return null;
  if (typeof context === "string") {
    try {
      return normalizeProtocol(new URL(context).protocol);
    } catch {
      return null;
    }
  }
  if (context instanceof URL) {
    return normalizeProtocol(context.protocol);
  }

  const forwardedProto = context.headers?.get("x-forwarded-proto")?.split(",")[0];
  return normalizeProtocol(forwardedProto) ?? normalizeProtocol(context.nextUrl?.protocol);
}

export function shouldUseSecureCookies(context?: CookieRequestContext | URL | string) {
  if (process.env.NODE_ENV !== "production") return false;
  if (process.env.MMH_INSECURE_COOKIES === "1") return false;
  const protocol = requestProtocol(context);
  if (protocol === "http:") return false;
  return true;
}

export function sessionCookieOptions(maxAge: number, context?: CookieRequestContext | URL | string): Partial<ResponseCookie> {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookies(context),
    path: "/",
    maxAge,
  };
}

export function expiredSessionCookieOptions(context?: CookieRequestContext | URL | string): Partial<ResponseCookie> {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookies(context),
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  };
}
