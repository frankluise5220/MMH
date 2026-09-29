import { cache } from "react";
import { cookies } from "next/headers";
import {
  HOUSEHOLD_COOKIE,
  USER_ID_COOKIE,
  USERNAME_COOKIE,
  VERIFIED_COOKIE,
  verifyVerifiedSessionValue,
} from "@/lib/server/session-cookies";
import { resolveSessionUser, sessionMatchesAuthVersion, type SessionUserRow } from "@/lib/server/session-user";

export type CurrentUser = SessionUserRow;

export const USER_ROLE_ADMIN = "admin";
export const USER_ROLE_USER = "user";
export const USER_ROLE_VIEWER = "viewer";

const USER_LOOKUP_TIMEOUT_MS = 8000;

/**
 * Read the verified login cookies and resolve the current database user.
 *
 * Cached per request (React.cache) so multiple modules in the same request
 * share one lookup instead of running repeated DB queries.
 *
 * If householdId is present, username is resolved inside that household.
 * Without householdId, legacy username-only lookup prefers an explicitly marked
 * system user, then falls back to unique username lookup; otherwise the session
 * is treated as ambiguous.
 */
export const getCurrentUser = cache(async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  const cookieUserId = cookieStore.get(USER_ID_COOKIE)?.value?.trim();
  const verified = verifyVerifiedSessionValue(cookieStore.get(VERIFIED_COOKIE)?.value, cookieUserId);
  if (!verified.ok) return null;

  // The proxy write gate resolves the same cookies through the same helper
  // (src/lib/server/session-user.ts) so "page renders" and "save is allowed"
  // can never disagree.
  const resolution = await resolveSessionUser(
    {
      userId: verified.userId,
      username: cookieStore.get(USERNAME_COOKIE)?.value,
      householdId: cookieStore.get(HOUSEHOLD_COOKIE)?.value,
    },
    { totalTimeoutMs: USER_LOOKUP_TIMEOUT_MS },
  );

  const user = resolution.user;
  if (!user) return null;
  // Only the by-id branch carries a version claim to compare against.
  if (resolution.matchedBy === "id") return sessionMatchesAuthVersion(user, verified) ? user : null;
  return user;
});

/**
 * Checks whether the user is an administrator (admin role or isSystem flag).
 * Administrators can access data of all households (books).
 */
export function isAdmin(user: CurrentUser | null): boolean {
  if (!user) return false;
  return user.role === USER_ROLE_ADMIN || user.isSystem === true;
}

export function isReadOnly(user: CurrentUser | null): boolean {
  return Boolean(user && !isAdmin(user) && user.role === USER_ROLE_VIEWER);
}

export function canWrite(user: CurrentUser | null): boolean {
  return Boolean(user) && !isReadOnly(user);
}
