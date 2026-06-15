import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import { verifyPassword } from "@/lib/auth/password";
import { getOrCreatePlaceholderAccountId } from "@/lib/server/placeholder-account";

export const runtime = "nodejs";

const fundProductTypes = ["fund", "money", "wealth", "deposit"] as const;
const costBasisMethods = ["moving_avg", "fifo", "lifo"] as const;

function normalizeFundProductType(raw: unknown) {
  const value = String(raw ?? "").trim();
  return fundProductTypes.includes(value as (typeof fundProductTypes)[number]) ? value : "fund";
}

function normalizeCostBasisMethod(raw: unknown) {
  const value = String(raw ?? "").trim();
  return costBasisMethods.includes(value as (typeof costBasisMethods)[number]) ? value : "moving_avg";
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

function getProvidedApiKey(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const key = req.headers.get("x-api-key");
  return key?.trim() || null;
}

function requireApiKey(req: Request) {
  const required = (process.env.STATEMENT_API_KEY ?? "").trim();
  if (!required) return { ok: true as const };
  const provided = getProvidedApiKey(req);
  if (!provided || provided !== required) return { ok: false as const };
  return { ok: true as const };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

// === Internal: POST (create) ===
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    const kind = (typeof body?.kind === "string" ? body.kind.trim() : "other") as any;
    const requestedGroupId = String(body.groupId ?? "").trim() || null;
    const requestedInstitutionId = String(body.institutionId ?? "").trim() || null;
    const currency = String(body.currency ?? "CNY").trim() || "CNY";
    const isInvestment = kind === "investment";

    if (!name) return NextResponse.json({ ok: false, error: "名称必填" }, { status: 400 });

    const { householdId } = await getHouseholdScope();

    const group = requestedGroupId
      ? await prisma.accountGroup.findFirst({ where: { id: requestedGroupId, householdId } })
      : await prisma.accountGroup.findFirst({ where: { householdId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
    const ensuredGroup = group ?? await prisma.accountGroup.create({
      data: { name: "默认分组", householdId, sortOrder: 0 },
    });

    const institution = requestedInstitutionId
      ? await prisma.institution.findFirst({ where: { id: requestedInstitutionId, householdId } })
      : null;
    if (requestedInstitutionId && !institution) return NextResponse.json({ ok: false, error: "机构不存在或不属于当前账簿" }, { status: 400 });

    const account = await prisma.account.create({
      data: {
        name,
        kind,
        currency,
        groupId: ensuredGroup.id,
        institutionId: institution?.id ?? null,
        householdId,
        isActive: true,
        investProductType: isInvestment ? normalizeFundProductType(body.investProductType) as any : null,
        costBasisMethod: isInvestment ? normalizeCostBasisMethod(body.costBasisMethod) as any : null,
        defaultFundQueryApiId: isInvestment ? String(body.defaultFundQueryApiId ?? "").trim() || null : null,
      },
    });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, account });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "创建失败" }, { status: 500 });
  }
}

// === Internal: PUT (update) ===
export async function PUT(req: NextRequest) {
  try {
    const { householdId, user } = await getHouseholdScope();
    const body = await req.json();
    const id = String(body.id ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

    const existing = await prisma.account.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ ok: false, error: "账户不存在" }, { status: 404 });
    if (!isAdmin(user) && existing.householdId !== householdId) {
      return NextResponse.json({ ok: false, error: "越权操作" }, { status: 403 });
    }

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = String(body.name).trim();
    if (body.kind !== undefined) data.kind = String(body.kind).trim();
    if (body.currency !== undefined) data.currency = String(body.currency ?? "CNY").trim() || "CNY";
    if (body.groupId !== undefined) data.groupId = String(body.groupId).trim() || null;
    if (body.institutionId !== undefined) data.institutionId = String(body.institutionId).trim() || null;

    const parseDay = (raw: unknown) => {
      if (raw === undefined) return undefined;
      const s = String(raw ?? "").trim();
      if (!s) return null;
      const n = Number(s);
      if (!Number.isFinite(n) || n < 1 || n > 31) return undefined;
      return n;
    };
    if (body.billingDay !== undefined) data.billingDay = parseDay(body.billingDay);
    if (body.repaymentDay !== undefined) data.repaymentDay = parseDay(body.repaymentDay);
    if (body.creditLimit !== undefined) data.creditLimit = String(body.creditLimit ?? "").trim() || null;
    if (body.numberMasked !== undefined) data.numberMasked = String(body.numberMasked ?? "").trim() || null;

    const nextKind = String(data.kind ?? existing.kind);
    if (nextKind === "investment") {
      if (body.investProductType !== undefined || existing.kind !== "investment") data.investProductType = normalizeFundProductType(body.investProductType ?? existing.investProductType) as any;
      if (body.costBasisMethod !== undefined || existing.kind !== "investment") data.costBasisMethod = normalizeCostBasisMethod(body.costBasisMethod ?? existing.costBasisMethod) as any;
      if (body.defaultFundQueryApiId !== undefined) data.defaultFundQueryApiId = String(body.defaultFundQueryApiId ?? "").trim() || null;
    } else {
      data.investProductType = null;
      data.costBasisMethod = null;
      data.defaultFundQueryApiId = null;
    }

    await prisma.account.update({ where: { id }, data });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "更新失败" }, { status: 500 });
  }
}

