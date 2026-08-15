/**
 * 账单导入预览共用的账单元信息（statement meta）展示工具。
 *
 * 邮箱账单导入设置页（settings/email/page.tsx）与账单导入预览弹窗
 * （StatementImportPreviewDialog.tsx）曾各自复制一份相同实现，
 * 统一放在这里保证展示口径一致。
 */

export type StatementPreviewMeta = {
  statementAmount?: number | string | null;
  statementPeriodStart?: string | null;
  statementPeriodEnd?: string | null;
  statementDueDate?: string | null;
  statementCurrency?: string | null;
  creditLimit?: number | string | null;
};

export function statementMoneyNumber(value?: number | string | null): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

export function formatStatementMoneyAmount(value?: number | string | null): string {
  const amount = statementMoneyNumber(value);
  return amount === null ? "" : `¥${amount.toFixed(2)}`;
}

export function uniqueStatementInfoTexts(items: Array<{ _meta?: StatementPreviewMeta | null }>): string[] {
  const lines = items
    .map((item) => {
      const meta = item._meta;
      if (!meta) return "";
      const parts = [
        statementMoneyNumber(meta.statementAmount) !== null
          ? `账单金额 ${formatStatementMoneyAmount(meta.statementAmount)}`
          : "",
        meta.statementPeriodStart || meta.statementPeriodEnd
          ? `账期 ${meta.statementPeriodStart || "?"} ~ ${meta.statementPeriodEnd || "?"}`
          : "",
        meta.statementDueDate ? `还款日 ${meta.statementDueDate}` : "",
        meta.statementCurrency ? `币种 ${meta.statementCurrency}` : "",
        statementMoneyNumber(meta.creditLimit) !== null
          ? `总授信额度 ${formatStatementMoneyAmount(meta.creditLimit)}`
          : "",
      ].filter(Boolean);
      return parts.join(" · ");
    })
    .filter(Boolean);
  return Array.from(new Set(lines));
}
