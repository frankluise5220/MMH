import { NextRequest, NextResponse } from "next/server";
import { AccountKind, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";
import { verifyPassword } from "@/lib/auth/password";
import { getOrCreatePlaceholderAccountId } from "@/lib/server/placeholder-account";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { getOrCreateDefaultAccountGroupId } from "@/lib/server/account-group-default";
import { normalizeFundUnitsDecimals } from "@/lib/fund/unit-precision";
import { resolveTradingCalendarForAccount } from "@/lib/fund/trading-calendar";
import { supportsCostBasisMethod } from "@/lib/investment-config";
import {
  getCreditCardInstitutionDefaults,
  normalizeCreditBillMode,
  syncCreditCardInstitutionSettings,
} from "@/lib/server/credit-card-institution-settings";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { computeInvestBalances } from "@/lib/invest-balance";
import { computeInsuranceAccountDisplayBalances } from "@/lib/insurance/balance";
import { computeAccountDisplayBalances, recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";
import {
  accountSupportsNumberMasked,
  assertAccountIdentityUnique,
  isAccountIdentityUniqueError,
} from "@/lib/server/account-identity-unique";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import { BALANCE_INITIALIZATION_SOURCE, encodeBalanceReconcileTarget } from "@/lib/balance-reconcile";
import { ensureBrokerageCashAccountForStockAccount } from "@/lib/server/brokerage-cash-account";
import {
  STOCK_ACCOUNT_INSTITUTION_ERROR,
  isStockAccountInstitutionType,
  isStockInvestmentAccount,
} from "@/lib/account-institution-rules";
import { normalizeCurrency } from "@/lib/currency";
import { getHouseholdBaseCurrency } from "@/lib/server/fx-rates";

export const runtime = "nodejs";

const fundProductTypes = ["fund", "money", "wealth", "metal", "stock", "property"] as const;
const costBasisMethods = ["moving_avg", "fifo", "lifo"] as const;

function normalizeFundProductType(raw: unknown) {
  const value = String(raw ?? "").trim();
  return fundProductTypes.includes(value as (typeof fundProductTypes)[number]) ? value : "fund";
}

function normalizeCostBasisMethod(raw: unknown) {
  const value = String(raw ?? "").trim();
  return costBasisMethods.includes(value as (typeof costBasisMethods)[number]) ? value : "moving_avg";
}

function parseDay(raw: unknown) {
  if (raw === undefined) return undefined;
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1 || n > 31) return undefined;
  return n;
}

function parseDateOnly(raw: unknown) {
  const value = String(raw ?? "").trim();
  if (!value) return new Date();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

// === Internal: POST (create) ===
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    const kind = (typeof body?.kind === "string" ? body.kind.trim() : "other") as any;
    const requestedGroupId = String(body.groupId ?? "").trim() || null;
    const requestedInstitutionId = String(body.institutionId ?? "").trim() || null;
    const requestedCounterpartyId = String(body.counterpartyId ?? "").trim() || null;
    const requestedUserId = String(body.userId ?? "").trim() || null;
    const isInvestment = kind === "investment";
    const isCreditLike = kind === "bank_credit";
    const investProductType = isInvestment ? normalizeFundProductType(body.investProductType) : null;
    const tradingCalendar = resolveTradingCalendarForAccount(kind, investProductType, body.tradingCalendar);
    const initialBalanceRaw = String(body.initialBalance ?? "").trim();
    const initialBalance = initialBalanceRaw ? Number(initialBalanceRaw) : null;
    const initialBalanceDate = initialBalanceRaw ? parseDateOnly(body.initialBalanceDate) : null;

    if (!name) return NextResponse.json({ ok: false, code: "NAME_REQUIRED", error: "名称必填" }, { status: 400 });
    if (initialBalanceRaw && !Number.isFinite(initialBalance)) {
      return NextResponse.json({ ok: false, code: "INVALID_BALANCE", error: "余额必须是有效数字" }, { status: 400 });
    }
    if (initialBalanceRaw && !initialBalanceDate) {
      return NextResponse.json({ ok: false, code: "INVALID_DATE_FORMAT", error: "时间节点格式必须是 YYYY-MM-DD" }, { status: 400 });
    }

    const { householdId } = await getHouseholdScope();
    const currencyInput = String(body.currency ?? "").trim();
    const currency = normalizeCurrency(currencyInput || await getHouseholdBaseCurrency(householdId));

    const group = requestedGroupId
      ? await prisma.accountGroup.findFirst({ where: { id: requestedGroupId, householdId } })
      : await prisma.accountGroup.findFirst({ where: { householdId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
    const ensuredGroup = group ?? { id: await getOrCreateDefaultAccountGroupId(prisma, householdId) };

    const institution = requestedInstitutionId
      ? await prisma.institution.findFirst({ where: { id: requestedInstitutionId, householdId } })
      : null;
    if (requestedInstitutionId && !institution) return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "机构不存在或不属于当前账簿" }, { status: 400 });
    if (isStockInvestmentAccount(kind, investProductType) && !isStockAccountInstitutionType(institution?.type)) {
      return NextResponse.json({ ok: false, code: "STOCK_ACCOUNT_INSTITUTION_REQUIRED", error: STOCK_ACCOUNT_INSTITUTION_ERROR }, { status: 400 });
    }
    const counterparty = requestedCounterpartyId
      ? await prisma.counterparty.findFirst({ where: { id: requestedCounterpartyId, householdId } })
      : null;
    if (requestedCounterpartyId && !counterparty) return NextResponse.json({ ok: false, code: "COUNTERPARTY_NOT_FOUND", error: "往来对象不存在或不属于当前账簿" }, { status: 400 });

    const owner = requestedUserId
      ? await prisma.user.findFirst({ where: { id: requestedUserId, householdId } })
      : null;
    if (requestedUserId && !owner) return NextResponse.json({ ok: false, code: "OWNER_NOT_FOUND", error: "所有人不存在或不属于当前账簿" }, { status: 400 });

    const creditDefaults = isCreditLike
      ? await getCreditCardInstitutionDefaults(prisma, householdId, institution?.id)
      : null;
    const requestedBillingDay = parseDay(body.billingDay);
    const requestedRepaymentDay = parseDay(body.repaymentDay);
    const billingDay = isCreditLike
      ? requestedBillingDay ?? creditDefaults?.billingDay ?? null
      : null;
    const repaymentDay = isCreditLike
      ? requestedRepaymentDay ?? creditDefaults?.repaymentDay ?? null
      : null;
    const creditLimit = isCreditLike
      ? String(body.creditLimit ?? "").trim() || creditDefaults?.creditLimit || null
      : null;
    const creditBillMode = isCreditLike
      ? body.creditBillMode !== undefined
        ? normalizeCreditBillMode(body.creditBillMode)
        : creditDefaults?.creditBillMode ?? normalizeCreditBillMode(null)
      : normalizeCreditBillMode(null);
    const numberMasked = accountSupportsNumberMasked(kind)
      ? String(body.numberMasked ?? "").trim() || null
      : null;
    const note = String(body.note ?? "").trim() || null;

    await assertAccountIdentityUnique(prisma, {
      householdId,
      groupId: ensuredGroup.id,
      institutionId: institution?.id ?? null,
      counterpartyId: counterparty?.id ?? null,
      kind,
      name,
      numberMasked,
    });

    const supportsDefaultFundQueryApi = isInvestment && (investProductType === "fund" || investProductType === "money");
    const shouldCreateInitialBalance = !isInvestment && initialBalance != null && initialBalance !== 0;
    let brokerageCashAccount: Awaited<ReturnType<typeof ensureBrokerageCashAccountForStockAccount>> = null;
    const account = await prisma.$transaction(async (tx) => {
      const createdAccount = await tx.account.create({
        data: {
          name,
          kind,
          debtDirection: kind === "bank_credit" ? "payable" : null,
          ...(kind === "loan" && counterparty?.id ? { debtDirection: "receivable" } : {}),
          currency,
          groupId: ensuredGroup.id,
          institutionId: institution?.id ?? null,
          counterpartyId: counterparty?.id ?? null,
          userId: owner?.id ?? null,
          householdId,
          isActive: true,
          billingDay,
          repaymentDay,
          creditLimit,
          creditBillMode,
          numberMasked,
          note,
          investProductType: investProductType as any,
          costBasisMethod: isInvestment && supportsCostBasisMethod(investProductType) ? normalizeCostBasisMethod(body.costBasisMethod) as any : null,
          ...(tradingCalendar ? { tradingCalendar: tradingCalendar as any } : {}),
          defaultFundQueryApiId: supportsDefaultFundQueryApi ? String(body.defaultFundQueryApiId ?? "").trim() || null : null,
          fundUnitsDecimals: isInvestment ? normalizeFundUnitsDecimals(body.fundUnitsDecimals) : 3,
        },
        include: {
          AccountGroup: { select: { id: true, name: true } },
          Institution: { select: { id: true, name: true, shortName: true, type: true } },
          Counterparty: { select: { id: true, name: true, shortName: true, type: true } },
        },
      });

      if (shouldCreateInitialBalance && initialBalanceDate) {
        const initialBalanceValue = initialBalance ?? 0;
        const isLiability = kind === "bank_credit" || kind === "loan";
        const targetBalance = isLiability ? -Math.abs(initialBalanceValue) : initialBalanceValue;
        await tx.txRecord.create({
          data: {
            householdId,
            date: initialBalanceDate,
            type: TransactionType.income,
            accountId: createdAccount.id,
            accountName: createdAccount.name,
            amount: 0,
            categoryName: "初始余额",
            source: BALANCE_INITIALIZATION_SOURCE,
            note: null,
            toNote: encodeBalanceReconcileTarget(targetBalance),
            currency: createdAccount.currency,
          },
        });
      }

      if (createdAccount.kind === AccountKind.investment && createdAccount.investProductType === "stock") {
        brokerageCashAccount = await ensureBrokerageCashAccountForStockAccount(tx, createdAccount);
      }

      return createdAccount;
    });
    if (shouldCreateInitialBalance) {
      await recalcAndSaveAccountBalance(account.id);
    }
    if (isCreditLike) {
      await syncCreditCardInstitutionSettings(prisma, {
        householdId,
        institutionId: account.institutionId,
        billingDay: account.billingDay,
        repaymentDay: account.repaymentDay,
        creditBillMode: account.creditBillMode,
      });
      const institutionCards = account.institutionId
        ? await prisma.account.findMany({
            where: { householdId, institutionId: account.institutionId, kind: "bank_credit" },
            select: { id: true },
          })
        : [{ id: account.id }];
      await invalidateCreditCardCycleCacheForAccountIds(institutionCards.map((item) => item.id), { deleteManualCycles: true });
    }
    revalidateAfterSettingsChange();
    // Client-side handles page refresh
    return NextResponse.json({ ok: true, account, brokerageCashAccount });
  } catch (e) {
    if (isAccountIdentityUniqueError(e)) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_IDENTITY_CONFLICT", error: e.message }, { status: e.status });
    }
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: e instanceof Error ? e.message : "创建失败" }, { status: 500 });
  }
}

