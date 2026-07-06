import { prisma } from "@/lib/db/prisma";
import { normalizeDefaultCategoryHierarchyForHousehold } from "@/lib/default-categories";
import { getHouseholdScope } from "@/lib/server/household-scope";
import SettingsCategoriesClient from "./client";

export default async function SettingsCategoriesPage() {
  const { householdId, hidFilter } = await getHouseholdScope();
  await normalizeDefaultCategoryHierarchyForHousehold(prisma, householdId);
  const categories = await prisma.category.findMany({
    where: { ...hidFilter },
    orderBy: { name: "asc" },
    select: { id: true, name: true, type: true, parentId: true, isSystem: true },
  });

  return <SettingsCategoriesClient categories={categories} initialLoaded />;
}
