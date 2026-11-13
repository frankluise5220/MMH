import { Prisma, type PrismaClient, type TxRecord } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { chunk, IN_CHUNK_SIZE } from "@/lib/server/prisma-in-chunks";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";
import { restoreMetalExtractPropertyTransactions } from "@/lib/property/transactions";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { createManySkipDuplicatesCompat } from "@/lib/server/prisma-create-many";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import {
  restoreBusinessRecordsForCashEntryIds,
  type RestoredBusinessFundTarget,
} from "@/lib/server/entry-business-link";

type DbWriter = PrismaClient | Prisma.TransactionClient;
type UndoSnapshot = Record<string, unknown>;
export const ENTRY_UNDO_HISTORY_LIMIT = 5;
const ENTRY_UNDO_PREVIEW_LIMIT = 5;

type EntryUndoPreviewItem = {
  id: string;
  date: string;
  type: string;
  amount: number | null;
  accountName: string;
  toAccountName: string;
  categoryName: string;
  counterpartyInstitutionName: string;
  fundCode: string;
  fundName: string;
  note: string;
};

type EntryUndoPreview = {
  count: number;
  hiddenCount: number;
  items: EntryUndoPreviewItem[];
};

type PreparedEntryUndo = {
  snapshots: UndoSnapshot[];
  entryIds: string[];
} | null;

function undoScope(ctx: HouseholdContext) {
  return { householdId: ctx.householdId, userId: ctx.user?.id ?? null };
}

function serializeRecords(records: TxRecord[], tagIdsByEntryId: Map<string, string[]>): UndoSnapshot[] {
  return JSON.parse(JSON.stringify(records.map((record) => ({
    ...record,
    _entryTagIds: tagIdsByEntryId.get(record.id) ?? [],
  })))) as UndoSnapshot[];
}

export async function prepareEntryUndo(
  db: DbWriter,
  householdId: string,
  requestedEntryIds: Iterable<string>,
): Promise<PreparedEntryUndo> {
  const ids = Array.from(new Set(Array.from(requestedEntryIds).filter(Boolean)));
  if (ids.length === 0) return null;

  const initial = await db.txRecord.findMany({
    where: { id: { in: ids }, OR: [{ householdId }, { householdId: null }] },
  });
  if (initial.length === 0) return null;

  const relatedIds = new Set(initial.map((record) => record.id));
  for (const record of initial) {
    if (record.fundSourceEntryId) relatedIds.add(record.fundSourceEntryId);
    if (record.depositSourceEntryId) relatedIds.add(record.depositSourceEntryId);
  }

  const sourceIds = Array.from(relatedIds);
  const planIds = Array.from(new Set(initial.map((record) => record.creditCardInstallmentPlanId).filter((id): id is string => !!id)));
  const sourcePlans = await db.creditCardInstallmentPlan.findMany({
    where: { householdId, sourceEntryId: { in: sourceIds } },
    select: { id: true },
  });
  for (const plan of sourcePlans) planIds.push(plan.id);
  const uniquePlanIds = Array.from(new Set(planIds));
  const installmentPlans = uniquePlanIds.length > 0
    ? await db.creditCardInstallmentPlan.findMany({
        where: { householdId, id: { in: uniquePlanIds } },
        select: { id: true, status: true },
      })
    : [];

  const related: TxRecord[] = [];
  const seenRelatedIds = new Set<string>();
  const relatedWhere = (part: string[]): Prisma.TxRecordWhereInput => ({
    OR: [
      { householdId, id: { in: part } },
      { householdId: null, id: { in: part } },
      { householdId, fundSourceEntryId: { in: part } },
      { householdId: null, fundSourceEntryId: { in: part } },
      { householdId, depositSourceEntryId: { in: part } },
      { householdId: null, depositSourceEntryId: { in: part } },
    ],
  });
  // The OR contains 6 `{ in: sourceIds }` clauses, so large batches exceed
  // SQLite's parameter limit. Query in sourceIds chunks and merge with dedupe.
  for (const part of chunk(sourceIds, IN_CHUNK_SIZE)) {
    const partRows = await db.txRecord.findMany({ where: relatedWhere(part) });
    for (const row of partRows) {
      if (seenRelatedIds.has(row.id)) continue;
      seenRelatedIds.add(row.id);
      related.push(row);
    }
  }
  if (planIds.length > 0) {
    for (const part of chunk(uniquePlanIds, IN_CHUNK_SIZE)) {
      const partRows = await db.txRecord.findMany({
        where: {
          OR: [
            { householdId, creditCardInstallmentPlanId: { in: part } },
            { householdId: null, creditCardInstallmentPlanId: { in: part } },
          ],
        },
      });
      for (const row of partRows) {
        if (seenRelatedIds.has(row.id)) continue;
        seenRelatedIds.add(row.id);
        related.push(row);
      }
    }
  }
  const entryTags = await db.entryTag.findMany({
    where: { entryId: { in: related.map((record) => record.id) } },
    select: { entryId: true, tagId: true },
  });
  const tagIdsByEntryId = new Map<string, string[]>();
  for (const entryTag of entryTags) {
    const tagIds = tagIdsByEntryId.get(entryTag.entryId) ?? [];
    tagIds.push(entryTag.tagId);
    tagIdsByEntryId.set(entryTag.entryId, tagIds);
  }

  const snapshots = serializeRecords(related, tagIdsByEntryId);
  if (snapshots[0] && installmentPlans.length > 0) {
    snapshots[0]._installmentPlanStatuses = installmentPlans.map((plan) => ({
      id: plan.id,
      status: plan.status,
    }));
  }
  return {
    snapshots,
    entryIds: related.map((record) => record.id),
  };
}