// === Internal: PATCH (toggle active) ===
export async function PATCH(req: NextRequest) {
  try {
    const { householdId, user } = await getHouseholdScope();
    const body = await req.json();
    const id = String(body.id ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

    const existing = await prisma.account.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ ok: false, error: "账户不存在" }, { status: 404 });
    if (!isAdmin(user) && existing.householdId !== householdId) {
      return NextResponse.json({ ok: false, error: "越权操作" }, { status: 403 });
    }

    await prisma.account.update({ where: { id }, data: { isActive: !existing.isActive } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "操作失败" }, { status: 500 });
  }
}

// === Internal: DELETE ===
export async function DELETE(req: NextRequest) {
  try {
    const { householdId, user } = await getHouseholdScope();
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

    const existing = await prisma.account.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ ok: false, error: "账户不存在" }, { status: 404 });
    if (existing.isPlaceholder) return NextResponse.json({ ok: false, error: "占位账户不可删除" }, { status: 403 });
    if (!isAdmin(user) && existing.householdId !== householdId) {
      return NextResponse.json({ ok: false, error: "越权操作" }, { status: 403 });
    }

    // Check if account has any records referencing it
    const recordCount = await prisma.txRecord.count({ where: { accountId: id } });
    const toRecordCount = await prisma.txRecord.count({ where: { toAccountId: id } });
    const hasRecords = recordCount > 0 || toRecordCount > 0;

    if (!hasRecords) {
      // No records → delete directly (cascade handles related tables)
      await prisma.account.delete({ where: { id } });
      return NextResponse.json({ ok: true });
    }

    // Has records → require password verification
    let body: { password?: string } | null = null;
    try { body = await req.json(); } catch { /* no body */ }
    const password = (body?.password ?? "").trim();
    if (!password) {
      return NextResponse.json({ ok: false, error: "该账户已产生记录，需输入密码才能删除", needPassword: true }, { status: 409 });
    }

    // Verify password against current user
    if (!user) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
    const currentUser = await prisma.user.findUnique({ where: { id: user.id } });
    if (!currentUser) return NextResponse.json({ ok: false, error: "用户不存在" }, { status: 401 });

    if (currentUser.passwordHash) {
      const match = await verifyPassword(password, currentUser.passwordHash);
      if (!match) return NextResponse.json({ ok: false, error: "密码错误" }, { status: 401 });
    } else {
      // No passwordHash → check legacy SystemSetting password
      const legacy = await prisma.systemSetting.findUnique({ where: { key: "access_password" } });
      if (!legacy || !legacy.value) {
        return NextResponse.json({ ok: false, error: "请先设置密码" }, { status: 400 });
      }
      if (password !== legacy.value) return NextResponse.json({ ok: false, error: "密码错误" }, { status: 401 });
    }

    // Password verified → reassign all references to placeholder account
    const placeholderId = await getOrCreatePlaceholderAccountId(householdId);

    // Update TxRecord where accountId = deleted account
    if (recordCount > 0) {
      await prisma.txRecord.updateMany({
        where: { accountId: id },
        data: { accountId: placeholderId, accountName: "空白" },
      });
    }

    // Update TxRecord where toAccountId = deleted account
    if (toRecordCount > 0) {
      await prisma.txRecord.updateMany({
        where: { toAccountId: id },
        data: { toAccountId: placeholderId, toAccountName: "空白" },
      });
    }

    // Reassign other related records (these have onDelete: Cascade,
    // but we want to preserve them by reassigning first)
    await prisma.fundConfirmDays.updateMany({ where: { accountId: id }, data: { accountId: placeholderId } });
    await prisma.fundFeeRate.updateMany({ where: { accountId: id }, data: { accountId: placeholderId } });
    await prisma.regularInvestPlan.updateMany({ where: { accountId: id }, data: { accountId: placeholderId } });
    await prisma.regularInvestPlan.updateMany({ where: { cashAccountId: id }, data: { cashAccountId: placeholderId } });

    // Snapshots & other related data are no longer meaningful → delete them
    await prisma.accountAlias.deleteMany({ where: { accountId: id } });
    await prisma.creditCardCycle.deleteMany({ where: { accountId: id } });
    await prisma.fundSnapshot.deleteMany({ where: { accountId: id } });
    await prisma.fundHolding.deleteMany({ where: { accountId: id } });

    // Now safe to delete the account (remaining cascade relations are already cleaned up)
    await prisma.account.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "删除失败" }, { status: 500 });
  }
}

// === External: GET (summaries, requires API key) ===
export async function GET(req: Request) {
  if (!requireApiKey(req).ok) {
    return NextResponse.json({ ok: false, error: "未授权" }, { status: 401, headers: corsHeaders() });
  }

  const rows = await prisma.txRecord.groupBy({
    by: ["accountName"],
    _sum: { amount: true },
    _count: { _all: true },
  });

  const accounts = rows
    .map((r) => ({ name: r.accountName, balance: toNumber(r._sum.amount), count: r._count._all }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));

  return NextResponse.json({ ok: true, accounts }, { headers: corsHeaders() });
}
