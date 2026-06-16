export type DefaultCategoryTemplate = {
  type: "expense" | "income";
  name: string;
  parentId: null;
};

export const defaultCategoryTemplates: DefaultCategoryTemplate[] = [
  { type: "expense", name: "生活费", parentId: null },
  { type: "expense", name: "餐饮", parentId: null },
  { type: "expense", name: "交通费", parentId: null },
  { type: "expense", name: "购物", parentId: null },
  { type: "expense", name: "居住", parentId: null },
  { type: "expense", name: "水电燃气", parentId: null },
  { type: "expense", name: "通讯", parentId: null },
  { type: "expense", name: "医疗", parentId: null },
  { type: "expense", name: "教育", parentId: null },
  { type: "expense", name: "娱乐", parentId: null },
  { type: "expense", name: "人情开支", parentId: null },
  { type: "expense", name: "保险", parentId: null },
  { type: "expense", name: "育儿", parentId: null },
  { type: "expense", name: "养老", parentId: null },
  { type: "expense", name: "其他支出", parentId: null },
  { type: "income", name: "工资", parentId: null },
  { type: "income", name: "奖金", parentId: null },
  { type: "income", name: "兼职收入", parentId: null },
  { type: "income", name: "投资收益", parentId: null },
  { type: "income", name: "报销", parentId: null },
  { type: "income", name: "红包礼金", parentId: null },
  { type: "income", name: "退款返现", parentId: null },
  { type: "income", name: "其他收入", parentId: null },
];
