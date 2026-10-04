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
 *  2. 页签条 `top-0 bottom-0` + `items-start`（顶对齐）：`top-0` 与容器 `pt-10` 配平避免
 *     3px 白缝，`bottom-0` 让条铺满容器高度、非活动页签才能 `self-stretch` 对齐内容板底部，
 *     `items-start` 才能让活动页签「顶部固定、不增高」；
 *  3. 页签条**不能带 z-index**（position:absolute + 非 auto z-index 会新建层叠上下文，
 *     把活动页签的 z-30 困在条内，导致内容板 1px 上边框画在活动页签之上）；
 *  4. 活动页签 z-30（盖内容板顶边框、与内容板连体），非活动页签 z-10（低于内容板 z-20，
 *     往下延伸部分被内容板盖住、只露标签头）——绝不能把非活动页签 z 提到内容板之上，
 *     否则会盖住内容板里的表单标签；
 *  5. 活动页签外阴影只能「向上」（负 offset + 小 blur），否则向下溢出把内容板顶部压暗；
 *  6. 内容板**四角恒为 12px 圆角**（`rounded-xl`），任何时候都不去圆角：活动页签无论排首位还是
 *     末位，都与内容板左右边缘留出 18px（见第 7 条），内容板两上角必然露在页签外侧——去掉任一
 *     上圆角都会露出一个直角台阶（与页签 8px 倒角并排，视觉上是「尖角」）；
 *  7. 活动页签左右**对称**：排首位时左缩进 18px（`ml-4.5`），排末位时右缩进 18px（`mr-4.5`），
 *     18px = 内容板倒角半径 12px + 页签凹角半径 6px——凹角外端正好落在内容板上圆角弧的起点
 *     （x = 内容板边缘 ∓ 12px），两条弧相切、接缝处不出现折角/断口。排在中间时不缩进，两侧
 *     凹角分别接到左右相邻页签的竖边；
 *  8. 非活动页签左右各缩进 6px（`mx-1.5`），不顶到内容板左右边缘；
 *  9. 非活动页签 `self-stretch`：拉伸到页签条（=容器）高度、底部恰好对齐内容板下缘、被
 *     内容板完全覆盖——不能固定 `pb-24` 往下延，否则内容板矮（如飞牛页签）时会超出下缘；
 * 10. 非活动页签必须 `flex items-start justify-center`：`self-stretch` 后 button 默认垂直
 *     居中内容，标签文字会被推到内容板后面（z-10 < z-20）而不可见——顶对齐才能露在卡片上方；
 * 11. stretch 变体必须带 `min-w-0`：flex 项默认 `min-width:auto`，活动页签字号大（text-base）
 *     且标签长时会被内容撑宽、挤窄其他页签（宽度随文字缩放）——`min-w-0` 才能严格等宽平分；
 *     `overflow-hidden` 兜底只加在**非活动页签**与活动页签的**内层 span** 上（活动页签自身
 *     不能 overflow-hidden，见第 12 条）；
 * 12. 活动页签下缘用**外扩凹角**（inverted fillet）接内容板上沿横线，不用 `rounded-b-*`：
 *     上缘是凸圆角（连接页签外缘），下缘的弧要把「页签竖边」向外侧接到「内容板上沿横线」，
 *     由 `ft-tab-fillet` 的 `::before`/`::after` 两个伪元素画出（CSS 见 globals.css，含几何推导）。
 *     两个坑（改前必读 globals.css 注释）：① 两层都得用**内联 SVG**，硬色标 `radial-gradient`
 *     的圆环边界 Chromium 不抗锯齿，弧线会变锯齿台阶；② **填充层必须补满 7px 高**，把凹角落地段
 *     的内容板上边框抹掉，否则「圆弧落在一段多余横线上」，接不上卡片的大倒角圆弧。
 *     因此活动页签**不能** `overflow:hidden`（会裁掉按钮盒外的伪元素）——超长标签的裁切
 *     改由内层 `<span class="overflow-hidden">` 承担。
 */

/** 页签条容器类名。 */
export const FOLDER_TAB_STRIP = "absolute inset-x-0 top-0 bottom-0 flex items-start gap-1.5";

