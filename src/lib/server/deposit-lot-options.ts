import { prisma } from "@/lib/db/prisma";
import { depositCalendarDate, depositRedemptionPrincipal } from "@/lib/server/deposit-lot-balance";

export type DepositLotOption = {
  id: string;
  fundName: string;
  /**
   * 存单所挂存款产品的名称，仅作**显示**用。
   *
   * 老存单（迁移遗留）自身的 `fundName` 是 null —— 名称一直挂在 `DepositProduct.name`
   * 上。只返回 `fundName` 时，取回弹窗的「取出存单」下拉会渲染成「有选项、没文字」的
   * 空条目（2026-10-01 用户报障：先能看到两条存单，约 2 秒后接口返回把父级选项覆盖成空白）。
   * 这里单独给一个字段，避免把产品名写回 `fundName`（那会改掉存单自身的名称语义，
   * 也会让 `buildDepositLots` 按 fundName 分桶的兜底匹配失配）。
   */
  productName: string | null;
  /**
   * 存单挂的存款产品 id。取回弹窗要靠它把产品身份带到取回行上：
   * 以前这里没返回，弹窗拿到的是 undefined → 提交时既没有产品 id 也没有名称，
   * 服务端 `resolveOrCreateDepositProduct` 返回 null → 报「请选择或新增存款产品」，
   * 无名的老存单因此永远取不回来（2026-10-01 实测）。
   */
  depositProductId: string | null;
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
        depositProductId: true,
        DepositProduct: { select: { annualRate: true, name: true } },
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
        // 老存单 fundName 为 null，产品名才是真正的显示名；只给 fundName 会让下拉空白。
        productName: row.DepositProduct?.name?.trim() || null,
        depositProductId: row.depositProductId ?? null,
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
