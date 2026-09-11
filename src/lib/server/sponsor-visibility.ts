import { prisma } from "@/lib/db/prisma";
import { getCurrentUser } from "@/lib/server/auth";
import { getCachedHouseholdScope } from "@/lib/server/household-scope";

/**
 * Global kill switch for the sponsor (tip) settings entry.
 *
 * While this is false the entry is never revealed on any surface, no matter
 * what the data-driven conditions below say. The rest of the visibility
 * logic is kept intact so the entry can be restored by flipping this flag
 * back to true.
 */
export const SPONSOR_ENTRY_ENABLED = false;

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
 * The entry stays hidden unless ALL conditions hold:
 * - the sponsor entry is globally enabled (SPONSOR_ENTRY_ENABLED),
 * - the system has been installed for more than SPONSOR_MIN_INSTALL_DAYS
 *   days (earliest household creation time as the installation proxy),
 * - the current ledger has more than SPONSOR_RECORD_THRESHOLD non-deleted
 *   transaction records (TxRecord), and
 * - the user has provided a contact email, either through a configured
 *   bill-import email account (EmailAccount) or through the current user's
 *   profile email field (User.email).
 */
export async function shouldShowSponsor(): Promise<boolean> {
  if (!SPONSOR_ENTRY_ENABLED) return false;

  const user = await getCurrentUser();
  if (!user) return false;

  const { householdId, hidFilter } = await getCachedHouseholdScope();

  const [recordCount, emailAccountCount, userWithEmail, earliestHousehold] = await Promise.all([
    prisma.txRecord.count({ where: { ...hidFilter, deletedAt: null } }),
    prisma.emailAccount.count({ where: { householdId } }),
    prisma.user.findUnique({ where: { id: user.id }, select: { email: true } }),
    prisma.household.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);

  if (recordCount <= SPONSOR_RECORD_THRESHOLD) return false;

  const installedAt = earliestHousehold?.createdAt;
  const installedEnough = installedAt
    ? Date.now() - installedAt.getTime() > SPONSOR_MIN_INSTALL_DAYS * DAY_MS
    : false;
  if (!installedEnough) return false;

  const hasBillImportEmail = emailAccountCount > 0;
  const hasUserEmail = (userWithEmail?.email?.trim() ?? "") !== "";
  return hasBillImportEmail || hasUserEmail;
}
