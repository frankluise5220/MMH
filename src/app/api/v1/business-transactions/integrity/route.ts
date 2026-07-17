/**
 * API: /api/v1/business-transactions/integrity
 *
 * GET
 *   检查旧 TxRecord 投资/保险/理财/存款/贵金属业务字段与独立业务交易表、
 *   EntryBusinessLink 的一致性。
 *
 * POST JSON body { limit?: number }
 *   使用现有同步逻辑补齐缺失的独立业务交易记录和关联记录。
 *
 * 返回:
 *   GET  { ok: true, data: { ok, summary, issueCount, issues } }
 *   POST { ok: true, data: { attempted, before, after } }
 */
import { NextResponse } from "next/server";

import {
  auditBusinessTransactionIntegrity,
  repairBusinessTransactionIntegrity,
} from "@/lib/server/business-transaction-integrity";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

function normalizeLimit(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 5000;
  return Math.min(Math.round(n), 20_000);
}

export async function GET() {
  try {
    const { householdId } = await getHouseholdScope();
    const data = await auditBusinessTransactionIntegrity(householdId);
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error("GET /api/v1/business-transactions/integrity error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "检查失败" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const data = await repairBusinessTransactionIntegrity(householdId, normalizeLimit(body?.limit));
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error("POST /api/v1/business-transactions/integrity error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "修复失败" },
      { status: 500 },
    );
  }
}
