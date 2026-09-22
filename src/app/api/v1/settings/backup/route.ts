import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { verifySensitiveOperationPassword } from "@/lib/server/sensitive-operation-auth";
import {
  buildBackupFileName,
  buildHouseholdBackupPayload,
  buildHouseholdTableExportWorkbook,
  buildTableExportFileName,
  decryptBackupBytes,
  decryptBackupPackage,
  encryptBackupBytes,
  encryptBackupPayload,
  ensureSqliteRestoreCompatibilitySchema,
  restoreHouseholdBackup,
  serializeEncryptedBackupPackage,
  type RestoreHouseholdBackupProgress,
} from "@/lib/server/backup";
import {
  createSqliteSnapshotBuffer,
  isSqliteFileDatabase,
  restoreSqliteSnapshotBuffer,
} from "@/lib/server/sqlite-snapshot";
import {
  RESTORE_UPLOAD_LIMIT_BYTES,
  RESTORE_UPLOAD_LIMIT_LABEL,
} from "@/lib/backup-upload-limit";

export const runtime = "nodejs";
const RESTORE_TASK_TTL_MS = 60 * 60 * 1000;

type RestoreTaskState = "queued" | "running" | "success" | "error";
type RestoreFallbackAdmin = {
  name: string;
  role: string;
  isSystem: boolean;
  email?: string | null;
  passwordHash?: string | null;
} | null;
type RestoreTask = {
  id: string;
  householdId: string;
  userId: string;
  status: RestoreTaskState;
  progress: RestoreHouseholdBackupProgress;
  summary?: {
    householdName: string;
    counts: { transactions: number };
  };
  error?: string;
  createdAt: number;
  updatedAt: number;
};

declare global {
  var __mmhRestoreTasks: Map<string, RestoreTask> | undefined;
  var __mmhActiveRestoreHouseholds: Set<string> | undefined;
}

const restoreTasks = globalThis.__mmhRestoreTasks ??= new Map<string, RestoreTask>();
const activeRestoreHouseholds = globalThis.__mmhActiveRestoreHouseholds ??= new Set<string>();

function restoreProgress(
  progress: RestoreHouseholdBackupProgress,
): RestoreHouseholdBackupProgress {
  return {
    stage: progress.stage,
    percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    label: progress.label,
    detail: progress.detail,
  };
}

function cleanupRestoreTasks() {
  const cutoff = Date.now() - RESTORE_TASK_TTL_MS;
  for (const [id, task] of restoreTasks) {
    if (task.updatedAt < cutoff && task.status !== "running" && task.status !== "queued") {
      restoreTasks.delete(id);
    }
  }
}

function updateRestoreTask(task: RestoreTask, patch: Partial<Omit<RestoreTask, "id" | "createdAt">>) {
  Object.assign(task, patch, { updatedAt: Date.now() });
}

