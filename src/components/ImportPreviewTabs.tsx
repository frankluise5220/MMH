"use client";

import { FOLDER_TAB_STRIP, FolderTabRuler, folderTabClass, folderTabNeighbors } from "@/app/login/FolderTabs";

/**
 * 一次导入里的多个预览页签（资金收支 / 基金买卖）。
 *
 * 同一张支付宝账单里既有普通流水，也有被记成「不计收支」的基金买卖：
 * 前者走流水导入，后者走基金买入 / 赎回导入。两者共用同一个预览窗口，
 * 由这条页签切换；页签条只有这一份实现，别再各自手抄。
 *
 * 样式用 FT 卡片页签（文件卡片式）：几何全部来自 `--ft-tab-*` 令牌与
 * `folderTabClass` / `.ft-card-tab-active`，与记账弹窗的页签同源，
 * 不再自己写一套圆角 + 底色。
 */

export type ImportPreviewTab = {
  key: string;
  label: string;
  count: number;
};

export function ImportPreviewTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: readonly ImportPreviewTab[];
  active: string | null;
  onChange: (key: string) => void;
}) {
  if (tabs.length < 2) return null;
  const order = tabs.map((tab) => tab.key);
  const rulerLabels = tabs.map((tab) => `${tab.label} ${tab.count}`);
  return (
    <div className={`${FOLDER_TAB_STRIP} shrink-0`}>
      <div className="flex items-start gap-1.5">
        {tabs.map((tab, index) => {
          const isActive = active === tab.key;
          // 空页签（比如这张账单里没有基金买卖）点进去就是一张空卡片，看起来像坏了；
          // 直接置灰，别让用户点到。
          const isDisabled = tab.count === 0 && !isActive;
          return (
            <button
              key={tab.key}
              type="button"
              disabled={isDisabled}
              onClick={() => { if (!isDisabled) onChange(tab.key); }}
              className={`${folderTabClass(
                isActive,
                index === tabs.length - 1,
                "stretch",
                index === 0,
                folderTabNeighbors(order, tab.key, active ?? ""),
              )}${isActive ? " ft-card-tab-active" : ""}${isDisabled ? " disabled:cursor-not-allowed disabled:opacity-60" : ""}`}
            >
              {/* 活动页签不能 overflow-hidden（下缘凹角画在按钮盒外），裁切交给内层 span。 */}
              <span className="relative block overflow-hidden text-ellipsis whitespace-nowrap">
                <FolderTabRuler labels={rulerLabels} />
                {tab.label}
                <span className="ml-1.5 text-xs font-normal tabular-nums text-slate-500">{tab.count}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
