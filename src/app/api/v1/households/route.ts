import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { canWrite, getCurrentUser, isAdmin, isReadOnly } from "@/lib/server/auth";
import { issueSessionCookies, sessionDaysFromRequest } from "@/lib/server/session-issue";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getHouseholdDisplayName } from "@/lib/household-display";
import { createLedgerWithDefaults } from "@/lib/households/create-ledger";
import { queueLedgerInventoryReport } from "@/lib/server/ledger-inventory";
import { matchesGatewayFnosIdentity, readGatewayFnosIdentity } from "@/lib/server/gateway-identity";
import { hashPassword } from "@/lib/auth/password";
import { optionalPrismaDeleteMany } from "@/lib/server/optional-prisma-delegate";
import { logger } from "@/lib/logger";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Authentication is required." }, { status: 401 });
  }

  // Always return all households (for the switch list); isAdmin/isSystem still reflect the current user's permissions
  const households = await prisma.household.findMany({
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const { householdId: activeId } = await getHouseholdScope();
  const displayHouseholds = households.map((household) => ({
    ...household,
    name: getHouseholdDisplayName(household),
  }));
  const active = households.find(h => h.id === activeId) ?? households[0] ?? null;

  return NextResponse.json({
    ok: true,
    active: active ? { ...active, name: getHouseholdDisplayName(active) } : null,
    households: displayHouseholds,
    isAdmin: isAdmin(user),
    isSystem: user?.isSystem === true,
    role: user?.role ?? null,
    isReadOnly: isReadOnly(user),
    canWrite: canWrite(user),
    canBackupSystem: isAdmin(user),
  });
}

/**
 * POST /api/v1/households
 * Creates a new household (including default owner, account, categories, and admin user).
 *
 * Body: { name: string, adminName: string, adminPassword: string, adminEmail: string }
 * - adminName: admin username / default family member name, must be explicitly provided
 * - adminPassword: admin password (hashed and stored immediately at creation, no longer deferred)
 * - adminEmail: admin email (used for password recovery)
 * Non-admin users are automatically linked to the new household after creating it.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Authentication is required." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  const adminName = String(body.adminName ?? "").trim();
  const adminPassword = String(body.adminPassword ?? "").trim();
  const adminEmail = String(body.adminEmail ?? "").trim();
  const fnosUid = String(body.fnosUid ?? "").trim();
  const gatewayIdentity = readGatewayFnosIdentity(req.headers);

  if (!name || name.length > 50) {
    return NextResponse.json({ ok: false, code: "INVALID_HOUSEHOLD_NAME", error: "Ledger name must be between 1 and 50 characters." }, { status: 400 });
  }
  if (!adminName || adminName.length > 50) {
    return NextResponse.json({ ok: false, code: "ADMIN_NAME_REQUIRED", error: "Administrator username must be between 1 and 50 characters." }, { status: 400 });
  }
  if (fnosUid) {
    if (!matchesGatewayFnosIdentity(gatewayIdentity, fnosUid)) {
      return NextResponse.json({ ok: false, code: "FNOS_ID_REQUIRED", error: "The fnOS account identity is required." }, { status: 400 });
    }
  } else if (!adminPassword || adminPassword.length < 1) {
    return NextResponse.json({ ok: false, code: "ADMIN_PASSWORD_REQUIRED", error: "Administrator password is required." }, { status: 400 });
  }

  const existingMmhPrincipal = !fnosUid
    ? await prisma.user.findFirst({
        where: { id: user.id, registrationPrincipalId: { not: null } },
        select: { registrationPrincipalId: true },
      })
    : null;

  // Hash before the transaction: bcrypt is CPU-bound and needs no database access.
  const adminPasswordHash = fnosUid || !adminPassword ? null : await hashPassword(adminPassword);

  const created = await prisma.$transaction((tx) =>
    createLedgerWithDefaults(
      tx,
      {
        name,
        adminName,
        adminPasswordHash,
        adminEmail,
        fnosUid: fnosUid || undefined,
        registrationPrincipalId: existingMmhPrincipal?.registrationPrincipalId,
      },
      { currentUser: user },
    ),
  );

  // A ledger was created; refresh the installation inventory in the background.
  queueLedgerInventoryReport("ledger-created");

  // Creating a ledger is also a login transition: issue the new admin session
  // so the redirect cannot reopen the previous ledger from stale cookies.
  const response = NextResponse.json({ ok: true, household: created.household });
  issueSessionCookies(
    response,
    {
      userId: created.adminUser.id,
      name: created.adminUser.name,
      householdId: created.household.id,
      authVersion: created.adminUser.authVersion,
    },
    { sessionDays: sessionDaysFromRequest(req), req },
  );
  return response;
}

/**
 * PUT /api/v1/households
 * Admin renames a household.
 *
 * Body: { id: string, name: string }
 */
export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "ADMIN_REQUIRED", error: "Administrator permission is required." }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();
  const name = String(body.name ?? "").trim();

  if (!id) {
    return NextResponse.json({ ok: false, code: "MISSING_ID", error: "A ledger ID is required." }, { status: 400 });
  }
  if (!name || name.length > 50) {
    return NextResponse.json({ ok: false, code: "INVALID_HOUSEHOLD_NAME", error: "Ledger name must be between 1 and 50 characters." }, { status: 400 });
  }

  const existing = await prisma.household.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ ok: false, code: "HOUSEHOLD_NOT_FOUND", error: "Ledger not found." }, { status: 404 });
  }

  await prisma.household.update({ where: { id }, data: { name } });
  return NextResponse.json({ ok: true, household: { id, name } });
}

