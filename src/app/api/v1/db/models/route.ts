import { NextResponse } from "next/server";

/**
 * 获取Prisma schema的所有模型列表
 * GET /api/v1/db/models
 */
export async function GET() {
  try {
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

    const models = dmmf.map((model: any) => ({
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
    });
  } catch (e) {
    console.error("获取模型列表失败:", e);

    // Fallback: 如果DMMF不可用，返回空列表
    return NextResponse.json({
      ok: true,
      models: [],
      error: e instanceof Error ? e.message : "无法动态获取模型列表，请使用Prisma Studio",
    });
  }
}
