import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getRequestTimeZone } from "@/lib/server/business-time-zone";
import { todayDateBusinessYmd } from "@/lib/date-utils";
import { probeFundQueryApi } from "@/lib/fund/queryApi";

const TestSchema = z.object({
  /** 行标识；自建源可不填，此时用 `parser` 顶替。 */
  code: z.string().min(1).max(40).optional(),
  parser: z.string().min(1).max(40).optional(),
  /** 仅自定义 JSON 源使用：字段路径与鉴权方式。 */
  parserConfig: z.unknown().optional(),
  baseUrl: z.string().min(1),
  /** 用户刚填的 key（明文）；留空表示这条源不需要鉴权。 */
  apiKey: z.string().optional(),
  fundCode: z.string().optional(),
});

/**
 * POST /api/v1/settings/fund-query-api/test
 * 新增净值源之前实测一次：地址 + 占位符 + 解析器三者是否真能取到净值。
 * 测试失败也返回 200，由 `ok` 字段区分，便于前端统一展示原因。
 */
export async function POST(req: NextRequest) {
  await getHouseholdScope();
  const body = await req.json().catch(() => null);
  const parsed = TestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, reason: "MISSING_REQUIRED_FIELDS", message: "缺少必填字段（code 或 parser，以及 baseUrl）" },
      { status: 400 },
    );
  }

  const code = (parsed.data.code ?? parsed.data.parser ?? "").trim();
  const result = await probeFundQueryApi({
    code,
    parser: parsed.data.parser,
    parserConfig: parsed.data.parserConfig,
    baseUrl: parsed.data.baseUrl,
    apiKey: parsed.data.apiKey,
    fundCode: parsed.data.fundCode,
    date: todayDateBusinessYmd(await getRequestTimeZone()),
  });

  return NextResponse.json(result);
}
