import { NextRequest, NextResponse } from "next/server";
import { InsuranceAccountingType, InsuranceProductType, InsuranceStatus } from "@prisma/client";

import { isInsuranceAccount } from "@/lib/account-kind-utils";
import { getOrCreateInsuranceAccount } from "@/lib/insurance/autoAccount";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

const PRODUCT_TYPES = new Set<InsuranceProductType>([
  "savings",
  "dividend",
  "annuity",
  "universal",
  "investment_linked",
  "critical_illness",
  "medical",
  "accident",
  "term_life",
  "whole_life",
  "other",
]);

const ACCOUNTING_TYPES = new Set<InsuranceAccountingType>(["asset", "protection", "hybrid"]);
const STATUSES = new Set<InsuranceStatus>(["active", "matured", "surrendered", "lapsed"]);

function parseMoney(value: unknown) {
  if (value == null || value === "") return null;
  const num = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(num) ? num : null;
}

function parseDate(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function GET() {
  const { hidFilter } = await getHouseholdScope();

  const products = await prisma.insuranceProduct.findMany({
    where: hidFilter,
    include: {
      Account: { select: { id: true, name: true } },
      Institution: { select: { id: true, name: true, shortName: true } },
      OwnerGroup: { select: { id: true, name: true } },
      InsuredUser: { select: { id: true, name: true } },
    },
    orderBy: [{ Institution: { name: "asc" } }, { name: "asc" }],
  });

  return NextResponse.json({
    ok: true,
    products: products.map((item) => ({
      id: item.id,
      name: item.name,
      shortName: item.shortName,
      productType: item.productType,
      accountingType: item.accountingType,
      policyNo: item.policyNo,
      status: item.status,
      currency: item.currency,
      accountId: item.accountId,
      institutionId: item.institutionId,
      ownerGroupId: item.ownerGroupId,
      insuredUserId: item.insuredUserId,
      beneficiaryName: item.beneficiaryName,
      startDate: item.startDate?.toISOString().slice(0, 10) ?? null,
      effectiveDate: item.effectiveDate?.toISOString().slice(0, 10) ?? null,
      maturityDate: item.maturityDate?.toISOString().slice(0, 10) ?? null,
      premiumMode: item.premiumMode,
      premiumAmount: item.premiumAmount ? Number(item.premiumAmount) : null,
      coverageAmount: item.coverageAmount ? Number(item.coverageAmount) : null,
      cashValueEnabled: item.cashValueEnabled,
      note: item.note,
      accountName: item.Account?.name ?? "",
      institutionName: item.Institution?.name ?? "",
      institutionShortName: item.Institution?.shortName ?? "",
      ownerGroupName: item.OwnerGroup?.name ?? "",
      insuredUserName: item.InsuredUser?.name ?? "",
    })),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ ok: false, error: "无效的请求体" }, { status: 400 });
    }

    const name = String(body.name ?? "").trim();
    const requestedAccountId = String(body.accountId ?? "").trim() || null;
    const shortName = String(body.shortName ?? "").trim() || null;
    const productTypeRaw = String(body.productType ?? "other").trim() as InsuranceProductType;
    const accountingTypeRaw = String(body.accountingType ?? "asset").trim() as InsuranceAccountingType;
    const statusRaw = String(body.status ?? "active").trim() as InsuranceStatus;
    const policyNo = String(body.policyNo ?? "").trim() || null;
    const currency = String(body.currency ?? "CNY").trim() || "CNY";
    const institutionId = String(body.institutionId ?? "").trim() || null;
    const ownerGroupId = String(body.ownerGroupId ?? "").trim() || null;
    const insuredUserId = String(body.insuredUserId ?? "").trim() || null;
    const beneficiaryName = String(body.beneficiaryName ?? "").trim() || null;
    const premiumMode = String(body.premiumMode ?? "").trim() || null;
    const premiumAmount = parseMoney(body.premiumAmount);
    const coverageAmount = parseMoney(body.coverageAmount);
    const cashValueEnabled = body.cashValueEnabled === false ? false : true;
    const note = String(body.note ?? "").trim() || null;

    if (!name) {
      return NextResponse.json({ ok: false, error: "保险产品名称不能为空" }, { status: 400 });
    }
    if (!ownerGroupId) {
      return NextResponse.json({ ok: false, error: "请选择投保人" }, { status: 400 });
    }

    const productType = PRODUCT_TYPES.has(productTypeRaw) ? productTypeRaw : "other";
    const accountingType = ACCOUNTING_TYPES.has(accountingTypeRaw) ? accountingTypeRaw : "asset";
    const status = STATUSES.has(statusRaw) ? statusRaw : "active";

    const { hidFilter } = await getHouseholdScope();
    const householdId = hidFilter.householdId;

    const [institution, ownerGroup, insuredUser] = await Promise.all([
      institutionId ? prisma.institution.findFirst({ where: { id: institutionId, ...hidFilter } }) : Promise.resolve(null),
      prisma.accountGroup.findFirst({ where: { id: ownerGroupId, ...hidFilter } }),
      insuredUserId ? prisma.user.findFirst({ where: { id: insuredUserId, ...hidFilter } }) : Promise.resolve(null),
    ]);

    if (institutionId && !institution) {
      return NextResponse.json({ ok: false, error: "承保机构不存在" }, { status: 400 });
    }
    if (institution && institution.type !== "insurance") {
      return NextResponse.json({ ok: false, error: "承保机构必须是保险公司" }, { status: 400 });
    }
    if (!ownerGroup) {
      return NextResponse.json({ ok: false, error: "投保人不存在" }, { status: 400 });
    }
    if (insuredUserId && !insuredUser) {
      return NextResponse.json({ ok: false, error: "被保险人不存在" }, { status: 400 });
    }

    const account = requestedAccountId
      ? await prisma.account.findFirst({ where: { id: requestedAccountId, ...hidFilter } })
      : await getOrCreateInsuranceAccount(prisma, ownerGroupId, householdId);

    if (!account) {
      return NextResponse.json({ ok: false, error: "保险账户不存在" }, { status: 400 });
    }
    if (!isInsuranceAccount(account)) {
      return NextResponse.json({ ok: false, error: "请选择保险账户" }, { status: 400 });
    }

    const duplicate = await prisma.insuranceProduct.findFirst({
      where: { householdId, accountId: account.id, name, policyNo },
    });
    if (duplicate) {
      return NextResponse.json({ ok: false, error: "该保险产品已存在" }, { status: 409 });
    }

    const created = await prisma.insuranceProduct.create({
      data: {
        name,
        shortName,
        productType,
        accountingType,
        policyNo,
        status,
        currency,
        householdId,
        accountId: account.id,
        institutionId,
        ownerGroupId,
        insuredUserId,
        beneficiaryName,
        startDate: parseDate(body.startDate),
        effectiveDate: parseDate(body.effectiveDate),
        maturityDate: parseDate(body.maturityDate),
        premiumMode,
        premiumAmount,
        coverageAmount,
        cashValueEnabled,
        note,
      },
    });

    return NextResponse.json({
      ok: true,
      insuranceProduct: {
        id: created.id,
        name: created.name,
        shortName: created.shortName,
        productType: created.productType,
        accountingType: created.accountingType,
        policyNo: created.policyNo,
        status: created.status,
        currency: created.currency,
        accountId: created.accountId,
        institutionId: created.institutionId,
        ownerGroupId: created.ownerGroupId,
        insuredUserId: created.insuredUserId,
        beneficiaryName: created.beneficiaryName,
        startDate: created.startDate?.toISOString().slice(0, 10) ?? null,
        effectiveDate: created.effectiveDate?.toISOString().slice(0, 10) ?? null,
        maturityDate: created.maturityDate?.toISOString().slice(0, 10) ?? null,
        premiumMode: created.premiumMode,
        premiumAmount: created.premiumAmount ? Number(created.premiumAmount) : null,
        coverageAmount: created.coverageAmount ? Number(created.coverageAmount) : null,
        cashValueEnabled: created.cashValueEnabled,
        note: created.note,
        accountName: account.name,
        institutionName: institution?.name ?? "",
        institutionShortName: institution?.shortName ?? "",
        ownerGroupName: ownerGroup.name,
        insuredUserName: insuredUser?.name ?? "",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "创建保险产品失败";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
