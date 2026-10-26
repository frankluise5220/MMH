import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import {
  USER_ID_COOKIE,
  VERIFIED_COOKIE,
  verifyVerifiedSessionValue,
} from "@/lib/server/session-cookies";
import { verifySensitiveOperationPassword } from "@/lib/server/sensitive-operation-auth";
import {
  buildBackupFileName,
  buildHouseholdBackupPayload,
  buildHouseholdTableExportWorkbook,
  buildSystemBackupPayload,
  buildTableExportFileName,
  decryptBackupBytes,
  decryptBackupPackage,
  encryptBackupBytes,
  encryptBackupPayload,
  ensureSqliteRestoreCompatibilitySchema,
  restoreHouseholdBackup,
  type RestoreHouseholdBackupProgress,
} from "@/lib/server/backup";
import { decodeBackupPackage, encodeBackupPackage } from "@/lib/server/backup-package";
import {
  alignRestoredSnapshotHousehold,
  captureSnapshotLoginUser,
  createSqliteSnapshotBuffer,
  isSqliteFileDatabase,
  reinstateSnapshotLoginUser,
  restoreSqliteSnapshotBuffer,
} from "@/lib/server/sqlite-snapshot";
import { INSTALLATION_ID_SETTING_KEY } from "@/lib/server/installation-id";
import { getSystemSetting, setSystemSetting } from "@/lib/server/system-setting";
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
  let uploadedBytes: Buffer | null = null;
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

    // 读取与解包都走 backup-package.ts：gzip 包按魔数识别，老的明文包照原样解析。
    uploadedBytes = await fs.promises.readFile(uploadedFilePath);
    rawPayload = decodeBackupPackage(uploadedBytes);
    uploadedBytes = null;

    const rawObject = rawPayload as Record<string, unknown> | null;
    const packageType = String(rawObject?.packageType ?? "");
    const scopeObject = (rawObject?.scope as Record<string, unknown> | undefined) ?? {};
    const scopeName = String(scopeObject.householdName ?? "current book");
    // 账簿备份（哪怕容器是整库快照）恢复后仍用本机的账号登录；系统还原才是整机克隆，
    // 用户与配置全部来自备份机。
    const replacesAccounts = scopeObject.backupScope !== "household";

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

      // The snapshot carries the exporter's installation id; keeping the local
      // one is what stops two deployments from being registered as one ledger
      // inventory after a restore onto different hardware.
      const localInstallationId = await getSystemSetting(INSTALLATION_ID_SETTING_KEY);

      // 账簿恢复：换文件会把本机用户整张表换成导出方的，先把当前登录用户留一份。
      const loginUser = replacesAccounts ? null : await captureSnapshotLoginUser(task.userId);

      const result = await restoreSqliteSnapshotBuffer(bytes, (progress) => {
        updateRestoreTask(task, { progress: restoreProgress(progress) });
      });

      // The snapshot carries the schema of the system that created it. An
      // older backup (for example from 0.1.31) lacks columns added by newer
      // releases, so backfill the live schema in-process right after the file
      // swap; otherwise the running app queries fail until the next restart.
      await ensureSqliteRestoreCompatibilitySchema();

      // 整包进来之后再处理归属：快照里的 householdId 属于导出方，同机恢复时相同
      // （零成本），跨机/跨账簿恢复时整表改写成本账簿的 id。
      updateRestoreTask(task, {
        progress: restoreProgress({
          stage: "restoring",
          percent: 92,
          label: "Attributing snapshot",
          detail: "Moving the snapshot's rows into the current ledger",
        }),
      });
      const alignment = await alignRestoredSnapshotHousehold(task.householdId);

      // 成员整个来自快照；本机登录用户补回去，会话与密码都不用重来。
      const loginUserState = loginUser
        ? await reinstateSnapshotLoginUser(loginUser, task.householdId)
        : null;

      if (localInstallationId) {
        await setSystemSetting(INSTALLATION_ID_SETTING_KEY, localInstallationId);
      }
      if (alignment.renamed) {
        console.info("恢复整库快照：账簿 id 已改写", {
          from: alignment.from,
          to: alignment.to,
          tables: alignment.tables,
        });
      }

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
          detail: loginUserState === "skipped"
            ? "Data has been restored; the local account could not be kept, sign in with an account from the backup"
            : replacesAccounts
              ? "Data and accounts have been restored from the backup machine; the page will refresh"
              : "Data and members have been restored; your local account still works. The page will refresh",
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
    uploadedBytes = null;
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
  const mode = req.nextUrl.searchParams.get("mode");
  // 恢复进度必须绕开 `getCurrentUser()`：SQLite 上整个导入是一个事务，数据库连接被它占着，
  // 任何一次用户查询都要排在事务后面 —— 那正是「进度停在 36%」的成因。这里只验签会话
  // cookie（不查库），再用任务上记录的 userId 做归属判断。
  if (mode === "restore-status") {
    return restoreStatusResponse(req);
  }
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Sign in required." }, { status: 401 });
  }
  cleanupRestoreTasks();
  return NextResponse.json({ ok: false, code: "METHOD_NOT_ALLOWED", error: "Use POST to export a backup, export tables, or restore a backup." }, { status: 405 });
}

