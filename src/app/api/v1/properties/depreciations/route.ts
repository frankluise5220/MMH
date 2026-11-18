/**
 * API: /api/v1/properties/depreciations
 *
 * 固定资产折旧台账（自动计提 + 手工登记）。
 *
 * GET    ?propertyAssetId=xxx
 *        Response: { ok, data: { records, manualTotal, autoTotal } }
 * POST   Body: { propertyAssetId, periodDate, amount, note? }
 *        手工登记一笔折损 / 减值（一次性折完也走这里），同月再登记会累加。
 *        Response: { ok, data: { record, settled, applied, capped } }
 * DELETE ?propertyAssetId=xxx&id=yyy
 *        删除一条**手工**记录并重算资产上的累计折旧；自动计提的行不可删。
 *
 * 折旧是账面价值减少，不产生 TxRecord、不改账户余额、不进收支报表。
 * 口径实现见 src/lib/server/property-depreciation.ts。
 */
import { NextRequest, NextResponse } from "next/server";

import { formatDateUtc, toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import {
  ManualDepreciationError,
  addManualDepreciation,
  deleteManualDepreciation,
  loadDepreciationLedger,
  recordedDepreciationTotal,
  recordedManualDepreciationTotal,
} from "@/lib/server/property-depreciation";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

function fail(code: string, error: string, status: number) {
  return NextResponse.json({ ok: false, code, error }, { status, headers: corsHeaders() });
}

function serializeRecord(record: {
  id: string;
  periodMonth: Date;
  amount: unknown;
  accumulatedAfter: unknown;
  method: string | null;
  note: string | null;
}) {
  return {
    id: record.id,
    /** 所属月 YYYY-MM：自动行存月初、手工行存月末，展示口径一致。 */
    period: formatDateUtc(record.periodMonth).slice(0, 7),
    amount: toNumber(record.amount),
    accumulatedAfter: toNumber(record.accumulatedAfter),
    method: record.method ?? "straight_line",
    manual: (record.method ?? "straight_line") === "manual",
    note: record.note ?? null,
  };
}

export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const propertyAssetId = String(req.nextUrl.searchParams.get("propertyAssetId") ?? "").trim();
    if (!propertyAssetId) return fail("MISSING_PROPERTY_ASSET", "缺少资产", 400);

    // 归属校验放这里：台账查询本身不带 householdId，不校验会串账簿。
    const asset = await prisma.propertyAsset.findFirst({
      where: { id: propertyAssetId, householdId, deletedAt: null },
      select: { id: true },
    });
    if (!asset) return fail("PROPERTY_ASSET_NOT_FOUND", "资产不存在或不属于当前账簿", 404);

    const [records, manualTotal, manualCount, autoTotal] = await Promise.all([
      loadDepreciationLedger(propertyAssetId, 36),
      recordedManualDepreciationTotal(propertyAssetId),
      prisma.propertyAssetDepreciation.count({ where: { propertyAssetId, method: "manual" } }),
      recordedDepreciationTotal(propertyAssetId),
    ]);

    return NextResponse.json({
      ok: true,
      data: { records: records.map(serializeRecord), manualTotal, manualCount, autoTotal },
    }, { headers: corsHeaders() });
  } catch (error) {
    return fail("LOAD_FAILED", error instanceof Error ? error.message : "读取失败", 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return fail("INVALID_REQUEST", "请求体无效", 400);

    const propertyAssetId = String(body.propertyAssetId ?? "").trim();
    if (!propertyAssetId) return fail("MISSING_PROPERTY_ASSET", "缺少资产", 400);
    const periodDate = String(body.periodDate ?? "").trim();
    if (!periodDate) return fail("MISSING_PERIOD_DATE", "缺少折损日期", 400);
    const amount = Number(String(body.amount ?? "").replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) return fail("INVALID_AMOUNT", "折损金额必须大于 0", 400);

    const result = await addManualDepreciation({
      householdId,
      propertyAssetId,
      periodDateKey: periodDate,
      amount,
      note: typeof body.note === "string" ? body.note : null,
    });

    revalidateAfterInvestChange();

    return NextResponse.json({
      ok: true,
      data: {
        record: serializeRecord(result.record),
        settled: result.settled,
        applied: result.applied,
        /** 超出可折额度被截断（累计折损已到成本）。 */
        capped: result.capped,
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    if (error instanceof ManualDepreciationError) {
      return fail("MANUAL_DEPRECIATION_REJECTED", error.message, error.status);
    }
    return fail("SAVE_FAILED", error instanceof Error ? error.message : "登记失败", 500);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const propertyAssetId = String(req.nextUrl.searchParams.get("propertyAssetId") ?? "").trim();
    const id = String(req.nextUrl.searchParams.get("id") ?? "").trim();
    if (!propertyAssetId || !id) return fail("MISSING_RECORD", "缺少资产或记录", 400);

    const result = await deleteManualDepreciation({ householdId, propertyAssetId, id });
    revalidateAfterInvestChange();
    return NextResponse.json({ ok: true, data: { settled: result.settled } }, { headers: corsHeaders() });
  } catch (error) {
    if (error instanceof ManualDepreciationError) {
      return fail("MANUAL_DEPRECIATION_REJECTED", error.message, error.status);
    }
    return fail("DELETE_FAILED", error instanceof Error ? error.message : "删除失败", 500);
  }
}
