import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { resolveOrCreateWealthAccount } from "@/lib/server/wealth-account";
import {
  isInsurerInstitution,
  insurerInstitutionError,
  listInsurerInstitutionIds,
  notInsurerOwnedFilter,
  personalInstitutionError,
} from "@/lib/server/product-family-guard";
import { isPersonalInstitutionType } from "@/lib/institution-rules";
import { accountInstitutionTypeIsAllowed, ACCOUNT_INSTITUTION_TYPE_ERROR } from "@/lib/account-institution-rules";
import { normalizeCurrency, normalizeOptionalCurrency } from "@/lib/currency";
import { loadWealthHoldingCounts } from "@/lib/server/product-holding-counts";

export const runtime = "nodejs";

function parsePositiveNumber(raw: unknown) {
  const value = Number(String(raw ?? "").trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * GET /api/v1/wealth-products
 * Returns the bank wealth product master data for the current household.
 *
 * Query:
 * - institutionId?: string filter by institution; 「不指定机构」的通用产品始终包含在内
 *   （与债券产品同口径：留空机构 = 所有机构的账户都能选购）
 *
 * 家族口径：**只返回理财产品**，挂保险公司（type=insurance）名下的产品一律不返回，
 * 与保险家族「承保机构必须是保险公司」互为反向守卫。
 *
 * Response:
 * - { ok: true, products: [{ id, name, shortName, institutionId, institutionName, currency, annualRate, termDays, note }] }
 */
export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const institutionId = req.nextUrl.searchParams.get("institutionId")?.trim() || "";

    // 理财家族不含保险产品：先取本户所有保险公司 id，再排除挂在其下的产品
    // （筛选片段含 NULL 机构放行，语义见 `notInsurerOwnedFilter`）。
    const insurerIds = await listInsurerInstitutionIds(householdId);

    // 两组过滤都用 OR 表达，不能平铺展开（同名键会互相覆盖，保险产品就会漏进理财下拉），
    // 因此统一塞进 AND 数组。
    const scopeFilters = [
      ...(institutionId ? [{ OR: [{ institutionId }, { institutionId: null }] }] : []),
      notInsurerOwnedFilter(insurerIds),
    ].filter((filter) => Object.keys(filter).length > 0);

    const rows = await prisma.wealthProduct.findMany({
      where: {
        householdId,
        isActive: true,
        ...(scopeFilters.length > 0 ? { AND: scopeFilters } : {}),
      },
      include: { Institution: { select: { id: true, name: true, shortName: true } } },
      orderBy: [{ institutionId: "asc" }, { name: "asc" }],
    });

    // 每个产品下的真实记录数 = 未软删的**理财业务记录**数（软删不计入）。
    //
    // 口径必须是 `wealth_transactions`，不能是 `TxRecord.wealthProductId`：
    // 理财的买入/赎回/分红/核销写入路径（transactions/detail、transaction-actions、
    // business-transactions）只把产品外键写在业务行上，从未回填到 `transactions`
    // 这条资金腿，所以按 TxRecord 统计会恒为 0（2026-10-17 实测：全库
    // `transactions."wealthProductId"` 非空 0 条，而 `wealth_transactions` 有 131 条）。
    const recordCounts = await prisma.wealthTransaction.groupBy({
      by: ["wealthProductId"],
      where: {
        householdId,
        deletedAt: null,
        wealthProductId: { in: rows.map((item) => item.id) },
      },
      _count: { _all: true },
    });
    const recordCountByProductId = new Map(
      recordCounts
        .filter((item) => item.wealthProductId)
        .map((item) => [item.wealthProductId as string, item._count._all]),
    );

    // 产品库列表实际展示的是「当前持仓笔数」：已全部赎回的产品显示 0。
    const holdingCounts = await loadWealthHoldingCounts(householdId, rows.map((item) => item.id));

    return NextResponse.json({
      ok: true,
      products: rows.map((item) => ({
        id: item.id,
        name: item.name,
        shortName: item.shortName,
        // 产品家族：wealth=理财，advisor=投顾组合（录入窗口按下拉过滤互不混排）。
        productType: item.productType,
        institutionId: item.institutionId,
        institutionName: item.Institution?.shortName?.trim() || item.Institution?.name || "",
        currency: item.currency,
        annualRate: item.annualRate == null ? null : Number(item.annualRate),
        termDays: item.termDays,
        note: item.note,
        recordCount: recordCountByProductId.get(item.id) ?? 0,
        holdingCount: holdingCounts.get(item.id) ?? 0,
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
    // 产品家族：advisor=投顾组合窗口提交，缺省 wealth=理财。查重与账户解析都按家族隔离。
    const productType = body.productType === "advisor" ? "advisor" : "wealth";
    const cashAccountId = String(body.cashAccountId ?? "").trim();
    const requestedWealthAccountId = String(body.wealthAccountId ?? "").trim() || null;
    const requestedCurrency = normalizeOptionalCurrency(body.currency);
    const annualRate = parsePositiveNumber(body.annualRate);
    const termDays = parsePositiveNumber(body.termDays);
    const note = String(body.note ?? "").trim() || null;

    if (!name) return NextResponse.json({ ok: false, code: "PRODUCT_NAME_REQUIRED", error: "产品名称必填" }, { status: 400 });

    // 产品库（mode: "master"）：只登记产品主数据，不解析/创建理财账户，也不需要资金来源账户。
    if (String(body.mode ?? "").trim() === "master") {
      const institutionId = String(body.institutionId ?? "").trim() || null;
      // 投顾产品没有「通用（不限机构）」：产品库登记同样必须落到一个机构
      // （2026-11-03 用户裁定，与下单路径同一口径）。
      if (productType === "advisor" && !institutionId) {
        return NextResponse.json({ ok: false, code: "INSTITUTION_REQUIRED", error: "投顾产品必须指定所属机构" }, { status: 400 });
      }
      if (institutionId) {
        const institution = await prisma.institution.findFirst({ where: { id: institutionId, householdId } });
        if (!institution) return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "机构不存在" }, { status: 400 });
        if (isInsurerInstitution(institution)) return NextResponse.json(insurerInstitutionError(), { status: 400 });
        // 往来人员 / 往来组织 / 家庭成员不是理财产品的发行方。
        if (isPersonalInstitutionType(institution.type)) return NextResponse.json(personalInstitutionError(), { status: 400 });
        if (productType === "advisor" && !accountInstitutionTypeIsAllowed("investment", "advisor", institution.type)) {
          return NextResponse.json({ ok: false, code: "INSTITUTION_TYPE_INVALID", error: ACCOUNT_INSTITUTION_TYPE_ERROR }, { status: 400 });
        }
      }
      const duplicate = await prisma.wealthProduct.findFirst({ where: { householdId, institutionId, name, productType } });
      if (duplicate) return NextResponse.json({ ok: false, code: "PRODUCT_EXISTS", error: "同一机构下已有同名理财产品" }, { status: 409 });
      const created = await prisma.wealthProduct.create({
        data: {
          householdId,
          institutionId,
          name,
          shortName,
          productType,
          currency: requestedCurrency ? normalizeCurrency(requestedCurrency) : "CNY",
          annualRate,
          termDays: termDays == null ? null : Math.round(termDays),
          note,
          isActive: true,
        },
      });
      return NextResponse.json({
        ok: true,
        product: {
          id: created.id,
          name: created.name,
          shortName: created.shortName,
          productType: created.productType,
          institutionId: created.institutionId,
          currency: created.currency,
          annualRate: created.annualRate == null ? null : Number(created.annualRate),
          termDays: created.termDays,
          note: created.note,
        },
      });
    }

    if (!cashAccountId) return NextResponse.json({ ok: false, code: "CASH_ACCOUNT_REQUIRED", error: "请选择资金来源账户" }, { status: 400 });
    // 新建产品只登记名称/类型；到期日、票面利率等条款在购买界面按次填写后回填
    // （PUT /wealth-products/[id] 是债单条款真源），不再强制创建即填齐。

    // 机构归属（投顾产品用）：必填（2026-11-03 用户裁定，不提供「通用（不限机构）」），
    // 且必须符合投资账户机构口径；产品与自动建的投顾账户都落到该机构。
    let institutionOverride: string | null = null;
    const requestedInstitutionId = String(body.institutionId ?? "").trim() || null;
    if (productType === "advisor" && !requestedInstitutionId) {
      return NextResponse.json({ ok: false, code: "INSTITUTION_REQUIRED", error: "投顾产品必须指定所属机构" }, { status: 400 });
    }
    if (requestedInstitutionId) {
      const institution = await prisma.institution.findFirst({ where: { id: requestedInstitutionId, householdId } });
      if (!institution) return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "机构不存在" }, { status: 400 });
      if (isInsurerInstitution(institution)) return NextResponse.json(insurerInstitutionError(), { status: 400 });
      if (isPersonalInstitutionType(institution.type)) return NextResponse.json(personalInstitutionError(), { status: 400 });
      // 金融产品不可能归属于往来主体：显式指定的机构必须符合投资账户机构口径。
      if (productType === "advisor" && !accountInstitutionTypeIsAllowed("investment", "advisor", institution.type)) {
        return NextResponse.json({ ok: false, code: "INSTITUTION_TYPE_INVALID", error: ACCOUNT_INSTITUTION_TYPE_ERROR }, { status: 400 });
      }
      institutionOverride = requestedInstitutionId;
    }

    const { product, wealthAccount } = await prisma.$transaction(async (tx) => {
      const resolvedAccount = await resolveOrCreateWealthAccount(tx, {
        householdId,
        cashAccountId,
        requestedAccountId: requestedWealthAccountId,
        accountProductType: productType === "advisor" ? "advisor" : "wealth",
        institutionIdOverride: institutionOverride,
      });
      const effectiveInstitutionId = institutionOverride ?? resolvedAccount.institutionId;
      const existing = await tx.wealthProduct.findFirst({
        where: { householdId, institutionId: effectiveInstitutionId, name, productType },
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
          productType,
          institutionId: effectiveInstitutionId,
          currency: targetCurrency,
          annualRate,
          termDays: termDays == null ? null : Math.round(termDays),
          note,
        },
        include: { Institution: { select: { id: true, name: true, shortName: true } } },
      });
      return { product: resolvedProduct, wealthAccount: resolvedAccount };
    });

    return NextResponse.json({
      ok: true,
      product: {
        id: product.id,
        name: product.name,
        shortName: product.shortName,
        productType: product.productType,
        institutionId: product.institutionId,
        institutionName: product.Institution?.shortName?.trim() || product.Institution?.name || "",
        currency: product.currency,
        annualRate: product.annualRate == null ? null : Number(product.annualRate),
        termDays: product.termDays,
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
