/**
 * API: /api/v1/bill/billing-day-rules
 *
 * Manages the per-credit-card billing-day history (CreditCardBillingDay).
 * All mutations are applied to every credit-card account of the same
 * institution bill group (mirrors recordCreditCardBillingDayChange) and
 * invalidate the persisted credit-card cycle cache so the bill view
 * recomputes from the new rules.
 *
 * POST   { accountId, effectiveDate: "YYYY-MM-DD", billingDay: 1-31 | "month_end" }
 *        Upsert one rule (create, or overwrite the billing day of an
 *        existing effective date).
 * PUT    { accountId, originalEffectiveDate, effectiveDate, billingDay }
 *        Move/change a rule atomically. Rejects when the target date is
 *        already taken by another rule.
 * DELETE { accountId, ruleId?, effectiveDate? }
 *        Remove one rule by id when supplied; date fallback leaves the single
 *        immutable initial row in place.
 * PATCH  { accountId, billingDayTxPeriod?, repaymentDayMode?,
 *          repaymentDay?, repaymentOffsetDays? }
 *        Updates account-level statement settings.
 *
 * Every response returns `{ ok: true, data: { rules } }` with the refreshed
 * rule list (ascending, with each row id and one `isInitial` row).
 */
import { AccountKind, type CreditBillingDayTxPeriod, type Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  getCreditBillAccountIds,
  normalizeCreditBillingDayTxPeriod,
} from "@/lib/server/credit-card-institution-settings";
import {
  CREDIT_CARD_MAX_REPAYMENT_OFFSET_DAYS,
  CREDIT_CARD_MONTH_END_BILLING_DAY,
} from "@/lib/credit/billing";
import { markInitialBillingDayRules } from "@/lib/credit/billing-day-rules";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import {
  recordCreditCardBillingDayChange,
  syncCreditCardBillingDaysFromRules,
} from "@/lib/server/credit-card-billing-day-rules";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

function parseDateOnly(value: unknown): Date | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function parseBillingDay(value: unknown): number | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "month_end" || raw === "last_day" || raw === "end_of_month") {
    return CREDIT_CARD_MONTH_END_BILLING_DAY;
  }
  const day = Number(value);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

function parseRepaymentOffsetDays(value: unknown) {
  if (value === undefined) return undefined;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const days = Number(raw);
  return Number.isInteger(days) && days >= 0 && days <= CREDIT_CARD_MAX_REPAYMENT_OFFSET_DAYS
    ? days
    : undefined;
}

function normalizeRepaymentDayMode(value: unknown, fallbackOffsetDays?: number | null) {
  const raw = String(value ?? "").trim();
  if (raw === "offset") return "offset";
  if (raw === "fixed") return "fixed";
  return fallbackOffsetDays != null ? "offset" : "fixed";
}

async function resolveBillGroup(householdId: string, accountId: string) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, kind: AccountKind.bank_credit },
    select: {
      id: true,
      householdId: true,
      institutionId: true,
      kind: true,
      creditBillMode: true,
      billingDay: true,
      repaymentDay: true,
      repaymentOffsetDays: true,
      billingDayTxPeriod: true,
    },
  });
  if (!account) return null;
  const billAccountIds = await getCreditBillAccountIds(prisma, account);
  return { account, billAccountIds };
}

type RuleRow = {
  id: string;
  accountId: string;
  effectiveDate: Date;
  billingDay: number;
  createdAt: Date;
  updatedAt: Date;
};

function sortRuleRows(rows: RuleRow[]) {
  return rows.slice().sort((a, b) =>
    a.effectiveDate.getTime() - b.effectiveDate.getTime() ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id),
  );
}

function serializeRules(rows: RuleRow[]) {
  return markInitialBillingDayRules(
    sortRuleRows(rows)
      .map((row) => ({
        id: row.id,
        accountId: row.accountId,
        effectiveDate: row.effectiveDate.toISOString().slice(0, 10),
        billingDay: row.billingDay,
      })),
  );
}

