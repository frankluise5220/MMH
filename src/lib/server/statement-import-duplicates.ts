import { prisma } from "@/lib/db/prisma";
import { parseImportAccountId } from "@/lib/account-import-match";
import { addDaysUtc, formatDateUtc, parseDateInputToUtc } from "@/lib/date-utils";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";

/**
 * 账单「重复导入」检测。
 *
 * 判定口径（用户口径）：**同一天里、同一类型（支出/收入/转账/投资）下，已有记录的笔数与
 * 金额跟这次要导入的完全一致**，就说明这一天已经入过账 —— 典型场景是同一份账单被导了两遍。
 *
 * 三个条件缺一不可：
 * - 只比"这一天有记录"会误判（一天吃三顿饭很常见）；
 * - 只比总额会漏判（金额互相抵消）；
 * - 不比类型也会误判：同一天一笔 500 的支出和一笔 500 的收入笔数金额都对得上，
 *   但明显不是同一份账单（支出/收入/转账混在一起比较毫无意义）。
 *
 * 所以按「账户 + 日期 + 类型」分组后比较金额多重集合：笔数相同且每笔金额都能一一对上才算重复。
 * 类型未知的行走"不分类型"兜底（与旧口径一致），避免调用方漏传 type 时整体失效。
 *
 * 这里只做**检测**，不写流水；覆盖（软删除旧记录）由调用方显式传 action=delete 触发，
 * 因为删数据必须是用户点过「覆盖」之后的动作。
 */

export type StatementDuplicateItemLike = {
  type?: string | null;
  date?: string | null;
  amount?: number | null;
  inflow?: number | null;
  outflow?: number | null;
  account?: string | null;
  fromAccount?: string | null;
  toAccount?: string | null;
};

export type StatementDuplicateGroup = {
  accountId: string;
  accountName: string;
  /** YYYY-MM-DD（业务日历日，UTC 零点存储）。 */
  date: string;
  /** expense | income | transfer | investment；null = 类型未知时的不分类型兜底。 */
  type: string | null;
  count: number;
  amountTotal: number;
  recordIds: string[];
};

export type StatementDuplicateResult = {
  total: number;
  groups: StatementDuplicateGroup[];
};

function amountKeyOf(item: StatementDuplicateItemLike): string | null {
  const raw = Math.abs(Number(item.amount ?? 0));
  const amount = raw > 0 ? raw : Math.abs(Number(item.outflow ?? 0));
  if (!Number.isFinite(amount) || amount === 0) return null;
  return amount.toFixed(2);
}

function itemAccountId(item: StatementDuplicateItemLike): string | null {
  for (const value of [item.account, item.fromAccount, item.toAccount]) {
    const id = value ? parseImportAccountId(String(value).trim()) : null;
    if (id) return id;
  }
  return null;
}

function itemAccountName(item: StatementDuplicateItemLike): string | null {
  for (const value of [item.account, item.fromAccount, item.toAccount]) {
    const text = String(value ?? "").trim();
    if (text && !parseImportAccountId(text)) return text;
  }
  return null;
}

const TX_TYPES = new Set(["expense", "income", "transfer", "investment"]);

/**
 * 取这一行的收支类型。预览页的 item 一定带 type；批量导入页可能只给收/支列与
 * 对向账户，这里按同样的口径兜底推断，推断不出来才退回"不分类型"。
 */
function itemTypeOf(item: StatementDuplicateItemLike): string | null {
  const raw = String(item.type ?? "").trim().toLowerCase();
  if (TX_TYPES.has(raw)) return raw;
  if (item.fromAccount || item.toAccount) return "transfer";
  if (Number(item.inflow ?? 0) > 0) return "income";
  if (Number(item.outflow ?? 0) > 0) return "expense";
  return null;
}

/**
 * 找出「同日期 + 同笔数 + 同金额」的已存在记录。
 * 账户未能识别（预览里还没选账户）的行直接跳过 —— 没账户就无从比较。
 */
