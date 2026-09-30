import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { deleteProductMaster } from "@/lib/server/product-master-delete";
import { isInsurerInstitution, insurerInstitutionError } from "@/lib/server/product-family-guard";

export const runtime = "nodejs";

/**
 * PUT /api/v1/wealth-products/[id]
 * 编辑普通理财产品（名称 / 简称 / 备注 / 期限 / 年化 / 所属机构 / 币种）。
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
    if (body.currency !== undefined) {
      const currency = String(body.currency ?? "").trim().toUpperCase();
      data.currency = currency || product.currency;
    }
    if (body.institutionId !== undefined) {
      const institutionId = String(body.institutionId ?? "").trim() || null;
      if (institutionId) {
        const institution = await prisma.institution.findFirst({ where: { id: institutionId, householdId } });
        if (!institution) {
          return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "机构不存在" }, { status: 400 });
        }
        // 理财家族不得挂到保险公司名下（同新建守卫），否则编辑会把产品「送回」理财库。
        if (isInsurerInstitution(institution)) return NextResponse.json(insurerInstitutionError(), { status: 400 });
      }
      data.institutionId = institutionId;
    }
    if (body.termDays !== undefined) {
      const termDays = Number(String(body.termDays ?? "").trim());
      data.termDays = Number.isFinite(termDays) && termDays > 0 ? Math.round(termDays) : null;
    }
    if (body.annualRate !== undefined) {
      const annualRate = Number(String(body.annualRate ?? "").trim());
      data.annualRate = Number.isFinite(annualRate) && annualRate > 0 ? annualRate : null;
    }

    // 身份口径 = (householdId, institutionId, name)，改名 / 改机构都可能撞上已有产品。
    const nextName = (data.name as string | undefined) ?? product.name;
    const nextInstitutionId =
      data.institutionId !== undefined ? (data.institutionId as string | null) : product.institutionId;
    const conflict = await prisma.wealthProduct.findFirst({
      where: { householdId, name: nextName, institutionId: nextInstitutionId, NOT: { id: product.id } },
      select: { id: true },
    });
    if (conflict) {
      return NextResponse.json({ ok: false, code: "PRODUCT_EXISTS", error: "同一机构下已有同名理财产品" }, { status: 409 });
    }

    const updated = await prisma.wealthProduct.update({ where: { id: product.id }, data });

    return NextResponse.json({
      ok: true,
      product: {
        id: updated.id,
        name: updated.name,
        shortName: updated.shortName,
        currency: updated.currency,
        institutionId: updated.institutionId,
        annualRate: updated.annualRate == null ? null : Number(updated.annualRate),
        termDays: updated.termDays,
        note: updated.note,
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "UPDATE_FAILED", error: error instanceof Error ? error.message : "保存失败" }, { status: 500 });
  }
}

/**
 * DELETE /api/v1/wealth-products/[id]
 * 删除理财产品主数据，带引用保护（语义见 `deleteProductMaster`）。
 *
 * Body: { cascade?: boolean, password?: string }
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const productId = String(id ?? "").trim();
    if (!productId) return NextResponse.json({ ok: false, code: "PRODUCT_ID_REQUIRED", error: "缺少产品 id" }, { status: 400 });

    const body = await req.json().catch(() => null) as { cascade?: boolean; password?: string } | null;
    const outcome = await deleteProductMaster({
      family: "wealth",
      productId,
      body,
      remove: async () => {
        await prisma.wealthProduct.delete({ where: { id: productId } });
      },
    });
    return NextResponse.json(outcome.payload, { status: outcome.status });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "DELETE_FAILED", error: error instanceof Error ? error.message : "删除失败" }, { status: 500 });
  }
}

