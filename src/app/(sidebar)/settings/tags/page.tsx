import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import SettingsTagsClient from "./client";

export default async function TagsPage() {
  const { hidFilter } = await getHouseholdScope();
  const tags = await prisma.tag.findMany({
    where: { ...hidFilter },
    orderBy: { name: "asc" },
    select: { id: true, name: true, color: true },
  });

  return <SettingsTagsClient initialTags={tags} initialLoaded />;
}