export async function detectStatementImportDuplicates(
  householdId: string,
  items: StatementDuplicateItemLike[],
): Promise<StatementDuplicateResult> {
  type Bucket = { accountId: string; dateKey: string; type: string | null; amounts: string[] };
  const buckets = new Map<string, Bucket>();
  let minDay: Date | null = null;
  let maxDay: Date | null = null;

  // 账户兜底：预览里可能只写了账户名（批量导入页），按名字反查一次。
  const unresolvedNames = new Set<string>();
  for (const item of items) {
    if (itemAccountId(item)) continue;
    const name = itemAccountName(item);
    if (name) unresolvedNames.add(name);
  }
  const nameToId = new Map<string, string>();
  if (unresolvedNames.size > 0) {
    const accounts = await prisma.account.findMany({
      where: { householdId, name: { in: [...unresolvedNames] } },
      select: { id: true, name: true },
    });
    for (const account of accounts) nameToId.set(account.name, account.id);
  }

  for (const item of items) {
    const accountId = itemAccountId(item) ?? nameToId.get(itemAccountName(item) ?? "") ?? null;
    if (!accountId) continue;
    const day = parseDateInputToUtc(String(item.date ?? ""));
    if (!day) continue;
    const amountKey = amountKeyOf(item);
    if (!amountKey) continue;
    const dateKey = formatDateUtc(day);
    const type = itemTypeOf(item);
    const key = `${accountId}|${dateKey}|${type ?? "*"}`;
    const bucket = buckets.get(key) ?? { accountId, dateKey, type, amounts: [] };
    bucket.amounts.push(amountKey);
    buckets.set(key, bucket);
    if (!minDay || day < minDay) minDay = day;
    if (!maxDay || day > maxDay) maxDay = day;
  }

  if (buckets.size === 0 || !minDay || !maxDay) return { total: 0, groups: [] };

  const accountIds = Array.from(new Set([...buckets.values()].map((bucket) => bucket.accountId)));
  const records = await prisma.txRecord.findMany({
    where: {
      householdId,
      deletedAt: null,
      accountId: { in: accountIds },
      date: { gte: minDay, lt: addDaysUtc(maxDay, 1) },
    },
    select: { id: true, accountId: true, date: true, amount: true, type: true },
  });

  // 同一批记录建两份索引：按类型的（正常口径）与不分类型的（type 未知时的兜底）。
  const existing = new Map<string, { ids: string[]; amounts: string[] }>();
  for (const record of records) {
    if (!record.accountId) continue;
    const base = `${record.accountId}|${formatDateUtc(record.date)}`;
    const amountKey = Math.abs(Number(record.amount ?? 0)).toFixed(2);
    for (const key of [`${base}|${record.type}`, `${base}|*`]) {
      const entry = existing.get(key) ?? { ids: [], amounts: [] };
      entry.ids.push(record.id);
      entry.amounts.push(amountKey);
      existing.set(key, entry);
    }
  }

  const accountNames = new Map(
    (
      await prisma.account.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, name: true },
      })
    ).map((account) => [account.id, account.name]),
  );

  const groups: StatementDuplicateGroup[] = [];
  let total = 0;
  for (const [key, bucket] of buckets) {
    const match = existing.get(key);
    if (!match || match.ids.length !== bucket.amounts.length) continue;
    const incoming = [...bucket.amounts].sort();
    const current = [...match.amounts].sort();
    const sameAmounts = incoming.every((amount, index) => amount === current[index]);
    if (!sameAmounts) continue;
    const amountTotal = incoming.reduce((sum, amount) => sum + Number(amount), 0);
    groups.push({
      accountId: bucket.accountId,
      accountName: accountNames.get(bucket.accountId) ?? "",
      date: bucket.dateKey,
      type: bucket.type,
      count: bucket.amounts.length,
      amountTotal: Math.round(amountTotal * 100) / 100,
      recordIds: match.ids,
    });
    total += bucket.amounts.length;
  }

  groups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { total, groups };
}

/** 用户选择「覆盖」：软删除检测到的旧记录，并重算受影响账户余额。 */
export async function deleteStatementImportDuplicates(
  householdId: string,
  recordIds: string[],
): Promise<number> {
  if (recordIds.length === 0) return 0;
  const targets = await prisma.txRecord.findMany({
    where: { id: { in: recordIds }, householdId, deletedAt: null },
    select: { id: true, accountId: true },
  });
  if (targets.length === 0) return 0;
  const deleted = await prisma.txRecord.updateMany({
    where: { id: { in: targets.map((target) => target.id) }, householdId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  const accountIds = Array.from(
    new Set(targets.map((target) => target.accountId).filter((id): id is string => Boolean(id))),
  );
  for (const accountId of accountIds) {
    await recalcAndSaveAccountBalance(accountId).catch(() => undefined);
  }
  return deleted.count;
}
