import { FundSubtype, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";
import {
  classifyEntryBusinessType,
  type EntryBusinessType,
} from "@/lib/server/entry-business-link";

type BusinessIntegrityType = Exclude<EntryBusinessType, "other_investment">;

type BusinessIntegrityIssue = {
  entryId: string;
  businessType: BusinessIntegrityType;
  reason: "missingBusinessTransaction" | "missingBusinessLink" | "cannotRepair";
  detail?: string;
};

type ExpectedBusinessEntry = {
  id: string;
  businessType: BusinessIntegrityType;
  canRepair: boolean;
  cannotRepairDetail?: string;
};

const BUSINESS_TYPES: BusinessIntegrityType[] = ["fund", "insurance", "wealth", "deposit", "metal"];

function isRegularInvestRefund(entry: { fundSubtype?: string | null; source?: string | null }) {
  return entry.fundSubtype === FundSubtype.buy_failed && entry.source === "regular_invest_refund";
}

async function getExpectedBusinessEntries(householdId: string): Promise<ExpectedBusinessEntry[]> {
  const rows = await prisma.txRecord.findMany({
    where: {
      householdId,
      type: TransactionType.investment,
    },
    select: {
      id: true,
      householdId: true,
      type: true,
      accountId: true,
      toAccountId: true,
      fundProductType: true,
      fundCode: true,
      fundSubtype: true,
      source: true,
      wealthProductId: true,
      insuranceProductId: true,
      metalTypeId: true,
      metalTypeName: true,
      metalUnitId: true,
      metalUnitName: true,
      depositSourceEntryId: true,
    },
  });

  const expected: ExpectedBusinessEntry[] = [];
  for (const row of rows) {
    if (isRegularInvestRefund(row)) continue;
    const businessType = classifyEntryBusinessType(row);
    if (!businessType || businessType === "other_investment") continue;

    let canRepair = true;
    let cannotRepairDetail: string | undefined;
    if (businessType === "fund" && !row.fundCode) {
      canRepair = false;
      cannotRepairDetail = "基金记录缺少 fundCode";
    } else if (businessType === "fund" && !row.accountId && !row.toAccountId) {
      canRepair = false;
      cannotRepairDetail = "基金记录缺少基金账户";
    } else if (businessType === "insurance" && !row.insuranceProductId) {
      canRepair = false;
      cannotRepairDetail = "保险记录缺少 insuranceProductId";
    } else if (businessType === "metal" && (!row.metalTypeId || !row.metalUnitId || !row.metalTypeName || !row.metalUnitName)) {
      canRepair = false;
      cannotRepairDetail = "贵金属记录缺少品种或单位";
    }

    expected.push({
      id: row.id,
      businessType,
      canRepair,
      cannotRepairDetail,
    });
  }
  return expected;
}

async function existingBusinessIdsByType(householdId: string) {
  const [fund, insurance, wealth, deposit, metal] = await Promise.all([
    prisma.fundTransaction.findMany({ where: { householdId }, select: { id: true } }),
    prisma.insuranceTransaction.findMany({ where: { householdId }, select: { id: true } }),
    prisma.wealthTransaction.findMany({ where: { householdId }, select: { id: true } }),
    prisma.depositTransaction.findMany({ where: { householdId }, select: { id: true } }),
    prisma.preciousMetalTransaction.findMany({ where: { householdId }, select: { id: true } }),
  ]);
  return {
    fund: new Set(fund.map((row) => row.id)),
    insurance: new Set(insurance.map((row) => row.id)),
    wealth: new Set(wealth.map((row) => row.id)),
    deposit: new Set(deposit.map((row) => row.id)),
    metal: new Set(metal.map((row) => row.id)),
  } satisfies Record<BusinessIntegrityType, Set<string>>;
}

async function linkedBusinessIdsByType(householdId: string) {
  const rows = await prisma.entryBusinessLink.findMany({
    where: { householdId, deletedAt: null },
    select: {
      businessType: true,
      businessEntryId: true,
      fundTransactionId: true,
      insuranceTransactionId: true,
      wealthTransactionId: true,
      depositTransactionId: true,
      preciousMetalTransactionId: true,
    },
  });

  const result: Record<BusinessIntegrityType, Set<string>> = {
    fund: new Set(),
    insurance: new Set(),
    wealth: new Set(),
    deposit: new Set(),
    metal: new Set(),
  };
  for (const row of rows) {
    if (!BUSINESS_TYPES.includes(row.businessType as BusinessIntegrityType)) continue;
    const type = row.businessType as BusinessIntegrityType;
    const id =
      row.fundTransactionId ??
      row.insuranceTransactionId ??
      row.wealthTransactionId ??
      row.depositTransactionId ??
      row.preciousMetalTransactionId ??
      row.businessEntryId;
    if (id) result[type].add(id);
  }
  return result;
}

export async function auditBusinessTransactionIntegrity(householdId: string) {
  const [expected, existingByType, linkedByType] = await Promise.all([
    getExpectedBusinessEntries(householdId),
    existingBusinessIdsByType(householdId),
    linkedBusinessIdsByType(householdId),
  ]);

  const issues: BusinessIntegrityIssue[] = [];
  const summary = Object.fromEntries(BUSINESS_TYPES.map((type) => [type, {
    expected: 0,
    existing: existingByType[type].size,
    linked: linkedByType[type].size,
    missingBusinessTransaction: 0,
    missingBusinessLink: 0,
    cannotRepair: 0,
  }])) as Record<BusinessIntegrityType, {
    expected: number;
    existing: number;
    linked: number;
    missingBusinessTransaction: number;
    missingBusinessLink: number;
    cannotRepair: number;
  }>;

  for (const item of expected) {
    summary[item.businessType].expected += 1;
    if (!item.canRepair) {
      summary[item.businessType].cannotRepair += 1;
      issues.push({
        entryId: item.id,
        businessType: item.businessType,
        reason: "cannotRepair",
        detail: item.cannotRepairDetail,
      });
      continue;
    }
    if (!existingByType[item.businessType].has(item.id)) {
      summary[item.businessType].missingBusinessTransaction += 1;
      issues.push({
        entryId: item.id,
        businessType: item.businessType,
        reason: "missingBusinessTransaction",
      });
    }
    if (!linkedByType[item.businessType].has(item.id)) {
      summary[item.businessType].missingBusinessLink += 1;
      issues.push({
        entryId: item.id,
        businessType: item.businessType,
        reason: "missingBusinessLink",
      });
    }
  }

  return {
    ok: issues.length === 0,
    summary,
    issueCount: issues.length,
    issues,
  };
}

export async function repairBusinessTransactionIntegrity(householdId: string, limit = 5000) {
  const before = await auditBusinessTransactionIntegrity(householdId);
  const repairableIdsByType: Record<BusinessIntegrityType, Set<string>> = {
    fund: new Set(),
    insurance: new Set(),
    wealth: new Set(),
    deposit: new Set(),
    metal: new Set(),
  };

  for (const issue of before.issues) {
    if (issue.reason === "cannotRepair") continue;
    if (Array.from(repairableIdsByType[issue.businessType]).length >= limit) continue;
    repairableIdsByType[issue.businessType].add(issue.entryId);
  }

  let attempted = 0;
  const fundIds = Array.from(repairableIdsByType.fund);
  if (fundIds.length > 0) {
    await syncFundTransactionsFromTxRecords(fundIds);
    attempted += fundIds.length;
  }
  for (const type of ["insurance", "wealth", "deposit", "metal"] satisfies BusinessIntegrityType[]) {
    for (const id of repairableIdsByType[type]) {
      await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: id });
      attempted += 1;
    }
  }

  const after = await auditBusinessTransactionIntegrity(householdId);
  return {
    attempted,
    before,
    after,
  };
}
