"use client";

import { MultiSelectFilterDropdown } from "@/components/MultiSelectFilterDropdown";
import {
  ENTRY_CATEGORY_LABEL_KEYS,
  ENTRY_CATEGORY_VALUES,
  normalizeEntryCategories,
  type EntryCategory,
} from "@/lib/entry-categories";
import { useI18n } from "@/lib/i18n";

/**
 * 明细表的「交易类型」多选下拉：收支 / 转账 / 收益 / 其他。
 *
 * 默认由调用方给 `DEFAULT_ENTRY_CATEGORIES`（全部分类，含收益）——收益行会改变余额，
 * 藏起来余额列就对不上账；嫌吵的用户自己取消勾选。
 *
 * 交互照表头字段筛选（`TableColumnFilter`）：复选框多选，点选项文字＝只选这一类
 * 并收起面板；面板右上角「全部交易」在「全选↔全不选」之间切换（与 Excel 筛选一致）。
 * 全不选即「一条都不显示」，触发器此时显示「0 类交易」，不是静默回到全部。
 *
 * 宽度贴合文字：触发器不再占 `min-w-40`，面板按最长选项文字收缩（`panelWidth="auto"`）。
 *
 * 根节点是 `inline-flex`：它常被塞进工具栏的一行里（AdvancedDataTable 的
 * toolbarRightContent 外层是普通 div），用块级 div 会把后面的「共 N 条 / 导入导出」
 * 挤到下一行（2026-11-19 用户反馈「交易类型跟其他组件不在一行」）。
 * 高度默认 `h-7`，与 DateRangeSliderFilter、列设置等工具栏小按钮同高。
 */
export function EntryCategoryFilter({
  value,
  onChange,
  className = "",
  triggerHeightClass = "h-7",
}: {
  value: readonly string[];
  onChange: (next: EntryCategory[]) => void;
  className?: string;
  triggerHeightClass?: string;
}) {
  const { t } = useI18n();
  return (
    <div className={`inline-flex shrink-0 items-center ${className}`.trim()}>
      <MultiSelectFilterDropdown
        options={[...ENTRY_CATEGORY_VALUES]}
        selectedValues={[...value]}
        onChange={(next) => onChange(normalizeEntryCategories(next))}
        labelFor={(key) => t(ENTRY_CATEGORY_LABEL_KEYS[key as EntryCategory])}
        allLabel={t("entryCategory.all")}
        clearLabel={t("entryCategory.all")}
        headerTitle={t("entryCategory.headerTitle")}
        selectedSummaryLabel={(_first, count) => t("entryCategory.selectedCount", { count: String(count) })}
        zeroSelectionLabel={t("entryCategory.selectedCount", { count: "0" })}
        panelWidth="auto"
        triggerAutoWidth
        labelClickSelectsSingle
        headerToggleAll
        showAllLabelWhenFull
        triggerHeightClass={triggerHeightClass}
      />
    </div>
  );
}
