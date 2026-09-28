import { prisma } from "@/lib/db/prisma";
import { getCurrentUser } from "@/lib/server/auth";
import { getCachedHouseholdScope } from "@/lib/server/household-scope";

/**
 * Global kill switch for the sponsor (tip) settings entry.
 *
 * While this is false the entry is never revealed on any surface, no matter
 * what the data-driven conditions below say.
 */
export const SPONSOR_ENTRY_ENABLED = true;

/**
 * Minimum number of non-deleted transaction records before the sponsor
 * (tip) entry is revealed in the settings UI.
 */
export const SPONSOR_RECORD_THRESHOLD = 5000;

/**
 * Minimum system age (in days) before the sponsor (tip) entry is revealed.
 * The earliest household creation time is used as the installation proxy.
 */
export const SPONSOR_MIN_INSTALL_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the sponsor (tip) settings entry should be revealed to the
 * current user.
 *
 * The entry is revealed when EITHER condition holds:
 * - the sponsor entry is globally enabled (SPONSOR_ENTRY_ENABLED),
 * - the system has been installed for more than SPONSOR_MIN_INSTALL_DAYS
 *   days (earliest household creation time as the installation proxy), or
 * - the current ledger has more than SPONSOR_RECORD_THRESHOLD non-deleted
 *   transaction records (TxRecord).
 */
export async function shouldShowSponsor(): Promise<boolean> {
  if (!SPONSOR_ENTRY_ENABLED) return false;

  const user = await getCurrentUser();
  if (!user) return false;

  const { hidFilter } = await getCachedHouseholdScope();
  const [recordCount, earliestHousehold] = await Promise.all([
    prisma.txRecord.count({ where: { ...hidFilter, deletedAt: null } }),
    prisma.household.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);

  const installedAt = earliestHousehold?.createdAt;
  const installedEnough = installedAt
    ? Date.now() - installedAt.getTime() > SPONSOR_MIN_INSTALL_DAYS * DAY_MS
    : false;

  return installedEnough || recordCount > SPONSOR_RECORD_THRESHOLD;
}
