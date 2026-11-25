import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdDisplayName } from "@/lib/household-display";
import { readGatewayFnosIdentity } from "@/lib/server/gateway-identity";
import { getUserSessionDays, issueSessionCookies } from "@/lib/server/session-issue";

export const runtime = "nodejs";

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
 * Body: { householdId?: string }
 *
 * fnOS-unified-gateway login. Requires the fnOS gateway to have forwarded the
 * user identity (X-Trim-Username / X-Trim-Userid). Resolves the ledger user by
 * `fnosUid` — matched against the fnOS **username** first, falling back to the
 * numeric UID for records bound before the window switched to usernames
 * (see lib/server/gateway-identity.ts). Model 1: unique within a ledger,
 * repeatable across ledgers. When householdId is omitted and the identity is
 * bound in several ledgers, returns 409 AMBIGUOUS_USER with a ledger picker.
 *
 * This endpoint signs in and does nothing else. It deliberately accepts no
 * profile fields: binding a recovery email is an account-data change, so it
 * belongs inside the ledger (Settings → Users) where the operator's permission
 * is checked — not on the sign-in card, where whoever holds the gateway session
 * could rewrite the recovery address of the account being entered.
 *
 * On success sets the same session cookies as /api/v1/auth/verify.
 */
export async function POST(request: NextRequest) {
  const identity = readGatewayFnosIdentity(request.headers);
  if (!identity) {
    return NextResponse.json(
      { ok: false, code: "NOT_BEHIND_GATEWAY", error: "fnOS gateway identity is not available in this environment." },
      { status: 403, headers: cors() },
    );
  }

  const schema = z.object({
    householdId: z.string().min(1).optional(),
  });
  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(await request.json().catch(() => null));
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "householdId is optional." }, { status: 400, headers: cors() });
  }

  const select = {
    id: true,
    name: true,
    householdId: true,
    authVersion: true,
    Household: { select: { id: true, name: true } },
  } as const;

  let matches: FnosLoginUser[];
  if (parsed.householdId) {
    const user = await prisma.user.findFirst({
      where: { fnosUid: { in: identity.keys }, householdId: parsed.householdId },
      select,
    });
    matches = user ? [user] : [];
  } else {
    matches = await prisma.user.findMany({
      where: { fnosUid: { in: identity.keys } },
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

  const response = NextResponse.json({ ok: true, username: user.name, householdId: user.householdId });
  issueSessionCookies(
    response,
    {
      userId: user.id,
      name: user.name,
      householdId: user.householdId,
      authVersion: user.authVersion,
      // The gateway vouched for this identity, so the session itself is not a
      // secret a later check can confirm. Marking it `fnos` makes the sensi-
      // tive-operation verifier ask for the ledger-local password this account
      // owns (never the MMH membership password, never the legacy deployment
      // password), and refuse with LOCAL_PASSWORD_REQUIRED when it has none.
      authMethod: "fnos",
    },
    { sessionDays: await getUserSessionDays(user.id), req: request },
  );
  return response;
}
