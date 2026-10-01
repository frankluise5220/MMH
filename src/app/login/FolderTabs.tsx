"use client";

import type { ReactNode } from "react";

/**
 * 文件卡片式页签（folder / file-card tab）。
 *
 * 视觉语义：活动页签压在内容板上、与内容板连成一体；非活动页签是「叠在当前卡片后面」
 * 的一张更高的卡片，只露出顶部标签头，主体被内容板盖住。
 *
 * 从登录页抽出的可复用组件，供「登录方式页签」和「建账方式页签」共用。
 * 核心不变量（改样式前必读，均有几何/像素探针守护）：
 *
 *  1. 页签条 `inset-x-0`（不能 `inset-x-3`，否则整条右移 12px）；
 *  2. 页签条 `h-10` + `items-start`（顶对齐）：`h-10` 与容器 `pt-10` 配平避免 3px 白缝，
 *     `items-start` 才能「顶部固定、只增高」；
 *  3. 页签条**不能带 z-index**（position:absolute + 非 auto z-index 会新建层叠上下文，
 *     把活动页签的 z-30 困在条内，导致内容板 1px 上边框画在活动页签之上）；
 *  4. 活动页签 z-30（盖内容板顶边框、与内容板连体），非活动页签 z-10（低于内容板 z-20，
 *     往下延伸部分被内容板盖住、只露标签头）——绝不能把非活动页签 z 提到内容板之上，
 *     否则会盖住内容板里的表单标签；
 *  5. 活动页签外阴影只能「向上」（负 offset + 小 blur），否则向下溢出把内容板顶部压暗；
 *  6. 内容板圆角随活动页签位置切换（首→去左上圆角、末→去右上圆角），形成完整轮廓；
 *  7. 非活动页签排最右时右边缘缩进内容板右上倒角（`mr-3` = 圆角半径）。
 */

/** 页签条容器类名。 */
export const FOLDER_TAB_STRIP = "absolute inset-x-0 top-0 h-10 flex items-start gap-1.5";

/** 内容板基础类名（圆角由 folderTabPanelClass 按活动页签位置追加）。 */
export const FOLDER_TAB_PANEL =
  "relative z-20 rounded-xl border border-slate-300 bg-[#fbfaf7] p-4 shadow-[0_10px_24px_rgba(15,23,42,0.10)]";

type TabVariant = "stretch" | "min";

/**
 * 页签按钮类名。
 * @param active 是否活动页签
 * @param atEnd 是否排在最末（最右）——非活动页签在最右时右边缘缩进内容板倒角
 * @param variant "stretch" 平分整行宽（登录页签）；"min" 最小宽（建账页签）
 */
export function folderTabClass(active: boolean, atEnd: boolean, variant: TabVariant = "stretch") {
  const width = variant === "stretch" ? "flex-1 basis-0" : "min-w-[7.5rem]";
  if (active) {
    return `relative z-30 mt-0 ${width} whitespace-nowrap rounded-t-[10px] border border-b-0 border-slate-300 bg-[#fbfaf7] px-4 py-2 text-base font-semibold text-slate-800 shadow-[0_-2px_3px_rgba(15,23,42,0.06)]`;
  }
  return [
    `relative z-10 mt-1.5 ${width} whitespace-nowrap rounded-t-[10px] border border-slate-300 bg-slate-200 px-4 pt-2 pb-24 text-xs font-medium text-slate-500 shadow-[0_2px_4px_rgba(15,23,42,0.08)] hover:-translate-y-0.5 hover:bg-slate-100`,
    atEnd ? "mr-1.5" : "",
  ].filter(Boolean).join(" ");
}

/**
 * 内容板圆角类名：随活动页签是不是首/末位去掉对应上圆角。
 */
export function folderTabPanelClass(activeIndex: number, tabCount: number) {
  return [
    FOLDER_TAB_PANEL,
    activeIndex === 0 ? "rounded-tl-none" : "",
    tabCount > 1 && activeIndex === tabCount - 1 ? "rounded-tr-none" : "",
  ].filter(Boolean).join(" ");
}

export type FolderTabsItem = {
  id: string;
  label: ReactNode;
};

/**
 * 文件卡片式页签组件。
 *
 * 用法：
 *   <FolderTabs
 *     tabs={[{ id: "local", label: "本地账户" }, { id: "mmh", label: "MMH 用户" }]}
 *     activeId={loginMode}
 *     onChange={(id) => switchLoginMode(id)}
 *     variant="stretch"
 *     panelClassName="space-y-4"
 *   >
 *     ...内容板里的表单...
 *   </FolderTabs>
 *
 * 注意：`variant="stretch"` 时页签条需要占满宽度；页签条容器自带 `pt-10` 由调用方控制
 * 显示与否（重置/注册子态要收起页签条时，调用方自行判断，见登录页的 showReset 分支）。
 */
export function FolderTabs({
  tabs,
  activeId,
  onChange,
  variant = "stretch",
  stripClassName = "",
  panelClassName = "",
  renderTab,
  children,
}: {
  tabs: FolderTabsItem[];
  activeId: string;
  onChange: (id: string) => void;
  variant?: TabVariant;
  stripClassName?: string;
  panelClassName?: string;
  renderTab?: (tab: FolderTabsItem, active: boolean, atEnd: boolean) => ReactNode;
  children: ReactNode;
}) {
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === activeId));
  const lastIndex = tabs.length - 1;
  return (
    <div className="relative pt-10">
      <div className={`${FOLDER_TAB_STRIP} ${stripClassName}`.trim()}>
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          const atEnd = index === lastIndex;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={folderTabClass(active, atEnd, variant)}
            >
              {renderTab ? renderTab(tab, active, atEnd) : tab.label}
            </button>
          );
        })}
      </div>
      <div className={`${folderTabPanelClass(activeIndex, tabs.length)} ${panelClassName}`.trim()}>
        {children}
      </div>
    </div>
  );
}
