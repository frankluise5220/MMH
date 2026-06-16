import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type DefaultInstitutionType = "bank" | "brokerage" | "payment" | "ewallet" | "other";

export type DefaultInstitutionTemplate = {
  name: string;
  type: DefaultInstitutionType;
};

type InstitutionWriter = typeof prisma | Prisma.TransactionClient;

export const defaultInstitutionTemplates: DefaultInstitutionTemplate[] = [
  { name: "支付宝", type: "payment" },
  { name: "微信支付", type: "payment" },
  { name: "云闪付", type: "payment" },
  { name: "京东金融", type: "payment" },
  { name: "美团金融", type: "payment" },
  { name: "抖音支付", type: "payment" },
  { name: "工商银行", type: "bank" },
  { name: "农业银行", type: "bank" },
  { name: "中国银行", type: "bank" },
  { name: "建设银行", type: "bank" },
  { name: "交通银行", type: "bank" },
  { name: "招商银行", type: "bank" },
  { name: "邮储银行", type: "bank" },
  { name: "中信银行", type: "bank" },
  { name: "光大银行", type: "bank" },
  { name: "华夏银行", type: "bank" },
  { name: "民生银行", type: "bank" },
  { name: "浦发银行", type: "bank" },
  { name: "兴业银行", type: "bank" },
  { name: "广发银行", type: "bank" },
  { name: "平安银行", type: "bank" },
  { name: "北京银行", type: "bank" },
  { name: "上海银行", type: "bank" },
  { name: "农商银行", type: "bank" },
  { name: "证券账户", type: "brokerage" },
  { name: "现金钱包", type: "ewallet" },
];

export async function createDefaultInstitutionsForHousehold(writer: InstitutionWriter, householdId: string) {
  for (const institution of defaultInstitutionTemplates) {
    await writer.institution.create({
      data: {
        name: institution.name,
        type: institution.type,
        householdId,
      },
    });
  }
}
