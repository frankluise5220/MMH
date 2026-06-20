import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdDisplayName } from "@/lib/household-display";
import { LoginPageClient } from "./LoginPageClient";

export default async function LoginPage() {
  const cookieStore = await cookies();
  const hid = cookieStore.get("householdId")?.value;

  let householdName: string | null = null;
  if (hid) {
    const h = await prisma.household.findUnique({ where: { id: hid }, select: { id: true, name: true } });
    householdName = h ? getHouseholdDisplayName(h) : null;
  } else {
    const first = await prisma.household.findFirst({ select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
    householdName = first ? getHouseholdDisplayName(first) : null;
  }

  return <LoginPageClient householdName={householdName} />;
}
