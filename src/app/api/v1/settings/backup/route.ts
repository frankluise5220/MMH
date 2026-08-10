import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin, type CurrentUser } from "@/lib/server/auth";
import {
  buildBackupFileName,
  buildHouseholdBackupPayload,
  buildHouseholdTableExportWorkbook,
  buildTableExportFileName,
  decryptBackupPackage,
  encryptBackupPayload,
  restoreHouseholdBackup,
} from "@/lib/server/backup";

export const runtime = "nodejs";
const RESTORE_UPLOAD_LIMIT_BYTES = 128 * 1024 * 1024;
const LEGACY_PASSWORD_KEY = "access_password";

function requireAdmin(user: Awaited<ReturnType<typeof getCurrentUser>>) {
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ ok: false, error: "仅管理员可执行备份或恢复" }, { status: 403 });
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

async function verifySensitiveOperationUser(currentUser: CurrentUser, username: string, userPassword: string) {
  const name = username.trim();
  const password = userPassword.trim();
  if (!name) {
    return NextResponse.json({ ok: false, error: "请输入用户名" }, { status: 400 });
  }
  if (!password) {
    return NextResponse.json({ ok: false, error: "请输入用户密码" }, { status: 400 });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: currentUser.id },
    select: { name: true, passwordHash: true },
  });
  if (!dbUser) {
    return NextResponse.json({ ok: false, error: "当前用户不存在，请重新登录" }, { status: 401 });
  }
  if (name !== dbUser.name) {
    return NextResponse.json({ ok: false, error: "用户名或密码错误" }, { status: 401 });
  }

  if (dbUser.passwordHash) {
    const matched = await verifyPassword(password, dbUser.passwordHash);
    if (!matched) {
      return NextResponse.json({ ok: false, error: "用户名或密码错误" }, { status: 401 });
    }
    return null;
  }

  const legacySetting = await prisma.systemSetting.findUnique({ where: { key: LEGACY_PASSWORD_KEY } });
  if (!legacySetting?.value) {
    return NextResponse.json({ ok: false, error: "请先设置用户密码" }, { status: 400 });
  }
  if (password !== legacySetting.value) {
    return NextResponse.json({ ok: false, error: "用户名或密码错误" }, { status: 401 });
  }
  return null;
}

function getCredentialsFromJson(value: unknown) {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    username: String(body.username ?? body.userName ?? ""),
    userPassword: String(body.userPassword ?? body.password ?? ""),
  };
}

function restoreFailureMessage(error: unknown) {
  if (error instanceof SyntaxError) {
    return "备份文件不是有效的 MMH 加密备份，请重新选择 .mmh-backup 文件";
  }
  return error instanceof Error ? error.message : "恢复失败";
}

/**
 * GET /api/v1/settings/backup
 *
 * Response:
 * - `{ ok: false, error }`
 *
 * Use `POST ?mode=export` to export an encrypted restore package.
 * Use `POST ?mode=table-export` to export a non-restorable Excel workbook.
 */
export async function GET(req: NextRequest) {
  void req;
  return NextResponse.json({ ok: false, error: "请使用 POST 导出备份、导出表格或恢复备份" }, { status: 405 });
}

async function exportBackupPackage(req: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    const denied = requireAdmin(currentUser);
    if (denied) return denied;
    if (!currentUser) {
      return NextResponse.json({ ok: false, error: "请先登录" }, { status: 401 });
    }

    const credentials = getCredentialsFromJson(await req.json().catch(() => null));
    const credentialDenied = await verifySensitiveOperationUser(
      currentUser,
      credentials.username,
      credentials.userPassword,
    );
    if (credentialDenied) return credentialDenied;

    const { householdId, user } = await getHouseholdScope();
    const payload = await buildHouseholdBackupPayload(
      householdId,
      user ? { id: user.id, name: user.name, role: user.role } : null,
    );

    const encryptedPayload = await encryptBackupPayload(payload);
    const fileName = buildBackupFileName(payload.scope.householdName, payload.exportedAt, "mmh-backup");
    return new Response(JSON.stringify(encryptedPayload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": attachmentDisposition(fileName),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Backup export failed", error);
    const message = error instanceof Error ? error.message : "备份失败";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

async function exportTableWorkbook() {
  try {
    const currentUser = await getCurrentUser();
    const denied = requireAdmin(currentUser);
    if (denied) return denied;

    const { householdId, user } = await getHouseholdScope();
    const payload = await buildHouseholdBackupPayload(
      householdId,
      user ? { id: user.id, name: user.name, role: user.role } : null,
      { ensureBackupPackageKey: false },
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
    const message = error instanceof Error ? error.message : "导出表格失败";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/**
 * POST /api/v1/settings/backup
 *
 * Export or restore the current household backup package.
 *
 * Export:
 * - `POST /api/v1/settings/backup?mode=export`
 * - JSON body: `{ username, userPassword }`, verified before exporting the encrypted package
 * - returns an encrypted `.mmh-backup` package.
 *
 * Table export:
 * - `POST /api/v1/settings/backup?mode=table-export`
 * - no request body
 * - returns a non-restorable `.xlsx` workbook for manual data processing.
 *
 * Restore:
 * - `POST /api/v1/settings/backup`
 * - multipart/form-data
 *   - `file`: the `.mmh-backup` encrypted package exported by this endpoint
 *   - `username`: current user's username
 *   - `userPassword`: current user's password, verified before destructive restore
 *
 * Response:
 * - `{ ok: true, summary }`
 * - `{ ok: false, error }`
 */
export async function POST(req: NextRequest) {
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
    return NextResponse.json({ ok: false, error: "请先登录" }, { status: 401 });
  }

  const { householdId, user } = await getHouseholdScope();

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > RESTORE_UPLOAD_LIMIT_BYTES) {
    return NextResponse.json(
      { ok: false, error: "备份文件超过 128MB，请拆分或清理过大的导入原文后重新备份" },
      { status: 413 },
    );
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json(
      { ok: false, error: "备份文件上传不完整或超过恢复上传限制，请重新选择备份文件后再恢复" },
      { status: 400 },
    );
  }
  const file = form.get("file");
  const username = String(form.get("username") ?? form.get("userName") ?? "");
  const userPassword = String(form.get("userPassword") ?? "");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "请选择备份文件" }, { status: 400 });
  }
  const credentialDenied = await verifySensitiveOperationUser(currentUser, username, userPassword);
  if (credentialDenied) return credentialDenied;

  const lowerFileName = file.name.toLowerCase();
  if (!lowerFileName.endsWith(".mmh-backup")) {
    return NextResponse.json({ ok: false, error: "恢复仅支持 MMH 加密备份（.mmh-backup）" }, { status: 400 });
  }

  try {
    const rawText = await file.text();
    const rawPayload = JSON.parse(rawText);
    const payload = await decryptBackupPackage(rawPayload);

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

    const summary = await restoreHouseholdBackup(payload, {
      householdId,
      fallbackAdmin: dbUser,
    });

    return NextResponse.json({
      ok: true,
      summary,
      message: "恢复完成",
    });
  } catch (error) {
    console.error("Backup restore failed", error);
    return NextResponse.json(
      { ok: false, error: restoreFailureMessage(error) },
      { status: 400 },
    );
  }
}
