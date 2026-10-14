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
import { getInstallationPublicKey, getReportableInstallationId } from "@/lib/server/installation-id";
import {
  isRegistrationConfigured,
  mmhDeploymentPlatform,
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
  return mmhDeploymentPlatform();
}

async function buildInventory(installationId: string): Promise<InstallationInventory> {
  const [households, users, publicKey] = await Promise.all([
    prisma.household.findMany({
      select: { id: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    // Ledger members are exactly the users that belong to a ledger. Membership is
    // decided by `householdId`, NOT by `isSystem`: a system user is an operator
    // role, and one can perfectly well own a ledger (a single-admin deployment
    // is `isSystem: true` *with* a `householdId`). Filtering on `isSystem` here
    // reported `memberCount: 0` for exactly those deployments — the numbers were
    // structurally unable to move, so binding and unbinding looked like no-ops.
    // A user with no `householdId` is the deployment-wide global operator and
    // genuinely is not a member of any ledger, so it stays excluded.
    prisma.user.findMany({
      where: { householdId: { not: null } },
      select: { householdId: true, registrationPrincipalId: true },
    }),
    getInstallationPublicKey(),
  ]);

  const perHousehold = new Map<string, { memberCount: number; principals: Map<string, number> }>();
  // Account-centric totals for the whole deployment, keyed by principal id: how
  // many ledger users carry it, and where. The service cannot derive this itself
  // (it observes logins, not ledger rows), and it is what answers "how many
  // users is this MMH account bound to".
  const perPrincipal = new Map<string, { userCount: number; householdIds: string[] }>();
  for (const user of users) {
    if (!user.householdId) continue;
    const entry = perHousehold.get(user.householdId) ?? { memberCount: 0, principals: new Map<string, number>() };
    entry.memberCount += 1;
    if (user.registrationPrincipalId) {
      // Count users per principal rather than distinct principals: one MMH account
      // bound to three users of the same ledger is three bindings, so each bind
      // adds one and each unbind removes one.
      const boundUsers = (entry.principals.get(user.registrationPrincipalId) ?? 0) + 1;
      entry.principals.set(user.registrationPrincipalId, boundUsers);
      const summary = perPrincipal.get(user.registrationPrincipalId) ?? { userCount: 0, householdIds: [] };
      summary.userCount += 1;
      if (!summary.householdIds.includes(user.householdId)) summary.householdIds.push(user.householdId);
      perPrincipal.set(user.registrationPrincipalId, summary);
    }
    perHousehold.set(user.householdId, entry);
  }

  return {
    installationId,
    platform: deploymentPlatform(),
    // Required by the registration service on every report: it identifies the
    // deployment the numbers belong to. Stable per deployment (see
    // `getInstallationPublicKey`).
    ...(publicKey ? { installation: { platform: deploymentPlatform(), publicKey } } : {}),
    reportedAt: new Date().toISOString(),
    households: households.map((household) => {
      const entry = perHousehold.get(household.id);
      const principals = entry ? [...entry.principals.entries()] : [];
      return {
        householdId: household.id,
        createdAt: household.createdAt.toISOString(),
        memberCount: entry?.memberCount ?? 0,
        // Distinct MMH accounts bound inside this ledger — the "how many
        // accounts" view. Derived from the current rows on every report instead
        // of incremented, so it cannot drift.
        mmhMemberCount: principals.length,
        // The "how many users" view: each account with the number of ledger users
        // carrying it, so a bind moves it by one even when the same account is
        // bound to several users of this ledger.
        mmhBindings: principals.map(([principalId, userCount]) => ({ principalId, userCount })),
      };
    }),
    // Account-centric totals across the whole deployment, so the service does not
    // have to aggregate the per-ledger view itself.
    principals: [...perPrincipal.entries()].map(([principalId, summary]) => ({
      principalId,
      userCount: summary.userCount,
      householdIds: summary.householdIds,
    })),
  };
}

/** Sends one inventory snapshot. Never throws. */
export async function reportLedgerInventory(reason: LedgerInventoryReason): Promise<void> {
  if (ledgerInventoryReportingDisabled()) return;
  if (!isRegistrationConfigured()) return;

  lastReportAttemptedAt = Date.now();
  try {
    const installationId = await getReportableInstallationId();
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