/** 内容板基础类名（圆角由 folderTabPanelClass 按活动页签位置追加）。 */
export const FOLDER_TAB_PANEL =
  "relative z-20 rounded-xl border border-slate-300 bg-[#fbfaf7] p-4 shadow-[0_10px_24px_rgba(15,23,42,0.10)]";

type TabVariant = "stretch" | "min";

/**
 * 页签按钮类名。
 * @param active 是否活动页签
 * @param atEnd 是否排在最末（最右）
 * @param variant "stretch" 平分整行宽（当前所有调用点都用它）；"min" 最小宽——目前已无调用点，
 *                保留仅为兼容可能的「不填满」场景
 * @param atStart 是否排在首位。活动页签排首位时左缩进 18px（`ml-4.5`），与排末位时的 `mr-4.5`
 *                左右对称——凹角外端落在内容板上圆角弧起点，两条弧相切
 */
export function folderTabClass(active: boolean, atEnd: boolean, variant: TabVariant = "stretch", atStart = false) {
  const width = variant === "stretch" ? "flex-1 basis-0 min-w-0" : "min-w-[7.5rem]";
  if (active) {
    return [
      // 上缘保留凸圆角；下缘**不用** `rounded-b-*`——那会让竖边往内收、与内容板上沿接不上。
      // 改由 `ft-tab-fillet` 的两个伪元素画「外扩凹角」，把竖边向外侧接到内容板上沿横线
      // （几何与色值见 globals.css 的 .ft-tab-fillet 注释）。
      // 凹角必须画到按钮盒外，故这里**不能** overflow-hidden（超长标签改由内层 span 裁切）。
      `relative z-30 mt-0 ${width} rounded-t-[8px] border border-b-0 border-slate-300 bg-[#fbfaf7] px-4 py-2 text-base font-semibold text-slate-800 shadow-[0_-2px_3px_rgba(15,23,42,0.06)]`,
      "ft-tab-fillet",
      // 排首位/末位时的缩进 = 内容板倒角半径(12px) + 页签凹角半径(6px) = 18px。
      // 凹角外端正好落在内容板上圆角弧的起点上，两条弧相切、不会打架；
      // 若缩进小于此值，凹角会撞进内容板的圆角弧里，接缝处出现折角/断口。
      // 左右必须同时给，否则「左直线、右曲线」不对称（首位页签曾因此只画右凹角）。
      atStart ? "ml-4.5" : "",
      atEnd ? "mr-4.5" : "",
    ].filter(Boolean).join(" ");
  }
  return [
    `relative z-10 mt-1.5 self-stretch ${width} flex items-start justify-center overflow-hidden whitespace-nowrap rounded-[8px] border border-slate-300 bg-slate-200 mx-1.5 px-4 pt-2 text-xs font-medium text-slate-500 shadow-[0_2px_4px_rgba(15,23,42,0.08)] hover:-translate-y-0.5 hover:bg-slate-100`,
  ].join(" ");
}

/**
 * 内容板类名。四角恒为 12px 圆角，**不去任何圆角**。
 *
 * 活动页签左右都缩进 18px（见 folderTabClass 的 `ml-4.5`/`mr-4.5`），内容板两上角必然露在
 * 页签外侧；去掉任一上圆角都会露出一个直角台阶（与页签的 8px 倒角并排，视觉上是「尖角」）。
 * 保留 12px 圆角才能与页签凹角自然相切收口。
 */
export function folderTabPanelClass() {
  return FOLDER_TAB_PANEL;
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
              className={folderTabClass(active, atEnd, variant, index === 0)}
            >
              {/* 活动页签不能 overflow-hidden（下缘凹角要画到按钮盒外），
                  故把「裁切超长标签」的兜底挪到内层 span。 */}
              <span className="relative block overflow-hidden whitespace-nowrap">
                {renderTab ? renderTab(tab, active, atEnd) : tab.label}
              </span>
            </button>
          );
        })}
      </div>
      <div className={`${folderTabPanelClass()} ${panelClassName}`.trim()}>
        {children}
      </div>
    </div>
  );
}
