import { prisma } from "@/lib/db/prisma";
import SettingsCategoriesClient from "./client";

export const dynamic = "force-dynamic";

export default async function SettingsCategoriesPage() {
  const categories = await prisma.category.findMany({
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });

  return <SettingsCategoriesClient categories={categories} />;
}
