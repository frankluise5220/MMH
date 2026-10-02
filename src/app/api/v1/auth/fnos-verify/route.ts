import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdDisplayName } from "@/lib/household-display";
import { getUserSessionDays, issueSessionCookies } from "@/lib/server/session-issue";

export const runtime = "nodejs";

const MAX_EMAIL = 255;

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

interface FnosLoginUser {
  id: string;
  name: string;
  householdId: string | null;
  authVersion: number;
  email: string | null;
  Household: { id: string; name: string } | null;
}

function householdChoicesForUsers(users: FnosLoginUser[]) {
  const seen = new Set<string>();
  return users
    .map((user) => ({
      id: user.householdId,
      name: getHouseholdDisplayName({ id: user.householdId, name: user.Household?.name }, "未命名账簿"),
    }))
    .filter((household): household is { id: string; name: string } => {
      if (!household.id || seen.has(household.id)) return false;
      seen.add(household.id);
      return true;
    });
}

/**
 * POST /api/v1/auth/fnos-verify
 * Body: { householdId?: string, email?: string }
 *
 * fnOS-unified-gateway login. Requires the fnOS gateway to have forwarded the
 * user identity (X-Trim-Userid / X-Trim-Username). Resolves the ledger user by
 * fnosUid == X-Trim-Userid (Model 1: unique within a ledger, repeatable across
 * ledgers). When householdId is omitted and the UID is bound in several ledgers,
 * returns 409 AMBIGUOUS_USER with a ledger picker.
 *
 * An optional `email` is bound to the resolved user when provided (the fnOS
 * session is already authenticated by the gateway, so no extra code step).
 * On success sets the same session cookies as /api/v1/auth/verify.
 */
export async function POST(request: NextRequest) {
  const uid = request.headers.get("x-trim-userid");
  if (!uid) {
    return NextResponse.json(
      { ok: false, code: "NOT_BEHIND_GATEWAY", error: "fnOS gateway identity is not available in this environment." },
      { status: 403, headers: cors() },
    );
  }

  const schema = z.object({
    householdId: z.string().min(1).optional(),
    email: z.string().email().max(MAX_EMAIL).optional(),
  });
  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(await request.json().catch(() => null));
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "householdId and email are optional." }, { status: 400, headers: cors() });
  }

  const select = {
    id: true,
    name: true,
    householdId: true,
    authVersion: true,
    email: true,
    Household: { select: { id: true, name: true } },
  } as const;

  let matches: FnosLoginUser[];
  if (parsed.householdId) {
    const user = await prisma.user.findFirst({
      where: { fnosUid: uid, householdId: parsed.householdId },
      select,
    });
    matches = user ? [user] : [];
  } else {
    matches = await prisma.user.findMany({
      where: { fnosUid: uid },
      select,
      orderBy: { createdAt: "asc" },
    });
  }

  if (matches.length === 0) {
    return NextResponse.json(
      { ok: false, code: "FNOS_USER_NOT_BOUND", error: "该飞牛账号未绑定任何账簿用户，请先在系统设置里注册绑定。" },
      { status: 401, headers: cors() },
    );
  }
  if (matches.length > 1 && !parsed.householdId) {
    return NextResponse.json(
      { ok: false, code: "AMBIGUOUS_USER", error: "该飞牛账号绑定多个账簿，请选择要进入的账簿", households: householdChoicesForUsers(matches) },
      { status: 409, headers: cors() },
    );
  }

  const user = matches[0];

  if (parsed.email) {
    const email = parsed.email.trim().toLowerCase();
    if (user.email !== email) {
      const emailTaken = await prisma.user.findFirst({ where: { email, id: { not: user.id } }, select: { id: true } });
      if (emailTaken) {
        return NextResponse.json({ ok: false, code: "DUPLICATE_EMAIL", error: "This email is already used by another user." }, { status: 409, headers: cors() });
      }
      await prisma.user.update({ where: { id: user.id }, data: { email } });
    }
  }

  const response = NextResponse.json({ ok: true, username: user.name, householdId: user.householdId });
  issueSessionCookies(
    response,
    {
      userId: user.id,
      name: user.name,
      householdId: user.householdId,
      authVersion: user.authVersion,
    },
    { sessionDays: await getUserSessionDays(user.id), req: request },
  );
  return response;
}