async function loadRuleRows(accountId: string, billAccountIds: string[]): Promise<RuleRow[]> {
  const rows = await prisma.creditCardBillingDay.findMany({
    where: { accountId: { in: billAccountIds.length > 0 ? billAccountIds : [accountId] } },
    select: { id: true, accountId: true, effectiveDate: true, billingDay: true, createdAt: true, updatedAt: true },
    orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  return rows;
}

async function listRules(accountId: string, billAccountIds: string[]): Promise<{ rules: ReturnType<typeof serializeRules> }> {
  return { rules: serializeRules(await loadRuleRows(accountId, billAccountIds)) };
}

/**
 * GET ?accountId=<id>
 *        Read the billing-day rule history of the account's bill group
 *        (used by the shared 账单日设置 dialog outside the bill page).
 */
export async function GET(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const accountId = (new URL(req.url).searchParams.get("accountId") ?? "").trim();
    if (!accountId) {
      return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "缺少账户" }, { status: 400 });
    }

    const group = await resolveBillGroup(householdId, accountId);
    if (!group) {
      return NextResponse.json({ ok: false, code: "CREDIT_ACCOUNT_NOT_FOUND", error: "信用卡账户不存在" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, data: await listRules(accountId, group.billAccountIds) });
  } catch (error) {
    console.error("GET /api/v1/bill/billing-day-rules error:", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: error instanceof Error ? error.message : "读取账单日记录失败" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const accountId = String(body?.accountId ?? "").trim();
    const effectiveDate = parseDateOnly(body?.effectiveDate);
    const billingDay = parseBillingDay(body?.billingDay);
    if (!accountId) return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "缺少账户" }, { status: 400 });
    if (!effectiveDate) return NextResponse.json({ ok: false, code: "INVALID_EFFECTIVE_DATE", error: "生效日期格式不正确" }, { status: 400 });
    if (!billingDay) return NextResponse.json({ ok: false, code: "INVALID_BILLING_DAY", error: "账单日应为 1-31 的整数（31 表示月底）" }, { status: 400 });

    const group = await resolveBillGroup(householdId, accountId);
    if (!group) return NextResponse.json({ ok: false, code: "CREDIT_ACCOUNT_NOT_FOUND", error: "信用卡账户不存在" }, { status: 404 });

    await prisma.$transaction(async (tx) => {
      await recordCreditCardBillingDayChange(tx, {
        accountIds: group.billAccountIds,
        effectiveDate,
        billingDay,
      });
      await syncCreditCardBillingDaysFromRules(tx, {
        accountIds: group.billAccountIds,
      });
    });
    await invalidateCreditCardCycleCacheForAccountIds(group.billAccountIds, { deleteManualCycles: false });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, data: await listRules(accountId, group.billAccountIds) });
  } catch (error) {
    console.error("POST /api/v1/bill/billing-day-rules error:", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: error instanceof Error ? error.message : "保存账单日记录失败" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const accountId = String(body?.accountId ?? "").trim();
    const originalEffectiveDate = parseDateOnly(body?.originalEffectiveDate);
    const effectiveDate = parseDateOnly(body?.effectiveDate);
    const billingDay = parseBillingDay(body?.billingDay);
    if (!accountId) return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "缺少账户" }, { status: 400 });
    if (!originalEffectiveDate || !effectiveDate) return NextResponse.json({ ok: false, code: "INVALID_EFFECTIVE_DATE", error: "生效日期格式不正确" }, { status: 400 });
    if (!billingDay) return NextResponse.json({ ok: false, code: "INVALID_BILLING_DAY", error: "账单日应为 1-31 的整数（31 表示月底）" }, { status: 400 });

    const group = await resolveBillGroup(householdId, accountId);
    if (!group) return NextResponse.json({ ok: false, code: "CREDIT_ACCOUNT_NOT_FOUND", error: "信用卡账户不存在" }, { status: 404 });

    const moving = originalEffectiveDate.getTime() !== effectiveDate.getTime();
    if (moving) {
      const target = await prisma.creditCardBillingDay.findFirst({
        where: { accountId: group.billAccountIds[0] ?? accountId, effectiveDate },
        select: { id: true },
      });
      if (target) {
        return NextResponse.json({ ok: false, code: "EFFECTIVE_DATE_CONFLICT", error: "该生效日期已存在账单日记录，请直接编辑那一条" }, { status: 409 });
      }
    }

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (moving) {
        await tx.creditCardBillingDay.deleteMany({
          where: { accountId: { in: group.billAccountIds }, effectiveDate: originalEffectiveDate },
        });
      }
      await recordCreditCardBillingDayChange(tx, {
        accountIds: group.billAccountIds,
        effectiveDate,
        billingDay,
      });
      await syncCreditCardBillingDaysFromRules(tx, {
        accountIds: group.billAccountIds,
      });
    });
    await invalidateCreditCardCycleCacheForAccountIds(group.billAccountIds, { deleteManualCycles: false });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, data: await listRules(accountId, group.billAccountIds) });
  } catch (error) {
    console.error("PUT /api/v1/bill/billing-day-rules error:", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: error instanceof Error ? error.message : "更新账单日记录失败" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const accountId = String(body?.accountId ?? "").trim();
    const ruleId = String(body?.ruleId ?? "").trim();
    const effectiveDate = parseDateOnly(body?.effectiveDate);
    if (!accountId) return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "缺少账户" }, { status: 400 });
    if (!ruleId && !effectiveDate) return NextResponse.json({ ok: false, code: "INVALID_EFFECTIVE_DATE", error: "生效日期格式不正确" }, { status: 400 });

    const group = await resolveBillGroup(householdId, accountId);
    if (!group) return NextResponse.json({ ok: false, code: "CREDIT_ACCOUNT_NOT_FOUND", error: "信用卡账户不存在" }, { status: 404 });

    const markedRules = serializeRules(await loadRuleRows(accountId, group.billAccountIds));
    if (ruleId) {
      const target = markedRules.find((rule) => rule.id === ruleId);
      if (!target) return NextResponse.json({ ok: false, code: "RULE_NOT_FOUND", error: "账单日记录不存在" }, { status: 404 });
      if (target.isInitial) {
        return NextResponse.json({ ok: false, code: "INITIAL_RULE_NOT_DELETABLE", error: "初始账单日记录不可删除" }, { status: 400 });
      }
      await prisma.$transaction(async (tx) => {
        await tx.creditCardBillingDay.delete({ where: { id: ruleId } });
        await syncCreditCardBillingDaysFromRules(tx, {
          accountIds: group.billAccountIds,
        });
      });
    } else {
      const targetDate = effectiveDate!.toISOString().slice(0, 10);
      const targets = markedRules.filter((rule) => rule.effectiveDate === targetDate);
      const deletableIds = targets.filter((rule) => !rule.isInitial).map((rule) => rule.id);
      if (targets.length > 0 && deletableIds.length === 0) {
        return NextResponse.json({ ok: false, code: "INITIAL_RULE_NOT_DELETABLE", error: "初始账单日记录不可删除" }, { status: 400 });
      }
      if (deletableIds.length > 0) {
        await prisma.$transaction(async (tx) => {
          await tx.creditCardBillingDay.deleteMany({
            where: { id: { in: deletableIds } },
          });
          await syncCreditCardBillingDaysFromRules(tx, {
            accountIds: group.billAccountIds,
          });
        });
      }
    }

    await invalidateCreditCardCycleCacheForAccountIds(group.billAccountIds, { deleteManualCycles: false });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, data: await listRules(accountId, group.billAccountIds) });
  } catch (error) {
    console.error("DELETE /api/v1/bill/billing-day-rules error:", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: error instanceof Error ? error.message : "删除账单日记录失败" }, { status: 500 });
  }
}

