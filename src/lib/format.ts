/**
 * 公共格式化工具函数
 *
 * 显示层规则：所有金额格式化统一使用此模块，禁止在各页面/组件中重复定义。
 * 数据源单一性 → 格式化单一性
 *
 * 命名约定：
 * - 显示层类型用 Display 后缀（如 PositionDisplayRow）
 * - 显示层变量在易混淆场景用 display 前缀
 * - 编辑弹窗 props 用 current/initial 前缀标注来源（如 currentAmount）
 * - 编辑弹窗内 useState 不需要前缀（作用域已清晰）
 */

/** 格式化金额，带正负号，2位小数，中文数字格式（不含¥前缀） */
export function formatMoney(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  return `${sign}${abs.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 格式化金额，4位小数，中文数字格式（用于净值等精度要求高的场景） */
export function formatMoney4(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  return `${sign}${abs.toLocaleString("zh-CN", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

/** 格式化金额，带¥前缀，2位小数 */
export function formatMoneyYuan(amount: number): string {
  return `¥${formatMoney(amount)}`;
}

/** 格式化金额，接受 string | number 输入（Prisma Decimal 等），非有限数字返回 "-" */
export function formatMoneyLoose(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? formatMoney(n) : "-";
}