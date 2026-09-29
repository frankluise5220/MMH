import { prisma } from "@/lib/db/prisma";

/**
 * Session user resolution — the single source of truth for turning the three
 * login cookies (`mmh_user_id` / `mmh_username` / `householdId`) into a user
 * row.
 *
 * Both the page/action layer (`getCurrentUser`) and the proxy write gate
 * (`getSessionWriteRole`) MUST resolve the session the same way. They used to
 * diverge: the write gate looked the user up by id only, so a cookie whose id
 * no longer existed (a user row recreated by a restore / registration flow)
 * produced "GET pages render fine, every save returns 503" — which surfaces in
 * the browser as Next's generic "An unexpected response was received from the
 * server." Keep the fallback chain here so both sides stay in sync.
 */

export type SessionUserRow = {
  id: string;
  name: string;
  role: string;
  isSystem: boolean;
  householdId: string | null;
  authVersion: number;
};

export const SESSION_USER_SELECT = {
  id: true,
  name: true,
  role: true,
  isSystem: true,
  householdId: true,
  authVersion: true,
} as const;

export type SessionUserCandidates = {
  /** Verified user id from the signed session cookie. */
  userId?: string | null;
  /** `mmh_username` cookie (user name, not necessarily an email). */
  username?: string | null;
  /** `householdId` cookie. */
  householdId?: string | null;
};

export type SessionUserMatchedBy = "id" | "username" | "system" | "household-admin" | "household-member" | "single-user";

export type SessionUserResolution =
  | { user: SessionUserRow; matchedBy: SessionUserMatchedBy }
  | { user: null; reason: "not-found" | "ambiguous" | "lookup-timeout" };

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return Promise.race([operation.catch(() => null), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Resolve the session cookies to a user row.
 *
 * Order (mirrors the historical `getCurrentUser` behaviour):
 *  1. by id (the signed session's subject)
 *  2. name + household, then system user with that name, then unique name
 *  3. household admin / household member when no name is available
 *  4. the system user / the only user in the database
 *
 * `totalTimeoutMs` bounds the whole resolution, not each query, so a slow
 * database cannot stretch a single request indefinitely.
 */
export async function resolveSessionUser(
  candidates: SessionUserCandidates,
  budget: { totalTimeoutMs: number },
): Promise<SessionUserResolution> {
  const deadline = Date.now() + Math.max(1, budget.totalTimeoutMs);
  const lookup = async <T>(operation: Promise<T>): Promise<T | null> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    return withTimeout(operation, remaining);
  };

  const userId = candidates.userId?.trim() ?? "";
  const username = candidates.username?.trim() ?? "";
  const householdId = candidates.householdId?.trim() ?? "";

  if (userId) {
    const user = await lookup(
      prisma.user.findUnique({ where: { id: userId }, select: SESSION_USER_SELECT }),
    );
    if (user) return { user, matchedBy: "id" };
  }

  if (username && householdId) {
    const scopedUser = await lookup(
      prisma.user.findFirst({ where: { name: username, householdId }, select: SESSION_USER_SELECT }),
    );
    if (scopedUser) return { user: scopedUser, matchedBy: "username" };

    const systemUser = await lookup(
      prisma.user.findFirst({
        where: { name: username, isSystem: true },
        select: SESSION_USER_SELECT,
        orderBy: { createdAt: "asc" },
      }),
    );
    if (systemUser) return { user: systemUser, matchedBy: "system" };

    const users = await lookup(
      prisma.user.findMany({
        where: { name: username },
        select: SESSION_USER_SELECT,
        take: 2,
        orderBy: { createdAt: "asc" },
      }),
    );
    if (!users) return { user: null, reason: "lookup-timeout" };
    return users.length === 1 ? { user: users[0], matchedBy: "username" } : { user: null, reason: "ambiguous" };
  }

  if (!username && householdId) {
    const householdAdmin = await lookup(
      prisma.user.findFirst({
        where: { householdId, OR: [{ role: "admin" }, { isSystem: true }] },
        select: SESSION_USER_SELECT,
        orderBy: { createdAt: "asc" },
      }),
    );
    if (householdAdmin) return { user: householdAdmin, matchedBy: "household-admin" };

    const member = await lookup(
      prisma.user.findFirst({ where: { householdId }, select: SESSION_USER_SELECT, orderBy: { createdAt: "asc" } }),
    );
    return member ? { user: member, matchedBy: "household-member" } : { user: null, reason: "not-found" };
  }

  if (!username) {
    const systemUser = await lookup(
      prisma.user.findFirst({ where: { isSystem: true }, select: SESSION_USER_SELECT, orderBy: { createdAt: "asc" } }),
    );
    if (systemUser) return { user: systemUser, matchedBy: "system" };

    const users = await lookup(
      prisma.user.findMany({ select: SESSION_USER_SELECT, take: 2, orderBy: { createdAt: "asc" } }),
    );
    if (!users) return { user: null, reason: "lookup-timeout" };
    return users.length === 1 ? { user: users[0], matchedBy: "single-user" } : { user: null, reason: "ambiguous" };
  }

  const systemUser = await lookup(
    prisma.user.findFirst({
      where: { name: username, isSystem: true },
      select: SESSION_USER_SELECT,
      orderBy: { createdAt: "asc" },
    }),
  );
  if (systemUser) return { user: systemUser, matchedBy: "system" };

  const users = await lookup(
    prisma.user.findMany({
      where: { name: username },
      select: SESSION_USER_SELECT,
      take: 2,
      orderBy: { createdAt: "asc" },
    }),
  );
  if (!users) return { user: null, reason: "lookup-timeout" };
  return users.length === 1 ? { user: users[0], matchedBy: "username" } : { user: null, reason: "ambiguous" };
}

/**
 * A session may only act while the user's authVersion matches the version
 * stamped into the signed cookie. Password set/clear/reset and admin resets
 * bump authVersion, which immediately invalidates older sessions.
 *
 * Only the "resolved by id" branch is gated: the name/household fallbacks
 * exist to keep a half-stale cookie usable, and they carry no version claim to
 * compare against (same as the pre-existing `getCurrentUser` behaviour).
 */
export function sessionMatchesAuthVersion(
  user: SessionUserRow,
  verified: { ok: true; authVersion: number } | { ok: false },
): boolean {
  return verified.ok ? verified.authVersion === user.authVersion : false;
}
