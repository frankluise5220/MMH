import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type DefaultCategoryType = "expense" | "income";
type CategoryMainType = DefaultCategoryType | "investment";

export type DefaultCategoryTemplate = {
  type: DefaultCategoryType;
  name: string;
  children?: Array<string | DefaultCategoryTemplateChild>;
};

type CategoryWriter = typeof prisma | Prisma.TransactionClient;

type DefaultCategoryTemplateChild = {
  name: string;
  children?: string[];
};

const rootCategoryRenames = [
  { type: "expense", from: "餐饮饮食", to: "餐饮费" },
  { type: "expense", from: "生活日用", to: "生活费" },
  { type: "expense", from: "交通出行", to: "交通费" },
  { type: "expense", from: "购物消费", to: "服饰装饰" },
  { type: "expense", from: "人情社交", to: "人情往来" },
] as const;

const sameNameChildFallback: Record<string, string> = {
  餐饮费: "其他餐饮",
  生活费: "其他生活",
  交通费: "其他交通",
  服饰装饰: "其他服饰",
  人情往来: "其他人情",
};

const categoryTypeLabels: Record<CategoryMainType, string> = {
  expense: "支出",
  income: "收入",
  investment: "投资",
};

const categoryTypeFallbackNames: Record<CategoryMainType, string> = {
  expense: "其他支出",
  income: "其他收入",
  investment: "投资记录",
};

export const defaultCategoryTemplates: DefaultCategoryTemplate[] = [
  {
    type: "expense",
    name: "餐饮费",
    children: ["餐饮美食", "早餐", "午餐", "晚餐", "外卖", "零食饮料", "买菜食材", "水果", "烟酒茶", "聚餐请客"],
  },
  {
    type: "expense",
    name: "生活费",
    children: ["日用百货", "日用品", "清洁用品", "家居用品", "维修维护", "快递物流", "物业杂费", "生活服务"],
  },
  {
    type: "expense",
    name: "交通费",
    children: ["交通出行", "公交地铁", "打车", "火车高铁", "机票", "长途客运", "停车费", "过路费", "加油", "充电", "爱车养车", "保养维修", "车险车税"],
  },
  {
    type: "expense",
    name: "居住住房",
    children: ["住房物业", "房租", "房贷", "物业费", "水费", "电费", "燃气费", "供暖费", "宽带电视", "家居家装", "装修", "家具家电"],
  },
  {
    type: "expense",
    name: "服饰装饰",
    children: ["服饰装扮", "服饰鞋包", "美妆护肤", "饰品配件", "美容美发", "洗护美发", "家居装饰"],
  },
  {
    type: "expense",
    name: "数码家电",
    children: ["数码电器", "手机电脑", "数码配件", "家用电器", "维修配件"],
  },
  {
    type: "expense",
    name: "医疗健康",
    children: ["挂号门诊", "药品", "体检", "住院", "牙科", "眼科", "保健品", "健身运动"],
  },
  {
    type: "expense",
    name: "教育成长",
    children: ["教育培训", "学费", "培训课程", "考试认证", "书本资料", "文具", "兴趣班", "在线课程"],
  },
  {
    type: "expense",
    name: "子女育儿",
    children: ["母婴亲子", "奶粉尿裤", "玩具", "童装", "托育幼儿园", "课外班", "儿童医疗", "儿童保险"],
  },
  {
    type: "expense",
    name: "人情往来",
    children: ["亲友代付", "人情开支", "红包", "礼金", "请客", "节日礼物", "婚丧嫁娶", "探望慰问"],
  },
  {
    type: "expense",
    name: "通讯网络",
    children: ["充值缴费", "手机话费", "流量套餐", "宽带", "软件会员", "云服务"],
  },
  {
    type: "expense",
    name: "娱乐休闲",
    children: ["文化休闲", "电影演出", "酒店旅游", "旅游", "游戏", "会员订阅", "宠物", "摄影", "棋牌", "酒吧咖啡", "运动户外"],
  },
  {
    type: "expense",
    name: "金融保险",
    children: ["保险", "互助保障", "信用借还", "账户存取", "手续费", "利息支出", "贷款还款", "信用卡费用", "投资亏损"],
  },
  {
    type: "expense",
    name: "赡养公益",
    children: ["赡养老人", "家庭补贴", "公益捐赠", "宗教香火"],
  },
  {
    type: "expense",
    name: "工作经营",
    children: ["商业服务", "办公用品", "差旅", "业务招待", "经营成本", "税费", "设备工具"],
  },
  {
    type: "expense",
    name: "其他支出",
    children: ["其他", "公共服务", "临时支出", "未分类支出"],
  },
  {
    type: "income",
    name: "工作收入",
    children: ["工资", "奖金", "津贴补贴", "加班费", "年终奖", "绩效", "兼职收入"],
  },
  {
    type: "income",
    name: "经营收入",
    children: ["营业收入", "服务收入", "佣金提成", "项目收入", "副业收入"],
  },
  {
    type: "income",
    name: "投资收入",
    children: ["投资收益", "利息", "股息分红", "基金收益", "股票收益", "理财收益", "租金收入"],
  },
  {
    type: "income",
    name: "家庭往来",
    children: ["红包礼金", "家人转入", "朋友转入", "报销", "退款", "退款返现", "借款收回"],
  },
  {
    type: "income",
    name: "福利补助",
    children: ["社保补贴", "公积金", "养老金", "失业金", "生育津贴", "政府补助"],
  },
  {
    type: "income",
    name: "其他收入",
    children: ["意外收入", "未分类收入"],
  },
];

