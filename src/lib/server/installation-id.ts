/**
 * Stable identifier of THIS deployment (one MMH installation = one NAS / one
 * Docker stack / one desktop install), persisted in `SystemSetting`.
 *
 * MMH deployments are independent self-hosted instances that share a single
 * central mmh-registration service. The registration service can only attribute
 * ledger bindings to a deployment when every report carries a stable id, so the
 * id is generated once on first use and then reused forever.
 *
 * Deliberately NOT cached in module scope: `settings/factory-reset` wipes
 * `SystemSetting` and a system backup restore rewrites it, so a cached value
 * could outlive the row it came from. Reports are infrequent (bind / ledger
 * create or delete, plus a 6-hour heartbeat), so one primary-key read per
 * report is free.
 *
 * Two deliberate properties:
 * - It is NOT a backup artifact. `backup.ts` excludes this key from exports,
 *   skips it on restore, and preserves the LOCAL value across a system restore;
 *   a restore must never give this deployment someone else's identity.
 * - `settings/factory-reset` wipes `SystemSetting`, so a reset deployment gets a
 *   NEW id. That is intended: the old ledger data is gone, so the previous
 *   inventory must not keep counting for the reset deployment. The central
 *   service should treat an installation that stops reporting (stale
 *   `reportedAt`) as retired.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";

export const INSTALLATION_ID_SETTING_KEY = "mmh_installation_id";

/**
 * Returns the deployment's installation id, creating it on first call.
 * Returns null when the setting cannot be read or written — callers must treat
 * reporting as best-effort and never fail a user flow over it.
 */
export async function getInstallationId(): Promise<string | null> {
  try {
    const existing = await prisma.systemSetting.findUnique({
      where: { key: INSTALLATION_ID_SETTING_KEY },
      select: { value: true },
    });
    const stored = existing?.value?.trim();
    if (stored) return stored;

    // `update: {}` keeps a value written by a concurrent request, so two
    // simultaneous first reports can never fight over the primary key.
    const generated = randomUUID();
    await prisma.systemSetting.upsert({
      where: { key: INSTALLATION_ID_SETTING_KEY },
      create: { key: INSTALLATION_ID_SETTING_KEY, value: generated },
      update: {},
    });
    const settled = await prisma.systemSetting.findUnique({
      where: { key: INSTALLATION_ID_SETTING_KEY },
      select: { value: true },
    });
    return settled?.value?.trim() || generated;
  } catch (error) {
    logger.warn("read or create installation id failed", "installation-id", error);
    return null;
  }
}
