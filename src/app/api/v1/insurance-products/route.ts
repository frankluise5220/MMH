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

function parseDecimal(value: unknown) {
  if (value == null || value === "") return null;
  const num = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(num) ? num : null;
}

function parseIntOrNull(value: unknown) {
  if (value == null || value === "") return null;
  const num = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(num) ? num : null;
}

function parseDate(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getProductMasterDelegate() {
  return (prisma as unknown as { insuranceProductMaster?: typeof prisma.insuranceProductMaster }).insuranceProductMaster;
}

function productMasterIdData(productMaster: { id: string } | null) {
  return productMaster ? { productMasterId: productMaster.id } : {};
}

async function getOrCreateProductMaster(input: {
  householdId: string;
  institutionId: string;
  name: string;
  shortName: string | null;
  productType: InsuranceProductType;
  accountingType: InsuranceAccountingType;
  currency: string;
  note?: string | null;
}) {
  const productMaster = getProductMasterDelegate();
  if (!productMaster) {
    console.warn("insuranceProductMaster delegate is unavailable; skipping insurance product master sync");
    return null;
  }
  return productMaster.upsert({
    where: {
      householdId_institutionId_name_productType: {
        householdId: input.householdId,
        institutionId: input.institutionId,
        name: input.name,
        productType: input.productType,
      },
    },
    update: {
      shortName: input.shortName,
      accountingType: input.accountingType,
      currency: input.currency,
      note: input.note ?? null,
    },
    create: {
      householdId: input.householdId,
      institutionId: input.institutionId,
      name: input.name,
      shortName: input.shortName,
      productType: input.productType,
      accountingType: input.accountingType,
      currency: input.currency,
      note: input.note ?? null,
    },
  });
}

export async function GET() {
  const { hidFilter } = await getHouseholdScope();

  const products = await prisma.insuranceProduct.findMany({
    where: hidFilter,
    include: {
      Account: { select: { id: true, name: true, institutionId: true, groupId: true } },
      Institution: { select: { id: true, name: true, shortName: true } },
      OwnerGroup: { select: { id: true, name: true } },
      InsuredUser: { select: { id: true, name: true } },
    },
    orderBy: [{ Institution: { name: "asc" } }, { name: "asc" }],
  });

  for (const item of products) {
    if (!item.institutionId) continue;
    const productMaster = await getOrCreateProductMaster({
      householdId: item.householdId,
      institutionId: item.institutionId,
      name: item.name,
      shortName: item.shortName,
      productType: item.productType,
      accountingType: item.accountingType,
      currency: item.currency,
      note: item.note,
    });
    if (productMaster && item.productMasterId !== productMaster.id) {
      await prisma.insuranceProduct.update({
        where: { id: item.id },
        data: { productMasterId: productMaster.id },
      });
    }
    if (!item.ownerGroupId) continue;
    if (item.Account?.institutionId && item.Account?.groupId === item.ownerGroupId) continue;
    const repairedAccount = await getOrCreateInsuranceAccount(prisma, item.ownerGroupId, item.householdId, item.institutionId);
    if (repairedAccount.id !== item.accountId) {
      await prisma.insuranceProduct.update({
        where: { id: item.id },
        data: { accountId: repairedAccount.id, ...productMasterIdData(productMaster) },
      });
      await prisma.txRecord.updateMany({
        where: { insuranceProductId: item.id, source: "insurance" },
        data: {
          toAccountId: repairedAccount.id,
          toAccountName: repairedAccount.name,
        },
      });
    }
  }

  const refreshedProducts = await prisma.insuranceProduct.findMany({
    where: hidFilter,
    include: {
      Account: { select: { id: true, name: true } },
      ProductMaster: { select: { id: true, name: true, shortName: true } },
      Institution: { select: { id: true, name: true, shortName: true } },
      OwnerGroup: { select: { id: true, name: true } },
      InsuredUser: { select: { id: true, name: true } },
    },
    orderBy: [{ Institution: { name: "asc" } }, { name: "asc" }],
  });

  return NextResponse.json({
    ok: true,
    products: refreshedProducts.map((item) => ({
      id: item.id,
      productMasterId: item.productMasterId,
      productMasterName: item.ProductMaster?.name ?? item.name,
      productMasterShortName: item.ProductMaster?.shortName ?? item.shortName,
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
      premiumFrequencyMonths: item.premiumFrequencyMonths,
      premiumAmount: item.premiumAmount ? Number(item.premiumAmount) : null,
      paymentTermYears: item.paymentTermYears ? Number(item.paymentTermYears) : null,
      coverageTermYears: item.coverageTermYears ? Number(item.coverageTermYears) : null,
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
    const premiumFrequencyMonths = parseIntOrNull(body.premiumFrequencyMonths);
    const premiumAmount = parseMoney(body.premiumAmount);
    const paymentTermYears = parseDecimal(body.paymentTermYears);
    const coverageTermYears = parseDecimal(body.coverageTermYears);
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

    if (!institutionId) {
      return NextResponse.json({ ok: false, error: "请选择承保机构" }, { status: 400 });
    }
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
      : await getOrCreateInsuranceAccount(prisma, ownerGroupId, householdId, institutionId);

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

    const productMaster = await getOrCreateProductMaster({
      householdId,
      institutionId,
      name,
      shortName,
      productType,
      accountingType,
      currency,
      note,
    });

    const created = await prisma.insuranceProduct.create({
      data: {
        name,
        shortName,
        ...productMasterIdData(productMaster),
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
        premiumFrequencyMonths,
        premiumAmount,
        paymentTermYears,
        coverageTermYears,
        coverageAmount,
        cashValueEnabled,
        note,
      },
    });

    return NextResponse.json({
      ok: true,
      insuranceProduct: {
        id: created.id,
        productMasterId: productMaster?.id ?? null,
        productMasterName: productMaster?.name ?? created.name,
        productMasterShortName: productMaster?.shortName ?? created.shortName,
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
        premiumFrequencyMonths: created.premiumFrequencyMonths,
        premiumAmount: created.premiumAmount ? Number(created.premiumAmount) : null,
        paymentTermYears: created.paymentTermYears ? Number(created.paymentTermYears) : null,
        coverageTermYears: created.coverageTermYears ? Number(created.coverageTermYears) : null,
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

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ ok: false, error: "无效的请求体" }, { status: 400 });
    }

    const id = String(body.id ?? "").trim();
    if (!id) {
      return NextResponse.json({ ok: false, error: "缺少保险产品ID" }, { status: 400 });
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
    const premiumFrequencyMonths = parseIntOrNull(body.premiumFrequencyMonths);
    const premiumAmount = parseMoney(body.premiumAmount);
    const paymentTermYears = parseDecimal(body.paymentTermYears);
    const coverageTermYears = parseDecimal(body.coverageTermYears);
    const coverageAmount = parseMoney(body.coverageAmount);
    const cashValueEnabled = body.cashValueEnabled === false ? false : true;
    const note = String(body.note ?? "").trim() || null;

    if (!name) {
      return NextResponse.json({ ok: false, error: "保险产品名称不能为空" }, { status: 400 });
    }
    if (!ownerGroupId) {
      return NextResponse.json({ ok: false, error: "请选择投保人" }, { status: 400 });
    }
    if (!institutionId) {
      return NextResponse.json({ ok: false, error: "请选择承保机构" }, { status: 400 });
    }

    const productType = PRODUCT_TYPES.has(productTypeRaw) ? productTypeRaw : "other";
    const accountingType = ACCOUNTING_TYPES.has(accountingTypeRaw) ? accountingTypeRaw : "asset";
    const status = STATUSES.has(statusRaw) ? statusRaw : "active";

    const { hidFilter } = await getHouseholdScope();
    const householdId = hidFilter.householdId;

    const existing = await prisma.insuranceProduct.findFirst({
      where: { id, ...hidFilter },
    });
    if (!existing) {
      return NextResponse.json({ ok: false, error: "保险产品不存在" }, { status: 404 });
    }

    const [institution, ownerGroup, insuredUser] = await Promise.all([
      prisma.institution.findFirst({ where: { id: institutionId, ...hidFilter } }),
      prisma.accountGroup.findFirst({ where: { id: ownerGroupId, ...hidFilter } }),
      insuredUserId ? prisma.user.findFirst({ where: { id: insuredUserId, ...hidFilter } }) : Promise.resolve(null),
    ]);

    if (!institution) {
      return NextResponse.json({ ok: false, error: "承保机构不存在" }, { status: 400 });
    }
    if (institution.type !== "insurance") {
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
      : await getOrCreateInsuranceAccount(prisma, ownerGroupId, householdId, institutionId);

    if (!account) {
      return NextResponse.json({ ok: false, error: "保险账户不存在" }, { status: 400 });
    }
    if (!isInsuranceAccount(account)) {
      return NextResponse.json({ ok: false, error: "请选择保险账户" }, { status: 400 });
    }

    const duplicate = await prisma.insuranceProduct.findFirst({
      where: {
        householdId,
        accountId: account.id,
        name,
        policyNo,
        NOT: { id },
      },
    });
    if (duplicate) {
      return NextResponse.json({ ok: false, error: "该保险产品已存在" }, { status: 409 });
    }

    const productMaster = await getOrCreateProductMaster({
      householdId,
      institutionId,
      name,
      shortName,
      productType,
      accountingType,
      currency,
      note,
    });

    const updated = await prisma.insuranceProduct.update({
      where: { id },
      data: {
        name,
        shortName,
        ...productMasterIdData(productMaster),
        productType,
        accountingType,
        policyNo,
        status,
        currency,
        accountId: account.id,
        institutionId,
        ownerGroupId,
        insuredUserId,
        beneficiaryName,
        startDate: parseDate(body.startDate),
        effectiveDate: parseDate(body.effectiveDate),
        maturityDate: parseDate(body.maturityDate),
        premiumMode,
        premiumFrequencyMonths,
        premiumAmount,
        paymentTermYears,
        coverageTermYears,
        coverageAmount,
        cashValueEnabled,
        note,
      },
    });

    if (existing.accountId !== account.id) {
      await prisma.txRecord.updateMany({
        where: {
          householdId,
          source: "insurance",
          insuranceProductId: id,
          fundSubtype: { in: ["redeem", "switch_out"] },
        },
        data: {
          accountId: account.id,
          accountName: account.name,
        },
      });
      await prisma.txRecord.updateMany({
        where: {
          householdId,
          source: "insurance",
          insuranceProductId: id,
          OR: [
            { fundSubtype: "buy" },
            { fundSubtype: null },
          ],
        },
        data: {
          toAccountId: account.id,
          toAccountName: account.name,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      insuranceProduct: {
        id: updated.id,
        productMasterId: productMaster?.id ?? updated.productMasterId ?? null,
        productMasterName: productMaster?.name ?? updated.name,
        productMasterShortName: productMaster?.shortName ?? updated.shortName,
        name: updated.name,
        shortName: updated.shortName,
        productType: updated.productType,
        accountingType: updated.accountingType,
        policyNo: updated.policyNo,
        status: updated.status,
        currency: updated.currency,
        accountId: updated.accountId,
        institutionId: updated.institutionId,
        ownerGroupId: updated.ownerGroupId,
        insuredUserId: updated.insuredUserId,
        beneficiaryName: updated.beneficiaryName,
        startDate: updated.startDate?.toISOString().slice(0, 10) ?? null,
        effectiveDate: updated.effectiveDate?.toISOString().slice(0, 10) ?? null,
        maturityDate: updated.maturityDate?.toISOString().slice(0, 10) ?? null,
        premiumMode: updated.premiumMode,
        premiumFrequencyMonths: updated.premiumFrequencyMonths,
        premiumAmount: updated.premiumAmount ? Number(updated.premiumAmount) : null,
        paymentTermYears: updated.paymentTermYears ? Number(updated.paymentTermYears) : null,
        coverageTermYears: updated.coverageTermYears ? Number(updated.coverageTermYears) : null,
        coverageAmount: updated.coverageAmount ? Number(updated.coverageAmount) : null,
        cashValueEnabled: updated.cashValueEnabled,
        note: updated.note,
        accountName: account.name,
        institutionName: institution.name,
        institutionShortName: institution.shortName ?? "",
        ownerGroupName: ownerGroup.name,
        insuredUserName: insuredUser?.name ?? "",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "更新保险产品失败";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
