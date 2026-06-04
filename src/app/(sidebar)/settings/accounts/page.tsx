import Link from "next/link";
import { revalidatePath } from "next/cache";
import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { SettingsDeleteButton } from "@/components/SettingsDeleteButton";
import { AccountEditModalButton } from "@/components/AccountEditModalButton";
import { AccountGroupEditButton } from "@/components/AccountGroupEditButton";
import { CreateAccountForm } from "@/components/CreateAccountForm";
import { Power, PowerOff } from "lucide-react";

export const dynamic = "force-dynamic";

function isAccountKind(value: string): value is AccountKind {
  return Object.values(AccountKind).includes(value as AccountKind);
}

function kindLabel(kind: AccountKind) {
  if (kind === AccountKind.bank_credit) return "信用卡";
  if (kind === AccountKind.bank_debit) return "借记卡";
  if (kind === AccountKind.ewallet) return "电子钱包";
  if (kind === AccountKind.cash) return "现金";
  if (kind === AccountKind.investment) return "投资";
  if (kind === AccountKind.loan) return "贷款";
  return "其他";
}

const settingsListKindOrder: AccountKind[] = [
  AccountKind.bank_credit,
  AccountKind.bank_debit,
  AccountKind.ewallet,
  AccountKind.cash,
  AccountKind.investment,
  AccountKind.loan,
  AccountKind.other,
];

async function ensureDefaultAccountGroupId() {
  const existing = await prisma.accountGroup.findFirst({ where: { name: "未指定" } });
  if (existing?.id) return existing.id;
  const legacy = await prisma.accountGroup.findFirst({ where: { name: "默认" } });
  if (legacy?.id) {
    try {
      await prisma.accountGroup.update({ where: { id: legacy.id }, data: { name: "未指定" } });
    } catch {}
    return legacy.id;
  }
  try {
    return (await prisma.accountGroup.create({ data: { name: "未指定", sortOrder: 0 } })).id;
  } catch {
    return (await prisma.accountGroup.findFirst({ where: { name: "未指定" } }))?.id ?? null;
  }
}

async function createAccountGroup(formData: FormData) {
  "use server";

  const name = String(formData.get("groupName") ?? "").trim();
  if (!name) return;

  await prisma.accountGroup
    .create({
      data: { name, sortOrder: 0 },
    })
    .catch(() => null);

  revalidatePath("/settings/accounts");
  revalidatePath("/accounts");
}

async function updateAccountGroup(formData: FormData) {
  "use server";

  const groupId = String(formData.get("groupId") ?? "").trim();
  const name = String(formData.get("groupName") ?? "").trim();
  const sortOrder = Number(formData.get("sortOrder") ?? "0") || 0;
  if (!groupId || !name) return;

  await prisma.accountGroup.update({
    where: { id: groupId },
    data: { name, sortOrder },
  }).catch(() => null);

  revalidatePath("/settings/accounts");
  revalidatePath("/accounts");
}

