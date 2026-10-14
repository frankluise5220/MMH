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
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import { ensureSystemSetting, getSystemSetting, setSystemSetting } from "@/lib/server/system-setting";

export const INSTALLATION_ID_SETTING_KEY = "mmh_installation_id";

/** Where the deployment's advertised public key lives. Same backup rules as the id. */
export const INSTALLATION_PUBLIC_KEY_SETTING_KEY = "mmh_installation_public_key";

/** The installation id allocated by the registration service for this deployment. */
export const CENTRAL_INSTALLATION_ID_SETTING_KEY = "mmh_central_installation_id";

/**
 * Returns the deployment's installation id, creating it on first call.
 * Returns null when the setting cannot be read or written — callers must treat
 * reporting as best-effort and never fail a user flow over it.
 */
export async function getInstallationId(): Promise<string | null> {
  try {
    const stored = (await getSystemSetting(INSTALLATION_ID_SETTING_KEY))?.trim();
    if (stored) return stored;

    const generated = randomUUID();
    // `ensureSystemSetting` keeps a value written by a concurrent request, so
    // two simultaneous first reports can never fight over the primary key.
    const settled = await ensureSystemSetting(INSTALLATION_ID_SETTING_KEY, generated);
    return settled.trim() || generated;
  } catch (error) {
    logger.warn("read or create installation id failed", "installation-id", error);
    return null;
  }
}

/**
 * The deployment's advertised public key, generated once and then reused.
 * The registration service rejects a ledger-inventory report that does not
 * identify the installation by key (`VALIDATION_ERROR: installation.publicKey
 * is required`), so every report has to carry one. It must be a STABLE value:
 * the service records the key against the installation, and a key that changed
 * on every report would make each one look like a different device.
 *
 * Only the public half is persisted. Nothing in this app signs with the private
 * key — the value exists to identify this deployment to the service, not to
 * authenticate anything locally — so keeping the private half would add a
 * secret to back up and rotate for no benefit. Generated as Ed25519 SPKI, DER,
 * base64 — a format the service already accepts for the same field on the
 * registration endpoint.
 */
export async function getInstallationPublicKey(): Promise<string | null> {
  try {
    const stored = (await getSystemSetting(INSTALLATION_PUBLIC_KEY_SETTING_KEY))?.trim();
    if (stored) return stored;

    const { publicKey } = generateKeyPairSync("ed25519");
    const encoded = Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64");
    const settled = await ensureSystemSetting(INSTALLATION_PUBLIC_KEY_SETTING_KEY, encoded);
    return settled.trim() || encoded;
  } catch (error) {
    logger.warn("read or create installation public key failed", "installation-id", error);
    return null;
  }
}

/**
 * The installation id the registration service allocated for this deployment.
 *
 * Distinct from `getInstallationId()` on purpose. The local UUID identifies this
 * deployment to itself; the service allocates its own id when a registration
 * registers the installation, and inventory reports must be keyed by THAT one —
 * the service refuses reports for an installation it has never seen. Kept in a
 * separate setting so a factory reset (which wipes `SystemSetting`) drops both
 * together and a fresh registration can establish a matched pair again.
 *
 * Null until this deployment has registered at least once.
 */
export async function getCentralInstallationId(): Promise<string | null> {
  try {
    const stored = (await getSystemSetting(CENTRAL_INSTALLATION_ID_SETTING_KEY))?.trim();
    return stored || null;
  } catch (error) {
    logger.warn("read central installation id failed", "installation-id", error);
    return null;
  }
}

/**
 * Records the service-allocated installation id. Never throws.
 *
 * Uses the overwriting setter, not `ensureSystemSetting`: the service may
 * allocate a different id (a different registration service instance assigns a
 * fresh one), and the newest answer from the service must win. An
 * "only write if missing" call would pin the first id forever and every later
 * report would be keyed by an id the service no longer knows.
 */
export async function rememberCentralInstallationId(id: string): Promise<void> {
  try {
    await setSystemSetting(CENTRAL_INSTALLATION_ID_SETTING_KEY, id.trim());
  } catch (error) {
    logger.warn("persist central installation id failed", "installation-id", error);
  }
}

/**
 * The id an inventory report must be keyed by: the service's own id when this
 * deployment has registered, otherwise the local UUID (which the service will
 * reject, but reporting stays best-effort and must not depend on a value that
 * only exists after a successful registration).
 */
export async function getReportableInstallationId(): Promise<string | null> {
  const [central, local] = await Promise.all([getCentralInstallationId(), getInstallationId()]);
  return central ?? local;
}
