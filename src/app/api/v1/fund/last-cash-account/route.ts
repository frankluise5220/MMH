import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId")?.trim();
  const fundCode = searchParams.get("fundCode")?.trim();

  if (!accountId) return NextResponse.json({ ok: false });

  const baseWhere = {
    OR: [{ toAccountId: accountId }, { accountId: accountId }],
    fundProductType: { not: null },
    deletedAt: null,
  };
  const where = fundCode
    ? { ...baseWhere, fundCode }
    : baseWhere;

  const last = await prisma.txRecord.findFirst({
    where,
    orderBy: { createdAt: "desc" },
    select: { accountId: true, toAccountId: true, fundSubtype: true },
  });

  // For buy records: accountId = cashAccount, toAccountId = investAccount
  // For redeem/switch_out records: accountId = investAccount, toAccountId = cashAccount
  // Determine cashAccountId based on fundSubtype
  let cashAccountId: string | null = null;
  if (last) {
    if (last.fundSubtype === "redeem" || last.fundSubtype === "switch_out") {
      cashAccountId = last.toAccountId;
    } else {
      cashAccountId = last.accountId;
    }
  }

  if (cashAccountId) {
    return NextResponse.json({ ok: true, cashAccountId, source: "last_used" });
  }

  const investAccount = await prisma.account.findUnique({
    where: { id: accountId },
    select: { institutionId: true },
  });

  if (investAccount?.institutionId) {
    const sameDebit = await prisma.account.findFirst({
      where: {
        institutionId: investAccount.institutionId,
        kind: "bank_debit",
        isActive: true,
      },
      orderBy: { name: "asc" },
      select: { id: true },
    });
    if (sameDebit) {
      return NextResponse.json({ ok: true, cashAccountId: sameDebit.id, source: "same_institution" });
    }

    const sameCash = await prisma.account.findFirst({
      where: {
        institutionId: investAccount.institutionId,
        kind: { in: ["cash", "ewallet"] },
        isActive: true,
      },
      orderBy: { name: "asc" },
      select: { id: true },
    });
    if (sameCash) {
      return NextResponse.json({ ok: true, cashAccountId: sameCash.id, source: "same_institution" });
    }
  }

  return NextResponse.json({ ok: true, cashAccountId: null, source: "none" });
}