async function createAccount(formData: FormData) {
  "use server";

  const name = String(formData.get("accountName") ?? "").trim();
  const kind = String(formData.get("kind") ?? "").trim();
  const currency = String(formData.get("currency") ?? "").trim() || "CNY";
  const groupId = String(formData.get("groupId") ?? "").trim();
  const institutionId = String(formData.get("institutionId") ?? "").trim();
  const billingDayRaw = String(formData.get("billingDay") ?? "").trim();
  const repaymentDayRaw = String(formData.get("repaymentDay") ?? "").trim();
  const creditLimitRaw = String(formData.get("creditLimit") ?? "").trim();
  const numberMaskedRaw = String(formData.get("numberMasked") ?? "").trim();
  const investProductTypeRaw = String(formData.get("investProductType") ?? "").trim();

  if (!name) return;

  const finalGroupId = groupId || (await ensureDefaultAccountGroupId()) || "";
  if (!finalGroupId) return;

  const finalKind = isAccountKind(kind) ? kind : AccountKind.other;
  const isBillLike = finalKind === AccountKind.bank_credit || finalKind === AccountKind.loan;

  const parseDay = (raw: string) => {
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const i = Math.trunc(n);
    if (i < 1 || i > 31) return null;
    return i;
  };
  const billingDay = isBillLike ? parseDay(billingDayRaw) : null;
  const repaymentDay = isBillLike ? parseDay(repaymentDayRaw) : null;

  const parseMoney = (raw: string) => {
    if (!raw) return null;
    const cleaned = raw.replace(/[, ]/g, "");
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return null;
    return n;
  };
  const creditLimit = isBillLike ? parseMoney(creditLimitRaw) : null;
  const numberMasked = isBillLike ? (numberMaskedRaw || null) : null;

  const validProductTypes = ["fund", "money", "wealth", "deposit"];
  const investProductType = finalKind === AccountKind.investment && validProductTypes.includes(investProductTypeRaw)
    ? investProductTypeRaw as import("@prisma/client").FundProductType
    : null;

  await prisma.account
    .create({
      data: {
        name,
        kind: finalKind,
        currency,
        groupId: finalGroupId,
        institutionId: institutionId || null,
        isActive: true,
        billingDay,
        repaymentDay,
        creditLimit,
        numberMasked,
        investProductType,
      },
    })
    .catch(() => null);

  revalidatePath("/settings/accounts");
  revalidatePath("/accounts");
  revalidatePath("/");
}

async function updateAccountRow(formData: FormData) {
  "use server";

  const intent = String(formData.get("intent") ?? "save").trim();
  const accountId = String(formData.get("accountId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const groupId = String(formData.get("groupId") ?? "").trim();
  const kind = String(formData.get("kind") ?? "").trim();
  const currency = String(formData.get("currency") ?? "").trim() || "CNY";
  const institutionId = String(formData.get("institutionId") ?? "").trim();
  const investProductTypeRaw = String(formData.get("investProductType") ?? "").trim();
  const billingDayRaw = String(formData.get("billingDay") ?? "").trim();
  const repaymentDayRaw = String(formData.get("repaymentDay") ?? "").trim();
  const creditLimitRaw = String(formData.get("creditLimit") ?? "").trim();
  const numberMaskedRaw = String(formData.get("numberMasked") ?? "").trim();

  if (!accountId) return;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.account.findUnique({ where: { id: accountId } });
    if (!existing) return;

    if (intent === "toggle") {
      await tx.account.update({
        where: { id: accountId },
        data: { isActive: !existing.isActive },
      });
      return;
    }

    const nextName = name || existing.name;
    const nextGroupId = groupId || (await ensureDefaultAccountGroupId()) || existing.groupId;
    const nextKind = isAccountKind(kind) ? kind : existing.kind;
    const nextCurrency = currency || existing.currency;
    const nextInstitutionId = institutionId || null;
    const validProductTypes = ["fund", "money", "wealth", "deposit"];
    const nextInvestProductType = nextKind === AccountKind.investment && validProductTypes.includes(investProductTypeRaw)
      ? investProductTypeRaw as import("@prisma/client").FundProductType
      : null;
    const validCostBasisMethods = ["moving_avg", "fifo", "lifo"];
    const costBasisMethodRaw = String(formData.get("costBasisMethod") ?? "").trim();
    const nextCostBasisMethod = nextKind === AccountKind.investment && validCostBasisMethods.includes(costBasisMethodRaw)
      ? costBasisMethodRaw as import("@prisma/client").CostBasisMethod
      : null;
    const defaultFundQueryApiId = String(formData.get("defaultFundQueryApiId") ?? "").trim() || null;

    const parseDay = (raw: string) => {
      if (!raw) return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      const i = Math.trunc(n);
      if (i < 1 || i > 31) return null;
      return i;
    };
    const isBillLike = nextKind === AccountKind.bank_credit || nextKind === AccountKind.loan;
    const nextBillingDay = isBillLike ? parseDay(billingDayRaw) : null;
    const nextRepaymentDay = isBillLike ? parseDay(repaymentDayRaw) : null;

    const parseMoney = (raw: string) => {
      if (!raw) return null;
      const cleaned = raw.replace(/[, ]/g, "");
      const n = Number(cleaned);
      if (!Number.isFinite(n)) return null;
      return n;
    };
    const nextCreditLimit = isBillLike ? parseMoney(creditLimitRaw) : null;
    const nextNumberMasked = isBillLike ? (numberMaskedRaw || null) : null;

    await tx.account.update({
      where: { id: accountId },
      data: {
        name: nextName,
        groupId: nextGroupId,
        kind: nextKind,
        currency: nextCurrency,
        institutionId: nextInstitutionId,
        billingDay: nextBillingDay,
        repaymentDay: nextRepaymentDay,
        creditLimit: nextCreditLimit,
        numberMasked: nextNumberMasked,
        investProductType: nextInvestProductType,
        costBasisMethod: nextCostBasisMethod,
        defaultFundQueryApiId: nextKind === AccountKind.investment ? defaultFundQueryApiId : null,
      },
    });

    if (existing.name !== nextName) {
      await tx.txRecord.updateMany({
        where: { accountId },
        data: { accountName: nextName },
      });

      await tx.txRecord.updateMany({
        where: { accountName: existing.name },
        data: { accountName: nextName },
      });
    }
  });

  revalidatePath("/settings/accounts");
  revalidatePath("/accounts");
  revalidatePath("/");
}

