import { prisma } from "@/lib/db/prisma";
import { createDefaultCategoriesForHousehold } from "@/lib/default-categories";
import { createDefaultInstitutionsForHousehold } from "@/lib/default-institutions";
import { getDefaultTradingCalendarForAccount } from "@/lib/fund/trading-calendar";
import { optionalPrismaDeleteMany } from "@/lib/server/optional-prisma-delegate";

type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Clears every business record that belongs to `householdId` and then recreates
 * that household's default account group, accounts, categories, and
 * institutions. The `Household` row and its users are deliberately preserved so
 * the operator keeps their session and membership.
 *
 * Scope guarantees:
 * - every delete is filtered by `householdId`, or by an id set derived from that
 *   household's own accounts, so other households are never touched;
 * - system-level settings, users, and other households are not modified.
 *
/**
 * Callers own authentication: this function performs no permission checks.
 *
 * `client` exists for tests and native builds that need a differently configured
 * client; production callers should omit it and use the shared instance.
 */
export async function resetHouseholdData(input: {
  householdId: string;
  operatorName: string;
  client?: typeof prisma;
}): Promise<void> {
  const { householdId, operatorName } = input;
  const db = input.client ?? prisma;

  await db.$transaction(async (tx) => {
    const accountRows = await tx.account.findMany({ where: { householdId }, select: { id: true } });
    const accountIds = accountRows.map((account) => account.id);

    // Relations keyed by the household itself.
    await tx.entryBusinessLink.deleteMany({ where: { householdId } });
    await tx.fundTransactionCashFlow.deleteMany({ where: { FundTransaction: { householdId } } });
    await tx.fxConversion.deleteMany({ where: { householdId } });
    await tx.entryTag.deleteMany({ where: { transactions: { householdId } } });
    await tx.attachment.deleteMany({ where: { transactions: { householdId } } });

    await tx.creditCardInstallmentPlan.deleteMany({ where: { householdId } });
    await tx.loanRateAdjustment.deleteMany({ where: { householdId } });
    if (accountIds.length > 0) {
      await tx.regularInvestPlan.deleteMany({ where: { accountId: { in: accountIds } } });
    }

    // Business transaction tables (each carries householdId).
    await tx.fundTransaction.deleteMany({ where: { householdId } });
    await tx.insuranceTransaction.deleteMany({ where: { householdId } });
    await tx.wealthTransaction.deleteMany({ where: { householdId } });
    await tx.bondTransaction.deleteMany({ where: { householdId } });
    await tx.depositTransaction.deleteMany({ where: { householdId } });
    await tx.preciousMetalTransaction.deleteMany({ where: { householdId } });
    await tx.stockTransaction.deleteMany({ where: { householdId } });
    await tx.propertyTransaction.deleteMany({ where: { householdId } });
    await tx.txRecord.deleteMany({ where: { householdId } });

    // Product masters and asset rows.
    await tx.propertyValuation.deleteMany({ where: { householdId } });
    await tx.propertyAsset.deleteMany({ where: { householdId } });
    await tx.insuranceProduct.deleteMany({ where: { householdId } });
    await tx.insuranceProductMaster.deleteMany({ where: { householdId } });
    await tx.wealthProduct.deleteMany({ where: { householdId } });
    await tx.bondProduct.deleteMany({ where: { householdId } });
    await tx.depositProduct.deleteMany({ where: { householdId } });

    // Holdings and per-account configuration (account-scoped, no householdId).
    if (accountIds.length > 0) {
      await tx.fundHolding.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.fundSnapshot.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.fundConfirmDays.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.fundFeeRate.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.preciousMetalHolding.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.stockHolding.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.billOverride.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.creditCardCycle.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.accountAlias.deleteMany({ where: { accountId: { in: accountIds } } });
    }
    // StockFeeRule is account-scoped only; never filter it by householdId.
    await optionalPrismaDeleteMany(tx, "stockFeeRule", { where: { accountId: { in: accountIds } } }, { tableNames: ["stock_fee_rules"] });

    await tx.settlementAgreement.deleteMany({ where: { householdId } });

    // Optional models: some deployments have not applied these tables yet.
    await optionalPrismaDeleteMany(tx, "stockPriceCache", { where: { StockSecurity: { is: { householdId } } } }, { tableNames: ["stock_price_cache", "stock_securities"] });
    await optionalPrismaDeleteMany(tx, "stockSecurity", { where: { householdId } }, { tableNames: ["stock_securities"] });
    await optionalPrismaDeleteMany(tx, "stockMarketFeeRule", { where: { householdId } }, { tableNames: ["stock_market_fee_rules"] });
    await tx.preciousMetalType.deleteMany({ where: { householdId } });
    await tx.preciousMetalUnit.deleteMany({ where: { householdId } });

    // Accounts and the reference data they depend on.
    await tx.account.deleteMany({ where: { householdId } });
    await tx.accountGroup.deleteMany({ where: { householdId } });
    await tx.statementRecognitionRule.deleteMany({ where: { householdId } });
    await tx.category.deleteMany({ where: { householdId } });
    await tx.counterparty.deleteMany({ where: { householdId } });
    await tx.institution.deleteMany({ where: { householdId } });
    await tx.importBatch.deleteMany({ where: { householdId } });
    await tx.fundQueryApi.deleteMany({ where: { householdId } });
    await tx.fxRate.deleteMany({ where: { householdId } });
    await tx.emailAccount.deleteMany({ where: { householdId } });
    await tx.tag.deleteMany({ where: { householdId } });
    await tx.reimbursementBatch.deleteMany({ where: { householdId } });
    await tx.reimbursement.deleteMany({ where: { householdId } });
    await tx.undoOperation.deleteMany({ where: { householdId } });

    await createDefaultAccountData(tx, householdId, operatorName);
  }, { maxWait: 10_000, timeout: 120_000 });
}

async function createDefaultAccountData(tx: TransactionClient, householdId: string, userName: string) {
  const group = await tx.accountGroup.create({
    data: { name: userName.trim() || "admin", householdId, sortOrder: 0 },
  });

  const defaults: Array<{ name: string; kind: string; investProductType?: string }> = [
    { name: "现金钱包", kind: "cash" },
    { name: "银行储蓄", kind: "bank_debit" },
    { name: "投资账户", kind: "investment", investProductType: "fund" },
  ];
  for (const account of defaults) {
    await tx.account.create({
      data: {
        name: account.name,
        kind: account.kind as never,
        groupId: group.id,
        investProductType: account.investProductType as never,
        tradingCalendar: getDefaultTradingCalendarForAccount(account.kind, account.investProductType) as never,
        householdId,
        isActive: true,
        currency: "CNY",
      },
    });
  }

  await createDefaultCategoriesForHousehold(tx, householdId);
  await createDefaultInstitutionsForHousehold(tx, householdId);
}
