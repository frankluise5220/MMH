import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { cookies } from "next/headers";

export async function GET() {
  const cookieStore = await cookies();
  const householdId = cookieStore.get("householdId")?.value;

  const activeHousehold = householdId
    ? await prisma.household.findUnique({ where: { id: householdId }, select: { id: true, name: true } })
    : null;

  const allHouseholds = await prisma.household.findMany({
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    ok: true,
    active: activeHousehold ?? allHouseholds[0] ?? null,
    households: allHouseholds,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();

  if (!name || name.length > 50) {
    return NextResponse.json({ ok: false, error: "账簿名称不合法（1-50字）" }, { status: 400 });
  }

  const household = await prisma.household.create({
    data: { name },
  });

  // 创建默认分类模板
  const defaultCategories = [
    { type: "expense", name: "餐饮", parentId: null },
    { type: "expense", name: "交通", parentId: null },
    { type: "expense", name: "购物", parentId: null },
    { type: "expense", name: "居住", parentId: null },
    { type: "expense", name: "医疗", parentId: null },
    { type: "expense", name: "教育", parentId: null },
    { type: "expense", name: "娱乐", parentId: null },
    { type: "expense", name: "通讯", parentId: null },
    { type: "expense", name: "其他支出", parentId: null },
    { type: "income", name: "工资", parentId: null },
    { type: "income", name: "奖金", parentId: null },
    { type: "income", name: "投资收益", parentId: null },
    { type: "income", name: "其他收入", parentId: null },
  ];
  for (const cat of defaultCategories) {
    await prisma.category.create({
      data: { ...cat, householdId: household.id },
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true, household });
}