export async function createDefaultCategoriesForHousehold(writer: CategoryWriter, householdId: string) {
  for (const category of defaultCategoryTemplates) {
    const parent = await writer.category.create({
      data: {
        type: category.type,
        name: category.name,
        parentId: null,
        householdId,
      },
      select: { id: true },
    });

    for (const child of category.children ?? []) {
      const childName = typeof child === "string" ? child : child.name;
      const createdChild = await writer.category.create({
        data: {
          type: category.type,
          name: childName,
          parentId: parent.id,
          householdId,
        },
        select: { id: true },
      });

      if (typeof child !== "string") {
        for (const grandChildName of child.children ?? []) {
          await writer.category.create({
            data: {
              type: category.type,
              name: grandChildName,
              parentId: createdChild.id,
              householdId,
            },
          });
        }
      }
    }
  }
}

export async function normalizeDefaultCategoryHierarchyForHousehold(writer: CategoryWriter, householdId: string) {
  await normalizeCategoryTypeLabelNodes(writer, householdId);

  for (const item of rootCategoryRenames) {
    await renameRootCategory(writer, householdId, item.type, item.from, item.to);
  }

  await ensureDefaultCategoryTemplatesForHousehold(writer, householdId);

  for (const category of defaultCategoryTemplates) {
    await normalizeSameNameChild(writer, householdId, category.type, category.name);
  }
}

async function normalizeCategoryTypeLabelNodes(writer: CategoryWriter, householdId: string) {
  for (const type of Object.keys(categoryTypeLabels) as CategoryMainType[]) {
    await normalizeCategoryTypeLabelNode(writer, householdId, type);
  }
}

async function normalizeCategoryTypeLabelNode(
  writer: CategoryWriter,
  householdId: string,
  type: CategoryMainType,
) {
  const label = categoryTypeLabels[type];
  const nodes = await writer.category.findMany({
    where: { householdId, type, name: label },
    select: { id: true, parentId: true },
  });

  for (const node of nodes) {
    await removeCategoryTypeLabelNode(writer, householdId, type, node.id, node.parentId);
  }
}

async function removeCategoryTypeLabelNode(
  writer: CategoryWriter,
  householdId: string,
  type: CategoryMainType,
  categoryId: string,
  parentId: string | null,
) {
  const children = await writer.category.findMany({
    where: { householdId, parentId: categoryId },
    select: { id: true, name: true },
  });

  for (const child of children) {
    const target = await writer.category.findFirst({
      where: { householdId, type, parentId, name: child.name, NOT: { id: child.id } },
      select: { id: true },
    });

    if (target) {
      await mergeCategoryInto(writer, householdId, child.id, target.id, child.name);
    } else {
      await writer.category.update({ where: { id: child.id }, data: { parentId } });
    }
  }

  if (type === "investment" && parentId === null) {
    await writer.txRecord.updateMany({
      where: { householdId, categoryId },
      data: { categoryId: null, categoryName: null },
    });
  } else {
    const fallbackId = parentId ?? await ensureFallbackCategory(writer, householdId, type);
    const fallbackName = parentId
      ? (await writer.category.findUnique({ where: { id: parentId }, select: { name: true } }))?.name ?? categoryTypeFallbackNames[type]
      : categoryTypeFallbackNames[type];

    await writer.txRecord.updateMany({
      where: { householdId, categoryId },
      data: { categoryId: fallbackId, categoryName: fallbackName },
    });
  }

  await writer.category.deleteMany({ where: { id: categoryId } });
}

