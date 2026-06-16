import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type DefaultCategoryType = "expense" | "income";

export type DefaultCategoryTemplate = {
  type: DefaultCategoryType;
  name: string;
  children?: string[];
};

type CategoryWriter = typeof prisma | Prisma.TransactionClient;

export const defaultCategoryTemplates: DefaultCategoryTemplate[] = [
  {
    type: "expense",
    name: "餐饮饮食",
    children: ["早餐", "午餐", "晚餐", "外卖", "零食饮料", "买菜食材", "水果", "烟酒茶", "聚餐请客"],
  },
  {
    type: "expense",
    name: "生活日用",
    children: ["生活费", "日用品", "清洁用品", "家居用品", "维修维护", "快递物流", "物业杂费"],
  },
  {
    type: "expense",
    name: "交通出行",
    children: ["交通费", "公交地铁", "打车", "火车高铁", "机票", "长途客运", "停车费", "过路费", "加油", "充电", "保养维修", "车险车税"],
  },
  {
    type: "expense",
    name: "居住住房",
    children: ["房租", "房贷", "物业费", "水费", "电费", "燃气费", "供暖费", "宽带电视", "装修", "家具家电"],
  },
  {
    type: "expense",
    name: "购物消费",
    children: ["服饰鞋包", "数码电器", "美妆护肤", "母婴用品", "运动户外", "书籍文具", "礼品", "网购"],
  },
  {
    type: "expense",
    name: "医疗健康",
    children: ["挂号门诊", "药品", "体检", "住院", "牙科", "眼科", "保健品", "健身运动"],
  },
  {
    type: "expense",
    name: "教育成长",
    children: ["学费", "培训课程", "考试认证", "书本资料", "文具", "兴趣班", "在线课程"],
  },
  {
    type: "expense",
    name: "子女育儿",
    children: ["奶粉尿裤", "玩具", "童装", "托育幼儿园", "课外班", "儿童医疗", "儿童保险"],
  },
  {
    type: "expense",
    name: "人情社交",
    children: ["人情开支", "红包", "礼金", "请客", "节日礼物", "婚丧嫁娶", "探望慰问"],
  },
  {
    type: "expense",
    name: "通讯网络",
    children: ["手机话费", "流量套餐", "宽带", "软件会员", "云服务"],
  },
  {
    type: "expense",
    name: "娱乐休闲",
    children: ["电影演出", "旅游", "游戏", "会员订阅", "宠物", "摄影", "棋牌", "酒吧咖啡"],
  },
  {
    type: "expense",
    name: "金融保险",
    children: ["保险", "手续费", "利息支出", "贷款还款", "信用卡费用", "投资亏损"],
  },
  {
    type: "expense",
    name: "赡养公益",
    children: ["赡养老人", "家庭补贴", "公益捐赠", "宗教香火"],
  },
  {
    type: "expense",
    name: "工作经营",
    children: ["办公用品", "差旅", "业务招待", "经营成本", "税费", "设备工具"],
  },
  {
    type: "expense",
    name: "其他支出",
    children: ["临时支出", "未分类支出"],
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
    children: ["红包礼金", "家人转入", "朋友转入", "报销", "退款返现", "借款收回"],
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

    for (const childName of category.children ?? []) {
      await writer.category.create({
        data: {
          type: category.type,
          name: childName,
          parentId: parent.id,
          householdId,
        },
      });
    }
  }
}