function publicRestoreTask(task: RestoreTask) {
  return {
    id: task.id,
    status: task.status,
    progress: task.progress,
    summary: task.summary,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function runRestoreTask(
  task: RestoreTask,
  uploadedFilePath: string,
  passphrase: string,
  fallbackAdmin: RestoreFallbackAdmin,
) {
  let rawText: string | null = null;
  let rawPayload: unknown = null;
  let payload: unknown = null;
  let packagePassphrase = passphrase;

  try {
    updateRestoreTask(task, {
      status: "running",
      progress: restoreProgress({
        stage: "preparing",
        percent: 36,
        label: "Reading backup",
        detail: "The backup file is uploaded; reading the package",
      }),
    });

    rawText = await fs.promises.readFile(uploadedFilePath, "utf8");
    rawPayload = JSON.parse(rawText);
    rawText = null;

    const rawObject = rawPayload as Record<string, unknown> | null;
    const packageType = String(rawObject?.packageType ?? "");
    const scopeName = String(
      (rawObject?.scope as Record<string, unknown> | undefined)?.householdName ?? "current book",
    );

    if (packageType === "encrypted-sqlite-backup" || packageType === "sqlite-backup") {
      updateRestoreTask(task, {
        progress: restoreProgress({
          stage: "preparing",
          percent: 44,
          label: "Preparing database backup",
          detail: "Validating and unpacking the database snapshot",
        }),
      });

      const bytes = await decryptBackupBytes(rawPayload, { passphrase: packagePassphrase });
      rawPayload = null;
      packagePassphrase = "";

      const result = await restoreSqliteSnapshotBuffer(bytes, (progress) => {
        updateRestoreTask(task, { progress: restoreProgress(progress) });
      });

      // The snapshot carries the schema of the system that created it. An
      // older backup (for example from 0.1.31) lacks columns added by newer
      // releases, so backfill the live schema in-process right after the file
      // swap; otherwise the running app queries fail until the next restart.
      await ensureSqliteRestoreCompatibilitySchema();

      updateRestoreTask(task, {
        status: "success",
        summary: {
          householdName: scopeName,
          counts: { transactions: result.transactionCount },
        },
        progress: restoreProgress({
          stage: "done",
          percent: 100,
          label: "Restore complete",
          detail: "Data has been restored to the backup point; the page will refresh",
        }),
      });
      return;
    }

    updateRestoreTask(task, {
      progress: restoreProgress({
        stage: "preparing",
        percent: 42,
        label: "Preparing backup",
        detail: "Validating and unpacking the backup content",
      }),
    });

    payload = await decryptBackupPackage(rawPayload, { passphrase: packagePassphrase });
    rawPayload = null;
    packagePassphrase = "";

    const summary = await restoreHouseholdBackup(payload, {
      householdId: task.householdId,
      fallbackAdmin,
      onProgress: (progress) => {
        updateRestoreTask(task, { progress: restoreProgress(progress) });
      },
    });
    payload = null;

    updateRestoreTask(task, {
      status: "success",
      summary,
      progress: restoreProgress({
        stage: "done",
        percent: 100,
        label: "Restore complete",
        detail: "Data has been restored; the page will refresh",
      }),
    });
  } catch (error) {
    console.error("Backup restore failed", error);
    updateRestoreTask(task, {
      status: "error",
      error: restoreFailureMessage(error),
      progress: restoreProgress({
        stage: "done",
        percent: task.progress.percent,
        label: "Restore failed",
        detail: restoreFailureMessage(error),
      }),
    });
  } finally {
    rawText = null;
    rawPayload = null;
    payload = null;
    packagePassphrase = "";
    await fs.promises.unlink(uploadedFilePath).catch(() => undefined);
    activeRestoreHouseholds.delete(task.householdId);
  }
}

function requireAdmin(user: Awaited<ReturnType<typeof getCurrentUser>>) {
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "ADMIN_REQUIRED", error: "Only administrators can back up or restore." }, { status: 403 });
  }
  return null;
}

function requireSignedIn(user: Awaited<ReturnType<typeof getCurrentUser>>) {
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Sign in required." }, { status: 401 });
  }
  return null;
}

function encodeRfc5987Value(value: string) {
  return encodeURIComponent(value).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function asciiHeaderFileName(fileName: string) {
  const fallback = fileName
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]+/g, "-")
    .replace(/["\\;]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (fallback && /[A-Za-z0-9]/.test(fallback)) return fallback;
  return "mmh-backup.mmh-backup";
}

function attachmentDisposition(fileName: string) {
  return `attachment; filename="${asciiHeaderFileName(fileName)}"; filename*=UTF-8''${encodeRfc5987Value(fileName)}`;
}

function getCredentialsFromJson(value: unknown): {
  backupScope: "system" | "household";
  backupPassphrase: string;
  userPassword: string;
} {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    backupScope: String(body.backupScope ?? body.scope ?? "household") === "system" ? "system" : "household",
    backupPassphrase: String(
      body.backupPassphrase ??
      body.backupPassword ??
      body.encryptionPassphrase ??
      body.encryptionInfo ??
      "",
    ),
    userPassword: String(body.userPassword ?? body.password ?? ""),
  };
}

function restoreFailureMessage(error: unknown) {
  if (error instanceof SyntaxError) {
    return "The selected file is not a valid MMH backup. Choose a .mmh-backup or .mmhbackup file.";
  }
  return error instanceof Error ? error.message : "Restore failed.";
}

/**
 * GET /api/v1/settings/backup
 *
 * Response:
 * - `?mode=restore-status&id=<restoreId>` returns `{ ok: true, task }`
 * - `{ ok: false, code, error }`
 *
 * Use `POST ?mode=export` to export a restore package (encrypted when a
 * backup passphrase is supplied, plain otherwise).
 * Use `POST ?mode=table-export` to export a non-restorable Excel workbook.
 */
export async function GET(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Sign in required." }, { status: 401 });
  }
  cleanupRestoreTasks();
  const mode = req.nextUrl.searchParams.get("mode");
  if (mode === "restore-status") {
    const id = String(req.nextUrl.searchParams.get("id") ?? "");
    const task = restoreTasks.get(id);
    if (!task) {
      return NextResponse.json({ ok: false, code: "RESTORE_TASK_NOT_FOUND", error: "The restore task does not exist or has expired." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, task: publicRestoreTask(task) });
  }
  return NextResponse.json({ ok: false, code: "METHOD_NOT_ALLOWED", error: "Use POST to export a backup, export tables, or restore a backup." }, { status: 405 });
}