async function ensureFallbackCategory(
  writer: CategoryWriter,
  householdId: string,
  type: CategoryMainType,
) {
  const fallbackName = categoryTypeFallbackNames[type];
  let fallback = await writer.category.findFirst({
    where: { householdId, type, parentId: null, name: fallbackName },
    select: { id: true },
  });

  if (!fallback) {
    fallback = await writer.category.create({
      data: { householdId, type, parentId: null, name: fallbackName },
      select: { id: true },
    });
  }

  return fallback.id;
}

async function mergeCategoryInto(
  writer: CategoryWriter,
  householdId: string,
  sourceId: string,
  targetId: string,
  targetName: string,
) {
  await writer.category.updateMany({
    where: { householdId, parentId: sourceId },
    data: { parentId: targetId },
  });
  await writer.txRecord.updateMany({
    where: { householdId, categoryId: sourceId },
    data: { categoryId: targetId, categoryName: targetName },
  });
  await writer.category.deleteMany({ where: { id: sourceId } });
}

async function renameRootCategory(
  writer: CategoryWriter,
  householdId: string,
  type: DefaultCategoryType,
  from: string,
  to: string,
) {
  const legacy = await writer.category.findFirst({
    where: { householdId, type, parentId: null, name: from },
    select: { id: true },
  });
  if (!legacy) return;

  const target = await writer.category.findFirst({
    where: { householdId, type, parentId: null, name: to },
    select: { id: true },
  });

  if (!target) {
    await writer.category.update({ where: { id: legacy.id }, data: { name: to } });
    await writer.txRecord.updateMany({ where: { householdId, categoryId: legacy.id }, data: { categoryName: to } });
    return;
  }

  if (target.id === legacy.id) return;

  await writer.category.updateMany({
    where: { householdId, parentId: legacy.id },
    data: { parentId: target.id },
  });
  await writer.txRecord.updateMany({
    where: { householdId, categoryId: legacy.id },
    data: { categoryId: target.id, categoryName: to },
  });
  await writer.category.delete({ where: { id: legacy.id } });
}

async function ensureDefaultCategoryTemplatesForHousehold(writer: CategoryWriter, householdId: string) {
  for (const category of defaultCategoryTemplates) {
    let root = await writer.category.findFirst({
      where: { householdId, type: category.type, parentId: null, name: category.name },
      select: { id: true },
    });
    if (!root) {
      root = await writer.category.create({
        data: { type: category.type, name: category.name, parentId: null, householdId },
        select: { id: true },
      });
    }

    for (const child of category.children ?? []) {
      const childName = typeof child === "string" ? child : child.name;
      let childRecord = await writer.category.findFirst({
        where: { householdId, type: category.type, parentId: root.id, name: childName },
        select: { id: true },
      });
      if (!childRecord) {
        childRecord = await writer.category.create({
          data: { type: category.type, name: childName, parentId: root.id, householdId },
          select: { id: true },
        });
      }

      if (typeof child !== "string") {
        for (const grandChildName of child.children ?? []) {
          const exists = await writer.category.findFirst({
            where: { householdId, type: category.type, parentId: childRecord.id, name: grandChildName },
            select: { id: true },
          });
          if (!exists) {
            await writer.category.create({
              data: { type: category.type, name: grandChildName, parentId: childRecord.id, householdId },
            });
          }
        }
      }
    }
  }
}

async function normalizeSameNameChild(
  writer: CategoryWriter,
  householdId: string,
  type: DefaultCategoryType,
  rootName: string,
) {
  const root = await writer.category.findFirst({
    where: { householdId, type, parentId: null, name: rootName },
    select: { id: true },
  });
  if (!root) return;

  const duplicate = await writer.category.findFirst({
    where: { householdId, type, parentId: root.id, name: rootName },
    select: { id: true },
  });
  if (!duplicate) return;

  const [usedCount, childCount] = await Promise.all([
    writer.txRecord.count({ where: { householdId, categoryId: duplicate.id } }),
    writer.category.count({ where: { householdId, parentId: duplicate.id } }),
  ]);

  if (usedCount === 0 && childCount === 0) {
    await writer.category.delete({ where: { id: duplicate.id } });
    return;
  }

  const fallbackName = sameNameChildFallback[rootName] ?? `其他${rootName}`;
  const existingFallback = await writer.category.findFirst({
    where: { householdId, type, parentId: root.id, name: fallbackName },
    select: { id: true },
  });
  if (!existingFallback) {
    await writer.category.update({ where: { id: duplicate.id }, data: { name: fallbackName } });
    await writer.txRecord.updateMany({ where: { householdId, categoryId: duplicate.id }, data: { categoryName: fallbackName } });
  }
}
