import { getFundProfileNameMap, normalizeFundDisplayName } from "@/lib/fund/fundProfile";
import { prisma } from "@/lib/db/prisma";
import { chunk, IN_CHUNK_SIZE } from "@/lib/server/prisma-in-chunks";

type StatisticsFundNameSource = {
  id?: string | null;
  entryId?: string | null;
  fundCode?: string | null;
  fundName?: string | null;
};

type LinkedFundDisplaySource = {
  fundCode: string;
  fundName: string | null;
};

function normalizeStatisticFundCode(value: string | null | undefined) {
  const code = String(value ?? "").trim();
  return /^\d{6}$/.test(code) ? code : "";
}

export async function buildStatisticsFundDisplayResolver(
  entries: Iterable<StatisticsFundNameSource>,
  householdId?: string | null,
) {
  const rows = Array.from(entries);
  const entryIds = Array.from(new Set(rows.flatMap((row) => [
    String(row.id ?? "").trim(),
    String(row.entryId ?? "").trim(),
  ]).filter(Boolean)));
  const linkedFundByEntryId = new Map<string, LinkedFundDisplaySource>();

  if (entryIds.length > 0) {
    // Cross-year ranges can exceed SQLite's variable limit, and the OR query
    // multiplies that pressure across three IN clauses. Query in chunks and
    // dedupe by fundTransaction.id because one row can match multiple chunks.
    const select = {
      id: true,
      cashEntryId: true,
      fundCode: true,
      fundName: true,
      cashFlows: { select: { txRecordId: true } },
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: { cashEntryId: true },
      },
    } as const;
    type LinkedFundRow = {
      id: string;
      cashEntryId: string | null;
      fundCode: string;
      fundName: string | null;
      cashFlows: Array<{ txRecordId: string | null }>;
      EntryBusinessLink: Array<{ cashEntryId: string | null }>;
    };
    const linkedFundRows: LinkedFundRow[] = [];
    const seenRowIds = new Set<string>();
    const rememberRows = (rows: LinkedFundRow[]) => {
      for (const row of rows) {
        if (seenRowIds.has(row.id)) continue;
        seenRowIds.add(row.id);
        linkedFundRows.push(row);
      }
    };
    for (const part of chunk(entryIds, IN_CHUNK_SIZE)) {
      // 三条腿分开查、并行跑，别写成一条 OR：OR 跨三个关系时 Postgres 用不上
      // 单列索引，只能退化成对 fundTransaction 的顺序扫描 + 多次子查询（4000 个
      // entryId 实测 3-10 秒）。拆开后每条都是索引查找，结果集在 JS 里按 id 去重。
      const baseWhere = {
        ...(householdId ? { householdId } : {}),
        deletedAt: null,
      };
      const [byCashEntry, byCashFlow, byBusinessLink] = await Promise.all([
        prisma.fundTransaction.findMany({
          where: { ...baseWhere, cashEntryId: { in: part } },
          select,
        }),
        prisma.fundTransaction.findMany({
          where: { ...baseWhere, cashFlows: { some: { txRecordId: { in: part } } } },
          select,
        }),
        prisma.fundTransaction.findMany({
          where: { ...baseWhere, EntryBusinessLink: { some: { deletedAt: null, cashEntryId: { in: part } } } },
          select,
        }),
      ]);
      rememberRows(byCashEntry);
      rememberRows(byCashFlow);
      rememberRows(byBusinessLink);
    }

    const rememberLinkedFund = (entryId: string | null | undefined, row: LinkedFundDisplaySource) => {
      const id = String(entryId ?? "").trim();
      if (id && !linkedFundByEntryId.has(id)) linkedFundByEntryId.set(id, row);
    };

    for (const row of linkedFundRows) {
      rememberLinkedFund(row.cashEntryId, row);
    }
    for (const row of linkedFundRows) {
      for (const flow of row.cashFlows) rememberLinkedFund(flow.txRecordId, row);
    }
    for (const row of linkedFundRows) {
      for (const link of row.EntryBusinessLink) rememberLinkedFund(link.cashEntryId, row);
    }
  }

  const fundCodes = Array.from(new Set([
    ...rows.map((row) => normalizeStatisticFundCode(row.fundCode)),
    ...Array.from(linkedFundByEntryId.values()).map((row) => normalizeStatisticFundCode(row.fundCode)),
  ].filter(Boolean)));
  // 名字只从 FundProfile 读；净值缓存不再持有基金名。
  const profileNameByCode = await getFundProfileNameMap(fundCodes);

  return function resolveStatisticsFundDisplay(entry: StatisticsFundNameSource) {
    const rawFundCode = String(entry.fundCode ?? "").trim();
    const storedName = String(entry.fundName ?? "").trim();
    const linkedFund =
      linkedFundByEntryId.get(String(entry.id ?? "").trim()) ??
      linkedFundByEntryId.get(String(entry.entryId ?? "").trim());
    const linkedCode = normalizeStatisticFundCode(linkedFund?.fundCode);
    const normalizedCode = normalizeStatisticFundCode(rawFundCode) || linkedCode;
    const fundCode = normalizedCode || rawFundCode;
    if (!normalizedCode) return { fundCode, fundName: storedName || fundCode };

    const fundName = (
      profileNameByCode.get(normalizedCode) ??
      normalizeFundDisplayName(normalizedCode, storedName) ??
      normalizeFundDisplayName(normalizedCode, linkedFund?.fundName) ??
      normalizedCode
    );
    return { fundCode: normalizedCode, fundName };
  };
}
