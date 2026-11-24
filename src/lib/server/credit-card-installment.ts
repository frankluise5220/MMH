import {
  CreditCardInstallmentSourceType,
  TransactionType,
  type Prisma,
} from "@prisma/client";

import {
  buildCreditCardInstallmentSchedule,
  creditInstallmentStatementMonthForDate,
  normalizeInstallmentPrincipalOverrides,
  parseInstallmentPrincipalSchedule,
  type CreditCardInstallmentRateType,
} from "@/lib/credit/installment";
import type { CreditCardBillingDayRule } from "@/lib/credit/billing";
import { formatDateUtc, toStatementMonth } from "@/lib/date-utils";
import { ensureInstallmentFeeExpenseCategory } from "@/lib/default-categories";
import { attachEntryTags } from "@/lib/server/entry-tags";

type InstallmentWriter = Prisma.TransactionClient;

type CreateCreditCardInstallmentInput = {
  householdId: string;
  account: { id: string; name: string };
  sourceType: CreditCardInstallmentSourceType;
  sourceEntryId?: string | null;
  sourceStatementMonth?: string | null;
  originalAmount: number;
  principal: number;
  totalRuns: number;
  rateType: CreditCardInstallmentRateType;
  rate: number;
  adjustmentDate: Date;
  adjustmentStatementMonth: string;
  billingDay: number;
  firstPaymentDate: Date;
  firstPaymentStatementMonth: string;
  billingDayTxPeriod?: string | null;
  category?: { id: string; name: string } | null;
  label: string;
  tagIds?: string[];
  /** 每期本金（用户逐期调整）；不传/空数组 = 等额分摊。合计必须等于 principal。 */
  principalOverrides?: readonly number[] | null;
};

/** 分期归属口径需要的账单日规则历史（按账户分组），两个入口共用。 */
async function loadBillingDayRulesByAccountIds(
  db: InstallmentWriter,
  accountIds: readonly string[],
) {
  const ids = Array.from(new Set(accountIds.filter(Boolean)));
  const byAccountId = new Map<string, CreditCardBillingDayRule[]>();
  if (ids.length === 0) return byAccountId;
  const rows = await db.creditCardBillingDay.findMany({
    where: { accountId: { in: ids } },
    select: { accountId: true, effectiveDate: true, billingDay: true },
    orderBy: [{ effectiveDate: "asc" }],
  });
  for (const row of rows) {
    const list = byAccountId.get(row.accountId) ?? [];
    list.push({ effectiveDate: row.effectiveDate, billingDay: row.billingDay });
    byAccountId.set(row.accountId, list);
  }
  return byAccountId;
}

