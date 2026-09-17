import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { normalizeDepositInterestPayoutInput } from "@/lib/deposit-interest-payout";
import { ensureWealthBondPlansForProduct } from "@/lib/server/bond-plan-tasks";

export const runtime = "nodejs";

/**
 * PUT /api/v1/wealth-products/[id]
 * 编辑理财产品。城投债（bond）条款（票面利率/到期日/付息方式/首次付息日）为
 * 可手工调整字段 —— 这是"债单字段驱动"的唯一真源入口；保存后同步刷新该债单
 * 的只读计划行（预期付息日/金额）。
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
    if (body.maturityDate !== undefined) {
      const text = String(body.maturityDate ?? "").trim().slice(0, 10);
      if (!text) data.maturityDate = null;
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return NextResponse.json({ ok: false, code: "INVALID_DATE", error: "到期日格式不正确" }, { status: 400 });
      else data.maturityDate = new Date(`${text}T00:00:00.000Z`);
    }
    if (body.payoutFrequency !== undefined) {
      data.payoutFrequency = normalizeDepositInterestPayoutInput(body.payoutFrequency);
    }
    if (body.firstPayoutDate !== undefined) {
      const text = String(body.firstPayoutDate ?? "").trim().slice(0, 10);
      if (!text) data.firstPayoutDate = null;
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return NextResponse.json({ ok: false, code: "INVALID_DATE", error: "首次付息日格式不正确" }, { status: 400 });
      else data.firstPayoutDate = new Date(`${text}T00:00:00.000Z`);
    }

    // 城投债的到期日/票面利率是条款必需项，不允许编辑成空。
    const nextMaturityDate = data.maturityDate !== undefined ? (data.maturityDate as Date | null) : product.maturityDate;
    const nextAnnualRate = data.annualRate !== undefined ? (data.annualRate as number | null) : (product.annualRate == null ? null : Number(product.annualRate));
    if (product.productType === "bond") {
      if (!nextMaturityDate) return NextResponse.json({ ok: false, code: "BOND_MATURITY_REQUIRED", error: "城投债必须填写到期日" }, { status: 400 });
      if (!nextAnnualRate) return NextResponse.json({ ok: false, code: "BOND_RATE_REQUIRED", error: "城投债必须填写票面利率" }, { status: 400 });
      if (data.payoutFrequency === null) data.payoutFrequency = "maturity";
    }

    const updated = await prisma.wealthProduct.update({ where: { id: product.id }, data });
    if (updated.productType === "bond") {
      await ensureWealthBondPlansForProduct({ householdId, productId: updated.id }).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      product: {
        id: updated.id,
        name: updated.name,
        shortName: updated.shortName,
        currency: updated.currency,
        annualRate: updated.annualRate == null ? null : Number(updated.annualRate),
        termDays: updated.termDays,
        productType: updated.productType,
        maturityDate: updated.maturityDate ? updated.maturityDate.toISOString().slice(0, 10) : null,
        payoutFrequency: updated.payoutFrequency,
        firstPayoutDate: updated.firstPayoutDate ? updated.firstPayoutDate.toISOString().slice(0, 10) : null,
        note: updated.note,
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "UPDATE_FAILED", error: error instanceof Error ? error.message : "保存失败" }, { status: 500 });
  }
}
