import { NextRequest, NextResponse } from "next/server";

import { normalizeCurrency, normalizeOptionalCurrency } from "@/lib/currency";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { deleteProductMaster } from "@/lib/server/product-master-delete";

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
 * PUT /api/v1/deposit-products/[id]
 * 编辑存款产品主数据（名称 / 简称 / 币种 / 所属机构 / 年化 / 期限 / 备注）。
 *
 * 这是「产品库」的唯一写入口。注意存款产品与存款账户是两个概念：改产品不会动任何
 * 存单（TxRecord 按 id 引用产品），但 `institutionId` 决定它在存款单据下拉里是否可见
 * ——历史遗留的 institutionId 为 NULL 的产品在所有机构下拉都看不到，本接口允许就地补上机构。
 *
 * Body: name? / shortName? / currency? / institutionId? / annualRate? / termDays? / note?
 * Response: { ok: true, product }
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { householdId } = await getHouseholdScope();
    const { id } = await ctx.params;
    const productId = String(id ?? "").trim();
    if (!productId) {
      return NextResponse.json({ ok: false, code: "PRODUCT_ID_REQUIRED", error: "缺少产品 id" }, { status: 400 });
    }

    const product = await prisma.depositProduct.findFirst({ where: { id: productId, householdId } });
    if (!product) {
      return NextResponse.json({ ok: false, code: "PRODUCT_NOT_FOUND", error: "产品不存在" }, { status: 404 });
    }

    const body = await req.json();
    const data: Record<string, unknown> = {};

    if (body.name !== undefined) {
      const name = String(body.name ?? "").trim();
      if (!name) {
        return NextResponse.json({ ok: false, code: "PRODUCT_NAME_REQUIRED", error: "产品名称必填" }, { status: 400 });
      }
      data.name = name;
    }
    if (body.shortName !== undefined) data.shortName = String(body.shortName ?? "").trim() || null;
    if (body.note !== undefined) data.note = String(body.note ?? "").trim() || null;
    if (body.currency !== undefined) {
      const requested = normalizeOptionalCurrency(body.currency);
      data.currency = requested ? normalizeCurrency(requested) : product.currency;
    }
    if (body.institutionId !== undefined) {
      const institutionId = String(body.institutionId ?? "").trim() || null;
      if (institutionId) {
        const institution = await prisma.institution.findFirst({ where: { id: institutionId, householdId } });
        if (!institution) {
          return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "机构不存在" }, { status: 400 });
        }
      }
      data.institutionId = institutionId;
    }
    if (body.termDays !== undefined) {
      const termDays = parsePositiveNumber(body.termDays);
      data.termDays = termDays == null ? null : Math.round(termDays);
    }
    if (body.annualRate !== undefined) data.annualRate = parsePositiveNumber(body.annualRate);

    // 身份口径 = (householdId, institutionId, name)。改名字或改机构都可能撞上已有产品，
    // 撞了就拒绝，避免又制造一组同名重复（历史遗留的 6 组重复就是这么来的）。
    const nextName = (data.name as string | undefined) ?? product.name;
    const nextInstitutionId =
      data.institutionId !== undefined ? (data.institutionId as string | null) : product.institutionId;
    const conflict = await prisma.depositProduct.findFirst({
      where: { householdId, name: nextName, institutionId: nextInstitutionId, NOT: { id: product.id } },
      select: { id: true },
    });
    if (conflict) {
      return NextResponse.json(
        { ok: false, code: "PRODUCT_EXISTS", error: "同一机构下已有同名存款产品" },
        { status: 409 },
      );
    }

    const updated = await prisma.depositProduct.update({ where: { id: product.id }, data });
    return NextResponse.json({ ok: true, product: serializeDepositProduct(updated) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "UPDATE_FAILED", error: error instanceof Error ? error.message : "保存失败" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/v1/deposit-products/[id]
 * 删除存款产品主数据，带引用保护（语义见 `deleteProductMaster`）。
 *
 * Body: { cascade?: boolean, password?: string }
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const productId = String(id ?? "").trim();
    if (!productId) {
      return NextResponse.json({ ok: false, code: "PRODUCT_ID_REQUIRED", error: "缺少产品 id" }, { status: 400 });
    }

    const body = await req.json().catch(() => null) as { cascade?: boolean; password?: string } | null;
    const outcome = await deleteProductMaster({
      family: "deposit",
      productId,
      body,
      remove: async () => {
        await prisma.depositProduct.delete({ where: { id: productId } });
      },
    });
    return NextResponse.json(outcome.payload, { status: outcome.status });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "DELETE_FAILED", error: error instanceof Error ? error.message : "删除失败" },
      { status: 500 },
    );
  }
}
