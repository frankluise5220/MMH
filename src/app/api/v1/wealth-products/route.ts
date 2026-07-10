import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

function normalizeCurrency(raw: unknown) {
  return String(raw ?? "CNY").trim().toUpperCase() || "CNY";
}

function parsePositiveNumber(raw: unknown) {
  const value = Number(String(raw ?? "").trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * GET /api/v1/wealth-products
 * 返回当前账簿的银行理财产品主数据。
 *
 * Query:
 * - institutionId?: string 按机构筛选
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
        note: item.note,
      })),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "查询失败" }, { status: 500 });
  }
}

/**
 * POST /api/v1/wealth-products
 * 创建或返回同名银行理财产品主数据。
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
    const currency = normalizeCurrency(body.currency);
    const annualRate = parsePositiveNumber(body.annualRate);
    const termDays = parsePositiveNumber(body.termDays);
    const note = String(body.note ?? "").trim() || null;

    if (!name) return NextResponse.json({ ok: false, error: "产品名称必填" }, { status: 400 });

    if (institutionId) {
      const institution = await prisma.institution.findFirst({ where: { id: institutionId, householdId } });
      if (!institution) return NextResponse.json({ ok: false, error: "机构不存在或不属于当前账簿" }, { status: 400 });
    }

    const existing = await prisma.wealthProduct.findFirst({
      where: { householdId, institutionId, name },
      include: { Institution: { select: { id: true, name: true, shortName: true } } },
    });
    const product = existing ?? await prisma.wealthProduct.create({
      data: {
        householdId,
        name,
        shortName,
        institutionId,
        currency,
        annualRate,
        termDays: termDays == null ? null : Math.round(termDays),
        note,
      },
      include: { Institution: { select: { id: true, name: true, shortName: true } } },
    });

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
        note: product.note,
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "创建失败" }, { status: 500 });
  }
}