/**
 * DELETE /api/v1/households
 * System admin deletes a household (the last household cannot be deleted).
 *
 * Body: { id: string }
 * Permission: only isSystem users can delete
 * Constraint: at least one household must remain
 */
export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();

  // Only system admins can delete a household
  if (!user || user.isSystem !== true) {
    return NextResponse.json({ ok: false, code: "SYSTEM_ADMIN_REQUIRED", error: "System administrator permission is required." }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();

  if (!id) {
    return NextResponse.json({ ok: false, code: "MISSING_ID", error: "A ledger ID is required." }, { status: 400 });
  }

  // Check whether the household exists
  const existing = await prisma.household.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ ok: false, code: "HOUSEHOLD_NOT_FOUND", error: "Ledger not found." }, { status: 404 });
  }

  // The last household cannot be deleted
  const count = await prisma.household.count();
  if (count <= 1) {
    return NextResponse.json({ ok: false, code: "LAST_HOUSEHOLD_NOT_DELETABLE", error: "The last ledger cannot be deleted." }, { status: 400 });
  }

  try {
    await prisma.$transaction(async (tx) => {
      // First fetch all account IDs under this household (reused below)
      const accounts = await tx.account.findMany({ where: { householdId: id }, select: { id: true } });
      const accountIds = accounts.map(a => a.id);

      // Delete regular invest plans under this household (via accountId; RegularInvestPlan.accountId is required)
      if (accountIds.length > 0) {
        await tx.regularInvestPlan.deleteMany({ where: { accountId: { in: accountIds } } });
      }
      await tx.undoOperation.deleteMany({ where: { householdId: id } });
      // Delete fund query API configs under this household
      await tx.fundQueryApi.deleteMany({ where: { householdId: id } });
      await tx.entryBusinessLink.deleteMany({ where: { householdId: id } });
      await optionalPrismaDeleteMany(
        tx,
        "stockPriceCache",
        { where: { StockSecurity: { is: { householdId: id } } } },
        { tableNames: ["stock_price_cache", "stock_securities"] },
      );
      await optionalPrismaDeleteMany(
        tx,
        "stockTransaction",
        { where: { householdId: id } },
        { tableNames: ["stock_transactions"] },
      );
      await optionalPrismaDeleteMany(
        tx,
        "stockMarketFeeRule",
        { where: { householdId: id } },
        { tableNames: ["stock_market_fee_rules"] },
      );
      await optionalPrismaDeleteMany(
        tx,
        "stockHolding",
        { where: { householdId: id } },
        { tableNames: ["stock_holdings"] },
      );
      await optionalPrismaDeleteMany(
        tx,
        "stockSecurity",
        { where: { householdId: id } },
        { tableNames: ["stock_securities"] },
      );
      // Cascade-delete account-related data
      if (accountIds.length > 0) {
        // Delete holdings
        await tx.fundHolding.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.preciousMetalHolding.deleteMany({ where: { accountId: { in: accountIds } } });
        await optionalPrismaDeleteMany(
          tx,
          "stockFeeRule",
          { where: { accountId: { in: accountIds } } },
          { tableNames: ["stock_fee_rules"] },
        );
        // Delete confirm days, fee rates, bill overrides, and credit card cycles
        await tx.fundConfirmDays.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.fundFeeRate.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.billOverride.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.creditCardCycle.deleteMany({ where: { accountId: { in: accountIds } } });
        // Delete transaction records
        await tx.txRecord.deleteMany({
          where: {
            OR: [
              { accountId: { in: accountIds } },
              { toAccountId: { in: accountIds } },
            ],
          },
        });
        // Delete account aliases (by accountId)
        await tx.accountAlias.deleteMany({ where: { accountId: { in: accountIds } } });
      }
      // After transaction records are deleted, EntryTags are cleaned up with them; now delete tags.
      await tx.tag.deleteMany({ where: { householdId: id } });
      // Delete accounts under this household
      await tx.account.deleteMany({ where: { householdId: id } });
      // Accounts and transactions must be deleted before the household-level data they still reference
      await tx.importBatch.deleteMany({ where: { householdId: id } });
      await tx.institution.deleteMany({ where: { householdId: id } });
      // Delete account owners under this household
      await tx.accountGroup.deleteMany({ where: { householdId: id } });
      // Delete categories under this household
      await tx.category.deleteMany({ where: { householdId: id } });
      // Delete users under this household
      await tx.user.deleteMany({ where: { householdId: id } });
      // Finally delete the household itself
      await tx.household.delete({ where: { id } });
    }, { maxWait: 10_000, timeout: 120_000 });
  } catch (error) {
    logger.error("Failed to delete ledger", "api/v1/households", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: "Failed to delete ledger." }, { status: 500 });
  }

  // A ledger was deleted; refresh the installation inventory in the background.
  queueLedgerInventoryReport("ledger-deleted");

  return NextResponse.json({ ok: true });
}