export async function saveEntryUndo(
  db: DbWriter,
  ctx: HouseholdContext,
  input: PreparedEntryUndo,
  action: "create" | "batch_create" | "edit" | "batch_edit" | "delete" | "batch_delete",
  label: string,
) {
  if (!input || input.snapshots.length === 0) return null;
  const created = await db.undoOperation.create({
    data: {
      householdId: ctx.householdId,
      userId: ctx.user?.id ?? null,
      action,
      label,
      snapshots: input.snapshots as Prisma.InputJsonValue,
      entryIds: input.entryIds as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  const older = await db.undoOperation.findMany({
    where: undoScope(ctx),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: ENTRY_UNDO_HISTORY_LIMIT,
    select: { id: true },
  });
  if (older.length > 0) {
    await db.undoOperation.deleteMany({
      where: { id: { in: older.map((operation) => operation.id) } },
    });
  }
  return created;
}

/**
 * 「确认新增」专用快照：只装这次真正新建的行。
 *
 * prepareEntryUndo 会把 fundSourceEntryId / depositSourceEntryId / 分期计划指向的旧行
 * 一起展开进快照，撤销 edit / delete 时这是必须的（关联行也要一起恢复）；但撤销
 * create 是把快照里的每一行软删，展开旧行会把历史存单、买入行一起删掉。
 * 所以新增走这里：不展开 related，一次确认的所有新 id 一次传入。
 */
export async function prepareCreatedEntryUndo(
  db: DbWriter,
  householdId: string,
  createdEntryIds: Iterable<string>,
): Promise<PreparedEntryUndo> {
  const ids = Array.from(new Set(Array.from(createdEntryIds).filter(Boolean)));
  if (ids.length === 0) return null;
  const records = await db.txRecord.findMany({
    where: { id: { in: ids }, OR: [{ householdId }, { householdId: null }], deletedAt: null },
  });
  if (records.length === 0) return null;
  const entryTags = await db.entryTag.findMany({
    where: { entryId: { in: records.map((record) => record.id) } },
    select: { entryId: true, tagId: true },
  });
  const tagIdsByEntryId = new Map<string, string[]>();
  for (const entryTag of entryTags) {
    const tagIds = tagIdsByEntryId.get(entryTag.entryId) ?? [];
    tagIds.push(entryTag.tagId);
    tagIdsByEntryId.set(entryTag.entryId, tagIds);
  }
  const snapshots = serializeRecords(records, tagIdsByEntryId);
  // 撤销时只按这组 id 清理关联：历史存单 / 买入行不在里面，绝不会被连带删掉。
  if (snapshots[0]) snapshots[0]._createdEntryIds = records.map((record) => record.id);
  return {
    snapshots,
    entryIds: records.map((record) => record.id),
  };
}

/** 一次确认新增 = 一条撤销记录；没新建行（例如重复单）时不写记录。 */
export async function saveCreatedEntryUndo(
  db: DbWriter,
  ctx: HouseholdContext,
  createdEntryIds: Iterable<string>,
  action: "create" | "batch_create",
  label: string,
) {
  try {
    const undo = await prepareCreatedEntryUndo(db, ctx.householdId, createdEntryIds);
    if (!undo) return null;
    return await saveEntryUndo(db, ctx, undo, action, label);
  } catch (error) {
    // 撤销登记是附加能力：主写操作已经落库，不能因为它失败就把「确认新增」判成失败
    // （否则用户会再点一次确认，制造重复记录）。
    console.error("[entry-undo] failed to register created entry undo", error);
    return null;
  }
}

export async function getLatestEntryUndo(ctx: HouseholdContext) {
  return prisma.undoOperation.findFirst({
    where: { ...undoScope(ctx), undoneAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, label: true, action: true, createdAt: true, undoneAt: true, entryIds: true },
  });
}

export async function getAvailableEntryUndoCount(ctx: HouseholdContext) {
  return prisma.undoOperation.count({
    where: { ...undoScope(ctx), undoneAt: null },
  });
}

function previewText(value: unknown) {
  return value == null ? "" : String(value).trim();
}

function previewDate(value: unknown) {
  return previewText(value).slice(0, 10);
}

function previewNumber(value: unknown) {
  if (value == null || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function snapshotPreviewItem(snapshot: UndoSnapshot): EntryUndoPreviewItem {
  return {
    id: previewText(snapshot.id),
    date: previewDate(snapshot.date),
    type: previewText(snapshot.type),
    amount: previewNumber(snapshot.amount),
    accountName: previewText(snapshot.accountName),
    toAccountName: previewText(snapshot.toAccountName),
    categoryName: previewText(snapshot.categoryName),
    counterpartyInstitutionName: previewText(snapshot.counterpartyInstitutionName),
    fundCode: previewText(snapshot.fundCode),
    fundName: previewText(snapshot.fundName) || previewText(snapshot.metalTypeName) || previewText(snapshot.insuranceProductName),
    note: previewText(snapshot.note) || previewText(snapshot.toNote),
  };
}

export async function getEntryUndoPreview(ctx: HouseholdContext, operationId: string): Promise<EntryUndoPreview | null> {
  const stored = await prisma.undoOperation.findFirst({
    where: { ...undoScope(ctx), id: operationId, undoneAt: null },
    select: { snapshots: true },
  });
  const snapshots = Array.isArray(stored?.snapshots)
    ? stored.snapshots as UndoSnapshot[]
    : [];
  if (snapshots.length === 0) return null;

  const items = snapshots
    .slice(0, ENTRY_UNDO_PREVIEW_LIMIT)
    .map(snapshotPreviewItem)
    .filter((item) => item.id || item.date || item.accountName || item.note);

  return {
    count: snapshots.length,
    hiddenCount: Math.max(0, snapshots.length - items.length),
    items,
  };
}

function restoreValue(value: unknown, type: string) {
  if (value == null) return null;
  if (type === "DateTime") return new Date(String(value));
  if (type === "BigInt") return BigInt(String(value));
  return value;
}

const txRecordScalarFields = new Map(
  (Prisma.dmmf.datamodel.models.find((model) => model.name === "TxRecord")?.fields ?? [])
    .filter((field) => field.kind !== "object")
    .map((field) => [field.name, field.type]),
);

function snapshotToUpdateData(snapshot: UndoSnapshot) {
  const data: Record<string, unknown> = {};
  for (const [field, type] of txRecordScalarFields) {
    if (field === "id" || field === "createdAt" || field === "updatedAt") continue;
    if (!(field in snapshot)) continue;
    data[field] = restoreValue(snapshot[field], type);
  }
  return data;
}

async function recalculateRestoredEntries(records: TxRecord[], options?: { forceInvestRevalidate?: boolean; skipBusinessSync?: boolean }) {
  const accountIds = new Set<string>();
  const fundAccounts = new Map<string, Set<string>>();
  const metalAccounts = new Set<string>();
  let touchedInvestment = false;

  for (const record of records) {
    accountIds.add(record.accountId);
    if (record.toAccountId) accountIds.add(record.toAccountId);
    if (record.type === "investment" || record.fundProductType) touchedInvestment = true;
    const investmentAccountId = record.fundSubtype === "redeem" || record.fundSubtype === "switch_out"
      ? record.accountId
      : record.toAccountId;
    if (!investmentAccountId) continue;
    if (record.metalTypeId || record.fundProductType === "metal") {
      metalAccounts.add(investmentAccountId);
    } else if (record.fundCode && record.fundProductType) {
      const codes = fundAccounts.get(investmentAccountId) ?? new Set<string>();
      codes.add(record.fundCode);
      fundAccounts.set(investmentAccountId, codes);
    }
  }

  // 撤销「新增」时业务单 / link 已按白名单软删，这两个 sync 会按 upsert 把它们复活；
  // 那种场景只保留余额、持仓、缓存重算。
  if (!options?.skipBusinessSync) {
    await syncFundTransactionsFromTxRecords(records.map((record) => record.id)).catch((error) => {
      console.error("[entry-undo] failed to sync fund transactions", error);
    });
    for (const record of records) {
      await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: record.id }).catch((error) => {
        console.error("[entry-undo] failed to sync independent business transaction", { entryId: record.id, error });
      });
    }
  }
  for (const [accountId, codes] of fundAccounts) {
    await recalcFundPositions(accountId, Array.from(codes)).catch((error) => {
      console.error("[entry-undo] failed to recalculate fund position", { accountId, error });
    });
  }
  for (const accountId of metalAccounts) {
    await recalcPreciousMetalPositions(accountId).catch((error) => {
      console.error("[entry-undo] failed to recalculate metal position", { accountId, error });
    });
  }
  for (const accountId of accountIds) {
    await recalcAndSaveAccountBalance(accountId).catch((error) => {
      console.error("[entry-undo] failed to recalculate account balance", { accountId, error });
    });
  }
  await invalidateCreditCardCycleCacheForAccountIds(accountIds).catch((error) => {
    console.error("[entry-undo] failed to invalidate credit-card cycles", error);
  });
  // 资金腿本身不带 fundCode / fundProductType，只看腿判断不出「投资侧也有变化」。
  // 整笔恢复时业务单（基金交易/持仓）已回来，必须失效投资侧缓存，否则页面仍读旧缓存，
  // 看起来像「只恢复了资金明细，关联数据没恢复」。
  if (touchedInvestment || options?.forceInvestRevalidate) revalidateAfterInvestChange();
  else revalidateAfterTxChange();
}

/**
 * 撤销「确认新增」时把这次操作产生的关联一并撤销。
 *
 * ownedIds 是本次真正新建的 TxRecord id（不展开历史引用）。业务单按「自己就是本次
 * 新建的行」或「现金腿是本次新建的行」定位，link / 标签 / 附件 / 分期子行按 ownedIds
 * 定位，因此 depositSourceEntryId / fundSourceEntryId 指向的历史存单、买入行不会被删。
 */
async function revertCreatedEntryRelations(
  tx: Prisma.TransactionClient,
  ctx: HouseholdContext,
  ownedIds: string[],
  deletedAt: Date,
) {
  if (ownedIds.length === 0) return;
  const householdId = ctx.householdId;
  const businessWhere = {
    householdId,
    deletedAt: null,
    OR: [{ id: { in: ownedIds } }, { cashEntryId: { in: ownedIds } }],
  };

  // 8 类独立业务单：基金 / 保险 / 理财 / 债券 / 存款 / 贵金属 / 股票 / 房产
  await tx.fundTransaction.updateMany({ where: businessWhere, data: { deletedAt } });
  await tx.insuranceTransaction.updateMany({ where: businessWhere, data: { deletedAt } });
  await tx.wealthTransaction.updateMany({ where: businessWhere, data: { deletedAt } });
  await tx.bondTransaction.updateMany({ where: businessWhere, data: { deletedAt } });
  await tx.depositTransaction.updateMany({ where: businessWhere, data: { deletedAt } });
  await tx.preciousMetalTransaction.updateMany({ where: businessWhere, data: { deletedAt } });
  await tx.stockTransaction.updateMany({ where: businessWhere, data: { deletedAt } });
  await tx.propertyTransaction.updateMany({ where: businessWhere, data: { deletedAt } });

  // 基金现金流明细没有 deletedAt，只能物理删；业务-现金腿 link 软删。
  const fundRows = await tx.fundTransaction.findMany({
    where: { householdId, OR: [{ id: { in: ownedIds } }, { cashEntryId: { in: ownedIds } }] },
    select: { id: true },
  });
  if (fundRows.length > 0) {
    await tx.fundTransactionCashFlow.deleteMany({
      where: { fundTransactionId: { in: fundRows.map((row) => row.id) } },
    });
  }
  await tx.entryBusinessLink.updateMany({
    where: {
      householdId,
      deletedAt: null,
      OR: [
        { cashEntryId: { in: ownedIds } },
        { businessEntryId: { in: ownedIds } },
        { fundTransactionId: { in: fundRows.map((row) => row.id) } },
      ],
    },
    data: { deletedAt },
  });
  await tx.entryTag.deleteMany({ where: { entryId: { in: ownedIds } } });
  await tx.attachment.deleteMany({ where: { entryId: { in: ownedIds } } });

  // 信用卡分期：计划置 cancelled，冲抵行与已落地的 payment / fee 子行一起软删。
  const installmentPlans = await tx.creditCardInstallmentPlan.findMany({
    where: { householdId, sourceEntryId: { in: ownedIds } },
    select: { id: true },
  });
  for (const plan of installmentPlans) {
    await tx.txRecord.updateMany({
      where: { householdId, creditCardInstallmentPlanId: plan.id, deletedAt: null },
      data: { deletedAt },
    });
    await tx.creditCardInstallmentPlan.updateMany({
      where: { id: plan.id, householdId },
      data: { status: "cancelled" },
    });
  }

  // 存单系统计划行按 lotId 拼 id，只处理本次新建的存单，不动历史存单的计划。
  const lotPlanIds = ownedIds.flatMap((id) =>
    ["depm_", "depa_", "depi_", "bondm_", "bonda_", "bondi_"].map((prefix) => `${prefix}${id}`),
  );
  await tx.regularInvestPlan.updateMany({
    where: { householdId, id: { in: lotPlanIds } },
    data: { status: "completed" },
  });
}

export async function undoLatestEntryOperation(ctx: HouseholdContext) {
  const operation = await getLatestEntryUndo(ctx);
  if (!operation || operation.undoneAt) return null;
  const stored = await prisma.undoOperation.findUnique({
    where: { id: operation.id },
    select: { snapshots: true, action: true },
  });
  const snapshots = Array.isArray(stored?.snapshots)
    ? stored.snapshots as UndoSnapshot[]
    : [];
  if (snapshots.length === 0) return null;

  const isCreate = operation.action === "create" || operation.action === "batch_create";
  // 新增类记录带「本次新建行」白名单；旧的 batch_create 记录没有，回退到快照 id（保持原行为）。
  const declaredOwned = snapshots[0]?._createdEntryIds;
  const ownedIds = (
    Array.isArray(declaredOwned)
      ? declaredOwned.filter((id): id is string => typeof id === "string" && id.length > 0)
      : snapshots.map((snapshot) => String(snapshot.id ?? "")).filter(Boolean)
  );
  const deletedAt = new Date();

  await prisma.$transaction(async (tx) => {
    if (isCreate) {
      for (const id of ownedIds) {
        // 「对账」锁定的记录不可删除：撤销「新建」等价于删除，必须先解除对账。
        const locked = await tx.txRecord.findFirst({
          where: { id, OR: [{ householdId: ctx.householdId }, { householdId: null }], reconciledAt: { not: null } },
          select: { id: true },
        });
        if (locked) throw new Error("该记录已对账锁定，需先解除对账才能撤销");
        await tx.txRecord.updateMany({
          where: { id, OR: [{ householdId: ctx.householdId }, { householdId: null }], deletedAt: null },
          data: { deletedAt },
        });
      }
      // 改动前留下的 batch_create 记录没有白名单，其快照可能含历史引用：只软删明细，
      // 不做关联清理，避免拿旧记录去删用户已有的业务单。
      if (Array.isArray(declaredOwned)) {
        await revertCreatedEntryRelations(tx, ctx, ownedIds, deletedAt);
      }
      await tx.undoOperation.update({ where: { id: operation.id }, data: { undoneAt: deletedAt } });
      return;
    }
    for (const snapshot of snapshots) {
      const id = String(snapshot.id ?? "");
      if (!id) continue;
      const current = await tx.txRecord.findFirst({
        where: { id, OR: [{ householdId: ctx.householdId }, { householdId: null }] },
        select: { id: true, reconciledAt: true },
      });
      if (!current) throw new Error(`Record ${id} has been permanently deleted and cannot be undone`);
      // 「对账」锁定的记录不可修改：撤销编辑会把快照写回去，必须先解除对账。
      if (current.reconciledAt) throw new Error("该记录已对账锁定，需先解除对账才能撤销");
      await tx.txRecord.update({ where: { id }, data: snapshotToUpdateData(snapshot) as Prisma.TxRecordUncheckedUpdateInput });
      const tagIds = Array.isArray(snapshot._entryTagIds)
        ? snapshot._entryTagIds.map(String).filter(Boolean)
        : [];
      await tx.entryTag.deleteMany({ where: { entryId: id } });
      if (tagIds.length > 0) {
        await createManySkipDuplicatesCompat(tx.entryTag, tagIds.map((tagId) => ({ entryId: id, tagId })));
      }
    }
    const planStatuses = snapshots.flatMap((snapshot) =>
      Array.isArray(snapshot._installmentPlanStatuses)
        ? snapshot._installmentPlanStatuses as Array<{ id?: unknown; status?: unknown }>
        : [],
    );
    for (const plan of planStatuses) {
      const id = String(plan.id ?? "");
      const status = String(plan.status ?? "");
      if (!id || !status) continue;
      await tx.creditCardInstallmentPlan.updateMany({
        where: { id, householdId: ctx.householdId },
        data: { status: status as Prisma.EnumCreditCardInstallmentStatusFieldUpdateOperationsInput["set"] },
      });
    }
    await tx.undoOperation.update({ where: { id: operation.id }, data: { undoneAt: new Date() } });
  });

  // 整笔业务单也要一起恢复：业务单被整笔删除时，仅恢复 TxRecord 不够——资金腿不携带
  // fundCode，syncFundTransactionsFromTxRecords 认不出来，投资侧派生行会永远回不来。
  // 业务单删除必然连带删除它的资金腿，腿在快照里恢复，业务单就按 link 反查一起恢复。
  // 撤销「新增」正好相反：关联刚被软删，这里绝不能把它们复活。
  const restoredBusiness = isCreate
    ? { restoredCount: 0, fundTargets: [] as RestoredBusinessFundTarget[] }
    : await restoreBusinessRecordsForCashEntryIds(
      ctx,
      snapshots.map((snapshot) => String(snapshot.id ?? "")).filter(Boolean),
    ).catch((error) => {
      console.error("[entry-undo] failed to restore business records", error);
      return { restoredCount: 0, fundTargets: [] as RestoredBusinessFundTarget[] };
    });
  // 提取实物明细的固定资产交易没有 EntryBusinessLink，只能按 cashEntryId 反查恢复；
  // 撤销「新增」时关联刚被软删，绝不能复活。
  const restoredMetalAssets = isCreate
    ? { restoredCount: 0 }
    : await restoreMetalExtractPropertyTransactions(prisma, {
      householdId: ctx.householdId,
      cashEntryIds: snapshots.map((snapshot) => String(snapshot.id ?? "")).filter(Boolean),
    }).catch((error) => {
      console.error("[entry-undo] failed to restore metal extract fixed asset", error);
      return { restoredCount: 0 };
    });

  const restored = await prisma.txRecord.findMany({
    where: {
      id: { in: snapshots.map((snapshot) => String(snapshot.id)) },
      OR: [{ householdId: ctx.householdId }, { householdId: null }],
    },
  });
  await recalculateRestoredEntries(restored, {
    forceInvestRevalidate:
      restoredBusiness.restoredCount > 0
      || restoredBusiness.fundTargets.length > 0
      || restoredMetalAssets.restoredCount > 0,
    skipBusinessSync: isCreate,
  });
  for (const target of restoredBusiness.fundTargets) {
    await recalcFundPositions(target.fundAccountId, [target.fundCode]).catch((error) => {
      console.error("[entry-undo] failed to recalculate restored fund position", { target, error });
    });
  }
  const remainingCount = await getAvailableEntryUndoCount(ctx);
  return {
    operationId: operation.id,
    label: operation.label,
    action: operation.action,
    restoredCount: restored.length,
    restoredBusinessCount: restoredBusiness.restoredCount,
    remainingCount,
    historyLimit: ENTRY_UNDO_HISTORY_LIMIT,
  };
}
