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

export function shouldUseSecureCookies() {
  return process.env.NODE_ENV === "production" && process.env.MMH_INSECURE_COOKIES !== "1";
}

export function sessionCookieOptions(maxAge: number): Partial<ResponseCookie> {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookies(),
    path: "/",
    maxAge,
  };
}

export function expiredSessionCookieOptions(): Partial<ResponseCookie> {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookies(),
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  };
}
