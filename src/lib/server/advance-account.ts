import { AccountKind, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

type ResolveAdvanceAccountInput = {
  householdId: string;
  cashAccountId: string;
  debtObjectId: string;
  /** Explicit settlement account picked in the advance dialog; reused only when it belongs to the selected counterparty. */
  preferredAccountId?: string;
};

const SETTLEMENT_ACCOUNT_SUFFIX = "的往来款";
const SETTLEMENT_GROUP_NAME = "往来款";
const BORROW_LEND_GROUP_NAME = "借入/借出";
const LIABILITY_GROUP_NAME = "负债";
/** 中性兜底分组：往来对象本就没有「所有人」，不该蹭某个人的分组。 */
const UNSET_GROUP_NAME = "未指定";

type SettlementAccountRow = {
  id: string;
  name: string;
  isActive: boolean;
  kind: AccountKind;
};

/**
 * Legacy advance rows were created as `loan` accounts (the "安盾" bug). Bring
 * them in line with ordinary counterparty settlement accounts: kind=settlement,
 * name "XX的往来款", filed under the 往来款 account group.
 *
 * 口径（2026-09-13）：挂在往来对象上的 kind=loan 账户也可能是贷款窗口建的
 * **贷款账户**（账户 kind 按入口窗口判定，不按对象属性）——这类账户只补激活，
 * 绝不改型、不改名（代付流程的账户查找已排除 loan，正常不会走到这一支）。
 */
async function ensureSettlementShape(
  tx: Db,
  account: SettlementAccountRow,
  input: { householdId: string; objectName: string },
): Promise<SettlementAccountRow> {
  if (account.isActive && (account.kind === AccountKind.settlement || account.kind === AccountKind.loan)) return account;
  const data: Prisma.AccountUncheckedUpdateInput = { isActive: true };
  if (account.kind !== AccountKind.settlement && account.kind !== AccountKind.loan) {
    data.kind = AccountKind.settlement;
    data.name = `${input.objectName}${SETTLEMENT_ACCOUNT_SUFFIX}`;
    const group = await findSettlementGroup(tx, input.householdId);
    if (group) data.groupId = group.id;
  }
  return tx.account.update({
    where: { id: account.id },
    data,
    select: { id: true, name: true, isActive: true, kind: true },
  });
}

/**
 * 往来款账户该落在哪个分组。
 *
 * 分组的真实语义是「所有人」（owner），而往来对象本就没有所有人
 * （`accounts/route.ts` 对 loan/settlement 把 groupName 归空），所以**绝不能**
 * 回落到「任意第一个分组」——那会把账户塞进某个人的分组（例如「张四」）。
 * 落在哪个中性分组并不关键（用户事后可以自己调整），**关键是别抛错**。
 *
 * 优先级：往来款 → 借入/借出 → 负债 → **未指定** → 任意第一个 → 自愈建「未指定」。
 * 「未指定」这一层是 0.1.52 的既有行为，勿再丢。
 *
 * **保证有返回值**：历史库/极端情况下一个分组都没有时，直接补一个中性的
 * 「未指定」，避免升级后因缺分组让整条代付记账链路抛错。
 */
async function findSettlementGroup(tx: Db, householdId: string) {
  const dedicated = await tx.accountGroup.findFirst({
    where: { householdId, name: { in: [SETTLEMENT_GROUP_NAME, BORROW_LEND_GROUP_NAME, LIABILITY_GROUP_NAME] } },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true },
  });
  if (dedicated) return dedicated;

  const unset = await tx.accountGroup.findFirst({
    where: { householdId, name: UNSET_GROUP_NAME },
    select: { id: true },
  });
  if (unset) return unset;

  const fallback = await tx.accountGroup.findFirst({
    where: { householdId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true },
  });
  if (fallback) return fallback;

  // 一个分组都没有：自愈建一个中性的，别让代付链路挂掉。
  return tx.accountGroup.create({
    data: { name: UNSET_GROUP_NAME, householdId, sortOrder: 0 },
    select: { id: true },
  });
}

