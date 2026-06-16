import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";
import { LoginPageClient } from "./LoginPageClient";

export default async function LoginPage() {
  const cookieStore = await cookies();
  const hid = cookieStore.get("householdId")?.value;

  let householdName: string | null = null;
  if (hid) {
    const h = await prisma.household.findUnique({ where: { id: hid }, select: { name: true } });
    householdName = h?.name ?? null;
  } else {
    const first = await prisma.household.findFirst({ select: { name: true }, orderBy: { createdAt: "asc" } });
    householdName = first?.name ?? null;
  }

  return <LoginPageClient householdName={householdName} />;
}