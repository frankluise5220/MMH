import { prisma } from "@/lib/db/prisma";
import { parseImportAccountId, resolveImportAccountFromList } from "@/lib/account-import-match";
import { addDaysUtc, formatDateUtc, parseDateInputToUtc } from "@/lib/date-utils";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";

/**
 * 账单「重复导入」检测（唯一一套口径，2026-11-16 用户裁定）。
 *
 * 判重身份按「日期 + 交易身份」分组，组内先比**笔数**、笔数一致再比**金额**，
 * 两样都一致才判定为重复：
 *
 * - 转账的身份是 **A 转钱到 B**：`转出账户 → 转入账户`（方向不可颠倒，反向流水是另一笔钱）。
 * - 支出/收入/投资的身份是 `账户 + 类型`（单边没有对手方，只能按账户与类型归组）。
 *
 * 这就是原先「整份账单导两遍」的整组口径，唯一的变化是把转账从「单账户」改成
 * 「A→B 方向」：库里转账落库为 `accountId = 转出方`、`toAccountId = 转入方`，所以
 * 同一天转出方还有别的收款/付款时，不会被并进同一组而把笔数算错。
 *
 * 为什么必须先比笔数：单边记录只按金额比对会把同一天两笔真实的同额消费（两笔 20 元
 * 停车费）吞掉；整组比对才既能挡住「同一份账单导两遍」，又不会误删真实流水。
 *
 * 日期不做宽容窗口：分组键里的日期就是业务日历日，账单的交易日/记账日错位由调用方
 * 在预览里修正；跨日期放宽会让「每月固定同额还款」被判成重复，用户点「覆盖」就把
 * 上个月的记录删掉了。
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
  /** 新导入行的备注：覆盖旧记录时用来判断「备注是否不一致」，也是追加旧备注的基底。 */
  remark?: string | null;
  /** 没有备注时的落账备注来源（与 /statement/import 的 buildNote 一致）。 */
  rawText?: string | null;
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
  /** 转账分组带上对手账户名，界面可以直接说清「哪一笔转给谁」。 */
  counterAccountName?: string;
};

/** 覆盖时要把旧备注追加到哪一行（index 是本次 items 数组下标）。 */
export type StatementDuplicateMergedNote = {
  index: number;
  note: string;
};

export type StatementDuplicateResult = {
  total: number;
  groups: StatementDuplicateGroup[];
  /**
   * 「覆盖」时新记录该用的备注：旧记录有备注且与新备注不一致时，把旧备注追到后面。
   * 只有检测出重复的组才会产生条目；没有需要合并的行时为空数组。
   */
  nextNotes: StatementDuplicateMergedNote[];
};

const TX_TYPES = new Set(["expense", "income", "transfer", "investment"]);

function amountKeyOf(item: StatementDuplicateItemLike): string | null {
  const raw = Math.abs(Number(item.amount ?? 0));
  const amount = raw > 0 ? raw : Math.abs(Number(item.outflow ?? 0));
  if (!Number.isFinite(amount) || amount === 0) return null;
  return amount.toFixed(2);
}

/** 落账备注里由 `buildNote` 自动追加的「（入账日期 …）」，比对时不算用户备注差异。 */
const POSTED_DATE_SUFFIX_RE = /\s*[（(]入账日期?\s*[^）)]*[）)]\s*$/;

function noteCompareKey(value: string | null | undefined) {
  return String(value ?? "").trim().replace(POSTED_DATE_SUFFIX_RE, "").trim();
}

/**
 * 覆盖旧记录时的备注合并（2026-11-24 用户裁定）：
 * 新旧备注不一致时，把**旧备注追加到新记录后面**，避免用户手工补的备注
 * （报销、用途说明）随覆盖一起丢失。
 *
 * - 旧备注为空 → 保留新备注；
 * - 新备注为空（或只有入账日期后缀）→ 直接用旧备注；
 * - 两条一致、或一方已经包含另一方（同一份账单导第二遍、上次已合并过）→ 不重复追加。
 */
export function mergeImportNote(newNote: string | null | undefined, oldNote: string | null | undefined) {
  const current = String(newNote ?? "").trim();
  const previous = String(oldNote ?? "").trim();
  if (!previous) return current;
  const currentKey = noteCompareKey(current);
  const previousKey = noteCompareKey(previous);
  if (!previousKey) return current;
  if (!currentKey) return previous;
  if (currentKey === previousKey) return current;
  // 一方已经包含另一方（模板微调、上次覆盖时已合并过）→ 取信息更全的那条，不重复追加。
  if (currentKey.includes(previousKey)) return current;
  if (previousKey.includes(currentKey)) return previous;
  return `${current}；${previous}`;
}

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

type AccountMatcherSource = Awaited<ReturnType<typeof loadHouseholdAccounts>>[number];