export async function resolveOrCreateAdvanceAccount(tx: Db, input: ResolveAdvanceAccountInput) {
  const cashAccount = await tx.account.findFirst({
    where: { id: input.cashAccountId, householdId: input.householdId, isActive: true },
    select: { id: true, currency: true },
  });
  if (!cashAccount) throw new Error("资金账户不存在或已停用");

  const refMatch = /^(counterparty|institution):(.+)$/.exec(input.debtObjectId);
  const sourceKind = refMatch?.[1] ?? "counterparty";
  const sourceId = refMatch?.[2] ?? input.debtObjectId;
  const counterparty = sourceKind === "counterparty"
    ? await tx.counterparty.findFirst({
        where: { id: sourceId, householdId: input.householdId },
        select: { id: true, name: true, shortName: true, sourceInstitutionId: true },
      })
    : null;
  const institution = !counterparty
    ? await tx.institution.findFirst({
        where: { id: sourceId, householdId: input.householdId, type: { in: ["person", "organization"] } },
        select: { id: true, name: true, shortName: true },
      })
    : null;
  if (!counterparty && !institution) throw new Error("请选择往来对象");

  const relationWhere = counterparty
    ? {
        OR: [
          { counterpartyId: counterparty.id },
          ...(counterparty.sourceInstitutionId ? [{ institutionId: counterparty.sourceInstitutionId }] : []),
        ],
      }
    : { institutionId: institution!.id };

  const objectId = counterparty?.id ?? institution!.id;
  const objectName = counterparty?.shortName?.trim() || counterparty?.name || institution?.shortName?.trim() || institution!.name;
  // 口径（2026-09-13）：代付的账户侧只能是往来款账户。挂在往来对象上的 kind=loan
  // 账户是贷款窗口建的贷款账户（按入口窗口判定，不按对象属性），不得被代付流程
  // 复用/改型——同对象多账户是允许的（09-11 用户定版），名下只有贷款账户时直接新建往来款账户。
  const kindWhere = { kind: AccountKind.settlement, isPlaceholder: { not: true } };
  const accountSelect = { id: true, name: true, isActive: true, kind: true } as const;
  const ensureShape = (account: SettlementAccountRow) =>
    ensureSettlementShape(tx, account, { householdId: input.householdId, objectName });

  // An explicitly picked account wins, but only while it still belongs to the
  // selected counterparty (the dialog options are scoped to it).
  if (input.preferredAccountId) {
    const preferred = await tx.account.findFirst({
      where: { id: input.preferredAccountId, householdId: input.householdId, ...relationWhere, ...kindWhere },
      select: accountSelect,
    });
    if (preferred) {
      const account = await ensureShape(preferred);
      return { account, objectId, objectName };
    }
  }

  // Reuse the counterparty settlement account when one exists.
  const existing = await tx.account.findFirst({
    where: { householdId: input.householdId, ...relationWhere, ...kindWhere },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    select: accountSelect,
  });
  if (existing) {
    const account = await ensureShape(existing);
    return { account, objectId, objectName };
  }

  // 规则（09-11 用户定版）：该往来对象名下**已有往来款账户**时，不允许自动建立——
  // 必须由用户在表单里选择（preferredAccountId），或手动新建（手动新建已有
  // assertAccountIdentityUnique 禁同名）。这里做一次不限于 settlement 的兜底：
  // 历史「安盾」类杂类账户（kind 非 settlement/loan）归一复用；**贷款账户（kind=loan）
  // 除外**——那是贷款窗口建的贷款账户（09-13 口径），名下只有贷款账户时按上面
  // 的规则直接新建往来款账户，绝不把贷款账户抓来当往来款用。
  const stillOwned = await tx.account.findFirst({
    where: { householdId: input.householdId, isPlaceholder: { not: true }, kind: { not: AccountKind.loan }, ...relationWhere },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    select: accountSelect,
  });
  if (stillOwned) {
    const account = await ensureShape(stillOwned);
    return { account, objectId, objectName };
  }

  // findSettlementGroup 保证非空（极端情况会自愈建「未指定」），这里不再抛错。
  const group = await findSettlementGroup(tx, input.householdId);

  const account = await tx.account.create({
    data: {
      name: `${objectName}${SETTLEMENT_ACCOUNT_SUFFIX}`,
      kind: AccountKind.settlement,
      debtDirection: "receivable",
      currency: cashAccount.currency,
      groupId: group.id,
      counterpartyId: counterparty?.id ?? null,
      institutionId: institution?.id ?? null,
      householdId: input.householdId,
      isActive: true,
    },
    select: { id: true, name: true, isActive: true, kind: true },
  });
  return { account, objectId, objectName };
}
