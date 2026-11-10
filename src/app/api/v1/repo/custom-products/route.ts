import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { REPO_INSTRUMENT_KIND, repoProductByCode, repoFeeRatePercent } from "@/lib/repo";

export const runtime = "nodejs";

function text(raw: unknown): string {
  return String(raw ?? "").trim();
}

function positiveInt(raw: unknown): number | null {
  const value = Number(String(raw ?? "").trim());
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/**
 * GET /api/v1/repo/custom-products —— 本账簿的自定义逆回购品种。
 * 交易所静态清单（src/lib/repo.ts）之外的品种在这里维护。
 */
export async function GET() {
  try {
    const { householdId } = await getHouseholdScope();
    const rows = await prisma.repoProductCustom.findMany({
      where: { householdId },
      orderBy: [{ market: "asc" }, { termDays: "asc" }, { code: "asc" }],
    });
    return NextResponse.json({
      ok: true,
      products: rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        market: row.market,
        termDays: row.termDays,
        feeRatePercent: row.feeRatePercent == null ? null : Number(row.feeRatePercent),
        note: row.note,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取自定义逆回购品种失败";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/**
 * POST /api/v1/repo/custom-products —— 新建自定义逆回购品种。
 *
 * Body: { code, name, market: "sh" | "sz", termDays, feeRatePercent?, note? }
 * 校验：代码不与交易所静态清单重复、本账簿内唯一；费率留空按交易所期限档兜底。
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const code = text(body.code);
    const name = text(body.name);
    const market = text(body.market).toLowerCase();
    const termDays = positiveInt(body.termDays);
    if (!code) return NextResponse.json({ ok: false, error: "请填写品种代码" }, { status: 400 });
    // 逆回购品种与股票一致：6 位数字代码（交易所标准品种就是 204001 / 131810 这种）。
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ ok: false, error: "品种代码必须是 6 位数字" }, { status: 400 });
    }
    if (!name) return NextResponse.json({ ok: false, error: "请填写品种简称" }, { status: 400 });
    if (name.length > 32) return NextResponse.json({ ok: false, error: "品种简称过长" }, { status: 400 });
    if (market !== "sh" && market !== "sz") {
      return NextResponse.json({ ok: false, error: "市场必须是沪市或深市" }, { status: 400 });
    }
    if (!termDays) return NextResponse.json({ ok: false, error: "请填写期限（天）" }, { status: 400 });

    // 交易所静态清单是规则常量，不允许自建同名品种造成口径混乱。
    if (repoProductByCode(code)) {
      return NextResponse.json({ ok: false, error: `代码 ${code} 已是交易所标准品种，直接在清单里选择即可` }, { status: 400 });
    }
    const clash = await prisma.repoProductCustom.findFirst({ where: { householdId, code }, select: { id: true } });
    if (clash) {
      return NextResponse.json({ ok: false, error: `本账簿已有代码 ${code} 的自定义品种` }, { status: 400 });
    }

    const feeRateRaw = body.feeRatePercent == null || text(body.feeRatePercent) === "" ? null : Number(body.feeRatePercent);
    const feeRatePercent =
      feeRateRaw != null && Number.isFinite(feeRateRaw) && feeRateRaw >= 0 ? Number(feeRateRaw.toFixed(5)) : repoFeeRatePercent(termDays);

    const created = await prisma.repoProductCustom.create({
      data: {
        householdId,
        code,
        name,
        market,
        termDays,
        feeRatePercent,
        note: text(body.note) || null,
      },
    });
    return NextResponse.json({
      ok: true,
      product: {
        id: created.id,
        code: created.code,
        name: created.name,
        market: created.market,
        termDays: created.termDays,
        feeRatePercent: created.feeRatePercent == null ? null : Number(created.feeRatePercent),
        note: created.note,
        instrumentKind: REPO_INSTRUMENT_KIND,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "新建自定义逆回购品种失败";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