// === Internal: PUT (update) ===
export async function PUT(req: NextRequest) {
  try {
    const { householdId, user } = await getHouseholdScope();
    const body = await req.json();
    const id = String(body.id ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, code: "MISSING_ID", error: "缺少 id" }, { status: 400 });

    const existing = await prisma.account.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "账户不存在" }, { status: 404 });
    if (!isAdmin(user) && existing.householdId !== householdId) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
    }

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = String(body.name).trim();
    if (body.kind !== undefined) data.kind = String(body.kind).trim();
    if (body.currency !== undefined) {
      const currencyInput = String(body.currency ?? "").trim();
      data.currency = normalizeCurrency(currencyInput || await getHouseholdBaseCurrency(householdId));
    }
    if (body.groupId !== undefined) data.groupId = String(body.groupId).trim() || null;
    if (body.institutionId !== undefined) data.institutionId = String(body.institutionId).trim() || null;
    if (body.counterpartyId !== undefined) data.counterpartyId = String(body.counterpartyId).trim() || null;
    if (body.note !== undefined) data.note = String(body.note ?? "").trim() || null;

    if (body.fundUnitsDecimals !== undefined) {
      data.fundUnitsDecimals = normalizeFundUnitsDecimals(body.fundUnitsDecimals ?? existing.fundUnitsDecimals);
    }

    const nextKind = String(data.kind ?? existing.kind);
    const nextCounterpartyId = data.counterpartyId === undefined ? existing.counterpartyId : (data.counterpartyId ? String(data.counterpartyId) : null);
    const nextCounterparty = nextCounterpartyId
      ? await prisma.counterparty.findFirst({ where: { id: nextCounterpartyId, householdId } })
      : null;
    if (nextCounterpartyId && !nextCounterparty) return NextResponse.json({ ok: false, code: "COUNTERPARTY_NOT_FOUND", error: "往来对象不存在或不属于当前账簿" }, { status: 400 });
    data.debtDirection = nextKind === "bank_credit" ? "payable" : nextKind === "loan" && nextCounterparty ? "receivable" : null;
    if (nextKind === "bank_credit") {
      data.billingDay = body.billingDay !== undefined ? parseDay(body.billingDay) : existing.billingDay;
      data.repaymentDay = body.repaymentDay !== undefined ? parseDay(body.repaymentDay) : existing.repaymentDay;
      data.creditLimit = body.creditLimit !== undefined ? (String(body.creditLimit ?? "").trim() || null) : existing.creditLimit;
      data.numberMasked = body.numberMasked !== undefined ? (String(body.numberMasked ?? "").trim() || null) : existing.numberMasked;
      data.creditBillMode = body.creditBillMode !== undefined
        ? normalizeCreditBillMode(body.creditBillMode)
        : existing.creditBillMode;
    } else {
      data.billingDay = null;
      data.repaymentDay = null;
      data.creditLimit = null;
      data.numberMasked = accountSupportsNumberMasked(nextKind)
        ? body.numberMasked !== undefined
          ? String(body.numberMasked ?? "").trim() || null
          : existing.numberMasked
        : null;
      data.creditBillMode = normalizeCreditBillMode(null);
    }
    if (nextKind !== "loan") {
      data.counterpartyId = null;
    } else if (data.counterpartyId === undefined) {
      data.counterpartyId = nextCounterparty?.id ?? existing.counterpartyId ?? null;
    }
    if (nextKind === "investment") {
      if (body.investProductType !== undefined || existing.kind !== "investment") data.investProductType = normalizeFundProductType(body.investProductType ?? existing.investProductType) as any;
      const nextInvestProductType = String(data.investProductType ?? existing.investProductType ?? "");
      data.costBasisMethod = supportsCostBasisMethod(nextInvestProductType)
        ? normalizeCostBasisMethod(body.costBasisMethod ?? existing.costBasisMethod) as any
        : null;
      if (body.tradingCalendar !== undefined || body.investProductType !== undefined || existing.kind !== "investment") {
        data.tradingCalendar = resolveTradingCalendarForAccount(nextKind, nextInvestProductType, body.tradingCalendar ?? existing.tradingCalendar) as any;
      }
      const supportsDefaultFundQueryApi = nextInvestProductType === "fund" || nextInvestProductType === "money";
      if (body.defaultFundQueryApiId !== undefined || !supportsDefaultFundQueryApi) {
        data.defaultFundQueryApiId = supportsDefaultFundQueryApi ? String(body.defaultFundQueryApiId ?? "").trim() || null : null;
      }
    } else {
      data.investProductType = null;
      data.costBasisMethod = null;
      data.tradingCalendar = null;
      data.defaultFundQueryApiId = null;
    }
    const nextInvestProductTypeForInstitution = nextKind === "investment"
      ? String(data.investProductType ?? existing.investProductType ?? "fund")
      : null;

    const hasNextName = Object.prototype.hasOwnProperty.call(data, "name");
    const hasNextNumberMasked = Object.prototype.hasOwnProperty.call(data, "numberMasked");
    const nextName = hasNextName ? String(data.name ?? "").trim() : existing.name;
    const nextNumberMasked = hasNextNumberMasked ? data.numberMasked : existing.numberMasked;
    if (!nextName) return NextResponse.json({ ok: false, code: "NAME_REQUIRED", error: "名称必填" }, { status: 400 });

    const nextGroupId = data.groupId === undefined ? existing.groupId : String(data.groupId ?? "");
    if (!nextGroupId) return NextResponse.json({ ok: false, code: "OWNER_REQUIRED", error: "请选择所有人" }, { status: 400 });
    const nextInstitutionId = data.institutionId === undefined ? existing.institutionId : (data.institutionId ? String(data.institutionId) : null);
    if (nextGroupId) {
      const group = await prisma.accountGroup.findFirst({ where: { id: nextGroupId, householdId } });
      if (!group) return NextResponse.json({ ok: false, code: "OWNER_NOT_FOUND", error: "所有人不存在或不属于当前账簿" }, { status: 400 });
    }
    const nextInstitution = nextInstitutionId
      ? await prisma.institution.findFirst({ where: { id: nextInstitutionId, householdId } })
      : null;
    if (nextInstitutionId) {
      if (!nextInstitution) return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "机构不存在或不属于当前账簿" }, { status: 400 });
    }
    if (isStockInvestmentAccount(nextKind, nextInvestProductTypeForInstitution) && !isStockAccountInstitutionType(nextInstitution?.type)) {
      return NextResponse.json({ ok: false, code: "STOCK_ACCOUNT_INSTITUTION_REQUIRED", error: STOCK_ACCOUNT_INSTITUTION_ERROR }, { status: 400 });
    }
    await assertAccountIdentityUnique(prisma, {
      householdId,
      groupId: nextGroupId,
      institutionId: nextInstitutionId,
      counterpartyId: (data.counterpartyId === undefined ? existing.counterpartyId : data.counterpartyId) as string | null,
      kind: nextKind,
      name: nextName,
      numberMasked: nextNumberMasked,
      excludeId: existing.id,
    });

    const creditCycleRuleChanged =
      nextKind === "bank_credit" &&
      (
        existing.kind !== "bank_credit" ||
        nextInstitutionId !== existing.institutionId ||
        (body.billingDay !== undefined && data.billingDay !== existing.billingDay) ||
        (body.repaymentDay !== undefined && data.repaymentDay !== existing.repaymentDay) ||
        (body.creditBillMode !== undefined && data.creditBillMode !== existing.creditBillMode)
      );

    const updated = await prisma.account.update({ where: { id }, data });
    const brokerageCashAccount =
      updated.kind === AccountKind.investment && updated.investProductType === "stock"
        ? await ensureBrokerageCashAccountForStockAccount(prisma, updated)
        : null;
    let affectedCreditAccountIds: string[] = [];
    if (updated.kind === "bank_credit") {
      await syncCreditCardInstitutionSettings(prisma, {
        householdId: updated.householdId,
        institutionId: updated.institutionId,
        billingDay: updated.billingDay,
        repaymentDay: updated.repaymentDay,
        creditBillMode: updated.creditBillMode,
      });
      const institutionCards = updated.institutionId
        ? await prisma.account.findMany({
            where: { householdId: updated.householdId, institutionId: updated.institutionId, kind: "bank_credit" },
            select: { id: true },
          })
        : [{ id: updated.id }];
      affectedCreditAccountIds = institutionCards.map((item) => item.id);
      await invalidateCreditCardCycleCacheForAccountIds(
        affectedCreditAccountIds,
        { deleteManualCycles: false },
      );
    }
    revalidateAfterSettingsChange();
    return NextResponse.json({
      ok: true,
      data: {
        id: updated.id,
        kind: updated.kind,
        billingDay: updated.billingDay,
        repaymentDay: updated.repaymentDay,
        creditBillMode: updated.creditBillMode,
        institutionId: updated.institutionId,
        note: updated.note,
        brokerageCashAccountId: brokerageCashAccount?.id ?? null,
        affectedCreditAccountIds,
        creditCycleRuleChanged,
      },
    });
  } catch (e) {
    if (isAccountIdentityUniqueError(e)) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_IDENTITY_CONFLICT", error: e.message }, { status: e.status });
    }
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: e instanceof Error ? e.message : "更新失败" }, { status: 500 });
  }
}

