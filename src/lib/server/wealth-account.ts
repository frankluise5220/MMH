import { prisma } from "@/lib/db/prisma";
import { resolveTradingCalendarForAccount } from "@/lib/fund/trading-calendar";
import { isWealthAccountAllowedForCashAccount } from "@/lib/wealth-account-rules";
import { normalizeCurrency } from "@/lib/currency";

type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

type ResolveWealthAccountInput = {
  householdId: string;
  cashAccountId: string;
  requestedAccountId?: string | null;
  /** 目标账户类型：wealth=理财账户（默认），bond=债券账户。两类账户互不混用。 */
  accountProductType?: "wealth" | "bond";
};

const wealthAccountInclude = {
  Institution: { select: { id: true, name: true, shortName: true, type: true } },
  AccountGroup: { select: { id: true, name: true } },
} as const;

/**
 * Resolves a wealth account for a purchase. Bank wealth accounts must belong to
 * the funding account's institution; third-party payment/wallet accounts are
 * also allowed. Missing same-institution accounts are created automatically.
 */
export async function resolveOrCreateWealthAccount(tx: Db, input: ResolveWealthAccountInput) {
  const accountProductType = input.accountProductType === "bond" ? "bond" : "wealth";
  const accountTypeLabel = accountProductType === "bond" ? "债券账户" : "理财账户";
  const cashAccount = await tx.account.findFirst({
    where: { id: input.cashAccountId, householdId: input.householdId, isActive: true },
    include: wealthAccountInclude,
  });
  if (!cashAccount) throw new Error("资金来源账户不存在或已停用");
  const cashCurrency = normalizeCurrency(cashAccount.currency);

  const requestedAccountId = input.requestedAccountId?.trim() || "";
  if (requestedAccountId) {
    const requested = await tx.account.findFirst({
      where: { id: requestedAccountId, householdId: input.householdId, isActive: true },
      include: wealthAccountInclude,
    });
    if (!requested || requested.kind !== "investment" || requested.investProductType !== accountProductType) {
      throw new Error(`${accountTypeLabel}不存在或类型不正确`);
    }
    if (normalizeCurrency(requested.currency) !== cashCurrency) {
      throw new Error(`${accountTypeLabel}币种必须与资金来源账户一致。资金来源是 ${cashCurrency}，${accountTypeLabel}是 ${normalizeCurrency(requested.currency)}`);
    }
    if (!isWealthAccountAllowedForCashAccount({
      cashGroupId: cashAccount.groupId,
      cashInstitutionId: cashAccount.institutionId,
      wealthGroupId: requested.groupId,
      wealthInstitutionId: requested.institutionId,
      wealthInstitutionType: requested.Institution?.type,
    })) {
      throw new Error(`${accountTypeLabel}只能选择资金来源同机构或第三方支付机构的账户`);
    }
    return requested;
  }

  if (!cashAccount.institutionId) {
    throw new Error("资金来源账户没有机构，无法自动建立理财账户");
  }

  const existing = await tx.account.findFirst({
    where: {
      householdId: input.householdId,
      groupId: cashAccount.groupId,
      institutionId: cashAccount.institutionId,
      kind: "investment",
      investProductType: accountProductType,
      currency: cashCurrency,
    },
    include: wealthAccountInclude,
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
  });
  if (existing) {
    if (existing.isActive) return existing;
    return tx.account.update({
      where: { id: existing.id },
      data: { isActive: true },
      include: wealthAccountInclude,
    });
  }

  return tx.account.create({
    data: {
      name: accountProductType === "bond" ? "债券" : "理财",
      kind: "investment",
      investProductType: accountProductType,
      currency: cashCurrency,
      householdId: input.householdId,
      groupId: cashAccount.groupId,
      institutionId: cashAccount.institutionId,
      userId: cashAccount.userId,
      isActive: true,
      tradingCalendar: resolveTradingCalendarForAccount("investment", accountProductType, null),
    },
    include: wealthAccountInclude,
  });
}
