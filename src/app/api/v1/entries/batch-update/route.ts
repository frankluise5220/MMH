import { NextRequest, NextResponse } from "next/server";
import { TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { getAccountFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";

/**
 * 批量更新交易记录
 *
 * POST {
 *   updates: Array<{
 *     id: string;              // TxRecord.id
 *     date?: string;           // YYYY-MM-DD
 *     type?: "expense" | "income" | "transfer" | "investment";
 *     account?: string;        // 来源账户 Account.id
 *     toAccount?: string;      // 去向账户 Account.id
 *     remark?: string;         // 备注，可传空字符串清空
 *     fundConfirmDate?: string;// 确认日期 YYYY-MM-DD，可传空字符串清空
 *     fundArrivalDate?: string;// 到账日期 YYYY-MM-DD，可传空字符串清空
 *     cashAccountId?: string;  // 资金账户 Account.id（按 fundSubtype 自动落到 accountId/toAccountId）
 *     fundAccountId?: string;  // 基金账户 Account.id（按 fundSubtype 自动落到 accountId/toAccountId）
 *     amount?: string | number;// 金额（绝对值），会保持原记录的正负号
 *     accountName?: string;    // 兼容旧调用：来源账户名称
 *   }>;
 * }
 *   返回 { ok: true, updatedCount, changed, notFoundIds? }
 *   如果所有 ID 都未匹配到记录，返回 { ok: false, error }
 */
type BatchUpdateItem = {
  id: string;
  date?: string;
  type?: string;
  account?: string;
  toAccount?: string;
  remark?: string;
  fundConfirmDate?: string;
  fundArrivalDate?: string;
  cashAccountId?: string;
  fundAccountId?: string;
  amount?: string | number;
  accountName?: string;
};

const validTypes = new Set<string>(Object.values(TransactionType));

function ymd(value: Date) {
  return value.toISOString().slice(0, 10);
}

function parseAmountUpdate(raw: string, baseAmountAbs: number) {
  const normalized = raw.replace(/[,，￥¥\s]/g, "");
  if (!normalized) return null;
  if (!/^[\d.+\-*/()]+$/.test(normalized)) return null;

  let expr = normalized;
  if (/^[+\-*/]/.test(expr)) expr = `${baseAmountAbs}${expr}`;

  try {
    const computed = Function(`"use strict"; return (${expr});`)();
    return typeof computed === "number" && Number.isFinite(computed) ? Math.abs(computed) : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { hidFilter } = await getHouseholdScope();
    const body = await req.json();
    const updates: BatchUpdateItem[] = body.updates;

    if (!Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json({ ok: false, error: "没有更新数据" }, { status: 400 });
    }

    const ids = Array.from(new Set(updates.map((u) => String(u.id ?? "").trim()).filter(Boolean)));
    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: "没有有效记录ID" }, { status: 400 });
    }

    const existingRecords = await prisma.txRecord.findMany({
      where: { id: { in: ids }, deletedAt: null, ...hidFilter },
      select: { id: true, date: true, type: true, amount: true, fundSubtype: true, source: true, accountId: true, accountName: true, toAccountId: true, toAccountName: true, note: true, fundConfirmDate: true, fundArrivalDate: true },
    });
    const existingMap = new Map(existingRecords.map((record) => [record.id, record]));
    const notFoundIds = ids.filter((id) => !existingMap.has(id));

    const accountIds = Array.from(new Set(updates.flatMap((item) => [item.account, item.toAccount, item.cashAccountId, item.fundAccountId].map((id) => String(id ?? "").trim()).filter(Boolean))));
    const accounts = accountIds.length > 0
      ? await prisma.account.findMany({ where: { id: { in: accountIds }, isActive: true, ...hidFilter }, select: { id: true, name: true } })
      : [];
    const accountById = new Map(accounts.map((account) => [account.id, account]));

    let updatedCount = 0;
    const changed: Array<{ id: string; date: string; oldValue: string; newValue: string; field: string }> = [];
    let investChanged = false;
    const touchedRecordIds = new Set<string>();
    const balanceAccountIds = new Set<string>();
    const amountTouchedIds = new Set<string>();

    for (const item of updates) {
      const id = String(item.id ?? "").trim();
      const existing = existingMap.get(id);
      if (!existing) continue;

      const data: Record<string, unknown> = {};
      if (existing.type === "investment") investChanged = true;

      if (existing.accountId) balanceAccountIds.add(existing.accountId);
      if (existing.toAccountId) balanceAccountIds.add(existing.toAccountId);

      if (item.date !== undefined) {
        const dateValue = String(item.date).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return NextResponse.json({ ok: false, error: "日期格式必须是 YYYY-MM-DD" }, { status: 400 });
        data.date = new Date(`${dateValue}T00:00:00.000Z`);
        changed.push({ id, date: ymd(existing.date), oldValue: ymd(existing.date), newValue: dateValue, field: "date" });
      }

      if (item.type !== undefined) {
        const typeValue = String(item.type).trim();
        if (!validTypes.has(typeValue)) return NextResponse.json({ ok: false, error: `交易类型不正确：${typeValue}` }, { status: 400 });
        data.type = typeValue;
        changed.push({ id, date: ymd(existing.date), oldValue: existing.type, newValue: typeValue, field: "type" });
        if (typeValue === "investment") investChanged = true;
      }

      if (item.account !== undefined) {
        const accountId = String(item.account).trim();
        const account = accountById.get(accountId);
        if (!account) return NextResponse.json({ ok: false, error: `来源账户不存在：${accountId}` }, { status: 400 });
        data.accountId = account.id;
        data.accountName = account.name;
        balanceAccountIds.add(account.id);
        changed.push({ id, date: ymd(existing.date), oldValue: existing.accountName ?? "-", newValue: account.name, field: "account" });
      } else if (item.accountName) {
        const accountName = String(item.accountName).trim();
        const account = await prisma.account.findFirst({ where: { name: accountName, isActive: true, ...hidFilter }, select: { id: true, name: true } });
        if (account) data.accountId = account.id;
        data.accountName = account?.name ?? accountName;
        if (account?.id) balanceAccountIds.add(account.id);
        changed.push({ id, date: ymd(existing.date), oldValue: existing.accountName ?? "-", newValue: account?.name ?? accountName, field: "account" });
      }

      if (item.toAccount !== undefined) {
        const toAccountId = String(item.toAccount).trim();
        const account = accountById.get(toAccountId);
        if (!account) return NextResponse.json({ ok: false, error: `去向账户不存在：${toAccountId}` }, { status: 400 });
        data.toAccountId = account.id;
        data.toAccountName = account.name;
        balanceAccountIds.add(account.id);
        changed.push({ id, date: ymd(existing.date), oldValue: existing.toAccountName ?? "-", newValue: account.name, field: "toAccount" });
      }

      if (item.remark !== undefined) {
        const remark = String(item.remark);
        data.note = remark || null;
        changed.push({ id, date: ymd(existing.date), oldValue: existing.note ?? "", newValue: remark, field: "remark" });
      }

      if (item.fundConfirmDate !== undefined) {
        const value = String(item.fundConfirmDate).trim();
        if (value) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NextResponse.json({ ok: false, error: "确认日期格式必须是 YYYY-MM-DD" }, { status: 400 });
          data.fundConfirmDate = new Date(`${value}T00:00:00.000Z`);
        } else {
          data.fundConfirmDate = null;
        }
        changed.push({ id, date: ymd(existing.date), oldValue: existing.fundConfirmDate ? ymd(existing.fundConfirmDate) : "", newValue: value, field: "fundConfirmDate" });
        investChanged = true;
      }

      if (item.fundArrivalDate !== undefined) {
        const value = String(item.fundArrivalDate).trim();
        if (value) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NextResponse.json({ ok: false, error: "到账日期格式必须是 YYYY-MM-DD" }, { status: 400 });
          data.fundArrivalDate = new Date(`${value}T00:00:00.000Z`);
        } else {
          data.fundArrivalDate = null;
        }
        changed.push({ id, date: ymd(existing.date), oldValue: existing.fundArrivalDate ? ymd(existing.fundArrivalDate) : "", newValue: value, field: "fundArrivalDate" });
        investChanged = true;
      }

      if (item.cashAccountId !== undefined || item.fundAccountId !== undefined) {
        const isRedeemLike = existing.fundSubtype === "redeem" || existing.fundSubtype === "dividend_cash" || existing.fundSubtype === "switch_out";
        const isCashOnToSide = isRedeemLike || (existing.fundSubtype === "buy_failed" && existing.source === "regular_invest_refund");

        const cashAccountId = item.cashAccountId !== undefined ? String(item.cashAccountId).trim() : "";
        const fundAccountId = item.fundAccountId !== undefined ? String(item.fundAccountId).trim() : "";

        if (cashAccountId) {
          const cashAcc = accountById.get(cashAccountId);
          if (!cashAcc) return NextResponse.json({ ok: false, error: `资金账户不存在：${cashAccountId}` }, { status: 400 });
          if (isCashOnToSide) {
            data.toAccountId = cashAcc.id;
            data.toAccountName = cashAcc.name;
            balanceAccountIds.add(cashAcc.id);
            changed.push({ id, date: ymd(existing.date), oldValue: existing.toAccountName ?? "-", newValue: cashAcc.name, field: "cashAccount" });
          } else {
            data.accountId = cashAcc.id;
            data.accountName = cashAcc.name;
            balanceAccountIds.add(cashAcc.id);
            changed.push({ id, date: ymd(existing.date), oldValue: existing.accountName ?? "-", newValue: cashAcc.name, field: "cashAccount" });
          }
          investChanged = true;
        }

        if (fundAccountId) {
          const fundAcc = accountById.get(fundAccountId);
          if (!fundAcc) return NextResponse.json({ ok: false, error: `基金账户不存在：${fundAccountId}` }, { status: 400 });
          if (isCashOnToSide) {
            data.accountId = fundAcc.id;
            data.accountName = fundAcc.name;
            balanceAccountIds.add(fundAcc.id);
            changed.push({ id, date: ymd(existing.date), oldValue: existing.accountName ?? "-", newValue: fundAcc.name, field: "fundAccount" });
          } else {
            data.toAccountId = fundAcc.id;
            data.toAccountName = fundAcc.name;
            balanceAccountIds.add(fundAcc.id);
            changed.push({ id, date: ymd(existing.date), oldValue: existing.toAccountName ?? "-", newValue: fundAcc.name, field: "fundAccount" });
          }
          investChanged = true;
        }
      }

      if (item.amount !== undefined) {
        const raw = typeof item.amount === "number" ? String(item.amount) : String(item.amount ?? "");
        const v = raw.trim();
        const oldN = Number(existing.amount);
        const absNew = parseAmountUpdate(v, Math.abs(oldN));
        if (absNew == null) return NextResponse.json({ ok: false, error: "金额必须是数字或运算式，如 100、*2、+10、-5、/2" }, { status: 400 });
        const signed = oldN < 0 ? -absNew : absNew;
        data.amount = signed;
        changed.push({ id, date: ymd(existing.date), oldValue: String(Math.abs(oldN)), newValue: String(absNew), field: "amount" });
        investChanged = true;
        amountTouchedIds.add(id);
      }

      if (Object.keys(data).length === 0) continue;

      const result = await prisma.txRecord.updateMany({
        where: { id, deletedAt: null, ...hidFilter },
        data,
      });
      if (result.count > 0) {
        updatedCount += result.count;
        touchedRecordIds.add(id);
      }
    }

    if (updatedCount === 0) {
      return NextResponse.json(
        { ok: false, error: `未找到匹配的记录 (IDs: ${ids.slice(0, 3).join(", ")}${ids.length > 3 ? "..." : ""})` },
        { status: 404 }
      );
    }

    if (touchedRecordIds.size > 0) {
      const touched = await prisma.txRecord.findMany({
        where: { id: { in: Array.from(touchedRecordIds) }, deletedAt: null, ...hidFilter },
        select: {
          id: true,
          type: true,
          fundCode: true,
          fundSubtype: true,
          source: true,
          amount: true,
          fundNav: true,
          fundConfirmDate: true,
          accountId: true,
          toAccountId: true,
        },
      });

      const fundCodesByInvestAcc = new Map<string, Set<string>>();

      for (const r of touched) {
        if (r.accountId) balanceAccountIds.add(r.accountId);
        if (r.toAccountId) balanceAccountIds.add(r.toAccountId);

        if (r.type !== "investment" || !r.fundCode) continue;
        const isRedeemOrRefund = r.fundSubtype === "redeem" || r.fundSubtype === "switch_out" || r.fundSubtype === "dividend_cash"
          || (r.fundSubtype === "buy_failed" && r.source === "regular_invest_refund");
        const investAccId = isRedeemOrRefund ? r.accountId : r.toAccountId;
        if (investAccId) {
          if (!fundCodesByInvestAcc.has(investAccId)) fundCodesByInvestAcc.set(investAccId, new Set());
          fundCodesByInvestAcc.get(investAccId)!.add(r.fundCode);
        }

        if (amountTouchedIds.has(r.id) && r.fundSubtype === "buy" && r.fundConfirmDate && r.fundNav != null && Number(r.fundNav) > 0) {
          const investIdForFee = r.toAccountId;
          if (!investIdForFee) continue;
          const feeRateRaw = await getFundFeeRateByDate(investIdForFee, r.fundCode, r.fundConfirmDate, "buy");
          const feeRate = feeRateRaw / 100;
          const amountAbs = Math.abs(Number(r.amount));
          const fee = Number((amountAbs * feeRate).toFixed(2));
          const principal = amountAbs - fee;
          const nav = Number(r.fundNav);
          const fundUnitsDecimals = await getAccountFundUnitsDecimals(investIdForFee);
          const units = nav > 0 ? roundFundUnits(principal / nav, fundUnitsDecimals) : null;
          await prisma.txRecord.update({
            where: { id: r.id },
            data: { fundFee: fee, ...(units != null ? { fundUnits: units } : {}) },
          });
        }
      }

      for (const acctId of balanceAccountIds) {
        await recalcAndSaveAccountBalance(acctId).catch(() => {});
      }

      for (const [acctId, codes] of fundCodesByInvestAcc.entries()) {
        await recalcFundPositions(acctId, Array.from(codes)).catch(() => {});
      }
    }

    // Client-side handles page refresh
    return NextResponse.json({
      ok: true,
      updatedCount,
      changed,
      notFoundIds: notFoundIds.length > 0 ? notFoundIds : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "更新失败";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
