import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { SettingsInsuranceProductsClient } from "./client";

export const dynamic = "force-dynamic";

export default async function SettingsInsuranceProductsPage() {
  const { hidFilter } = await getHouseholdScope();

  const [productMasters, institutions] = await Promise.all([
    prisma.insuranceProductMaster.findMany({
      where: hidFilter,
      include: {
        Institution: { select: { id: true, name: true, shortName: true } },
        _count: { select: { InsuranceProduct: true } },
      },
      orderBy: [{ Institution: { name: "asc" } }, { name: "asc" }],
    }),
    prisma.institution.findMany({
      where: { ...hidFilter, type: "insurance" },
      select: { id: true, name: true, shortName: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <SettingsInsuranceProductsClient
      initialProducts={productMasters.map((item) => ({
        id: item.id,
        name: item.name,
        shortName: item.shortName,
        productType: item.productType,
        accountingType: item.accountingType,
        currency: item.currency,
        institutionId: item.institutionId,
        institutionName: item.Institution?.name ?? "",
        institutionShortName: item.Institution?.shortName ?? "",
        note: item.note,
        policyCount: item._count.InsuranceProduct,
      }))}
      institutions={institutions.map((item) => ({
        id: item.id,
        name: item.name,
        shortName: item.shortName,
        label: item.shortName || item.name,
      }))}
    />
  );
}