function loadHouseholdAccounts(householdId: string) {
  return prisma.account.findMany({
    where: { householdId },
    select: {
      id: true,
      name: true,
      kind: true,
      numberMasked: true,
      Institution: { select: { name: true, shortName: true } },
      AccountGroup: {
        select: { name: true, Institution: { select: { name: true, shortName: true } } },
      },
      AccountAlias: { select: { alias: true } },
      Counterparty: { select: { name: true, shortName: true } },
    },
  });
}

/** 行里的账户单元格可能是 `account-id:xxx`，也可能是账户名；名字走与落账同一套匹配器。 */
function resolveAccountCell(
  value: string | null | undefined,
  accounts: AccountMatcherSource[],
): { id: string | null; name: string | null } {
  const text = String(value ?? "").trim();
  if (!text) return { id: null, name: null };
  const direct = parseImportAccountId(text);
  if (direct) return { id: direct, name: null };
  const matched = resolveImportAccountFromList(text, accounts);
  return matched ? { id: matched.id, name: matched.name } : { id: null, name: text };
}

/**
 * 交易身份：转账是 `A→B`（方向敏感），其余是单账户。
 * 转账解析不出双方（只有一边账户名）时退回单账户口径，仍然按整组比对。
 */
function identityOf(type: string | null, accountId: string | null, toAccountId: string | null): string | null {
  if (type === "transfer" && accountId && toAccountId && accountId !== toAccountId) {
    return `T:${accountId}>${toAccountId}`;
  }
  return accountId ? `S:${accountId}` : null;
}

type ResolvedRow = {
  /** 该行在调用方 items 数组里的下标：覆盖时按金额配对，把旧备注写回这一行。 */
  index: number;
  type: string | null;
  dateKey: string;
  amountKey: string;
  accountId: string | null;
  toId: string | null;
  accountName: string | null;
  counterAccountName: string | null;
};

type Bucket = {
  key: string;
  type: string | null;
  dateKey: string;
  accountId: string;
  accountName: string;
  /** 转账的对手账户 id：输出时换成账户名，解析不出双方时为空。 */
  counterAccountId?: string;
  amounts: string[];
  /** 组内每个导入行的下标与金额键：与旧记录按金额一一配对追加备注。 */
  items: Array<{ index: number; amountKey: string }>;
};

/**
 * 找出与库里已有记录重复的导入行。
 *
 * 返回的 `recordIds` 是「覆盖」时要软删的旧记录；`total` 是命中的导入行数。
 */
