import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getFundConfirmRule, normalizeNonNegativeDays, setFundDateRuleAuto } from "@/lib/fund/confirmDays";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * 基金确认日规则（T+N）的唯一读写接口。
 *
 * GET /api/v1/fund/confirm-days
 * Query params:
 * - accountId: required. Investment account id.
 * - fundCode: optional. When present, returns the single rule for that fund.
 * - list: "1". When present (and no fundCode), returns the full rule table for
 *   the account: every fund seen in transactions plus every stored rule.
 *
 * GET responses:
 * - single: { ok, days, arrivalDays, manualOverride }
 * - list: { ok, rows: [{ fundCode, fundName, days, arrivalDays, manualOverride }] }
 * `days` 是从申请日算的确认交易日数，`arrivalDays` 是从确认日算的到账交易日数。
 *
 * POST /api/v1/fund/confirm-days
 * Body: { accountId, rows: [{ fundCode, days?, arrivalDays? }], auto? }
 * Saves rows as a batch (upsert per account+fundCode) and sets `manualOverride`:
 * 这张表是唯一被授权改写 T+N 的入口，保存后其它界面（交易/定投/导入/初始化）
 * 只能读，不能再覆盖。
 * `auto: true` 是例外：交易表单保存时用它回写自己算出的天数——不置锁，
 * 且该行已锁定时直接跳过。
 *
 * DELETE /api/v1/fund/confirm-days?accountId=...&fundCode=...
 * Deletes the single rule for the given accountId + fundCode pair. 删除即解锁，
 * 自动写入路径可以重新建行。
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId")?.trim();
  const fundCode = searchParams.get("fundCode")?.trim();
  const listMode = searchParams.get("list") === "1";

  if (!accountId) {
    return NextResponse.json({ ok: false, code: "MISSING_PARAMS", error: "accountId is required." }, { status: 400 });
  }

  try {
    const ctx = await getHouseholdScope();
    const account = await prisma.account.findUnique({
      where: { id: accountId, ...ctx.hidFilter },
      select: { id: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Investment account not found." }, { status: 404 });
    }

    if (fundCode) {
      const rule = await getFundConfirmRule(accountId, fundCode);
      return NextResponse.json({
        ok: true,
        days: rule.days,
        arrivalDays: rule.arrivalDays,
        manualOverride: rule.manualOverride,
      });
    }

    if (listMode) {
      // Every fund code seen in transactions for this account, plus any stored rule.
      const [txCodes, storedRules] = await Promise.all([
        prisma.fundTransaction.findMany({
          where: { fundAccountId: accountId, deletedAt: null, fundCode: { not: undefined } },
          select: { fundCode: true, fundName: true, confirmDate: true },
          orderBy: [{ fundCode: "asc" }, { confirmDate: "desc" }, { createdAt: "desc" }],
          take: 20000,
        }),
        prisma.fundConfirmDays.findMany({
          where: { accountId },
          select: { fundCode: true, days: true, arrivalDays: true, manualOverride: true, updatedAt: true },
          orderBy: { updatedAt: "desc" },
        }),
      ]);
      const fundNameByCode = new Map<string, string>();
      for (const row of txCodes) {
        if (row.fundCode && row.fundName && !fundNameByCode.has(row.fundCode)) {
          fundNameByCode.set(row.fundCode, row.fundName);
        }
      }
      const ruleByCode = new Map<string, (typeof storedRules)[number]>();
      for (const rule of storedRules) {
        if (!ruleByCode.has(rule.fundCode)) ruleByCode.set(rule.fundCode, rule);
      }
      const codeSet = new Set<string>([...fundNameByCode.keys(), ...ruleByCode.keys()]);
      const rows = Array.from(codeSet).sort().map((code) => {
        const rule = ruleByCode.get(code);
        return {
          fundCode: code,
          fundName: fundNameByCode.get(code) ?? null,
          days: normalizeNonNegativeDays(rule?.days, 0),
          arrivalDays: normalizeNonNegativeDays(rule?.arrivalDays, 2),
          manualOverride: Boolean(rule?.manualOverride),
        };
      });
      return NextResponse.json({ ok: true, rows });
    }

    return NextResponse.json({ ok: true, days: 0, arrivalDays: 2 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: e instanceof Error ? e.message : "Failed to fetch confirm days." },
      { status: 500 }
    );
  }
}

type ConfirmDayRowInput = {
  fundCode?: string;
  days?: number;
  arrivalDays?: number;
};

function parseRowInput(row: ConfirmDayRowInput) {
  return {
    fundCode: String(row.fundCode ?? "").trim(),
    days: typeof row.days === "number" ? normalizeNonNegativeDays(row.days, 0) : undefined,
    arrivalDays: typeof row.arrivalDays === "number" ? normalizeNonNegativeDays(row.arrivalDays, 2) : undefined,
  };
}

async function upsertRule(accountId: string, input: ReturnType<typeof parseRowInput>) {
  const existing = await prisma.fundConfirmDays.findUnique({
    where: { accountId_fundCode: { accountId, fundCode: input.fundCode } },
    select: { id: true },
  });
  const data: Record<string, number | boolean> = {};
  if (input.days !== undefined) data.days = input.days;
  if (input.arrivalDays !== undefined) data.arrivalDays = input.arrivalDays;
  // 这张表是唯一被授权改写 T+N 的入口：保存即锁定，其它界面从此只读。
  data.manualOverride = true;
  if (existing) {
    await prisma.fundConfirmDays.update({ where: { id: existing.id }, data });
    return;
  }
  await prisma.fundConfirmDays.create({
    data: {
      accountId,
      fundCode: input.fundCode,
      days: input.days ?? 0,
      arrivalDays: input.arrivalDays ?? 2,
      manualOverride: true,
    },
  });
}

async function deleteRule(accountId: string, fundCode: string) {
  const existing = await prisma.fundConfirmDays.findUnique({
    where: { accountId_fundCode: { accountId, fundCode } },
    select: { id: true },
  });
  if (!existing) {
    return null;
  }
  await prisma.fundConfirmDays.delete({ where: { id: existing.id } });
  return existing.id;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as {
      accountId?: string;
      rows?: ConfirmDayRowInput[];
      fundCode?: string;
      days?: number;
      arrivalDays?: number;
      /** true = 自动写入（交易表单等）：不置 manualOverride，且锁定行会被跳过。 */
      auto?: boolean;
    } | null;
    if (!body?.accountId) {
      return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "accountId is required." }, { status: 400 });
    }
    const ctx = await getHouseholdScope();
    const account = await prisma.account.findUnique({
      where: { id: body.accountId, ...ctx.hidFilter },
      select: { id: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Investment account not found." }, { status: 404 });
    }

    const rows = Array.isArray(body.rows) && body.rows.length > 0
      ? body.rows
      : body.fundCode
        ? [{
            fundCode: body.fundCode,
            days: body.days,
            arrivalDays: body.arrivalDays,
          }]
        : [];
    for (const raw of rows) {
      const input = parseRowInput(raw);
      if (!input.fundCode) continue;
      if (body.auto === true) {
        // 交易表单等自动路径：设置页锁定过的行只读，也不做锁定。
        await setFundDateRuleAuto(body.accountId, input.fundCode, {
          days: input.days,
          arrivalDays: input.arrivalDays,
        });
        continue;
      }
      await upsertRule(body.accountId, input);
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "SAVE_FAILED", error: e instanceof Error ? e.message : "Failed to save confirm days." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const accountId = searchParams.get("accountId")?.trim();
    const fundCode = searchParams.get("fundCode")?.trim();
    if (!accountId || !fundCode) {
      return NextResponse.json({ ok: false, code: "MISSING_PARAMS", error: "accountId and fundCode are required." }, { status: 400 });
    }
    const ctx = await getHouseholdScope();
    const account = await prisma.account.findUnique({
      where: { id: accountId, ...ctx.hidFilter },
      select: { id: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Investment account not found." }, { status: 404 });
    }
    const deletedId = await deleteRule(accountId, fundCode);
    if (!deletedId) {
      return NextResponse.json({ ok: false, code: "RULE_NOT_FOUND", error: "Confirm day rule not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "DELETE_FAILED", error: e instanceof Error ? e.message : "Failed to delete confirm day rule." },
      { status: 500 }
    );
  }
}
