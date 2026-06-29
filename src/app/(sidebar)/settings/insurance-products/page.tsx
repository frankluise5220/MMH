import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { SettingsInsuranceProductsClient } from "./client";

export const dynamic = "force-dynamic";

export default async function SettingsInsuranceProductsPage() {
  const { hidFilter } = await getHouseholdScope();

  const [products, accounts, institutions, ownerGroups, users] = await Promise.all([
    prisma.insuranceProduct.findMany({
      where: hidFilter,
      include: {
        Account: { select: { id: true, name: true } },
        Institution: { select: { id: true, name: true, shortName: true } },
        OwnerGroup: { select: { id: true, name: true } },
        InsuredUser: { select: { id: true, name: true } },
        _count: { select: { TxRecord: true } },
      },
      orderBy: [{ Institution: { name: "asc" } }, { name: "asc" }],
    }),
    prisma.account.findMany({
      where: { ...hidFilter, kind: "insurance", isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.institution.findMany({
      where: { ...hidFilter, type: "insurance" },
      select: { id: true, name: true, shortName: true },
      orderBy: { name: "asc" },
    }),
    prisma.accountGroup.findMany({
      where: hidFilter,
      select: { id: true, name: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.user.findMany({
      where: hidFilter,
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <SettingsInsuranceProductsClient
      initialProducts={products.map((item) => ({
        id: item.id,
        name: item.name,
        shortName: item.shortName,
        productType: item.productType,
        accountingType: item.accountingType,
        policyNo: item.policyNo,
        status: item.status,
        currency: item.currency,
        accountId: item.accountId,
        accountName: item.Account?.name ?? "",
        institutionId: item.institutionId,
        institutionName: item.Institution?.name ?? "",
        institutionShortName: item.Institution?.shortName ?? "",
        ownerGroupId: item.ownerGroupId,
        ownerGroupName: item.OwnerGroup?.name ?? "",
        insuredUserId: item.insuredUserId,
        insuredUserName: item.InsuredUser?.name ?? "",
        beneficiaryName: item.beneficiaryName,
        startDate: item.startDate?.toISOString().slice(0, 10) ?? null,
        effectiveDate: item.effectiveDate?.toISOString().slice(0, 10) ?? null,
        maturityDate: item.maturityDate?.toISOString().slice(0, 10) ?? null,
        premiumMode: item.premiumMode,
        premiumFrequencyMonths: item.premiumFrequencyMonths,
        premiumAmount: item.premiumAmount ? Number(item.premiumAmount) : null,
        paymentTermYears: item.paymentTermYears ? Number(item.paymentTermYears) : null,
        coverageTermYears: item.coverageTermYears ? Number(item.coverageTermYears) : null,
        coverageAmount: item.coverageAmount ? Number(item.coverageAmount) : null,
        cashValueEnabled: item.cashValueEnabled,
        note: item.note,
        txCount: item._count.TxRecord,
      }))}
      accounts={accounts}
      institutions={institutions.map((item) => ({
        id: item.id,
        name: item.name,
        shortName: item.shortName,
        label: item.shortName || item.name,
      }))}
      ownerGroups={ownerGroups}
      users={users}
    />
  );
}
