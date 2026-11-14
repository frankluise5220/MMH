/**
 * 机构名称的唯一格式化入口（2026-11-14 用户裁定）。
 *
 * 口径：**只有「账户」语境使用机构简称**（账户标签、账户下拉、账户列表、
 * 由账户名派生的文本），机构作为独立主体出现时一律用全称。
 *
 * - `institutionFullName`：机构列 / 机构筛选 / 机构下拉 / 机构分组标题 /
 *   机构维度统计 / 导出机构列 / 产品与持仓的机构信息。
 * - `institutionShortName`：机构名只是账户标签的一个组成字段时。
 *
 * 两者都做「缺一个回落另一个」，所以没有简称的机构不会渲染成空白。
 */
export type InstitutionNameSource =
  | { name?: string | null; shortName?: string | null }
  | null
  | undefined;

/** 全称优先，缺全称回落简称。机构独立展示用。 */
export function institutionFullName(institution: InstitutionNameSource): string {
  const full = institution?.name?.trim() ?? "";
  if (full) return full;
  return institution?.shortName?.trim() ?? "";
}

/** 简称优先，缺简称回落全称。机构名作为账户标签的一部分时用。 */
export function institutionShortName(institution: InstitutionNameSource): string {
  const short = institution?.shortName?.trim() ?? "";
  if (short) return short;
  return institution?.name?.trim() ?? "";
}