export async function detectStatementImportDuplicates(
  householdId: string,
  items: StatementDuplicateItemLike[],
): Promise<StatementDuplicateResult> {
  // 账户兜底：预览里可能是名字（批量导入页 / 邮件账单），也可能是 `account-id:xxx`。
  const needsNameMatch = items.some((item) =>
    [item.account, item.fromAccount, item.toAccount].some((value) => {
      const text = String(value ?? "").trim();
      return Boolean(text) && !parseImportAccountId(text);
    }),
  );
  const accounts = needsNameMatch ? await loadHouseholdAccounts(householdId) : [];

  const rows: ResolvedRow[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const date = parseDateInputToUtc(String(item.date ?? ""));
    if (!date) continue;
    const amountKey = amountKeyOf(item);
    if (!amountKey) continue;
    const type = itemTypeOf(item);
    const from = resolveAccountCell(item.fromAccount, accounts);
    const to = resolveAccountCell(item.toAccount, accounts);
    const account = resolveAccountCell(item.account, accounts);
    // 转账落库挂转出方；转入方向（信用卡还款入账）预览里的 account 是收款方，不能用它。
    const accountId = type === "transfer" ? from.id ?? account.id ?? to.id : account.id ?? from.id ?? to.id;
    rows.push({
      index,
      type,
      dateKey: formatDateUtc(date),
      amountKey,
      accountId,
      toId: to.id,
      accountName: from.name ?? account.name,
      counterAccountName: to.name,
    });
  }
  if (rows.length === 0) return { total: 0, groups: [], nextNotes: [] };

  // 按「日期 + 类型 + 交易身份」归组：组内笔数一致后，再比金额多重集。
  const buckets = new Map<string, Bucket>();
  const scopeAccountIds = new Set<string>();
  let minDayKey = rows[0].dateKey;
  let maxDayKey = rows[0].dateKey;
  for (const row of rows) {
    if (row.accountId) scopeAccountIds.add(row.accountId);
    if (row.toId) scopeAccountIds.add(row.toId);
    if (row.dateKey < minDayKey) minDayKey = row.dateKey;
    if (row.dateKey > maxDayKey) maxDayKey = row.dateKey;
    const identity = identityOf(row.type, row.accountId, row.type === "transfer" ? row.toId : null);
    if (!identity) continue;
    const key = `${row.dateKey}|${row.type ?? "*"}|${identity}`;
    const bucket = buckets.get(key) ?? {
      key,
      type: row.type,
      dateKey: row.dateKey,
      accountId: row.accountId ?? "",
      accountName: row.accountName ?? "",
      counterAccountId: row.type === "transfer" ? row.toId ?? undefined : undefined,
      amounts: [],
      items: [],
    };
    bucket.amounts.push(row.amountKey);
    bucket.items.push({ index: row.index, amountKey: row.amountKey });
    buckets.set(key, bucket);
  }
  if (buckets.size === 0 || scopeAccountIds.size === 0) return { total: 0, groups: [], nextNotes: [] };

  const minDay = parseDateInputToUtc(minDayKey);
  const maxDay = parseDateInputToUtc(maxDayKey);
  if (!minDay || !maxDay) return { total: 0, groups: [], nextNotes: [] };
  const maxDayExclusive = addDaysUtc(maxDay, 1);

  const accountIdList = [...scopeAccountIds];
  const records = await prisma.txRecord.findMany({
    where: {
      householdId,
      deletedAt: null,
      date: { gte: minDay, lt: maxDayExclusive },
      OR: [{ accountId: { in: accountIdList } }, { toAccountId: { in: accountIdList } }],
    },
    select: { id: true, accountId: true, toAccountId: true, date: true, amount: true, type: true, note: true },
  });

  const nameById = new Map<string, string>();
  for (const account of accounts) nameById.set(account.id, account.name);
  const missingNameIds = accountIdList.filter((id) => !nameById.has(id));
  if (missingNameIds.length > 0) {
    const extra = await prisma.account.findMany({
      where: { id: { in: missingNameIds } },
      select: { id: true, name: true },
    });
    for (const account of extra) nameById.set(account.id, account.name);
  }

  // 库里已有记录按同样的分组键建索引；类型未知时用 `*` 兜底（不分类型整组比对）。
  const existing = new Map<string, { ids: string[]; amounts: string[]; notes: string[] }>();
  for (const record of records) {
    const dateKey = formatDateUtc(record.date);
    const identity = identityOf(record.type, record.accountId, record.toAccountId);
    if (!identity) continue;
    const amount = Math.abs(Number(record.amount ?? 0)).toFixed(2);
    for (const key of [`${dateKey}|${record.type}|${identity}`, `${dateKey}|*|${identity}`]) {
      const entry = existing.get(key) ?? { ids: [], amounts: [], notes: [] };
      entry.ids.push(record.id);
      entry.amounts.push(amount);
      entry.notes.push(record.note ?? "");
      existing.set(key, entry);
    }
  }

  const groups: StatementDuplicateGroup[] = [];
  const nextNotes: StatementDuplicateMergedNote[] = [];
  let total = 0;
  for (const [key, bucket] of buckets) {
    const match = existing.get(key);
    if (!match) continue;
    // 先比数量：数量不一致就不是同一组交易（例如当天还有别的流水）。
    if (match.ids.length !== bucket.amounts.length) continue;
    // 再比金额：数量相同才逐笔比对（排序后多重集相等 = 金额完全一致）。
    const incoming = [...bucket.amounts].sort();
    const current = [...match.amounts].sort();
    const sameAmounts = incoming.every((amount, index) => amount === current[index]);
    if (!sameAmounts) continue;
    const amountTotal = incoming.reduce((sum, amount) => sum + Number(amount), 0);
    groups.push({
      accountId: bucket.accountId,
      accountName: nameById.get(bucket.accountId) ?? bucket.accountName ?? "",
      date: bucket.dateKey,
      type: bucket.type,
      count: bucket.amounts.length,
      amountTotal: Math.round(amountTotal * 100) / 100,
      recordIds: match.ids,
      ...(bucket.counterAccountId
        ? { counterAccountName: nameById.get(bucket.counterAccountId) ?? "" }
        : {}),
    });
    total += bucket.amounts.length;

    // 覆盖后的备注：组内按金额把旧记录与新行配对（同组金额多重集已相等），
    // 旧备注有内容且与新备注不一致时追加到新备注后面（2026-11-24 用户裁定）。
    const oldNotesByAmount = new Map<string, string[]>();
    match.ids.forEach((_, i) => {
      const amount = match.amounts[i];
      const queue = oldNotesByAmount.get(amount);
      if (queue) queue.push(match.notes[i] ?? "");
      else oldNotesByAmount.set(amount, [match.notes[i] ?? ""]);
    });
    for (const entry of bucket.items) {
      const queue = oldNotesByAmount.get(entry.amountKey);
      if (!queue || queue.length === 0) continue;
      const oldNote = queue.shift() ?? "";
      if (!oldNote.trim()) continue;
      const item = items[entry.index];
      if (!item) continue;
      const currentNote = String(item.remark ?? item.rawText ?? "").trim();
      const merged = mergeImportNote(currentNote, oldNote);
      if (merged === currentNote) continue;
      nextNotes.push({ index: entry.index, note: merged });
    }
  }

  groups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { total, groups, nextNotes };
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