export default async function SettingsAccountsPage() {
  const [groups, institutions, accounts, statsById, statsByName, creditCycles, fundSnapshots, fundQueryApis] = await Promise.all([
    prisma.accountGroup.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.institution.findMany({ orderBy: [{ name: "asc" }] }),
    prisma.account.findMany({
      include: { AccountGroup: true, Institution: true },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    }),
    prisma.txRecord.groupBy({
      by: ["accountId"],
      _sum: { amount: true },
    }),
    prisma.txRecord.groupBy({
      by: ["accountName"],
      _sum: { amount: true },
    }),
    prisma.creditCardCycle.findMany({ orderBy: [{ statementMonth: "desc" }] }),
    prisma.fundSnapshot.findMany({ orderBy: [{ snapshotDate: "desc" }] }),
    prisma.fundQueryApi.findMany({ where: { isActive: true }, orderBy: { priority: "asc" } }),
  ]);

  const kindsInSettingsList = settingsListKindOrder.filter((kind) => accounts.some((a) => a.kind === kind));
  const groupOptions = groups.map((g) => ({ id: g.id, name: g.name }));
  const institutionOptions = institutions.map((it) => ({ id: it.id, name: it.name }));
  const fundQueryApiOptions = fundQueryApis.map((api) => ({ id: api.id, code: api.code, name: api.name }));

  const toN = (v: unknown) => {
    if (typeof v === "number") return v;
    if (v && typeof v === "object" && "toNumber" in v) return (v as { toNumber: () => number }).toNumber();
    return Number(v ?? 0);
  };
  const sumById = new Map(statsById.map((r) => [r.accountId!, toN(r._sum.amount)]));
  const sumByName = new Map(statsByName.map((r) => [r.accountName?.trim() ?? "", toN(r._sum.amount)]));
  const latestCreditRemain = new Map<string, number>();
  for (const c of creditCycles) {
    if (latestCreditRemain.has(c.accountId)) continue;
    latestCreditRemain.set(c.accountId, toN(c.cumulativeRemain));
  }
  const latestFundMarketValue = new Map<string, number>();
  for (const f of fundSnapshots) {
    if (latestFundMarketValue.has(f.accountId)) continue;
    latestFundMarketValue.set(f.accountId, toN(f.marketValue));
  }

  for (const a of accounts) {
    if (a.kind === AccountKind.bank_credit && a.billingDay) {
      const remain = latestCreditRemain.get(a.id);
      if (remain !== undefined) {
        const v = -remain;
        if (Number(a.balance) !== v) {
          await prisma.account.update({ where: { id: a.id }, data: { balance: String(v) } });
          a.balance = v as any;
        }
      }
      continue;
    }
    if (a.kind === AccountKind.investment) {
      const mv = latestFundMarketValue.get(a.id);
      if (mv !== undefined && Number(a.balance) !== mv) {
        await prisma.account.update({ where: { id: a.id }, data: { balance: String(mv) } });
        a.balance = mv as any;
      }
      continue;
    }
    const txSum = sumById.get(a.id) ?? sumByName.get(a.name) ?? 0;
    const cur = Number(a.balance);
    if (cur !== txSum) {
      await prisma.account.update({ where: { id: a.id }, data: { balance: String(txSum) } });
      a.balance = txSum as any;
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* account groups and create account panels */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-800">账户分组（所有人）</div>
          </div>
          <div className="p-4 space-y-3">
              <form action={createAccountGroup} className="flex items-center gap-2">
                <input
                  name="groupName"
                  className="h-9 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  placeholder="新增分组，例如：张三 / 李四 / 共同"
                />
                <button className="h-9 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700">新增</button>
              </form>
              <div className="text-xs text-slate-600 space-y-2">
                {groups.length ? (
                  groups.map((g) => (
                    <div
                      key={g.id}
                      className="border border-slate-200 rounded-md px-3 py-2 bg-slate-50 flex items-center justify-between"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-medium text-slate-800 truncate">{g.name}</span>
                        {g.sortOrder !== 0 && (
                          <span className="text-xs text-slate-400 tabular-nums shrink-0">#{g.sortOrder}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <AccountGroupEditButton group={g} action={updateAccountGroup} />
                        <SettingsDeleteButton
                          label={`分组：${g.name}`}
                          entity="accountGroup"
                          id={g.id}
                        />
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-slate-500">暂无分组</div>
                )}
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">新增账户</div>
            </div>
            <div className="p-4">
              <CreateAccountForm
                groups={groupOptions}
                institutions={institutionOptions}
                action={createAccount}
              />
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-800">账户列表</div>
          </div>
          <div className="overflow-auto max-h-[600px]">
            <table className="min-w-[1100px] w-full border-separate border-spacing-0">
              <colgroup>
                <col style={{width: "18%"}} />
                <col style={{width: "10%"}} />
                <col style={{width: "10%"}} />
                <col style={{width: "8%"}} />
                <col style={{width: "7%"}} />
                <col style={{width: "11%"}} />
                <col style={{width: "8%"}} />
                <col style={{width: "8%"}} />
                <col style={{width: "14%"}} />
              </colgroup>
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50">
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200 overflow-hidden text-ellipsis">名称</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200 overflow-hidden text-ellipsis">所有人</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200 overflow-hidden text-ellipsis">机构</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200 overflow-hidden text-ellipsis">类型</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200 overflow-hidden text-ellipsis">币种</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200 overflow-hidden text-ellipsis">账单日</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200 overflow-hidden text-ellipsis">还款日</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200 overflow-hidden text-ellipsis">状态</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200 overflow-hidden text-ellipsis">操作</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {accounts.length ? (
                  kindsInSettingsList.flatMap((kind) => {
                    const list = accounts.filter((a) => a.kind === kind);
                    return [
                      <tr key={`kind:${kind}`} className="bg-white">
                        <td colSpan={10} className="px-3 py-2 border-b border-slate-200 bg-slate-100">
                          <div className="text-xs font-semibold text-slate-700">{kindLabel(kind)}</div>
                        </td>
                      </tr>,
                      ...list.map((a) => {
                        const isBillLike = a.kind === AccountKind.bank_credit || a.kind === AccountKind.loan;
                        const editLabel =
                          a.kind === AccountKind.bank_credit
                            ? "信用卡设置"
                            : a.kind === AccountKind.loan
                              ? "账单设置"
                              : "编辑";
                        const editTitle =
                          a.kind === AccountKind.bank_credit
                            ? "信用卡账户设置"
                            : a.kind === AccountKind.loan
                              ? "账单账户设置"
                              : "账户设置";
                        return (
                          <tr key={a.id} className="hover:bg-slate-50">
                            <td className="px-3 py-2 border-b border-slate-100 overflow-hidden text-ellipsis">
                              <div className="text-xs font-medium text-slate-800 truncate">{a.name}</div>
                            </td>
                            <td className="px-3 py-2 border-b border-slate-100 overflow-hidden text-ellipsis">
                              <div className="text-xs text-slate-700 truncate">{a.AccountGroup?.name ?? ""}</div>
                            </td>
                            <td className="px-3 py-2 border-b border-slate-100 overflow-hidden text-ellipsis">
                              <div className="text-xs text-slate-700 truncate">{a.Institution?.name ?? ""}</div>
                            </td>
                            <td className="px-3 py-2 border-b border-slate-100 overflow-hidden text-ellipsis">
                              <div className="text-xs text-slate-700">{kindLabel(a.kind)}</div>
                            </td>
                            <td className="px-3 py-2 border-b border-slate-100 overflow-hidden text-ellipsis">
                              <div className="text-xs text-slate-700 tabular-nums">{a.currency}</div>
                            </td>
                            <td className="px-3 py-2 border-b border-slate-100 overflow-hidden text-ellipsis">
                              <div className="text-xs text-slate-700 tabular-nums">
                                {isBillLike ? (a.billingDay ? `${a.billingDay}日` : "-") : "-"}
                              </div>
                            </td>
                            <td className="px-3 py-2 border-b border-slate-100 overflow-hidden text-ellipsis">
                              <div className="text-xs text-slate-700 tabular-nums">
                                {isBillLike ? (a.repaymentDay ? `${a.repaymentDay}日` : "-") : "-"}
                              </div>
                            </td>
                            <td className="px-3 py-2 border-b border-slate-100 overflow-hidden text-ellipsis">
                              <span
                                className={`text-xs px-2 py-1 rounded-md border ${
                                  a.isActive
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                    : "bg-slate-50 text-slate-500 border-slate-200"
                                }`}
                              >
                                {a.isActive ? "启用" : "停用"}
                              </span>
                            </td>
                            <td className="px-3 py-2 border-b border-slate-100 overflow-hidden text-ellipsis">
                              <div className="flex items-center gap-2 relative">
                                <AccountEditModalButton
                                  label={editLabel}
                                  title={editTitle}
                                  variant={isBillLike ? "credit" : "default"}
                                  account={{
                                    id: a.id,
                                    name: a.name,
                                    groupId: a.groupId,
                                    institutionId: a.institutionId,
                                    kind: a.kind,
                                    currency: a.currency,
                                    billingDay: a.billingDay ?? null,
                                    repaymentDay: a.repaymentDay ?? null,
                                    creditLimit: a.creditLimit?.toString() ?? null,
                                    numberMasked: a.numberMasked ?? null,
                                    investProductType: a.investProductType ?? null,
                                    costBasisMethod: a.costBasisMethod ?? null,
                                    defaultFundQueryApiId: a.defaultFundQueryApiId ?? null,
                                  }}
                                  groups={groupOptions}
                                  institutions={institutionOptions}
                                  fundQueryApis={fundQueryApiOptions}
                                  action={updateAccountRow}
                                />
                                <form action={updateAccountRow}>
                                  <input type="hidden" name="accountId" value={a.id} />
                                  <button
                                    name="intent"
                                    value="toggle"
                                    title={a.isActive ? "停用账户" : "启用账户"}
                                    className={`h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white hover:border-amber-200 ${a.isActive ? "text-slate-500 hover:text-amber-600" : "text-amber-500 hover:text-amber-700"}`}
                                  >
                                    {a.isActive ? <PowerOff className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
                                  </button>
                                </form>
                                <SettingsDeleteButton label={`账户：${a.name}`} entity="account" id={a.id} />
                              </div>
                            </td>
                          </tr>
                        );
                      }),
                    ];
                  })
                ) : (
                  <tr>
                    <td className="px-4 py-6 text-slate-500" colSpan={9}>
                      暂无账户。你可以在上方新增，或在导入时自动创建。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
    </div>
  );
}
