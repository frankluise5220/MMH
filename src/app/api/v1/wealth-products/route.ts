import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { resolveOrCreateWealthAccount } from "@/lib/server/wealth-account";
import { normalizeCurrency, normalizeOptionalCurrency } from "@/lib/currency";
import { normalizeDepositInterestPayoutInput } from "@/lib/deposit-interest-payout";

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

function normalizeWealthProductType(raw: unknown): "standard" | "bond" {
  return String(raw ?? "").trim() === "bond" ? "bond" : "standard";
}

/**
 * GET /api/v1/wealth-products
 * Returns the bank wealth product master data for the current household.
 *
 * Query:
 * - institutionId?: string filter by institution
 *
 * Response:
 * - { ok: true, products: [{ id, name, shortName, institutionId, institutionName, currency, annualRate, termDays, note }] }
 */
export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const institutionId = req.nextUrl.searchParams.get("institutionId")?.trim() || "";
    const rows = await prisma.wealthProduct.findMany({
      where: {
        householdId,
        isActive: true,
        ...(institutionId ? { institutionId } : {}),
      },
      include: { Institution: { select: { id: true, name: true, shortName: true } } },
      orderBy: [{ institutionId: "asc" }, { name: "asc" }],
    });

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
        productType: item.productType,
        maturityDate: item.maturityDate ? item.maturityDate.toISOString().slice(0, 10) : null,
        payoutFrequency: item.payoutFrequency,
        firstPayoutDate: item.firstPayoutDate ? item.firstPayoutDate.toISOString().slice(0, 10) : null,
        note: item.note,
      })),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "查询失败" }, { status: 500 });
  }
}

/**
 * POST /api/v1/wealth-products
 * Creates or returns the bank wealth product master data with the same name.
 *
 * Body:
 * - name: string
 * - shortName?: string
 * - cashAccountId: string
 * - wealthAccountId?: string
 * - currency?: string
 * - annualRate?: number
 * - termDays?: number
 * - note?: string
 *
 * Response:
 * - { ok: true, product, wealthAccount }
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    const shortName = String(body.shortName ?? "").trim() || null;
    const cashAccountId = String(body.cashAccountId ?? "").trim();
    const requestedWealthAccountId = String(body.wealthAccountId ?? "").trim() || null;
    const requestedCurrency = normalizeOptionalCurrency(body.currency);
    const annualRate = parsePositiveNumber(body.annualRate);
    const termDays = parsePositiveNumber(body.termDays);
    const note = String(body.note ?? "").trim() || null;
    // 城投债条款（理财 bond 类型）
    const productType = normalizeWealthProductType(body.productType);
    const maturityDate = parseIsoDateOnly(body.maturityDate);
    const payoutFrequency = productType === "bond"
      ? normalizeDepositInterestPayoutInput(body.payoutFrequency) ?? "maturity"
      : null;
    const firstPayoutDate = productType === "bond" ? parseIsoDateOnly(body.firstPayoutDate) : null;

    if (!name) return NextResponse.json({ ok: false, code: "PRODUCT_NAME_REQUIRED", error: "产品名称必填" }, { status: 400 });
    if (!cashAccountId) return NextResponse.json({ ok: false, code: "CASH_ACCOUNT_REQUIRED", error: "请选择资金来源账户" }, { status: 400 });
    if (productType === "bond" && !maturityDate) {
      return NextResponse.json({ ok: false, code: "BOND_MATURITY_REQUIRED", error: "城投债必须填写到期日" }, { status: 400 });
    }
    if (productType === "bond" && !annualRate) {
      return NextResponse.json({ ok: false, code: "BOND_RATE_REQUIRED", error: "城投债必须填写票面利率" }, { status: 400 });
    }

    const { product, wealthAccount } = await prisma.$transaction(async (tx) => {
      const resolvedAccount = await resolveOrCreateWealthAccount(tx, {
        householdId,
        cashAccountId,
        requestedAccountId: requestedWealthAccountId,
      });
      const existing = await tx.wealthProduct.findFirst({
        where: { householdId, institutionId: resolvedAccount.institutionId, name },
        include: { Institution: { select: { id: true, name: true, shortName: true } } },
      });
      const targetCurrency = requestedCurrency ? normalizeCurrency(requestedCurrency) : normalizeCurrency(resolvedAccount.currency);
      if (existing && normalizeCurrency(existing.currency) !== targetCurrency) {
        throw new Error(`同名理财产品已存在，但币种是 ${normalizeCurrency(existing.currency)}，当前理财账户币种是 ${targetCurrency}`);
      }
      const resolvedProduct = existing ?? await tx.wealthProduct.create({
        data: {
          householdId,
          name,
          shortName,
          institutionId: resolvedAccount.institutionId,
          currency: targetCurrency,
          annualRate,
          termDays: termDays == null ? null : Math.round(termDays),
          productType,
          maturityDate,
          payoutFrequency,
          firstPayoutDate,
          note,
        },
        include: { Institution: { select: { id: true, name: true, shortName: true } } },
      });
      return { product: resolvedProduct, wealthAccount: resolvedAccount };
    });

    // 城投债：产品创建即生成/刷新只读计划行（到期/付息提醒，债单=唯一真源）。
    if (product.productType === "bond") {
      const { ensureWealthBondPlansForProduct } = await import("@/lib/server/bond-plan-tasks");
      await ensureWealthBondPlansForProduct({ householdId, productId: product.id }).catch(() => {});
    }

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
        productType: product.productType,
        maturityDate: product.maturityDate ? product.maturityDate.toISOString().slice(0, 10) : null,
        payoutFrequency: product.payoutFrequency,
        firstPayoutDate: product.firstPayoutDate ? product.firstPayoutDate.toISOString().slice(0, 10) : null,
        note: product.note,
      },
      wealthAccount: {
        id: wealthAccount.id,
        name: wealthAccount.name,
        kind: wealthAccount.kind,
        investProductType: wealthAccount.investProductType,
        groupId: wealthAccount.groupId,
        groupName: wealthAccount.AccountGroup?.name ?? "",
        institutionId: wealthAccount.institutionId,
        institutionName: wealthAccount.Institution?.name ?? "",
        institutionShortName: wealthAccount.Institution?.shortName ?? "",
        institutionType: wealthAccount.Institution?.type ?? "",
        currency: wealthAccount.currency,
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "CREATE_FAILED", error: error instanceof Error ? error.message : "创建失败" }, { status: 500 });
  }
}
