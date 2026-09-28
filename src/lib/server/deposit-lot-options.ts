import { prisma } from "@/lib/db/prisma";
import { depositCalendarDate, depositRedemptionPrincipal } from "@/lib/server/deposit-lot-balance";

export type DepositLotOption = {
  id: string;
  fundName: string;
  startDate: string | null;
  maturityDate: string | null;
  remainingAmount: number;
  annualRate: number | null;
  latestInterestDate: string | null;
  depositAccountId: string;
  depositAccountName: string;
};

function toIsoDate(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

export async function loadDepositLotOptions(params: {
  householdId: string;
  accountIds?: string[];
  includeClosed?: boolean;
  excludeEntryId?: string | null;
}): Promise<DepositLotOption[]> {
  const requestedAccountIds = (params.accountIds ?? []).map((id) => id.trim()).filter(Boolean);
  const depositAccounts = await prisma.account.findMany({
    where: {
      householdId: params.householdId,
      isPlaceholder: { not: true },
      OR: [{ kind: "deposit" }, { investProductType: "deposit" }],
      ...(requestedAccountIds.length > 0 ? { id: { in: requestedAccountIds } } : {}),
    },
    select: { id: true, name: true },
  });
  if (depositAccounts.length === 0) return [];

  const accountNameById = new Map(depositAccounts.map((account) => [account.id, account.name]));
  const depositAccountIds = depositAccounts.map((account) => account.id);
  const [buyRows, redemptionRows, interestRows] = await Promise.all([
    prisma.txRecord.findMany({
      where: {
        householdId: params.householdId,
        deletedAt: null,
        type: "investment",
        fundProductType: "deposit",
        fundSubtype: "buy",
        toAccountId: { in: depositAccountIds },
      },
      select: {
        id: true,
        date: true,
        amount: true,
        fundArrivalAmount: true,
        fundName: true,
        fundCode: true,
        fundConfirmDate: true,
        fundArrivalDate: true,
        depositAnnualRate: true,
        DepositProduct: { select: { annualRate: true } },
        toAccountId: true,
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    }),
    prisma.txRecord.findMany({
          where: {
            householdId: params.householdId,
            deletedAt: null,
            type: "investment",
            fundProductType: "deposit",
            fundSubtype: { in: ["redeem", "switch_out"] },
            accountId: { in: depositAccountIds },
            ...(params.excludeEntryId ? { id: { not: params.excludeEntryId } } : {}),
          },
          select: { depositSourceEntryId: true, amount: true, fundArrivalAmount: true, depositInterest: true },
        }),
    prisma.txRecord.findMany({
      where: {
        householdId: params.householdId,
        deletedAt: null,
        source: "deposit",
        type: "income",
        accountId: { in: depositAccountIds },
      },
      select: {
        id: true,
        date: true,
        accountId: true,
        depositSourceEntryId: true,
        fundName: true,
        fundCode: true,
        note: true,
      },
    }),
  ]);

  const redemptionsByLotId = new Map<string, typeof redemptionRows>();
  for (const row of redemptionRows) {
    if (!row.depositSourceEntryId) continue;
    const rows = redemptionsByLotId.get(row.depositSourceEntryId);
    if (rows) rows.push(row);
    else redemptionsByLotId.set(row.depositSourceEntryId, [row]);
  }
  const interestDatesByLotId = new Map<string, Date>();
  for (const buy of buyRows) {
    const lotName = (buy.fundName ?? buy.fundCode ?? "").trim();
    const matchingRows = interestRows.filter((interest) => {
      if (interest.depositSourceEntryId) return interest.depositSourceEntryId === buy.id;
      if (interest.accountId !== buy.toAccountId || !lotName) return false;
      const interestDate = depositCalendarDate(interest.date);
      const startDate = depositCalendarDate(buy.date);
      const maturityDate = depositCalendarDate(buy.fundArrivalDate);
      if (!interestDate || (startDate && interestDate < startDate) || (maturityDate && interestDate > maturityDate)) return false;
      const interestName = (interest.fundName ?? interest.fundCode ?? "").trim();
      return (interestName && interestName === lotName) || Boolean(interest.note?.includes(lotName));
    });
    const latest = matchingRows.reduce<Date | null>((current, interest) => {
      if (!current || depositCalendarDate(interest.date)! > depositCalendarDate(current)!) return interest.date;
      return current;
    }, null);
    if (latest) interestDatesByLotId.set(buy.id, latest);
  }
  return buyRows
    .filter((row) => {
      if (params.includeClosed) return true;
      const originalPrincipal = Math.abs(Number(row.fundArrivalAmount ?? row.amount ?? 0));
      const redeemedPrincipal = (redemptionsByLotId.get(row.id) ?? []).reduce(
        (total, redemption) => total + depositRedemptionPrincipal(redemption),
        0,
      );
      return originalPrincipal - redeemedPrincipal > 0.0001;
    })
    .map((row) => {
      const depositAccountId = row.toAccountId ?? "";
      const originalPrincipal = Math.abs(Number(row.fundArrivalAmount ?? row.amount ?? 0));
      const redeemedPrincipal = (redemptionsByLotId.get(row.id) ?? []).reduce(
        (total, redemption) => total + depositRedemptionPrincipal(redemption),
        0,
      );
      return {
        id: row.id,
        fundName: row.fundName?.trim() || row.fundCode?.trim() || "",
        startDate: toIsoDate(row.fundConfirmDate ?? row.date),
        maturityDate: toIsoDate(row.fundArrivalDate),
        remainingAmount: Math.max(0, Number((originalPrincipal - redeemedPrincipal).toFixed(2))),
        annualRate: row.depositAnnualRate != null
          ? Number(row.depositAnnualRate)
          : row.DepositProduct?.annualRate != null
            ? Number(row.DepositProduct.annualRate)
            : null,
        latestInterestDate: depositCalendarDate(interestDatesByLotId.get(row.id)),
        depositAccountId,
        depositAccountName: accountNameById.get(depositAccountId) ?? "",
      };
    })
    .filter((lot) => Boolean(lot.depositAccountId));
}

export async function depositLotBelongsToAccount(params: {
  householdId: string;
  accountId: string;
  lotId: string;
}): Promise<boolean> {
  const lot = await prisma.txRecord.findFirst({
    where: {
      id: params.lotId,
      householdId: params.householdId,
      deletedAt: null,
      type: "investment",
      fundProductType: "deposit",
      fundSubtype: "buy",
      toAccountId: params.accountId,
    },
    select: { id: true },
  });
  return Boolean(lot);
}
