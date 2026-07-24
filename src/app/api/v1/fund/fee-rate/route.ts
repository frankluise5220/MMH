import { NextRequest, NextResponse } from "next/server";
import { getFundFeeRate, getFundFeeRateByDate, setFundFeeRate, setFundFeeRateByDate, type FundFeeRateType } from "@/lib/fund/feeRate";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId")?.trim();
  const fundCode = searchParams.get("fundCode")?.trim();
  const feeType = parseFeeType(searchParams.get("feeType"));
  const effectiveDateRaw = searchParams.get("effectiveDate")?.trim();
  if (!accountId || !fundCode) {
    return NextResponse.json({ ok: false, error: "缺少参数" }, { status: 400 });
  }

  const effectiveDate = effectiveDateRaw ? utcDate(effectiveDateRaw) : null;
  if (effectiveDateRaw && (!effectiveDate || Number.isNaN(effectiveDate.getTime()))) {
    return NextResponse.json({ ok: false, error: "生效日期不正确" }, { status: 400 });
  }

  const rate = effectiveDate
    ? await getFundFeeRateByDate(accountId, fundCode, effectiveDate, feeType)
    : await getFundFeeRate(accountId, fundCode, feeType);
  return NextResponse.json({ ok: true, rate, feeType });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const accountId = String(body.accountId ?? "").trim();
    const fundCode = String(body.fundCode ?? "").trim();
    const rate = parseFloat(body.rate);
    const feeType = parseFeeType(body.feeType);
    const effectiveDateRaw = String(body.effectiveDate ?? "").trim();

    if (!accountId || !fundCode || !Number.isFinite(rate) || rate < 0) {
      return NextResponse.json({ ok: false, error: "参数不正确" }, { status: 400 });
    }

    if (effectiveDateRaw) {
      const effectiveDate = utcDate(effectiveDateRaw);
      if (Number.isNaN(effectiveDate.getTime())) {
        return NextResponse.json({ ok: false, error: "生效日期不正确" }, { status: 400 });
      }
      await setFundFeeRateByDate(accountId, fundCode, rate, effectiveDate, feeType);
    } else {
      await setFundFeeRate(accountId, fundCode, rate, feeType);
    }
    return NextResponse.json({ ok: true, feeType });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "保存失败" }, { status: 500 });
  }
}

function parseFeeType(value: unknown): FundFeeRateType {
  return value === "redeem" ? "redeem" : "buy";
}

function utcDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
