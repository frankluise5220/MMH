import type { BatchReplaceOption } from "@/components/BatchReplacePopoverButton";

/**
 * 批量修改里的账户下拉必须和表单里的账户下拉同源：走 SmartSelect 才能带副标题、
 * 悬浮全名和「设置 → 显示 → 账户下拉分组」的分组，也才有搜索框；原生 select
 * 只能显示被面板宽度截断的 label（2026-11-26 用户报障）。
 */
export const BATCH_ACCOUNT_SELECT_BEHAVIOR = {
  search: true,
  hierarchy: true,
  clearable: true,
  // 面板按字段自动分两列；账户标签是「机构·账户 所有者 · 种类」，480 才不至于把账户名截断。
  minDropdownWidth: 480,
  fitContent: true,
  dropdownMaxHeight: 240,
  density: "micro",
  resizableDropdown: true,
} as const;

/**
 * 标签下拉同理：标签一多，原生 select 里找不到目标，也要搜索框与色点。
 */
export const BATCH_TAG_SELECT_BEHAVIOR = {
  search: true,
  hierarchy: false,
  minDropdownWidth: 240,
  fitContent: true,
  dropdownMaxHeight: 240,
  density: "micro",
} as const;

/**
 * 把账户下拉选项（优先用带分组/副标题的 SS 选项）收窄到 `allowedIds`，并补回仍被引用的
 * 分组表头；SS 选项缺失时退回扁平账户列表，保证只传 `cashAccounts` 的旧调用也能用。
 */
export function toBatchAccountOptions(
  source: ReadonlyArray<any> | null | undefined,
  fallback: ReadonlyArray<any>,
  allowedIds: Set<string>,
): BatchReplaceOption[] {
  const narrow = (list: ReadonlyArray<any>) =>
    list.filter((option: any) => option.isHeader || allowedIds.has(String(option.id)));
  let raw = narrow(source && source.length > 0 ? source : fallback);
  // SS 选项与调用方给的 id 集合万一不同源（不同口径过滤），退回扁平列表而不是给一个空下拉。
  if (!raw.some((option: any) => !option.isHeader)) raw = narrow(fallback);
  const usedParents = new Set(raw.map((option: any) => option.parentId).filter(Boolean));
  return raw
    .filter((option: any) => !option.isHeader || usedParents.has(String(option.id)))
    .map((option: any) => ({
      value: String(option.id),
      label: String(option.label ?? ""),
      subLabel: option.subLabel ?? undefined,
      title: option.title ?? option.hoverTitle ?? undefined,
      isHeader: option.isHeader === true || undefined,
      parentId: option.parentId ?? undefined,
      kind: option.kind ?? null,
      investProductType: option.investProductType ?? null,
      institutionId: option.institutionId ?? null,
      currency: option.currency ?? null,
    }));
}
