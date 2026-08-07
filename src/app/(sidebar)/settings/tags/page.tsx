import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { readableTagWhere } from "@/lib/server/tag-scope";
import SettingsTagsClient from "./client";

export default async function TagsPage() {
  const { householdId } = await getHouseholdScope();
  const tags = await prisma.tag.findMany({
    where: readableTagWhere(householdId),
    orderBy: { name: "asc" },
    select: { id: true, name: true, color: true },
  });

  return <SettingsTagsClient initialTags={tags} initialLoaded />;
}