/**
 * 只读恢复进度：不碰数据库，因此在大事务进行中也能立刻返回。
 *
 * 鉴权用签名的会话 cookie（HMAC + 过期时间 + 用户 id 比对），再要求任务属于同一个用户，
 * 所以别人拿不到别人发起的恢复进度。
 */
async function restoreStatusResponse(req: NextRequest) {
  cleanupRestoreTasks();
  const cookieStore = await cookies();
  const sessionUserId = cookieStore.get(USER_ID_COOKIE)?.value ?? "";
  const verified = verifyVerifiedSessionValue(cookieStore.get(VERIFIED_COOKIE)?.value, sessionUserId);
  if (!verified.ok) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Sign in required." }, { status: 401 });
  }
  const id = String(req.nextUrl.searchParams.get("id") ?? "");
  const task = restoreTasks.get(id);
  if (!task) {
    return NextResponse.json({ ok: false, code: "RESTORE_TASK_NOT_FOUND", error: "The restore task does not exist or has expired." }, { status: 404 });
  }
  if (task.userId && task.userId !== verified.userId) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "This restore task belongs to another user." }, { status: 403 });
  }
  return NextResponse.json({ ok: true, task: publicRestoreTask(task) });
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

    // 单账簿部署里「这本账簿」和「整台设备」是同一批行，快照就是最忠实的账簿备份：
    // 一份文件、恢复时换文件（秒级），行情缓存和 AI 通道也一起带走。
    // 多账簿部署不能这么做——快照会带上别人的账簿，仍走逐行的可移植包。
    // 快照比可移植包多带 deployment 级的数据（installationId、迁移记录），所以这条
    // 捷径只对管理员开放，普通用户仍然拿逐行包。
    const snapshotCoversEverything =
      backupScope === "system"
      || (isAdmin(currentUser) && (await prisma.household.count()) === 1);
    if (isSqliteFileDatabase() && snapshotCoversEverything) {
      const snapshotBytes = await createSqliteSnapshotBuffer();
      const encryptedPayload = await encryptBackupBytes(
        snapshotBytes,
        // `backupScope` 保留用户的选择：它决定恢复端「成员来自哪里、你还用哪个账号」。
        // `container` 说明载荷是整库文件，恢复端据此要求整库覆盖确认。
        { householdId, householdName, backupScope, container: "sqlite-snapshot" },
        exportedAt,
        { passphrase },
      );
      const fileName = buildBackupFileName(householdName, exportedAt, "mmh-backup");
      return new Response(new Uint8Array(encodeBackupPackage(encryptedPayload)), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": attachmentDisposition(fileName),
          "Cache-Control": "no-store",
          // 让界面说清楚这个包是整库快照，不是只含一本账簿的逐行包。
          "X-MMH-Backup-Container": "sqlite-snapshot",
        },
      });
    }

    // 系统备份要带上所有账簿（多账簿部署换机时才不用一本一本手动导），
    // 账簿备份只带当前这一本。
    const exportedBy = user ? { id: user.id, name: user.name, role: user.role } : null;
    const payload = backupScope === "system"
      ? await buildSystemBackupPayload(householdId, exportedBy)
      : await buildHouseholdBackupPayload(householdId, exportedBy, { backupScope });
    const encryptedPayload = await encryptBackupPayload(payload, { passphrase });
    const fileName = buildBackupFileName(payload.scope.householdName, payload.exportedAt, "mmh-backup");
    return new Response(new Uint8Array(encodeBackupPackage(encryptedPayload)), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
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

  // 系统备份可能包含多本账簿，一次恢复会改写不止当前这一本，所以这里是全站互斥：
  // 别的账簿正在恢复时也拒绝，避免两个任务交替删写同一批表。
  if (activeRestoreHouseholds.size > 0) {
    return NextResponse.json({ ok: false, code: "RESTORE_ALREADY_RUNNING", error: "A restore task is already running. Wait for it to finish and retry." }, { status: 409 });
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
