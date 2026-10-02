import type { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { normalizeSessionDays } from "@/lib/session-days";
import {
  HOUSEHOLD_COOKIE,
  SESSION_DAYS_COOKIE,
  USER_ID_COOKIE,
  USERNAME_COOKIE,
  VERIFIED_COOKIE,
  createVerifiedSessionValue,
  sessionCookieOptions,
} from "@/lib/server/session-cookies";

/**
 * Issuing a login session used to be copy-pasted into six routes
 * (`auth/verify`, `auth/fnos-verify`, `auth/create-ledger`,
 * `auth/register/confirm`, `households`, `settings/users/register/confirm`),
 * along with two byte-identical copies of `resolveSessionMaxAge` and three of
 * `getUserSessionDays`. The copies had already drifted — two of them never
 * refreshed `mmh_session_days`. Everything funnels through here now.
 */

export type SessionIssueTarget = {
  userId: string;
  name: string;
  householdId: string | null;
  authVersion: number;
};

type CookieRequestContext = Parameters<typeof sessionCookieOptions>[1];

/**
 * Session length (days) carried by the request's own `mmh_session_days` cookie.
 *
 * Used when the session belongs to an account that has no stored preference
 * yet — a freshly created ledger admin or a signup — so the operator keeps
 * whatever session length they were already using instead of being reset to
 * the default.
 */
export function sessionDaysFromRequest(req: NextRequest): number {
  return normalizeSessionDays(req.cookies.get(SESSION_DAYS_COOKIE)?.value);
}

/**
 * Session length (days) stored per user. Falls back to the default when the
 * preference row (or the column, on a deployment that has not migrated yet) is
 * missing, so login keeps working.
 */
export async function getUserSessionDays(userId: string): Promise<number> {
  try {
    const settings = await prisma.userSettings.findUnique({
      where: { userId },
      select: { sessionDays: true },
    });
    return normalizeSessionDays(settings?.sessionDays);
  } catch {
    return normalizeSessionDays(undefined);
  }
}

/**
 * Writes the five login cookies. This is the only place that knows the cookie
 * shape.
 *
 * `sessionDays` must come from `sessionDaysFromRequest` (a new account with no
 * preference yet) or `getUserSessionDays` (an existing account).
 */
export function issueSessionCookies(
  response: NextResponse,
  target: SessionIssueTarget,
  options: { sessionDays: number; req?: CookieRequestContext },
): void {
  const sessionDays = normalizeSessionDays(options.sessionDays);
  const maxAge = sessionDays * 24 * 60 * 60;
  const cookieOptions = sessionCookieOptions(maxAge, options.req);

  response.cookies.set(
    VERIFIED_COOKIE,
    createVerifiedSessionValue(target.userId, maxAge, target.authVersion),
    cookieOptions,
  );
  response.cookies.set(USER_ID_COOKIE, target.userId, cookieOptions);
  response.cookies.set(USERNAME_COOKIE, target.name, cookieOptions);
  // Deliberately readable by the client: the settings UI shows the current
  // choice, and `sessionDaysFromRequest` reads it back on the next login.
  response.cookies.set(SESSION_DAYS_COOKIE, String(sessionDays), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  if (target.householdId) {
    response.cookies.set(HOUSEHOLD_COOKIE, target.householdId, cookieOptions);
  }
}