async function exportBackupPackage(req: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    const denied = requireSignedIn(currentUser);
    if (denied) return denied;
    if (!currentUser) {
      return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Sign in required." }, { status: 401 });
    }

    const credentials = getCredentialsFromJson(await req.json().catch(() => null));
    const credentialDenied = await verifySensitiveOperationPassword(credentials.userPassword);
    if (!credentialDenied.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: credentialDenied.code ?? "AUTH_VERIFICATION_FAILED",
          error: credentialDenied.error ?? "Password verification failed.",
        },
        { status: credentialDenied.status ?? 401 },
      );
    }

    const { householdId, user } = await getHouseholdScope();
    const household = await prisma.household.findUnique({ where: { id: householdId } });
    const householdName = household?.name ?? "default";
    const exportedAt = new Date();
    // An empty passphrase exports a plain package; a non-empty one encrypts it.
    const passphrase = credentials.backupPassphrase.trim();
    const backupScope = credentials.backupScope;
    if (backupScope === "system" && !isAdmin(currentUser)) {
      return NextResponse.json(
        { ok: false, code: "SYSTEM_BACKUP_ADMIN_REQUIRED", error: "Only administrators can create a system backup." },
        { status: 403 },
      );
    }

    if (isSqliteFileDatabase() && backupScope === "system") {
      const snapshotBytes = await createSqliteSnapshotBuffer();
      const encryptedPayload = await encryptBackupBytes(
        snapshotBytes,
        { householdId, householdName, backupScope: "system" },
        exportedAt,
        { passphrase },
      );
      const fileName = buildBackupFileName(householdName, exportedAt, "mmh-backup");
      return new Response(serializeEncryptedBackupPackage(encryptedPayload), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": attachmentDisposition(fileName),
          "Cache-Control": "no-store",
        },
      });
    }

    const payload = await buildHouseholdBackupPayload(
      householdId,
      user ? { id: user.id, name: user.name, role: user.role } : null,
      { backupScope },
    );
    const encryptedPayload = await encryptBackupPayload(payload, { passphrase });
    const fileName = buildBackupFileName(payload.scope.householdName, payload.exportedAt, "mmh-backup");
    return new Response(serializeEncryptedBackupPackage(encryptedPayload), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": attachmentDisposition(fileName),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Backup export failed", error);
    const message = error instanceof Error ? error.message : "Backup failed.";
    return NextResponse.json({ ok: false, code: "EXPORT_FAILED", error: message }, { status: 500 });
  }
}

async function exportTableWorkbook() {
  try {
    const currentUser = await getCurrentUser();
    const denied = requireSignedIn(currentUser);
    if (denied) return denied;

    const { householdId, user } = await getHouseholdScope();
    const payload = await buildHouseholdBackupPayload(
      householdId,
      user ? { id: user.id, name: user.name, role: user.role } : null,
      {
        ensureBackupPackageKey: false,
        backupScope: isAdmin(currentUser) ? "system" : "household",
        omitImportBatchRawText: false,
        omitTransactionDisplayNames: false,
      },
    );

    const workbook = await buildHouseholdTableExportWorkbook(payload);
    const fileName = buildTableExportFileName(payload.scope.householdName, payload.exportedAt);
    return new Response(new Uint8Array(workbook), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": attachmentDisposition(fileName),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Table export failed", error);
    const message = error instanceof Error ? error.message : "Table export failed.";
    return NextResponse.json({ ok: false, code: "EXPORT_FAILED", error: message }, { status: 500 });
  }
}

function restoreUploadTooLargeResponse() {
  return NextResponse.json(
    {
      ok: false,
      code: "FILE_TOO_LARGE",
      error: `The backup file exceeds ${RESTORE_UPLOAD_LIMIT_LABEL} and cannot be restored from the web page.`,
    },
    { status: 413 },
  );
}

function restoreUploadTempDir() {
  const dataDir = process.env.MMH_DATA_DIR || path.join(process.cwd(), "data");
  return path.join(dataDir, "tmp");
}

async function writeRestoreUploadToTemp(file: File) {
  const tempDir = restoreUploadTempDir();
  await fs.promises.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `restore-upload-${crypto.randomUUID()}.mmhbackup`);
  try {
    await pipeline(
      Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]),
      fs.createWriteStream(tempPath),
    );
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => undefined);
    throw error;
  }
  return tempPath;
}

