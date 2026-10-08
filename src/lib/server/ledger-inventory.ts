/**
 * Ledger inventory reporting.
 *
 * Answers an operational question the central mmh-registration service cannot
 * answer by itself: for one MMH account, how many ledgers is it bound to, and
 * how many members does each ledger have?
 *
 * Why the app has to report it: MMH deployments are independent self-hosted
 * instances. Ledger creation and binding normally happen entirely inside the
 * local database (`registrationPrincipalId` is copied to the new ledger's admin
 * row without any outbound call), so the central service sees only logins and
 * cannot tell "signed in again" from "bound another ledger".
 *
 * Design:
 * - A full snapshot per call, not an event delta: the registration service
 *   replaces its record for `installationId`, so repeats are idempotent and
 *   un-binds / ledger deletions never leave stale counts behind.
 * - Best-effort and fire-and-forget: reporting must never delay or fail a user
 *   flow, so every failure is logged and swallowed.
 * - A 6-hour heartbeat (from the system-task tick) re-sends the snapshot even
 *   when nothing happens locally, which repairs missed reports, ledgers created
 *   before this feature existed, and deployments whose central service was
 *   offline at bind time.
 * - No ledger names, member names or emails are sent — ids and counts only.
 */
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { getInstallationId } from "@/lib/server/installation-id";
import {
  isRegistrationConfigured,
  reportInstallationInventory,
  type InstallationInventory,
} from "@/lib/server/registration-client";

export type LedgerInventoryReason =
  | "ledger-created"
  | "ledger-deleted"
  | "mmh-bound"
  | "member-changed"
  | "heartbeat";

/** How often an otherwise idle deployment refreshes its inventory. */
const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Timestamp of the last ATTEMPT (set before the request on purpose). A rejected
 * or unreachable report must not make the heartbeat retry on every tick while
 * the central endpoint is still unimplemented.
 */
let lastReportAttemptedAt = 0;

/** Set MMH_INSTALLATION_REPORT_DISABLED=1 to keep the inventory local. */
export function ledgerInventoryReportingDisabled(): boolean {
  return (process.env.MMH_INSTALLATION_REPORT_DISABLED ?? "").trim() === "1";
}

/** MMH_DEPLOY_TARGET (fnos / windows / ...) when provided, else the Node platform. */
function deploymentPlatform(): string {
  const target = (process.env.MMH_DEPLOY_TARGET ?? "").trim().toLowerCase();
  return target || process.platform;
}

async function buildInventory(installationId: string): Promise<InstallationInventory> {
  const [households, users] = await Promise.all([
    prisma.household.findMany({
      select: { id: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    // The global system user has householdId = null and is not a ledger member,
    // exactly like the settings users list (see settings/users/route.ts GET).
    prisma.user.findMany({
      where: { isSystem: false, householdId: { not: null } },
      select: { householdId: true, registrationPrincipalId: true },
    }),
  ]);

  const perHousehold = new Map<string, { memberCount: number; principalIds: Set<string> }>();
  for (const user of users) {
    if (!user.householdId) continue;
    const entry = perHousehold.get(user.householdId) ?? { memberCount: 0, principalIds: new Set<string>() };
    entry.memberCount += 1;
    if (user.registrationPrincipalId) entry.principalIds.add(user.registrationPrincipalId);
    perHousehold.set(user.householdId, entry);
  }

  return {
    installationId,
    platform: deploymentPlatform(),
    reportedAt: new Date().toISOString(),
    households: households.map((household) => {
      const entry = perHousehold.get(household.id);
      const principalIds = entry ? [...entry.principalIds] : [];
      return {
        householdId: household.id,
        createdAt: household.createdAt.toISOString(),
        memberCount: entry?.memberCount ?? 0,
        mmhMemberCount: principalIds.length,
        principalIds,
      };
    }),
  };
}

/** Sends one inventory snapshot. Never throws. */
export async function reportLedgerInventory(reason: LedgerInventoryReason): Promise<void> {
  if (ledgerInventoryReportingDisabled()) return;
  if (!isRegistrationConfigured()) return;

  lastReportAttemptedAt = Date.now();
  try {
    const installationId = await getInstallationId();
    if (!installationId) return;
    const inventory = await buildInventory(installationId);
    const result = await reportInstallationInventory(inventory);
    if (!result.ok) {
      logger.warn(
        `ledger inventory report (${reason}) was not accepted (${result.code ?? `HTTP ${result.status ?? "unknown"}`})`,
        "ledger-inventory",
      );
    } else {
      logger.debug(`ledger inventory report (${reason}) sent: ${inventory.households.length} ledger(s)`, "ledger-inventory");
    }
  } catch (error) {
    logger.warn("ledger inventory report failed", "ledger-inventory", error);
  }
}

/**
 * Request-handler entry point: schedules a report without awaiting it, so the
 * HTTP response is never held back by the central service.
 */
export function queueLedgerInventoryReport(reason: LedgerInventoryReason): void {
  void reportLedgerInventory(reason);
}

/**
 * System-task tick entry point: refreshes the snapshot at most every 6 hours.
 * A fresh process has `lastReportAttemptedAt = 0`, so the first tick (~30s after
 * boot) always reports once, which also covers deployments upgraded in place.
 */
export async function reportLedgerInventoryHeartbeat(): Promise<void> {
  if (Date.now() - lastReportAttemptedAt < HEARTBEAT_INTERVAL_MS) return;
  await reportLedgerInventory("heartbeat");
}
