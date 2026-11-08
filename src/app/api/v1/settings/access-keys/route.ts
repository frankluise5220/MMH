import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { revealStoredAccessKey, storeAccessKey, storedAccessKeyPreview } from "@/lib/server/access-key-auth";

export const runtime = "nodejs";

/**
 * API Key management endpoint (admin only).
 *
 * GET   /api/v1/settings/access-keys        → Lists API keys; full value included
 *                                              when the storage format is reversible
 *                                              (legacy hashed keys only preview)
 * POST  /api/v1/settings/access-keys        → Creates { name, key }; stores reversibly
 *                                              encrypted (AES-256-GCM) so it can be
 *                                              copied again later
 * DELETE /api/v1/settings/access-keys?id=…  → Deletes the specified key
 */
async function requireAdmin(): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Sign in first." }, { status: 401 }) };
  }
  if (!isAdmin(user)) {
    return { ok: false, response: NextResponse.json({ ok: false, code: "ADMIN_REQUIRED", error: "Administrator permission is required." }, { status: 403 }) };
  }
  return { ok: true };
}

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const keys = await prisma.accessKey.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, key: true, scope: true, createdAt: true },
  });

  return NextResponse.json({
    ok: true,
    keys: await Promise.all(keys.map(async (key) => ({
      id: key.id,
      name: key.name,
      keyPreview: await storedAccessKeyPreview(key.key),
      key: await revealStoredAccessKey(key.key),
      scope: normalizeScope(key.scope),
      createdAt: key.createdAt,
    }))),
  });
}

/** Anything other than an explicit "read" keeps full access. */
function normalizeScope(value: string): "read" | "write" {
  return value === "read" ? "read" : "write";
}

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  key: z.string().min(16).max(200),
  scope: z.enum(["read", "write"]).optional().default("write"),
});

export async function POST(req: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => null)) as unknown;
  const parse = CreateSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json(
      { ok: false, code: "INVALID_REQUEST", error: "Name and a strong access key are required." },
      { status: 400 },
    );
  }

  const { name, key, scope } = parse.data;
  const storedKey = await storeAccessKey(key);

  const created = await prisma.accessKey.create({
    data: { name, key: storedKey, scope },
    select: { id: true, name: true, key: true, scope: true, createdAt: true },
  });

  return NextResponse.json({
    ok: true,
    key: {
      id: created.id,
      name: created.name,
      keyPreview: await storedAccessKeyPreview(created.key),
      key: key.trim(),
      scope: normalizeScope(created.scope),
      createdAt: created.createdAt,
    },
  });
}

export async function DELETE(req: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";

  if (!id) {
    return NextResponse.json({ ok: false, code: "MISSING_ID", error: "Missing id." }, { status: 400 });
  }

  const existing = await prisma.accessKey.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ ok: false, code: "ACCESS_KEY_NOT_FOUND", error: "API key was not found." }, { status: 404 });
  }

  await prisma.accessKey.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