export async function normalizeCreditCardInstallmentStatementMonths(
  tx: InstallmentWriter,
  input: {
    householdId: string;
    accountIds: string[];
    billingDay: number;
    billingDayTxPeriod?: string | null;
  },
) {
  const accountIds = Array.from(new Set(input.accountIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (accountIds.length === 0) return { updatedEntries: 0, updatedPlans: 0 };

  const plans = await tx.creditCardInstallmentPlan.findMany({
    where: {
      householdId: input.householdId,
      accountId: { in: accountIds },
      sourceType: CreditCardInstallmentSourceType.statement,
      status: "active",
    },
    select: {
      id: true,
      sourceStatementMonth: true,
      firstStatementMonth: true,
    },
  });
  if (plans.length === 0) return { updatedEntries: 0, updatedPlans: 0 };

  const planIds = plans.map((plan) => plan.id);
  const entries = await tx.txRecord.findMany({
    where: {
      householdId: input.householdId,
      accountId: { in: accountIds },
      deletedAt: null,
      source: "credit_card_installment",
      creditCardInstallmentPlanId: { in: planIds },
    },
    select: {
      id: true,
      accountId: true,
      date: true,
      statementMonth: true,
      creditCardInstallmentPlanId: true,
      installmentRole: true,
    },
  });

  // 归属口径与 materializeDueInstallmentPayments 共用
  // creditInstallmentStatementMonthForDate：按「该笔日期那一刻的账单日」回溯规则历史。
  const billingDayRulesByAccountId = await loadBillingDayRulesByAccountIds(tx, accountIds);

  let updatedEntries = 0;
  const sourceStatementMonthByPlanId = new Map<string, string>();
  const firstPaymentMonthByPlanId = new Map<string, string>();

  for (const entry of entries) {
    const expectedMonth = creditInstallmentStatementMonthForDate({
      date: entry.date,
      billingDayRules: entry.accountId ? billingDayRulesByAccountId.get(entry.accountId) : null,
      fallbackBillingDay: input.billingDay,
      billingDayTxPeriod: input.billingDayTxPeriod,
    });
    if (!expectedMonth) continue;
    if (entry.statementMonth !== expectedMonth) {
      await tx.txRecord.updateMany({
        where: {
          id: entry.id,
          householdId: input.householdId,
          deletedAt: null,
        },
        data: { statementMonth: expectedMonth },
      });
      updatedEntries += 1;
    }
    const planId = entry.creditCardInstallmentPlanId;
    if (!planId) continue;
    if (entry.installmentRole === "adjustment") {
      sourceStatementMonthByPlanId.set(planId, expectedMonth);
    }
    if (entry.installmentRole === "payment") {
      const current = firstPaymentMonthByPlanId.get(planId);
      if (!current || expectedMonth < current) {
        firstPaymentMonthByPlanId.set(planId, expectedMonth);
      }
    }
  }

  let updatedPlans = 0;
  for (const plan of plans) {
    const nextData: { sourceStatementMonth?: string; firstStatementMonth?: string } = {};
    const sourceMonth = sourceStatementMonthByPlanId.get(plan.id);
    if (sourceMonth && plan.sourceStatementMonth !== sourceMonth) {
      nextData.sourceStatementMonth = sourceMonth;
    }
    const firstPaymentMonth = firstPaymentMonthByPlanId.get(plan.id);
    if (firstPaymentMonth && plan.firstStatementMonth !== firstPaymentMonth) {
      nextData.firstStatementMonth = firstPaymentMonth;
    }
    if (Object.keys(nextData).length === 0) continue;
    await tx.creditCardInstallmentPlan.updateMany({
      where: { id: plan.id, householdId: input.householdId },
      data: nextData,
    });
    updatedPlans += 1;
  }

  return { updatedEntries, updatedPlans };
}

export async function createCreditCardInstallmentPlan(
  tx: InstallmentWriter,
  input: CreateCreditCardInstallmentInput,
) {
  if (input.sourceType === CreditCardInstallmentSourceType.transaction && !input.sourceEntryId) {
    throw new Error("消费分期缺少原消费记录");
  }
  if (input.sourceType === CreditCardInstallmentSourceType.statement && !input.sourceStatementMonth) {
    throw new Error("账单分期缺少来源账单月份");
  }
  if (!Number.isFinite(input.originalAmount) || input.originalAmount <= 0) {
    throw new Error("原金额必须大于 0");
  }
  if (!Number.isFinite(input.principal) || input.principal <= 0) {
    throw new Error("分期金额必须大于 0");
  }

  // 每期本金拆分：先规范化（期数一致、逐期非负、合计 == 分期金额），
  // 再交给排期函数；只有真正自定义过（长度对得上）才落库，等额分摊存 null。
  const principalOverrides = normalizeInstallmentPrincipalOverrides({
    overrides: input.principalOverrides,
    principal: input.principal,
    totalRuns: input.totalRuns,
  });
  const schedule = buildCreditCardInstallmentSchedule({
    principal: input.principal,
    totalRuns: input.totalRuns,
    rateType: input.rateType,
    rate: input.rate,
    billingDay: input.billingDay,
    firstDate: input.firstPaymentDate,
    principalOverrides,
  });
  const installmentDateLabel = formatDateUtc(input.adjustmentDate);
  const installmentKindLabel = input.sourceType === CreditCardInstallmentSourceType.statement ? "账单" : "消费";
  const installmentAmountLabel = input.principal.toFixed(2);
  const plan = await tx.creditCardInstallmentPlan.create({
    data: {
      householdId: input.householdId,
      accountId: input.account.id,
      sourceType: input.sourceType,
      sourceEntryId: input.sourceEntryId ?? null,
      sourceStatementMonth: input.sourceStatementMonth ?? null,
      originalAmount: input.originalAmount,
      installmentPrincipal: input.principal,
      totalRuns: input.totalRuns,
      rateType: input.rateType,
      rate: input.rate,
      firstStatementMonth: input.firstPaymentStatementMonth,
      // Schedule rebuild inputs: future payment rows are materialized when due
      // (materializeDueInstallmentPayments) instead of being pre-generated.
      billingDay: input.billingDay,
      firstPaymentDate: input.firstPaymentDate,
      principalScheduleJson: principalOverrides ? JSON.stringify(principalOverrides) : null,
      tagIds: input.tagIds?.length ? JSON.stringify(input.tagIds) : null,
      categoryId: input.category?.id ?? null,
      categoryName: input.category?.name ?? null,
    },
  });

  const adjustmentEntry = await tx.txRecord.create({
    data: {
      householdId: input.householdId,
      accountId: input.account.id,
      accountName: input.account.name,
      categoryId: input.category?.id ?? null,
      categoryName: input.category?.name ?? null,
      amount: input.principal,
      type: TransactionType.expense,
      date: input.adjustmentDate,
      postedAt: input.adjustmentDate,
      statementMonth: input.adjustmentStatementMonth,
      source: "credit_card_installment",
      creditCardInstallmentPlanId: plan.id,
      installmentTotal: input.totalRuns,
      installmentPrincipal: input.principal,
      installmentInterest: 0,
      installmentRole: "adjustment",
      note: `${installmentKindLabel}分期冲抵：${input.label}（分期金额 ${installmentAmountLabel}，分期日期 ${installmentDateLabel}）`,
    },
  });
  if (input.tagIds?.length) {
    await attachEntryTags({
      tx,
      entryId: adjustmentEntry.id,
      householdId: input.householdId,
      tagIds: input.tagIds,
    });
  }

  // Payment rows are NOT pre-generated here. Each installment payment/fee is
  // materialized by materializeDueInstallmentPayments when its date arrives,
  // so future-dated records never appear in ordinary record lists.
  return { plan, schedule };
}

type InstallmentPaymentRow = {
  installmentNo: number;
  date: Date;
  statementMonth: string;
  principal: number;
  interest: number;
};

/**
 * 计划上的每期本金排期：坏数据（期数对不上、合计漂移）一律退回等额分摊，
 * 不让一条脏计划把整批落库（runDueSystemTasks 里同批其它计划）带崩。
 */
function safeInstallmentPrincipalOverrides(
  raw: string | null,
  principal: number,
  totalRuns: number,
): number[] | null {
  const parsed = parseInstallmentPrincipalSchedule(raw);
  if (!parsed) return null;
  try {
    return normalizeInstallmentPrincipalOverrides({ overrides: parsed, principal, totalRuns });
  } catch {
    return null;
  }
}

function parsePlanTagIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Materialize due credit-card installment payment rows.
 *
 * Payment rows are created lazily: for each active plan, rebuild the schedule
 * from the stored billing day / first payment date and create the principal
 * (and fee) rows whose date is on or before `asOfDate` and whose installment
 * number is past the plan's watermark (`materializedThroughNo`). The watermark
 * — not the presence of the row — is what decides whether a period still needs
 * materializing, so a period the user deleted (soft or permanently removed
 * from the recycle bin) is never recreated.
 * Legacy plans without stored billingDay/firstPaymentDate fall back to the
 * account billing day and the first statement month + billing day.
 *
 * Fee (interest/handling-fee) rows always use the system category 分期手续费
 * (expense → 金融保险), independent of the plan's own category; existing fee
 * rows are converged to it as well.
 */
export async function materializeDueInstallmentPayments(
  db: InstallmentWriter,
  input: { householdId: string; accountIds?: string[]; asOfDate?: Date },
) {
  const asOf = input.asOfDate ?? new Date();
  // 银行分期的利息/手续费条目统一归到「分期手续费」（支出 → 金融保险 三级分类，
  // 系统分类不可删除）。解析失败时回退计划分类，不阻断本金行落地。
  const feeCategory = await ensureInstallmentFeeExpenseCategory(db, input.householdId).catch(() => null);
  if (feeCategory) {
    // 历史回填：此前生成的利息/手续费行挂在计划分类（银行分期/表单分类）下，
    // 统一收敛到「分期手续费」。updateMany 幂等，收敛后再次调用匹配 0 行。
    await db.txRecord.updateMany({
      where: {
        householdId: input.householdId,
        source: "credit_card_installment",
        installmentRole: "fee",
        deletedAt: null,
        OR: [{ categoryId: null }, { categoryId: { not: feeCategory.id } }, { categoryName: { not: feeCategory.name } }],
      },
      data: { categoryId: feeCategory.id, categoryName: feeCategory.name },
    });
  }
  const plans = await db.creditCardInstallmentPlan.findMany({
    where: {
      householdId: input.householdId,
      status: "active",
      ...(input.accountIds && input.accountIds.length > 0
        ? { accountId: { in: Array.from(new Set(input.accountIds)) } }
        : {}),
    },
    select: {
      id: true,
      accountId: true,
      sourceType: true,
      installmentPrincipal: true,
      totalRuns: true,
      rateType: true,
      rate: true,
      billingDay: true,
      firstPaymentDate: true,
      firstStatementMonth: true,
      materializedThroughNo: true,
      principalScheduleJson: true,
      tagIds: true,
      categoryId: true,
      categoryName: true,
      Account: { select: { name: true, billingDay: true, billingDayTxPeriod: true } },
    },
  });
  if (plans.length === 0) return { materialized: 0 };

  // 归属口径与 normalizeCreditCardInstallmentStatementMonths 共用同一个纯函数。
  const billingDayRulesByAccountId = await loadBillingDayRulesByAccountIds(
    db,
    plans.map((plan) => plan.accountId),
  );

  let materialized = 0;
  for (const plan of plans) {
    // 水位：这条计划已经落库到第几期。期供行允许用户单期删除，甚至从回收站彻底删除，
    // 一旦判重依赖「那一行还在不在」，被硬删的期就会被当成缺失重新补出来（删了又出现）。
    // 所以落库范围由计划自己推进：只落 installmentNo > 水位的期。
    const watermark = plan.materializedThroughNo ?? 0;
    const billingDay = plan.billingDay ?? plan.Account?.billingDay ?? 1;
    const firstDate =
      plan.firstPaymentDate ??
      new Date(`${plan.firstStatementMonth}-${String(billingDay).padStart(2, "0")}T00:00:00`);
    const schedule = buildCreditCardInstallmentSchedule({
      principal: Number(plan.installmentPrincipal),
      totalRuns: plan.totalRuns,
      rateType: plan.rateType,
      rate: Number(plan.rate),
      billingDay,
      firstDate,
      // 用户逐期调整过本金时按计划里存的排期落库，否则等额分摊。
      principalOverrides: safeInstallmentPrincipalOverrides(
        plan.principalScheduleJson,
        Number(plan.installmentPrincipal),
        plan.totalRuns,
      ),
    });
    const dueRows: InstallmentPaymentRow[] = schedule
      .filter((row) => row.installmentNo > watermark && row.date.getTime() <= asOf.getTime())
      .map((row) => ({
        installmentNo: row.installmentNo,
        date: row.date,
        statementMonth: creditInstallmentStatementMonthForDate({
          date: row.date,
          billingDayRules: billingDayRulesByAccountId.get(plan.accountId) ?? null,
          fallbackBillingDay: plan.billingDay ?? plan.Account?.billingDay ?? null,
          billingDayTxPeriod: plan.Account?.billingDayTxPeriod,
        }) ?? toStatementMonth(row.date, billingDay, plan.Account?.billingDayTxPeriod),
        principal: row.principal,
        interest: row.interest,
      }));
    if (dueRows.length === 0) continue;

    // 兜底判重（水位是主闸门）：升级前落库的行、执行中途失败后重跑时的重复检查。
    // 这里故意**不滤 deletedAt**：期供行允许用户单期删除，已软删的行也算「生成过」。
    const existing = await db.txRecord.findMany({
      where: {
        creditCardInstallmentPlanId: plan.id,
        installmentRole: { in: ["payment", "fee"] },
      },
      select: { installmentNo: true, installmentRole: true },
    });
    const existingPaymentNos = new Set(
      existing.filter((entry) => entry.installmentRole === "payment").map((entry) => entry.installmentNo),
    );
    const existingFeeNos = new Set(
      existing.filter((entry) => entry.installmentRole === "fee").map((entry) => entry.installmentNo),
    );

    const tagIds = parsePlanTagIds(plan.tagIds);
    let nextWatermark = watermark;
    for (const row of dueRows) {
      // 水位先推进：即便这一期两行都已存在（升级前落库 / 上一轮建完后中断），
      // 也算「这一期执行过了」，下次不再纳入范围。
      nextWatermark = Math.max(nextWatermark, row.installmentNo);
      // 本金行与手续费行各自判重：用户可能只删掉其中一条（明细里两行分开显示），
      // 被删掉的那条不再补，另一条照旧，不会整期一起复活。
      const needPrincipal = !existingPaymentNos.has(row.installmentNo);
      const needFee = row.interest > 0 && !existingFeeNos.has(row.installmentNo);
      if (!needPrincipal && !needFee) continue;
      const label = plan.sourceType === CreditCardInstallmentSourceType.statement
        ? `${plan.firstStatementMonth} 账单`
        : "消费分期";
      const installmentKindLabel = plan.sourceType === CreditCardInstallmentSourceType.statement ? "账单" : "消费";
      const installmentDateLabel = formatDateUtc(row.date);
      const installmentAmountLabel = Number(plan.installmentPrincipal).toFixed(2);

      if (needPrincipal) {
        const principalEntry = await db.txRecord.create({
          data: {
            householdId: input.householdId,
            accountId: plan.accountId,
            accountName: plan.Account?.name ?? "",
            categoryId: plan.categoryId ?? null,
            categoryName: plan.categoryName ?? null,
            amount: -row.principal,
            type: TransactionType.expense,
            date: row.date,
            postedAt: row.date,
            statementMonth: row.statementMonth,
            source: "credit_card_installment",
            creditCardInstallmentPlanId: plan.id,
            installmentNo: row.installmentNo,
            installmentTotal: plan.totalRuns,
            installmentPrincipal: row.principal,
            installmentInterest: 0,
            installmentRole: "payment",
            note: `${label}（${installmentKindLabel}分期本金 ${row.installmentNo}/${plan.totalRuns}，分期金额 ${installmentAmountLabel}，分期日期 ${installmentDateLabel}）`,
          },
        });
        if (tagIds.length) {
          await attachEntryTags({ tx: db, entryId: principalEntry.id, householdId: input.householdId, tagIds });
        }
        materialized += 1;
        existingPaymentNos.add(row.installmentNo);
      }

      if (needFee) {
        const feeEntry = await db.txRecord.create({
          data: {
            householdId: input.householdId,
            accountId: plan.accountId,
            accountName: plan.Account?.name ?? "",
            categoryId: feeCategory?.id ?? plan.categoryId ?? null,
            categoryName: feeCategory?.name ?? plan.categoryName ?? null,
            amount: -row.interest,
            type: TransactionType.expense,
            date: row.date,
            postedAt: row.date,
            statementMonth: row.statementMonth,
            source: "credit_card_installment",
            creditCardInstallmentPlanId: plan.id,
            installmentNo: row.installmentNo,
            installmentTotal: plan.totalRuns,
            installmentPrincipal: 0,
            installmentInterest: row.interest,
            installmentRole: "fee",
            note: `${label}（${installmentKindLabel}分期${plan.rateType === "annual_interest" ? "利息" : "手续费"} ${row.installmentNo}/${plan.totalRuns}，分期金额 ${installmentAmountLabel}，分期日期 ${installmentDateLabel}）`,
          },
        });
        if (tagIds.length) {
          await attachEntryTags({ tx: db, entryId: feeEntry.id, householdId: input.householdId, tagIds });
        }
        materialized += 1;
        existingFeeNos.add(row.installmentNo);
      }
    }

    if (nextWatermark > watermark) {
      // 水位只前进不后退（lt 条件兜住并发/重入），写到最大已执行期号。
      await db.creditCardInstallmentPlan.updateMany({
        where: { id: plan.id, householdId: input.householdId, materializedThroughNo: { lt: nextWatermark } },
        data: { materializedThroughNo: nextWatermark },
      });
    }
  }

  return { materialized };
}
