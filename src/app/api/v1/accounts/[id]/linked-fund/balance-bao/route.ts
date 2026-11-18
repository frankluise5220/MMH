import { NextRequest, NextResponse } from "next/server";
import { AccountKind, FundProductType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/** 余额宝就是天弘余额宝货币，代码固定；名称只在基金资料缺失时兜底。 */
const BALANCE_BAO_FUND_CODE = "000198";
const BALANCE_BAO_FUND_FALLBACK_NAME = "天弘余额宝货币";
const BALANCE_BAO_ACCOUNT_NAME_SUFFIX = "余额宝货币基金";

function isAlipayInstitution(name: string | null | undefined, shortName: string | null | undefined) {
  return /支付宝|alipay/i.test(`${name ?? ""} ${shortName ?? ""}`);
}

/**
 * POST /api/v1/accounts/[id]/linked-fund/balance-bao
 *
 * 电子钱包（支付宝）一键建余额宝货基账户（2026-11-18 用户裁定）：
 * - 账户名 = 「所有人 · 机构 · 余额宝货币基金」，所有人与机构都取自这只钱包账户；
 * - 同一机构下新增基金 000198 的持仓（份额 0，不动钱），否则下拉里选不到它；
 * - 最后把钱包账户的关联直接落库（linkedFundAccountId / linkedFundCode）。
 *
 * 幂等：同名货基账户已存在就复用，重复点击不会建出第二份。
 */
export async function POST(_req: NextRequest, context: RouteContext) {
  try {
    const { householdId } = await getHouseholdScope();
    const { id } = await context.params;
    const walletId = String(id ?? "").trim();
    if (!walletId) {
      return NextResponse.json({ ok: false, code: "MISSING_ID", error: "Missing account id" }, { status: 400 });
    }

    const wallet = await prisma.account.findFirst({
      where: { id: walletId, householdId },
      select: {
        id: true,
        kind: true,
        currency: true,
        groupId: true,
        userId: true,
        institutionId: true,
        AccountGroup: { select: { name: true } },
        Institution: { select: { name: true, shortName: true } },
      },
    });
    if (!wallet) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Account not found" }, { status: 404 });
    }
    if (wallet.kind !== AccountKind.ewallet) {
      return NextResponse.json(
        { ok: false, code: "NOT_EWALLET", error: "Only e-wallet accounts can link a money fund" },
        { status: 400 },
      );
    }
    if (!wallet.institutionId || !wallet.Institution) {
      return NextResponse.json(
        { ok: false, code: "MISSING_INSTITUTION", error: "E-wallet has no institution" },
        { status: 400 },
      );
    }
    if (!isAlipayInstitution(wallet.Institution.name, wallet.Institution.shortName)) {
      return NextResponse.json(
        { ok: false, code: "NOT_ALIPAY", error: "Balance Bao shortcut is only for Alipay e-wallets" },
        { status: 400 },
      );
    }

    // 「所有人」是钱包账户归属分组，不是登录用户；账户名按 所有人·机构·余额宝货币基金 拼。
    // 这是落进 Account.name 的存储名（不是界面渲染），所以不走 account-display 的统一入口。
    const ownerName = wallet.AccountGroup?.name?.trim() || "";
    const institutionName = wallet.Institution.name.trim();
    const newAccountName = [ownerName, institutionName, BALANCE_BAO_ACCOUNT_NAME_SUFFIX].filter(Boolean).join("·");

    const profile = await prisma.fundProfile.findUnique({
      where: { fundCode: BALANCE_BAO_FUND_CODE },
      select: { fundName: true },
    });
    const fundName = profile?.fundName?.trim() || BALANCE_BAO_FUND_FALLBACK_NAME;

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.account.findFirst({
        where: {
          householdId,
          groupId: wallet.groupId,
          institutionId: wallet.institutionId,
          kind: AccountKind.investment,
          investProductType: FundProductType.money,
          name: newAccountName,
        },
        select: { id: true, name: true },
      });

      const fundAccount = existing ?? await tx.account.create({
        data: {
          householdId,
          name: newAccountName,
          kind: AccountKind.investment,
          investProductType: FundProductType.money,
          currency: wallet.currency,
          groupId: wallet.groupId,
          userId: wallet.userId,
          institutionId: wallet.institutionId,
          isActive: true,
        },
        select: { id: true, name: true },
      });

      // 空持仓：让「选择货币基金」下拉能列出 000198，余额仍是 0。
      await tx.fundHolding.upsert({
        where: { accountId_fundCode: { accountId: fundAccount.id, fundCode: BALANCE_BAO_FUND_CODE } },
        create: { accountId: fundAccount.id, fundCode: BALANCE_BAO_FUND_CODE, fundName },
        update: { fundName },
      });

      await tx.account.update({
        where: { id: wallet.id },
        data: { linkedFundAccountId: fundAccount.id, linkedFundCode: BALANCE_BAO_FUND_CODE },
      });

      return {
        fundAccountId: fundAccount.id,
        fundAccountName: fundAccount.name,
        fundCode: BALANCE_BAO_FUND_CODE,
        fundName,
        reused: Boolean(existing),
      };
    });

    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[accounts][linked-fund][balance-bao]", error);
    return NextResponse.json(
      { ok: false, code: "INTERNAL_ERROR", error: "Failed to create the Balance Bao money fund account" },
      { status: 500 },
    );
  }
}