/**
 * POST /api/v1/settings/backup
 *
 * Export or restore the current household backup package.
 *
 * Export:
 * - `POST /api/v1/settings/backup?mode=export`
 * - JSON body: `{ userPassword, backupPassphrase?, backupScope?: "system" | "household" }`
 * - `userPassword` verifies the current logged-in administrator's own password
 * - `backupScope: "system"` requires an administrator; other authenticated users are limited to `"household"`
 * - `backupPassphrase` optionally encrypts the backup package; when omitted, the
 *   package is exported in plain form and can be restored without a passphrase
 * - returns a `.mmh-backup` package.
 *
 * Table export:
 * - `POST /api/v1/settings/backup?mode=table-export`
 * - no request body
 * - returns a non-restorable `.xlsx` workbook for manual data processing.
 *
 * Restore:
 * - `POST /api/v1/settings/backup`
 * - multipart/form-data
 *   - `file`: the `.mmh-backup` / `.mmhbackup` package exported by this endpoint (web restore upload limit is 512MB)
 *   - `userPassword`: current administrator's password, verified before restore
 *   - `backupPassphrase`: required only when the package is encrypted
 * - starts a background restore task and returns `{ ok: true, restoreId, task }`
 * - poll `GET /api/v1/settings/backup?mode=restore-status&id=<restoreId>` until `task.status` is `success` or `error`
 *
 * Response:
 * - `{ ok: true, restoreId, task }`
 * - `{ ok: false, code, error }`
 */
export async function POST(req: NextRequest) {
  cleanupRestoreTasks();
  const mode = req.nextUrl.searchParams.get("mode");
  if (mode === "export") {
    return exportBackupPackage(req);
  }
  if (mode === "table-export") {
    return exportTableWorkbook();
  }

  const currentUser = await getCurrentUser();
  const denied = requireAdmin(currentUser);
  if (denied) return denied;
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Sign in required." }, { status: 401 });
  }

  const { householdId, user } = await getHouseholdScope();

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > RESTORE_UPLOAD_LIMIT_BYTES) {
    return restoreUploadTooLargeResponse();
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json(
      { ok: false, code: "INVALID_UPLOAD", error: "The backup upload was incomplete or exceeded the restore upload limit. Choose the backup file again and retry." },
      { status: 400 },
    );
  }
  const file = form.get("file");
  const backupPassphrase = String(
    form.get("backupPassphrase") ??
    form.get("backupPassword") ??
    form.get("encryptionPassphrase") ??
    form.get("encryptionInfo") ??
    "",
  );
  const userPassword = String(form.get("userPassword") ?? form.get("password") ?? "");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, code: "MISSING_FILE", error: "Choose a backup file." }, { status: 400 });
  }
  const credentialDenied = await verifySensitiveOperationPassword(userPassword);
  if (!credentialDenied.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: credentialDenied.code ?? "AUTH_VERIFICATION_FAILED",
        error: credentialDenied.error ?? "Password verification failed.",
      },
      { status: credentialDenied.status ?? 401 },
    );
  }

  const lowerFileName = file.name.toLowerCase();
  if (!lowerFileName.endsWith(".mmh-backup") && !lowerFileName.endsWith(".mmhbackup")) {
    return NextResponse.json({ ok: false, code: "INVALID_FILE_TYPE", error: "Restore supports MMH backup files only (.mmh-backup or .mmhbackup)." }, { status: 400 });
  }
  if (file.size > RESTORE_UPLOAD_LIMIT_BYTES) {
    return restoreUploadTooLargeResponse();
  }

  if (activeRestoreHouseholds.has(householdId)) {
    return NextResponse.json({ ok: false, code: "RESTORE_ALREADY_RUNNING", error: "A restore task is already running for this book. Wait for it to finish and retry." }, { status: 409 });
  }

  let uploadedFilePath: string;
  try {
    uploadedFilePath = await writeRestoreUploadToTemp(file);
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "INVALID_BACKUP_FILE", error: restoreFailureMessage(error) },
      { status: 400 },
    );
  }

  try {
    const dbUser = user
      ? await prisma.user.findUnique({
          where: { id: user.id },
          select: {
            name: true,
            role: true,
            isSystem: true,
            email: true,
            passwordHash: true,
          },
        })
      : null;

    const task: RestoreTask = {
      id: crypto.randomUUID(),
      householdId,
      userId: currentUser.id,
      status: "queued",
      progress: restoreProgress({
        stage: "preparing",
        percent: 35,
        label: "Waiting to restore",
        detail: "The backup file is uploaded; the restore task is queued",
      }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    restoreTasks.set(task.id, task);
    activeRestoreHouseholds.add(householdId);
    void runRestoreTask(task, uploadedFilePath, backupPassphrase.trim(), dbUser);

    return NextResponse.json(
      {
        ok: true,
        restoreId: task.id,
        task: publicRestoreTask(task),
        message: "Restore task started.",
      },
      { status: 202 },
    );
  } catch (error) {
    await fs.promises.unlink(uploadedFilePath).catch(() => undefined);
    console.error("Backup restore failed", error);
    return NextResponse.json(
      { ok: false, code: "RESTORE_FAILED", error: restoreFailureMessage(error) },
      { status: 500 },
    );
  }
}
