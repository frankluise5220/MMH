import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

/**
 * 获取所有账户列表（用于内部页面）
 * GET /api/v1/accounts/internal
 */
export async function GET() {
  try {
    const accounts = await prisma.account.findMany({
      where: {},
      select: {
        id: true,
        name: true,
        kind: true,
        Institution: { select: { name: true } },
      },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    });

    return NextResponse.json({
      ok: true,
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        institutionName: a.Institution?.name || null,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 }
    );
  }
}