// === Internal: PATCH (toggle active) ===
export async function PATCH(req: NextRequest) {
  try {
    const { householdId, user } = await getHouseholdScope();
    const body = await req.json();
    const id = String(body.id ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, code: "MISSING_ID", error: "缺少 id" }, { status: 400 });

    const existing = await prisma.account.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "账户不存在" }, { status: 404 });
    if (!isAdmin(user) && existing.householdId !== householdId) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
    }

    await prisma.account.update({ where: { id }, data: { isActive: !existing.isActive } });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: e instanceof Error ? e.message : "操作失败" }, { status: 500 });
  }
}

// === Internal: DELETE ===
export async function DELETE(req: NextRequest) {
  try {
    const { householdId, user } = await getHouseholdScope();
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, code: "MISSING_ID", error: "缺少 id" }, { status: 400 });

    const existing = await prisma.account.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "账户不存在" }, { status: 404 });
    if (existing.isPlaceholder) return NextResponse.json({ ok: false, code: "PLACEHOLDER_ACCOUNT_NOT_DELETABLE", error: "占位账户不可删除" }, { status: 403 });
    if (!isAdmin(user) && existing.householdId !== householdId) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
    }

    // Check if account has any records referencing it
    const recordCount = await prisma.txRecord.count({ where: { accountId: id } });
    const toRecordCount = await prisma.txRecord.count({ where: { toAccountId: id } });
    const hasRecords = recordCount > 0 || toRecordCount > 0;

    if (!hasRecords) {
      // No records → delete directly (cascade handles related tables)
      await prisma.account.delete({ where: { id } });
      revalidateAfterSettingsChange();
      return NextResponse.json({ ok: true });
    }

    // Has records → require password verification
    let body: { password?: string } | null = null;
    try { body = await req.json(); } catch { /* no body */ }
    const password = (body?.password ?? "").trim();
    if (!password) {
      return NextResponse.json({ ok: false, code: "PASSWORD_REQUIRED_FOR_DELETE", error: "该账户已产生记录，需输入密码才能删除", needPassword: true }, { status: 409 });
    }

    // Verify password against current user
    if (!user) return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "未登录" }, { status: 401 });
    const currentUser = await prisma.user.findUnique({ where: { id: user.id } });
    if (!currentUser) return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "用户不存在" }, { status: 401 });

    if (currentUser.passwordHash) {
      const match = await verifyPassword(password, currentUser.passwordHash);
      if (!match) return NextResponse.json({ ok: false, code: "INVALID_PASSWORD", error: "密码错误" }, { status: 401 });
    } else {
      // No passwordHash → check legacy SystemSetting password
      const legacy = await prisma.systemSetting.findUnique({ where: { key: "access_password" } });
      if (!legacy || !legacy.value) {
        return NextResponse.json({ ok: false, code: "PASSWORD_NOT_SET", error: "请先设置密码" }, { status: 400 });
      }
      if (password !== legacy.value) return NextResponse.json({ ok: false, code: "INVALID_PASSWORD", error: "密码错误" }, { status: 401 });
    }

    // Password verified → reassign all references to placeholder account
    const placeholderId = await getOrCreatePlaceholderAccountId(householdId);

    // Update TxRecord where accountId = deleted account
    if (recordCount > 0) {
      await prisma.txRecord.updateMany({
        where: { accountId: id },
        data: { accountId: placeholderId, accountName: "" },
      });
    }

    // Update TxRecord where toAccountId = deleted account
    if (toRecordCount > 0) {
      await prisma.txRecord.updateMany({
        where: { toAccountId: id },
        data: { toAccountId: placeholderId, toAccountName: "" },
      });
    }

    // Reassign other related records (these have onDelete: Cascade,
    // but we want to preserve them by reassigning first)
    await prisma.fundConfirmDays.updateMany({ where: { accountId: id }, data: { accountId: placeholderId } });
    await prisma.fundFeeRate.updateMany({ where: { accountId: id }, data: { accountId: placeholderId } });
    await prisma.regularInvestPlan.updateMany({ where: { accountId: id }, data: { accountId: placeholderId } });
    await prisma.regularInvestPlan.updateMany({ where: { cashAccountId: id }, data: { cashAccountId: placeholderId } });

    // Related derived data is no longer meaningful → delete it
    await prisma.accountAlias.deleteMany({ where: { accountId: id } });
    await prisma.creditCardCycle.deleteMany({ where: { accountId: id } });
    await prisma.fundHolding.deleteMany({ where: { accountId: id } });
    await prisma.preciousMetalHolding.deleteMany({ where: { accountId: id } });

    // Now safe to delete the account (remaining cascade relations are already cleaned up)
    await prisma.account.delete({ where: { id } });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: e instanceof Error ? e.message : "删除失败" }, { status: 500 });
  }
}

