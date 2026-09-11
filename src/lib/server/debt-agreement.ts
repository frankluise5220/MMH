import { IntervalUnit } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { parseFlexibleDateToYmd } from "@/lib/date-utils";

type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export type DebtAgreementValues = {
  annualRate: number | null;
  termValue: number | null;
  dueDate: Date | null;
};

/**
 * 解析往来款「约定」三要素（表单里都是可选；空串 / 非法值一律当未填）。
 * 日期统一走 parseFlexibleDateToYmd，与全站口径一致。
 */
export function parseDebtAgreementInput(input: {
  annualRate?: unknown;
  termValue?: unknown;
  dueDate?: unknown;
}): DebtAgreementValues {
  const rateRaw = String(input.annualRate ?? "").trim();
  const rateNum = rateRaw === "" ? Number.NaN : Number(rateRaw);
  const annualRate = Number.isFinite(rateNum) && rateNum >= 0 ? rateNum : null;

  const termRaw = String(input.termValue ?? "").trim();
  const termNum = termRaw === "" ? Number.NaN : Number(termRaw);
  const termValue = Number.isFinite(termNum) && termNum > 0 ? Math.round(termNum) : null;

  const dueYmd = parseFlexibleDateToYmd(input.dueDate);
  const dueDate = dueYmd ? new Date(`${dueYmd}T00:00:00.000Z`) : null;

  return { annualRate, termValue, dueDate };
}

/**
 * 往来款「约定」按账户 1:1 upsert（`DebtAgreement.accountId @unique`）。
 * 用户定版：利率 / 期限 / 到期日是「这个往来对象这条关系」的属性，
 * 在**建立往来款账户**时提交，挂在账户上（不是某笔交易）。
 * 三要素全空 → 删除该账户的约定，不留空行。
 */
export async function upsertDebtAgreementForAccount(
  tx: Db,
  input: { householdId: string; accountId: string } & DebtAgreementValues,
) {
  const { householdId, accountId, annualRate, termValue, dueDate } = input;

  if (annualRate == null && termValue == null && dueDate == null) {
    await tx.debtAgreement.deleteMany({ where: { householdId, accountId } });
    return;
  }

  const data = {
    annualRate,
    termValue,
    termUnit: termValue != null ? IntervalUnit.month : null,
    dueDate,
  };
  await tx.debtAgreement.upsert({
    where: { accountId },
    create: { householdId, accountId, ...data },
    update: data,
  });
}
