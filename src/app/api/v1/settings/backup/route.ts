import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import {
  buildBackupFileName,
  buildHouseholdBackupPayload,
  buildHouseholdBackupWorkbook,
  parseBackupPayload,
  restoreHouseholdBackup,
} from "@/lib/server/backup";

export const runtime = "nodejs";

function requireAdmin(user: Awaited<ReturnType<typeof getCurrentUser>>) {
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ ok: false, error: "仅管理员可执行备份或恢复" }, { status: 403 });
  }
  return null;
}

/**
 * GET /api/v1/settings/backup
 *
 * Query:
 * - format=json|xlsx
 *
 * Response:
 * - `format=json`: downloads a full restore package for the current household.
 * - `format=xlsx`: downloads a workbook with visible sheets for manual review.
 */
export async function GET(req: NextRequest) {
  const currentUser = await getCurrentUser();
  const denied = requireAdmin(currentUser);
  if (denied) return denied;

  const { householdId, user } = await getHouseholdScope();
  const payload = await buildHouseholdBackupPayload(
    householdId,
    user ? { id: user.id, name: user.name, role: user.role } : null,
  );
  const format = req.nextUrl.searchParams.get("format") === "xlsx" ? "xlsx" : "json";
  const fileName = buildBackupFileName(payload.scope.householdName, payload.exportedAt, format);

  if (format === "xlsx") {
    const workbook = await buildHouseholdBackupWorkbook(payload);
    return new Response(new Uint8Array(workbook), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * POST /api/v1/settings/backup
 *
 * Restore the current household from a previously exported MMH JSON package.
 *
 * Body:
 * - multipart/form-data
 *   - `file`: the `.json` backup package exported by this endpoint
 *
 * Response:
 * - `{ ok: true, summary }`
 * - `{ ok: false, error }`
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  const denied = requireAdmin(currentUser);
  if (denied) return denied;

  const { householdId, user } = await getHouseholdScope();

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "请选择备份文件" }, { status: 400 });
  }

  if (!file.name.toLowerCase().endsWith(".json")) {
    return NextResponse.json({ ok: false, error: "恢复仅支持 MMH 打包备份（.json）" }, { status: 400 });
  }

  try {
    const rawText = await file.text();
    const rawPayload = JSON.parse(rawText);
    parseBackupPayload(rawPayload);

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

    const summary = await restoreHouseholdBackup(rawPayload, {
      householdId,
      fallbackAdmin: dbUser,
    });

    return NextResponse.json({
      ok: true,
      summary,
      message: "恢复完成",
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "恢复失败" },
      { status: 400 },
    );
  }
}
