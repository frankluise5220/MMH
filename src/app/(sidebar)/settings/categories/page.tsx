import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import SettingsCategoriesClient from "./client";

export const dynamic = "force-dynamic";

export default async function SettingsCategoriesPage() {
  const { hidFilter } = await getHouseholdScope();
  const categories = await prisma.category.findMany({
    where: hidFilter,
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });

  return <SettingsCategoriesClient categories={categories} />;
}
