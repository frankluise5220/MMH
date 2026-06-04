import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { Prisma } from "@prisma/client";

/**
 * 通用数据库编辑API
 * GET /api/v1/db/data?model=ModelName - 查询数据
 * POST /api/v1/db/data - 创建记录
 * PUT /api/v1/db/data - 更新记录
 * DELETE /api/v1/db/data?id=xxx&model=ModelName - 删除记录
 */

// Prisma模型名称映射到实际的Model
const getPrismaModel = (modelName: string) => {
  return (prisma as any)[modelName];
};

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const modelName = searchParams.get("model");

    if (!modelName) {
      return NextResponse.json({ ok: false, error: "缺少 model 参数" }, { status: 400 });
    }

    const model = getPrismaModel(modelName);
    if (!model) {
      return NextResponse.json({ ok: false, error: `模型 ${modelName} 不存在` }, { status: 400 });
    }

    // 获取排序参数
    const orderByField = searchParams.get("orderBy") || "createdAt";
    const orderByDir = searchParams.get("orderDir") || "desc";

    // 查询数据
    const data = await model.findMany({
      orderBy: {
        [orderByField]: orderByDir,
      },
    });

    // 将Decimal转换为Number
    const processedData = data.map((row: any) => {
      const processed: any = {};
      for (const [key, value] of Object.entries(row)) {
        if (value instanceof Prisma.Decimal) {
          processed[key] = Number(value);
        } else if (value instanceof Date) {
          processed[key] = value.toISOString();
        } else {
          processed[key] = value;
        }
      }
      return processed;
    });

    return NextResponse.json({ ok: true, data: processedData });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : "查询失败",
    }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { model: modelName, data } = body;

    if (!modelName || !data) {
      return NextResponse.json({ ok: false, error: "缺少 model 或 data 参数" }, { status: 400 });
    }

    const model = getPrismaModel(modelName);
    if (!model) {
      return NextResponse.json({ ok: false, error: `模型 ${modelName} 不存在` }, { status: 400 });
    }

    // 创建记录
    const created = await model.create({ data });

    return NextResponse.json({ ok: true, data: created });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : "创建失败",
    }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { model: modelName, id, data } = body;

    if (!modelName || !id || !data) {
      return NextResponse.json({ ok: false, error: "缺少 model、id 或 data 参数" }, { status: 400 });
    }

    const model = getPrismaModel(modelName);
    if (!model) {
      return NextResponse.json({ ok: false, error: `模型 ${modelName} 不存在` }, { status: 400 });
    }

    // 处理数据类型转换（字符串转数字、日期等）
    const processedData: any = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === "" || value === null || value === undefined) {
        // 空字符串保持为null（不更新）
        continue;
      }

      // 根据字段名推断类型
      if (key === "days" || key === "rate" || key.includes("Rate") || key.includes("Days") ||
          key === "amount" || key.includes("amount") || key.includes("Count") || key.includes("Runs")) {
        // 数字类型字段：转换字符串为数字
        const num = parseFloat(String(value));
        if (Number.isFinite(num)) {
          processedData[key] = num;
        } else {
          processedData[key] = 0; // 默认值
        }
      } else if (key.includes("Date") || key === "createdAt" || key === "updatedAt") {
        // 日期类型字段：转换字符串为Date
        const dateValue = new Date(String(value));
        if (!isNaN(dateValue.getTime())) {
          processedData[key] = dateValue;
        }
      } else if (value === "true" || value === "false") {
        // 布尔类型字段
        processedData[key] = value === "true";
      } else {
        // 其他字段保持原值
        processedData[key] = value;
      }
    }

    // 更新记录
    const updated = await model.update({
      where: { id },
      data: processedData,
    });

    return NextResponse.json({ ok: true, data: updated });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : "更新失败",
    }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const modelName = searchParams.get("model");
    const id = searchParams.get("id");

    if (!modelName || !id) {
      return NextResponse.json({ ok: false, error: "缺少 model 或 id 参数" }, { status: 400 });
    }

    const model = getPrismaModel(modelName);
    if (!model) {
      return NextResponse.json({ ok: false, error: `模型 ${modelName} 不存在` }, { status: 400 });
    }

    // 删除记录
    await model.delete({ where: { id } });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : "删除失败",
    }, { status: 500 });
  }
}