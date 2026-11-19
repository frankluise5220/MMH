import { NextResponse } from "next/server";

import { todayDateBusinessYmd } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdTimeZone } from "@/lib/server/household-preferences";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import {
  WalletLinkedFundError,
  bindWalletLinkedFundSegment,
  closeWalletLinkedFundSegment,
  deleteWalletLinkedFundSegment,
  loadWalletLinkedFundOverview,
  saveWalletLinkedFundSegment,
  summarizeWalletLinkedFundIncome,
} from "@/lib/server/wallet-linked-fund-periods";

export const runtime = "nodejs";

/**
 * 电子钱包的货基绑定区间（2026-11-19 用户要求：不同时间绑不同的货基要留表）。
 *
 * - GET    ?accountId=            全部段 + 当前生效段
 * - GET    ?accountId=&segmentId= 该段已生成的收益（天数 + 金额），删除前给用户看
 * - POST   { accountId, fundCode, startDate, fundName?, note? }  绑定/换绑（自动关旧段）
 * - PUT    { accountId, segmentId?, startDate, endDate?, fundCode }  改一段 / 补录一段
 * - PATCH  { accountId, segmentId?, endDate? }  关闭某段（缺省关当前段，endDate 缺省昨天）
 * - DELETE ?accountId=&segmentId=&keepIncome=1  删除误绑段；keepIncome=1 时保留该段收益行
 */

function errorResponse(error: unknown) {
  if (error instanceof WalletLinkedFundError) {
    const status = error.code === "ACCOUNT_LINKED_FUND_SEGMENT_MISSING"
      ? 404
      : error.code === "ACCOUNT_LINKED_FUND_OVERLAP"
        ? 409
        : 400;
    return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status });
  }
  throw error;
}

async function requireAccount(householdId: string, accountId: string) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId },
    select: { id: true, kind: true },
  });
  if (!account) {
    throw new WalletLinkedFundError("ACCOUNT_LINKED_FUND_ACCOUNT_MISSING", "Account not found");
  }
  return account;
}

export async function GET(request: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const url = new URL(request.url);
    const accountId = url.searchParams.get("accountId")?.trim() ?? "";
    if (!accountId) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_ID_REQUIRED", error: "accountId is required" }, { status: 400 });
    }
    // 带 segmentId = 问「删这一段会动到多少收益」，删除确认框要用。
    const segmentId = url.searchParams.get("segmentId")?.trim() ?? "";
    if (segmentId) {
      await requireAccount(householdId, accountId);
      const income = await summarizeWalletLinkedFundIncome({ householdId, accountId, segmentId });
      return NextResponse.json({ ok: true, data: { income } });
    }
    // 账户校验和段查询互不依赖，并行发；段本身用一次查询同时给出 current。
    const [, overview] = await Promise.all([
      requireAccount(householdId, accountId),
      loadWalletLinkedFundOverview(accountId),
    ]);
    return NextResponse.json({ ok: true, data: overview });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = (await request.json().catch(() => null)) as {
      accountId?: unknown;
      fundCode?: unknown;
      fundName?: unknown;
      startDate?: unknown;
      note?: unknown;
    } | null;
    const accountId = String(body?.accountId ?? "").trim();
    if (!accountId) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_ID_REQUIRED", error: "accountId is required" }, { status: 400 });
    }
    const startDate = String(body?.startDate ?? "").trim()
      || todayDateBusinessYmd(await getHouseholdTimeZone(householdId));
    const segment = await bindWalletLinkedFundSegment({
      householdId,
      accountId,
      fundCode: String(body?.fundCode ?? ""),
      fundName: typeof body?.fundName === "string" ? body.fundName : null,
      startDate,
      note: typeof body?.note === "string" ? body.note : null,
    });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, data: { segment } });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * 改一段 / 补录一段（表格行内编辑与底部空行新增都走这里）：
 * 不自动关旧段，也不做买入，纯粹维护「哪段时间用哪只货基」这张表。
 */
export async function PUT(request: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = (await request.json().catch(() => null)) as {
      accountId?: unknown;
      segmentId?: unknown;
      startDate?: unknown;
      endDate?: unknown;
      fundCode?: unknown;
      fundName?: unknown;
    } | null;
    const accountId = String(body?.accountId ?? "").trim();
    if (!accountId) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_ID_REQUIRED", error: "accountId is required" }, { status: 400 });
    }
    const result = await saveWalletLinkedFundSegment({
      householdId,
      accountId,
      segmentId: typeof body?.segmentId === "string" && body.segmentId.trim() ? body.segmentId.trim() : null,
      startDate: String(body?.startDate ?? "").trim(),
      endDate: typeof body?.endDate === "string" ? body.endDate : null,
      fundCode: String(body?.fundCode ?? ""),
      fundName: typeof body?.fundName === "string" ? body.fundName : null,
    });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = (await request.json().catch(() => null)) as {
      accountId?: unknown;
      segmentId?: unknown;
      endDate?: unknown;
    } | null;
    const accountId = String(body?.accountId ?? "").trim();
    if (!accountId) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_ID_REQUIRED", error: "accountId is required" }, { status: 400 });
    }
    const result = await closeWalletLinkedFundSegment({
      householdId,
      accountId,
      segmentId: typeof body?.segmentId === "string" ? body.segmentId : null,
      endDate: typeof body?.endDate === "string" ? body.endDate : null,
      todayYmd: todayDateBusinessYmd(await getHouseholdTimeZone(householdId)),
    });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const url = new URL(request.url);
    const accountId = url.searchParams.get("accountId")?.trim() ?? "";
    const segmentId = url.searchParams.get("segmentId")?.trim() ?? "";
    if (!accountId || !segmentId) {
      return NextResponse.json(
        { ok: false, code: "ACCOUNT_ID_REQUIRED", error: "accountId and segmentId are required" },
        { status: 400 },
      );
    }
    const result = await deleteWalletLinkedFundSegment({
      householdId,
      accountId,
      segmentId,
      keepIncome: url.searchParams.get("keepIncome") === "1",
    });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return errorResponse(error);
  }
}
