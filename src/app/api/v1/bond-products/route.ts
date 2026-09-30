import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { resolveOrCreateWealthAccount } from "@/lib/server/wealth-account";
import { normalizeCurrency, normalizeOptionalCurrency } from "@/lib/currency";
import { normalizeDepositInterestPayoutInput } from "@/lib/deposit-interest-payout";
import { ensureBondPlansForProduct } from "@/lib/server/bond-plan-tasks";

export const runtime = "nodejs";

function parsePositiveNumber(raw: unknown) {
  const value = Number(String(raw ?? "").trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseIsoDateOnly(raw: unknown): Date | null {
  const text = String(raw ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDateOnly(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/**
 * GET /api/v1/bond-products
 * 债券产品主数据（BondProduct）。债券独立于普通理财（WealthProduct），
 * 本接口是债券产品的唯一入口。
 *
 * Query:
 * - institutionId?: string 按机构过滤
 */
export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const institutionId = req.nextUrl.searchParams.get("institutionId")?.trim() || "";
    const rows = await prisma.bondProduct.findMany({
      where: {
        householdId,
        isActive: true,
        ...(institutionId ? { institutionId } : {}),
      },
      include: { Institution: { select: { id: true, name: true, shortName: true } } },
      orderBy: [{ institutionId: "asc" }, { name: "asc" }],
    });

    // 每个产品下的真实记录数 = 未软删的 TxRecord 数（软删不计入）。
    const recordCounts = await prisma.txRecord.groupBy({
      by: ["bondProductId"],
      where: {
        householdId,
        deletedAt: null,
        bondProductId: { in: rows.map((item) => item.id) },
      },
      _count: { _all: true },
    });
    const recordCountByProductId = new Map(
      recordCounts
        .filter((item) => item.bondProductId)
        .map((item) => [item.bondProductId as string, item._count._all]),
    );

    return NextResponse.json({
      ok: true,
      products: rows.map((item) => ({
        id: item.id,
        name: item.name,
        shortName: item.shortName,
        institutionId: item.institutionId,
        institutionName: item.Institution?.shortName?.trim() || item.Institution?.name || "",
        currency: item.currency,
        annualRate: item.annualRate == null ? null : Number(item.annualRate),
        termDays: item.termDays,
        maturityDate: isoDateOnly(item.maturityDate),
        payoutFrequency: item.payoutFrequency,
        interestCalcBasis: item.interestCalcBasis,
        firstPayoutDate: isoDateOnly(item.firstPayoutDate),
        note: item.note,
        recordCount: recordCountByProductId.get(item.id) ?? 0,
      })),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "查询失败" }, { status: 500 });
  }
}

/**
 * POST /api/v1/bond-products
 * 创建（或复用同名）债券产品，并解析/自动创建债券账户。
 *
 * Body:
 * - name: string
 * - shortName?: string
 * - cashAccountId: string
 * - bondAccountId?: string
 * - currency?: string
 * - annualRate?: number            票面利率
 * - termDays?: number
 * - maturityDate?: string          到期日
 * - payoutFrequency?: string       付息方式（编码同存款：maturity | yearly(:N) | monthly(:N)）
 * - interestCalcBasis?: string     daily | monthly
 * - firstPayoutDate?: string       首次付息日
 * - note?: string
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    const shortName = String(body.shortName ?? "").trim() || null;
    const cashAccountId = String(body.cashAccountId ?? "").trim();
    const requestedBondAccountId = String(body.bondAccountId ?? "").trim() || null;
    const requestedCurrency = normalizeOptionalCurrency(body.currency);
    const annualRate = parsePositiveNumber(body.annualRate);
    const termDays = parsePositiveNumber(body.termDays);
    const note = String(body.note ?? "").trim() || null;
    const maturityDate = parseIsoDateOnly(body.maturityDate);
    const payoutFrequency = normalizeDepositInterestPayoutInput(body.payoutFrequency) ?? "maturity";
    const interestCalcBasis = String(body.interestCalcBasis ?? "").trim() === "monthly" ? "monthly" : "daily";
    const firstPayoutDate = parseIsoDateOnly(body.firstPayoutDate);

    if (!name) return NextResponse.json({ ok: false, code: "PRODUCT_NAME_REQUIRED", error: "债券名称必填" }, { status: 400 });

    // 产品库（mode: "master"）：只登记债券主数据，不解析/创建债券账户。
    if (String(body.mode ?? "").trim() === "master") {
      const institutionId = String(body.institutionId ?? "").trim() || null;
      if (institutionId) {
        const institution = await prisma.institution.findFirst({ where: { id: institutionId, householdId } });
        if (!institution) return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "机构不存在" }, { status: 400 });
      }
      const duplicate = await prisma.bondProduct.findFirst({ where: { householdId, institutionId, name } });
      if (duplicate) return NextResponse.json({ ok: false, code: "PRODUCT_EXISTS", error: "同一机构下已有同名债券" }, { status: 409 });
      const created = await prisma.bondProduct.create({
        data: {
          householdId,
          institutionId,
          name,
          shortName,
          currency: requestedCurrency ? normalizeCurrency(requestedCurrency) : "CNY",
          annualRate,
          termDays: termDays == null ? null : Math.round(termDays),
          maturityDate,
          payoutFrequency,
          interestCalcBasis,
          firstPayoutDate,
          note,
          isActive: true,
        },
      });
      await ensureBondPlansForProduct({ householdId, productId: created.id }).catch(() => {});
      return NextResponse.json({
        ok: true,
        product: {
          id: created.id,
          name: created.name,
          shortName: created.shortName,
          institutionId: created.institutionId,
          currency: created.currency,
          annualRate: created.annualRate == null ? null : Number(created.annualRate),
          termDays: created.termDays,
          maturityDate: isoDateOnly(created.maturityDate),
          payoutFrequency: created.payoutFrequency,
          interestCalcBasis: created.interestCalcBasis,
          firstPayoutDate: isoDateOnly(created.firstPayoutDate),
          note: created.note,
        },
      });
    }

    if (!cashAccountId) return NextResponse.json({ ok: false, code: "CASH_ACCOUNT_REQUIRED", error: "请选择资金来源账户" }, { status: 400 });

    const { product, bondAccount } = await prisma.$transaction(async (tx) => {
      const resolvedAccount = await resolveOrCreateWealthAccount(tx, {
        householdId,
        cashAccountId,
        requestedAccountId: requestedBondAccountId,
        accountProductType: "bond",
      });
      const existing = await tx.bondProduct.findFirst({
        where: { householdId, institutionId: resolvedAccount.institutionId, name },
        include: { Institution: { select: { id: true, name: true, shortName: true } } },
      });
      const targetCurrency = requestedCurrency ? normalizeCurrency(requestedCurrency) : normalizeCurrency(resolvedAccount.currency);
      if (existing && normalizeCurrency(existing.currency) !== targetCurrency) {
        throw new Error(`同名债券已存在，但币种是 ${normalizeCurrency(existing.currency)}，当前债券账户币种是 ${targetCurrency}`);
      }
      const resolvedProduct = existing ?? await tx.bondProduct.create({
        data: {
          householdId,
          name,
          shortName,
          institutionId: resolvedAccount.institutionId,
          currency: targetCurrency,
          annualRate,
          termDays: termDays == null ? null : Math.round(termDays),
          maturityDate,
          payoutFrequency,
          interestCalcBasis,
          firstPayoutDate,
          note,
        },
        include: { Institution: { select: { id: true, name: true, shortName: true } } },
      });
      return { product: resolvedProduct, bondAccount: resolvedAccount };
    });

    // 债单创建即生成/刷新只读计划行（到期 / 付息提醒，债单=唯一真源）。
    await ensureBondPlansForProduct({ householdId, productId: product.id }).catch(() => {});

    return NextResponse.json({
      ok: true,
      product: {
        id: product.id,
        name: product.name,
        shortName: product.shortName,
        institutionId: product.institutionId,
        institutionName: product.Institution?.shortName?.trim() || product.Institution?.name || "",
        currency: product.currency,
        annualRate: product.annualRate == null ? null : Number(product.annualRate),
        termDays: product.termDays,
        maturityDate: isoDateOnly(product.maturityDate),
        payoutFrequency: product.payoutFrequency,
        interestCalcBasis: product.interestCalcBasis,
        firstPayoutDate: isoDateOnly(product.firstPayoutDate),
        note: product.note,
      },
      bondAccount: {
        id: bondAccount.id,
        name: bondAccount.name,
        kind: bondAccount.kind,
        investProductType: bondAccount.investProductType,
        groupId: bondAccount.groupId,
        groupName: bondAccount.AccountGroup?.name ?? "",
        institutionId: bondAccount.institutionId,
        institutionName: bondAccount.Institution?.name ?? "",
        institutionShortName: bondAccount.Institution?.shortName ?? "",
        institutionType: bondAccount.Institution?.type ?? "",
        currency: bondAccount.currency,
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "CREATE_FAILED", error: error instanceof Error ? error.message : "创建失败" }, { status: 500 });
  }
}