// === External: GET (summaries, supports cookie session and API key fallback) ===
export async function GET(req: Request) {
  let scope;
  try {
    scope = await getApiHouseholdScope(req);
  } catch (e) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: e instanceof Error ? e.message : "未授权" }, { status: 401, headers: corsHeaders() });
  }

  const rows = await prisma.account.findMany({
    where: {
      ...scope.hidFilter,
      isActive: true,
      isPlaceholder: { not: true },
    },
    include: {
      AccountGroup: { select: { name: true } },
      Institution: { select: { name: true } },
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  const [investBalByAccountId, displayBalanceByAccountId, currentCreditCycles, insuranceDisplayBalanceByAccountId] = await Promise.all([
    computeInvestBalances(scope),
    computeAccountDisplayBalances(
      rows
        .filter((account) => !isPureInvestmentAccount(account))
        .map((account) => ({
          id: account.id,
          kind: account.kind,
          investProductType: account.investProductType,
          billingDay: account.billingDay,
        })),
      scope.hidFilter,
    ),
    prisma.creditCardCycle.findMany({
      where: {
        accountId: { in: rows.filter((account) => account.kind === AccountKind.bank_credit && !!account.billingDay).map((account) => account.id) },
        isCurrentCycle: true,
      },
      select: { accountId: true, effectiveBill: true, cumulativeRemain: true, cumulativeOverpaid: true },
    }),
    computeInsuranceAccountDisplayBalances(
      rows.filter((account) => account.kind === AccountKind.insurance).map((account) => account.id),
      scope.hidFilter,
    ),
  ]);
  const currentCreditBalanceByAccountId = new Map(
    currentCreditCycles.map((cycle) => [
      cycle.accountId,
      creditCardDisplayBalanceFromCurrentCycle(cycle),
    ]),
  );

  const accounts = rows
    .map((account) => ({
      id: account.id,
      name: account.name,
      balance: isPureInvestmentAccount(account)
        ? investBalByAccountId.get(account.id)?.marketValue ?? 0
        : account.kind === AccountKind.insurance
          ? insuranceDisplayBalanceByAccountId.get(account.id) ?? 0
          : account.kind === AccountKind.bank_credit && account.billingDay
            ? currentCreditBalanceByAccountId.get(account.id) ?? toNumber(account.balance)
            : displayBalanceByAccountId.get(account.id) ?? toNumber(account.balance),
      count: 0,
      kind: account.kind,
      debtDirection: account.debtDirection,
      note: account.note,
      currency: account.currency,
      groupName: account.kind === AccountKind.loan ? "" : account.AccountGroup?.name ?? "",
      institutionName: account.Institution?.name ?? "",
      usageCount: account.usageCount,
      lastUsedAt: account.lastUsedAt ? account.lastUsedAt.toISOString() : null,
    }))
    // Most frequently used accounts first, then alphabetical, so entry forms
    // (Web and Android) surface the accounts the user actually uses.
    .sort((a, b) => (b.usageCount - a.usageCount) || a.name.localeCompare(b.name, "zh-Hans-CN"));

  return NextResponse.json({ ok: true, accounts }, { headers: corsHeaders() });
}

/**
 * Android-friendly investment account list.
 * Returns real Account ids so native clients can call investment/fund APIs that require accountId.
 */
export async function HEAD() {
  return new NextResponse(null, { status: 405, headers: corsHeaders() });
}
