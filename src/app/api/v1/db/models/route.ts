import { NextResponse } from "next/server";
import { getApiHouseholdScope } from "@/lib/server/api-auth";

export const runtime = "nodejs";

/**
 * 获取 Prisma schema 的 Agent 可访问模型列表。
 *
 * Auth: browser session cookie, Authorization: Bearer <admin password>, or X-Api-Key.
 *
 * GET /api/v1/db/models
 */

const BLOCKED_MODELS = new Set([
  "AccessKey",
  "AiChannel",
  "ApiKey",
  "EmailAccount",
  "FundQueryApi",
  "PasswordResetToken",
  "SystemSetting",
  "User",
  "UserSettings",
]);

const READ_ALLOWED_MODELS = new Set([
  "Account",
  "AccountAlias",
  "AccountGroup",
  "BillOverride",
  "Category",
  "CommandAlias",
  "CreditCardCycle",
  "FundConfirmDays",
  "FundFeeRate",
  "FundHolding",
  "FundNavCache",
  "FundSnapshot",
  "Institution",
  "InsuranceProduct",
  "RegularInvestPlan",
  "Tag",
  "TxRecord",
]);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: Request) {
  try {
    await getApiHouseholdScope(req);

    // 使用Prisma的DMMF API动态获取所有模型信息
    const { Prisma } = await import("@prisma/client");
    const dmmf = Prisma?.dmmf?.datamodel?.models || [];

    // 中文标题映射
    const MODEL_CN: Record<string, string> = {
      Household: "家庭",
      User: "用户",
      AccountGroup: "所有人",
      Account: "账户",
      Category: "分类",
      Institution: "机构",
      Tag: "标签",
      EntryTag: "明细标签",
      ImportBatch: "导入批次",
      UserSettings: "用户设置",
      AccountAlias: "账户别名",
      DistillLog: "提取日志",
      AccessKey: "访问密钥",
      AiChannel: "AI渠道",
      AiModel: "AI模型",
      BillOverride: "账单覆盖",
      CreditCardCycle: "账单周期",
      FundSnapshot: "资产快照",
      FundHolding: "持仓",
      FundFeeRate: "费率",
      FundConfirmDays: "确认天数",
      FundNavCache: "净值缓存",
      TxRecord: "交易记录",
      RegularInvestPlan: "定投计划",
      Attachment: "附件",
      ApiKey: "API密钥",
    };

    const models = dmmf
      .filter((model: any) => !BLOCKED_MODELS.has(model.name) && READ_ALLOWED_MODELS.has(model.name))
      .map((model: any) => ({
        name: model.name,
        dbName: model.dbName || model.name,
        title: MODEL_CN[model.name] || model.name,
        fields: model.fields.map((field: any) => ({
          name: field.name,
          type: field.type,
          kind: field.kind,
          isRequired: field.isRequired,
          isId: field.isId,
          isUnique: field.isUnique,
          hasDefaultValue: field.hasDefaultValue,
          default: field.default?.value || field.default,
        })),
      }));

    return NextResponse.json({
      ok: true,
      models,
    }, { headers: corsHeaders() });
  } catch (e) {
    console.error("获取模型列表失败:", e);

    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : "无法动态获取模型列表，请使用Prisma Studio",
    }, { status: 401, headers: corsHeaders() });
  }
}
