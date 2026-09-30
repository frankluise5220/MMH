import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { resolveOrCreateDepositProduct } from "@/lib/server/deposit-product";
import { normalizeCurrency, normalizeOptionalCurrency } from "@/lib/currency";

export const runtime = "nodejs";

function parsePositiveNumber(raw: unknown) {
  const value = Number(String(raw ?? "").trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

function serializeDepositProduct(item: {
  id: string;
  name: string;
  shortName: string | null;
  currency: string;
  institutionId: string | null;
  annualRate: unknown;
  termDays: number | null;
  note: string | null;
}) {
  return {
    id: item.id,
    name: item.name,
    shortName: item.shortName,
    currency: item.currency,
    institutionId: item.institutionId,
    annualRate: item.annualRate == null ? null : Number(item.annualRate),
    termDays: item.termDays,
    note: item.note,
  };
}

/**
 * GET /api/v1/deposit-products
 * Returns institution-scoped deposit product master data for the current household.
 *
 * Query:
 * - institutionId?: string filter by institution. An empty institutionId query
 *   returns no products so the deposit form cannot leak other institutions.
 *
 * Response:
 * - { ok: true, products: [{ id, name, shortName, currency, institutionId, annualRate, termDays, note }] }
 */
export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const institutionIdParam = req.nextUrl.searchParams.get("institutionId");
    const institutionId = institutionIdParam?.trim() || "";
    if (institutionIdParam !== null && !institutionId) {
      return NextResponse.json({ ok: true, products: [] });
    }
    const rows = await prisma.depositProduct.findMany({
      where: {
        householdId,
        isActive: true,
        ...(institutionId ? { institutionId } : {}),
      },
      orderBy: [{ name: "asc" }],
    });

    // 每个产品下的真实记录数 = 未软删的 TxRecord 数（软删不计入）。
    const recordCounts = await prisma.txRecord.groupBy({
      by: ["depositProductId"],
      where: {
        householdId,
        deletedAt: null,
        depositProductId: { in: rows.map((item) => item.id) },
      },
      _count: { _all: true },
    });
    const recordCountByProductId = new Map(
      recordCounts
        .filter((item) => item.depositProductId)
        .map((item) => [item.depositProductId as string, item._count._all]),
    );

    return NextResponse.json({
      ok: true,
      products: rows.map((item) => ({
        ...serializeDepositProduct(item),
        recordCount: recordCountByProductId.get(item.id) ?? 0,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "Failed to load deposit products" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/v1/deposit-products
 * Creates or returns the deposit product master with the same name under the same institution.
 *
 * Body:
 * - name: string
 * - shortName?: string
 * - institutionId?: string
 * - currency?: string
 * - annualRate?: number
 * - termDays?: number
 * - note?: string
 * - mode?: "master"  产品库专用：只建产品主数据，同名同机构已存在时返回 409，
 *                    不会像单据流程那样静默复用已有产品。
 *
 * Response:
 * - { ok: true, product }
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    const shortName = String(body.shortName ?? "").trim() || null;
    const institutionId = String(body.institutionId ?? "").trim() || null;
    const requestedCurrency = normalizeOptionalCurrency(body.currency);
    const currency = requestedCurrency ? normalizeCurrency(requestedCurrency) : "CNY";
    const annualRate = parsePositiveNumber(body.annualRate);
    const termDays = parsePositiveNumber(body.termDays);
    const note = String(body.note ?? "").trim() || null;

    if (!name) {
      return NextResponse.json({ ok: false, code: "PRODUCT_NAME_REQUIRED", error: "Product name is required" }, { status: 400 });
    }

    // 产品库（mode: "master"）：显式新建，重复即报错，避免用户以为「新增成功」实际复用了旧产品。
    if (String(body.mode ?? "").trim() === "master") {
      if (institutionId) {
        const institution = await prisma.institution.findFirst({ where: { id: institutionId, householdId } });
        if (!institution) {
          return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "机构不存在" }, { status: 400 });
        }
      }
      const duplicate = await prisma.depositProduct.findFirst({ where: { householdId, institutionId, name } });
      if (duplicate) {
        return NextResponse.json({ ok: false, code: "PRODUCT_EXISTS", error: "同一机构下已有同名存款产品" }, { status: 409 });
      }
      const created = await prisma.depositProduct.create({
        data: {
          householdId,
          institutionId,
          name,
          shortName,
          currency,
          annualRate,
          termDays: termDays == null ? null : Math.round(termDays),
          note,
          isActive: true,
        },
      });
      return NextResponse.json({ ok: true, product: serializeDepositProduct(created) });
    }

    const product = await prisma.$transaction(async (tx) => {
      return resolveOrCreateDepositProduct(tx, {
        householdId,
        name,
        shortName,
        institutionId,
        currency,
        annualRate,
        termDays,
        note,
      });
    });
    if (!product) {
      return NextResponse.json({ ok: false, code: "PRODUCT_NAME_REQUIRED", error: "Product name is required" }, { status: 400 });
    }

    return NextResponse.json({ ok: true, product: serializeDepositProduct(product) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "CREATE_FAILED", error: error instanceof Error ? error.message : "Failed to create deposit product" },
      { status: 500 },
    );
  }
}
