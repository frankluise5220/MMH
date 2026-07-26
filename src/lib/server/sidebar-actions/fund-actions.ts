"use server";

import { FundSubtype } from "@prisma/client";
import { getFundArrivalDays, getFundConfirmDays } from "@/lib/fund/confirmDays";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { getAccountFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { allocateBuyFailedRefunds, calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { getFundNav } from "@/lib/fund/navCache";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { toNumber, addWorkdaysUtc } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";

function ymdUtc(d: Date) {
  return d.toISOString().slice(0, 10);
}

export async function fillFundNavFromCache(formData: FormData) {
  const entryId = String(formData.get("entryId") ?? "").trim();
  if (!entryId) return { ok: false as const, error: "缺少 entryId" };

  try {
    const txRecord = await prisma.txRecord.findUnique({
      where: { id: entryId },
      select: {
        id: true,
        accountId: true,
        toAccountId: true,
        fundCode: true,
        fundSourceEntryId: true,
        source: true,
        createdAt: true,
        fundArrivalDate: true,
        fundConfirmDate: true,
        date: true,
        amount: true,
        fundSubtype: true,
        fundFee: true,
      },
    });

    if (!txRecord) return { ok: false as const, error: "基金记录不存在" };
    if (!txRecord.fundCode) return { ok: false as const, error: "该记录无基金代码" };

    // 买入类：accountId=资金账户, toAccountId=投资账户
    // 赎回类：accountId=投资账户, toAccountId=资金账户
    const isRedeemFill = txRecord.fundSubtype === "redeem" || txRecord.fundSubtype === "switch_out";
    const investmentAccId = isRedeemFill ? txRecord.accountId : txRecord.toAccountId;
    if (!investmentAccId) return { ok: false as const, error: "该记录没有关联投资账户" };

    const applyDate = ymdUtc(txRecord.date);
    const confirmDate = txRecord.fundConfirmDate
      ? ymdUtc(txRecord.fundConfirmDate)
      : addWorkdaysUtc(applyDate, await getFundConfirmDays(investmentAccId, txRecord.fundCode));
    const navDate = new Date(`${confirmDate}T00:00:00.000Z`);
    const navData = await getFundNav(txRecord.fundCode, navDate, investmentAccId);

    if (!navData) {
      return { ok: false as const, error: `API 未能获取 ${txRecord.fundCode} 在 ${confirmDate} 的净值，确认日期可能是非交易日，或基金查询API未配置` };
    }
    if (!navData.dateMatch) {
      return { ok: false as const, error: `${txRecord.fundCode} 在 ${confirmDate} 无净值，该日期可能是非交易日，请检查确认日期是否正确` };
    }

    const nav = navData.nav;
    const amount = Math.abs(toNumber(txRecord.amount));

    // 从费率库查询费率（按确认日期）
    const arrivalDays = await getFundArrivalDays(investmentAccId, txRecord.fundCode);
    const arrivalDateStr = arrivalDays > 0 ? addWorkdaysUtc(confirmDate, arrivalDays) : confirmDate;
    const arrivalDate = new Date(Date.UTC(parseInt(arrivalDateStr.slice(0, 4)), parseInt(arrivalDateStr.slice(5, 7)) - 1, parseInt(arrivalDateStr.slice(8, 10))));
    const feeType = isRedeemFill ? "redeem" : "buy";
    const feeRateRaw = await getFundFeeRateByDate(investmentAccId, txRecord.fundCode, navDate, feeType);
    const feeRate = feeRateRaw / 100;
    const fundUnitsDecimals = await getAccountFundUnitsDecimals(investmentAccId);
    let refundAmount = 0;
    if (txRecord.fundSubtype === "buy") {
      const linkedEntries = await prisma.txRecord.findMany({
        where: {
          deletedAt: null,
          fundCode: txRecord.fundCode,
          OR: [
            { id: txRecord.id },
            { fundSourceEntryId: txRecord.id },
            {
              fundSubtype: FundSubtype.buy_failed,
              source: "regular_invest_refund",
              accountId: investmentAccId,
            },
          ],
        },
        select: {
          id: true,
          date: true,
          createdAt: true,
          fundConfirmDate: true,
          fundArrivalDate: true,
          accountId: true,
          toAccountId: true,
          fundCode: true,
          fundSubtype: true,
          source: true,
          amount: true,
          fundSourceEntryId: true,
        },
      });
      const { refundAmountByBuyId } = allocateBuyFailedRefunds(linkedEntries.map((entry) => ({
        id: entry.id,
        date: entry.date,
        createdAt: entry.createdAt,
        fundConfirmDate: entry.fundConfirmDate,
        fundArrivalDate: entry.fundArrivalDate,
        accountId: entry.accountId,
        toAccountId: entry.toAccountId,
        fundCode: entry.fundCode,
        fundSubtype: entry.fundSubtype,
        source: entry.source,
        amount: toNumber(entry.amount),
        fundSourceEntryId: entry.fundSourceEntryId,
      })));
      refundAmount = refundAmountByBuyId.get(txRecord.id) ?? 0;
    }
    const confirmedAmount = txRecord.fundSubtype === "buy"
      ? Math.max(0, amount - refundAmount)
      : amount;
    const fee = confirmedAmount * feeRate;
    const units = calculateConfirmedBuyUnits({
      grossAmount: amount,
      refundAmount,
      fee,
      nav,
      roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
    });

    // 更新净值、确认日期、手续费、份额
    const updateData: {
      fundConfirmDate: Date;
      fundNav: number;
      fundFee: number;
      fundUnits?: number;
      fundName?: string;
      fundArrivalDate?: Date;
    } = {
      fundConfirmDate: navDate,
      fundNav: nav,
      fundFee: fee,
      fundArrivalDate: arrivalDate,
    };
    if (units != null) {
      updateData.fundUnits = units;
    }
    if (navData.name) {
      updateData.fundName = navData.name;
    }

    await prisma.txRecord.update({
      where: { id: entryId },
      data: updateData,
    });

    await recalcFundPositions(investmentAccId, [txRecord.fundCode]).catch(() => {});
    // revalidation handled by FundShell optimistic update

    return { ok: true as const, nav, units, fee, confirmDate, arrivalDate: arrivalDateStr };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "获取净值失败" };
  }
}