/**
 * PATCH — update the account-level statement settings:
 *   { accountId, billingDayTxPeriod?: "current" | "next",
 *     repaymentDayMode?: "fixed" | "offset", repaymentDay?: number | null,
 *     repaymentOffsetDays?: number | null }
 * These fields are institution-synced: every bank_credit account of the same
 * institution receives the change, mirroring syncCreditCardInstitutionSettings.
 * Returns the effective saved values plus the affected account ids.
 */
export async function PATCH(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const accountId = String(body?.accountId ?? "").trim();
    if (!accountId) return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "缺少账户" }, { status: 400 });

    const account = await prisma.account.findFirst({
      where: { id: accountId, householdId, kind: AccountKind.bank_credit },
      select: {
        id: true,
        householdId: true,
        institutionId: true,
        billingDayTxPeriod: true,
        repaymentDay: true,
        repaymentOffsetDays: true,
      },
    });
    if (!account) return NextResponse.json({ ok: false, code: "CREDIT_ACCOUNT_NOT_FOUND", error: "信用卡账户不存在" }, { status: 404 });

    const data: { billingDayTxPeriod?: CreditBillingDayTxPeriod; repaymentDay?: number | null; repaymentOffsetDays?: number | null } = {};
    if (body?.billingDayTxPeriod !== undefined) {
      data.billingDayTxPeriod = normalizeCreditBillingDayTxPeriod(body.billingDayTxPeriod);
    }
    if (
      body?.repaymentDayMode !== undefined ||
      body?.repaymentDay !== undefined ||
      body?.repaymentOffsetDays !== undefined
    ) {
      const repaymentOffsetDays = body.repaymentOffsetDays !== undefined
        ? parseRepaymentOffsetDays(body.repaymentOffsetDays)
        : account.repaymentOffsetDays;
      const repaymentDayMode = normalizeRepaymentDayMode(
        body.repaymentDayMode,
        body.repaymentOffsetDays !== undefined ? repaymentOffsetDays : account.repaymentOffsetDays,
      );
      if (repaymentDayMode === "offset") {
        if (body.repaymentOffsetDays !== undefined && repaymentOffsetDays === undefined) {
          return NextResponse.json({ ok: false, code: "INVALID_REPAYMENT_OFFSET_DAYS", error: `还款日偏移天数应为 0-${CREDIT_CARD_MAX_REPAYMENT_OFFSET_DAYS} 之间的整数` }, { status: 400 });
        }
        if (repaymentOffsetDays == null) {
          return NextResponse.json({ ok: false, code: "INVALID_REPAYMENT_OFFSET_DAYS", error: `还款日偏移天数应为 0-${CREDIT_CARD_MAX_REPAYMENT_OFFSET_DAYS} 之间的整数` }, { status: 400 });
        }
        data.repaymentDay = null;
        data.repaymentOffsetDays = repaymentOffsetDays;
      } else {
        const raw = body.repaymentDay;
        if (raw === undefined) {
          data.repaymentDay = account.repaymentDay;
        } else if (raw === null || String(raw).trim() === "") {
          data.repaymentDay = null;
        } else {
          const day = Number(raw);
          if (!Number.isInteger(day) || day < 1 || day > 31) {
            return NextResponse.json({ ok: false, code: "INVALID_REPAYMENT_DAY", error: "还款日应为 1-31 的整数" }, { status: 400 });
          }
          data.repaymentDay = day;
        }
        data.repaymentOffsetDays = null;
      }
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ ok: false, code: "NOTHING_TO_UPDATE", error: "没有需要保存的修改" }, { status: 400 });
    }

    // billingDayTxPeriod / repaymentDay are institution-synced settings: apply
    // to every credit-card account of the same institution (or just this card
    // when the account has no institution).
    const targetWhere = account.institutionId
      ? { householdId: account.householdId, institutionId: account.institutionId, kind: AccountKind.bank_credit }
      : { id: account.id };
    await prisma.account.updateMany({ where: targetWhere, data });
    const affected = await prisma.account.findMany({ where: targetWhere, select: { id: true } });
    const affectedIds = affected.length > 0 ? affected.map((row) => row.id) : [account.id];

    await invalidateCreditCardCycleCacheForAccountIds(affectedIds, { deleteManualCycles: false });
    revalidateAfterSettingsChange();
    return NextResponse.json({
      ok: true,
      data: {
        billingDayTxPeriod: data.billingDayTxPeriod ?? account.billingDayTxPeriod,
        repaymentDay: data.repaymentDay !== undefined ? data.repaymentDay : account.repaymentDay,
        repaymentOffsetDays: data.repaymentOffsetDays !== undefined ? data.repaymentOffsetDays : account.repaymentOffsetDays,
        accountIds: affectedIds,
      },
    });
  } catch (error) {
    console.error("PATCH /api/v1/bill/billing-day-rules error:", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: error instanceof Error ? error.message : "保存账单设置失败" }, { status: 500 });
  }
}
