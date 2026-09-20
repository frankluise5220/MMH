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
    return NextResponse.json({
      ok: true,
      products: rows.map(serializeDepositProduct),
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
