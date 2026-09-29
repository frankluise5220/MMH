import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

const MAX_FNOS_UID = 64;

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors() });
}

function normalizeFnosUid(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * POST /api/v1/settings/users/bind-fnid
 * Body: { userId, fnosUid: string | null }
 *
 * Binds (or unbinds, when fnosUid is null/empty) a fnOS user UID / FN ID to a
 * ledger user. Model 1: the same fnosUid may be bound in multiple ledgers, but
 * is unique within a single ledger.
 *
 * - Requires an admin (role=admin or isSystem).
 * - A system admin (isSystem=true) may only be modified by the system admin.
 * - A non-system target must belong to the current household.
 * - Binding a fnosUid already used by another user in the same household is a
 *   409 FNOS_UID_TAKEN.
 * Returns the updated user: { ok: true, data: { id, name, email, fnosUid } }.
 */
export async function POST(request: NextRequest) {
  const schema = z.object({
    userId: z.string().min(1),
    fnosUid: z.string().max(MAX_FNOS_UID).nullable().optional(),
  });
  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(await request.json().catch(() => null));
  } catch {
    return NextResponse.json(
      { ok: false, code: "INVALID_REQUEST", error: "userId and fnosUid are required." },
      { status: 400, headers: cors() },
    );
  }

  const fnosUid = normalizeFnosUid(parsed.fnosUid ?? null);

  try {
    const currentUser = await getCurrentUser();
    if (!currentUser || !isAdmin(currentUser)) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "需要管理员权限" }, { status: 403, headers: cors() });
    }
    const { householdId } = await getHouseholdScope();

    const target = await prisma.user.findUnique({ where: { id: parsed.userId } });
    if (!target) {
      return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "User was not found." }, { status: 404, headers: cors() });
    }
    if (target.isSystem && !(currentUser.isSystem === true)) {
      return NextResponse.json({ ok: false, code: "SYSTEM_ADMIN_RESTRICTED", error: "Only the system admin can bind the system admin." }, { status: 403, headers: cors() });
    }
    if (!target.isSystem && target.householdId !== householdId) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Unauthorized target user." }, { status: 403, headers: cors() });
    }

    // Model 1: unique within a ledger. Same fnosUid may exist in other ledgers.
    if (fnosUid) {
      const taken = await prisma.user.findFirst({
        where: { householdId: target.householdId ?? householdId, fnosUid, id: { not: parsed.userId } },
        select: { id: true },
      });
      if (taken) {
        return NextResponse.json({ ok: false, code: "FNOS_UID_TAKEN", error: "This FN ID is already bound to another user in this ledger." }, { status: 409, headers: cors() });
      }
    }

    const updated = await prisma.user.update({
      where: { id: parsed.userId },
      data: { fnosUid },
      select: { id: true, name: true, email: true, fnosUid: true, householdId: true, isSystem: true },
    });
    return NextResponse.json({ ok: true, data: updated }, { headers: cors() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: message }, { status: 500, headers: cors() });
  }
}
