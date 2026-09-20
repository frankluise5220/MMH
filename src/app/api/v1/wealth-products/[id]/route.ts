import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

/**
 * PUT /api/v1/wealth-products/[id]
 * 编辑普通理财产品（名称 / 简称 / 备注 / 期限 / 年化）。
 * 债券条款（票面利率、到期日、付息方式、计息基础、首次付息日）走
 * /api/v1/bond-products/[id]，不再由本接口承载。
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { householdId } = await getHouseholdScope();
    const { id } = await ctx.params;
    const productId = String(id ?? "").trim();
    if (!productId) return NextResponse.json({ ok: false, code: "PRODUCT_ID_REQUIRED", error: "缺少产品 id" }, { status: 400 });

    const product = await prisma.wealthProduct.findFirst({ where: { id: productId, householdId } });
    if (!product) return NextResponse.json({ ok: false, code: "PRODUCT_NOT_FOUND", error: "产品不存在" }, { status: 404 });

    const body = await req.json();
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = String(body.name ?? "").trim();
      if (!name) return NextResponse.json({ ok: false, code: "PRODUCT_NAME_REQUIRED", error: "产品名称必填" }, { status: 400 });
      data.name = name;
    }
    if (body.shortName !== undefined) data.shortName = String(body.shortName ?? "").trim() || null;
    if (body.note !== undefined) data.note = String(body.note ?? "").trim() || null;
    if (body.termDays !== undefined) {
      const termDays = Number(String(body.termDays ?? "").trim());
      data.termDays = Number.isFinite(termDays) && termDays > 0 ? Math.round(termDays) : null;
    }
    if (body.annualRate !== undefined) {
      const annualRate = Number(String(body.annualRate ?? "").trim());
      data.annualRate = Number.isFinite(annualRate) && annualRate > 0 ? annualRate : null;
    }
    const updated = await prisma.wealthProduct.update({ where: { id: product.id }, data });

    return NextResponse.json({
      ok: true,
      product: {
        id: updated.id,
        name: updated.name,
        shortName: updated.shortName,
        currency: updated.currency,
        annualRate: updated.annualRate == null ? null : Number(updated.annualRate),
        termDays: updated.termDays,
        note: updated.note,
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "UPDATE_FAILED", error: error instanceof Error ? error.message : "保存失败" }, { status: 500 });
  }
}
