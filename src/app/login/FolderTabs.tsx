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
 *  2. 页签条 `top-0 bottom-0` + `items-start`（顶对齐）：容器 `pt-10`（40px）决定内容板顶位置——
 *     **改页签高度时不要动它**，动了内容板会跟着上下移。页签靠 `mt` 从条顶往下收：
 *     活动页签 `mt-[7px]`（7px），高 = 1px 上边框 + `pt-1.5`(6px) + `pb-[3px]`(3px) + `text-base`
 *     行高 24px = 34px，页签底 = 7 + 34 = 41px = 内容板顶 40px + 1px，接缝恒 −1px。
 *     上下内边距**不对称**（6 / 3）是有意的：让标签跟着页签顶一起下移 3px，而不是随高度收缩
 *     上下各让 1.5px（用户明确要求「页签降 3px、活动页签的标签也降 3px」）。
 *     非活动页签 `mt-[13px]`（13px），比活动页签多 6px —— 保持「活动页签高出 6px」的层次；
 *     它 `self-stretch`、标签靠 `pt-[5px]` 在**露出区**内视觉居中（露出区 = 页签顶 → 内容板顶；
 *     中文字形墨迹微偏上，故 pt 略补 0.5px）；`mx-0.75`（左右各 3px）让相邻两个非活动页签间距 =
 *     3+3+gap(6px) = 12px。**紧邻活动页签的那一侧收到 1px**（见第 7 条），让「非活动 → 活动」的
 *     间距 = gap(6px) + 1px = 7px，与凹角方块宽度一致（页签顶下移时用 `pt` 反补，**不能**用
 *     `items-center`，见第 10 条）。
 *     只改上下内边距而不同步改 `mt`，页签底会离开内容板顶露出「白缝」。
 *     `bottom-0` 让条铺满容器高度、非活动页签才能 `self-stretch` 对齐内容板底部，
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
 *     凹角分别接到左右相邻页签的竖边 —— **前提是该侧间距正好等于凹角宽度 7px**：活动页签自身
 *     不带 margin，间距 = `gap`(6px) + 相邻非活动页签的该侧 margin，必须是 1px 而不是默认的
 *     3px（由 `folderTabClass` 的 `sideMargin` 按邻居是否活动自动切换）；放 3px 时间距 9px，
 *     多出的 2px 内容板上边框会露在凹角外，看着像「倒角旁边多一根短横线」；
 *  8. 非活动页签的**外侧边**（排在首位 / 末位，该侧就是内容板左右边缘）缩进 12px
 *     （`ml-3`/`mr-3`，= 内容板倒角半径），不压住内容板上角的圆弧；其余各边默认 3px
 *     （`ml-0.75`/`mr-0.75`），紧邻活动页签的一侧收到 1px（见第 7 条）；
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
 * 邻居页签是否活动。手写调用点（不用 <FolderTabs> 组件时）用 folderTabNeighbors 计算。
 */
export type FolderTabNeighbors = {
  /** 左邻页签是否为活动页签。 */
  prevActive?: boolean;
  /** 右邻页签是否为活动页签。 */
  nextActive?: boolean;
};

/**
 * 计算某个页签左右邻居的活动状态（供手写调用点传给 folderTabClass）。
 * @param order 页签 id 的**实际渲染顺序**
 */
export function folderTabNeighbors(order: readonly string[], id: string, activeId: string): FolderTabNeighbors {
  const index = order.indexOf(id);
  if (index < 0) return {};
  return {
    prevActive: index > 0 && order[index - 1] === activeId,
    nextActive: index < order.length - 1 && order[index + 1] === activeId,
  };
}

/**
 * 页签按钮类名。
 * @param active 是否活动页签
 * @param atEnd 是否排在最末（最右）
 * @param variant "stretch" 页签组内等宽平分（配合 `FolderTabRuler` 时组宽 = N × 最长标签宽）；
 *                "min" 最小宽——目前已无调用点，保留仅为兼容可能的「不填满」场景
 * @param atStart 是否排在首位。活动页签排首位时左缩进 18px（`ml-4.5`），与排末位时的 `mr-4.5`
 *                左右对称——凹角外端落在内容板上圆角弧起点，两条弧相切；
 *                非活动页签在首位 / 末位时该侧缩进 12px（`ml-3`/`mr-3`，= 内容板倒角半径）
 * @param neighbors 左右邻居是否活动。紧邻活动页签的那一侧 margin 必须从 3px 收到 1px，
 *                  详见函数体内 `sideMargin` 的推导（2026-10-05 用户反馈「中间页签左侧倒角多一根横线」）
 */
export function folderTabClass(
  active: boolean,
  atEnd: boolean,
  variant: TabVariant = "stretch",
  atStart = false,
  neighbors: FolderTabNeighbors = {},
) {
  const width = variant === "stretch" ? "flex-1 basis-0 min-w-0" : "min-w-[7.5rem]";
  if (active) {
    return [
      // 上缘保留凸圆角；下缘**不用** `rounded-b-*`——那会让竖边往内收、与内容板上沿接不上。
      // 改由 `ft-tab-fillet` 的两个伪元素画「外扩凹角」，把竖边向外侧接到内容板上沿横线
      // （几何与色值见 globals.css 的 .ft-tab-fillet 注释）。
      // 凹角必须画到按钮盒外，故这里**不能** overflow-hidden（超长标签改由内层 span 裁切）。
      // 页签高 = 1px 边框 + `pt-1.5`(6px) + `pb-[3px]`(3px) + `text-base` 行高 24px = 34px；
      // `mt-[7px]` 把它从条顶往下收 7px（内容板不动），页签底 = 7 + 34 = 41px = 内容板顶
      // （容器 `pt-10` = 40px）+ 1px，接缝恒 −1px。
      // 上下内边距不对称（6 / 3）是有意的：让标签跟着页签顶下移 3px，而不是随高度收缩各让 1.5px。
      // 改高度时必须同步改 `mt`（见文件头第 2 条），否则页签底会离开内容板顶露出白缝。
      `relative z-30 mt-[7px] ${width} rounded-t-[8px] border border-b-0 border-slate-300 bg-[#fbfaf7] px-4 pt-1.5 pb-[3px] text-base font-semibold text-slate-800 shadow-[0_-2px_3px_rgba(15,23,42,0.06)]`,
      "ft-tab-fillet",
      // 排首位/末位时的缩进 = 内容板倒角半径(12px) + 页签凹角半径(6px) = 18px。
      // 凹角外端正好落在内容板上圆角弧的起点上，两条弧相切、不会打架；
      // 若缩进小于此值，凹角会撞进内容板的圆角弧里，接缝处出现折角/断口。
      // 左右必须同时给，否则「左直线、右曲线」不对称（首位页签曾因此只画右凹角）。
      atStart ? "ml-4.5" : "",
      atEnd ? "mr-4.5" : "",
    ].filter(Boolean).join(" ");
  }
  // 非活动页签 `mt-[13px]`（13px）= 活动页签 `mt-[7px]`（7px）+ 6px —— 与活动页签一起下移，
  // 保持「活动页签高出 6px」的层次；顶部这 13px 是唯一露出区（其余被内容板 z-20 盖住）。
  // `pt-[5px]` 让标签文字在**露出区**内视觉居中：露出区 = 页签顶 → 内容板顶 = 27px，文字行高 16px。
  // 纯理论居中（行盒 5.5/5.5）会因中文字形 ascender 空间大、墨迹微偏上约 0.5px，故 `pt` 取 5px
  // 把墨迹质心拉回正中（像素质心实测偏移 ≈ 0）。**不能**用 `items-center`：页签是 `self-stretch`
  // （高到内容板下缘），居中会把文字推到内容板后面。
  // 左右 margin：默认各 3px（`ml-0.75`/`mr-0.75`），相邻两个**非活动**页签的间距 =
  // 3 + gap(6px) + 3 = 12px。
  // ⚠️ 但**紧邻活动页签的那一侧必须收到 1px（`ml-px`/`mr-px`）**：活动页签两侧的凹角方块只有
  // 7px 宽（left/right:-7px），它的外端必须正好落在相邻页签的竖边上才能接住；
  // 间距 = gap(6px) + 邻居 margin，取 3px 时是 9px > 7px，中间那约 2px 的内容板上边框会整段
  // 露在凹角外侧 —— 就是用户看到的「倒角旁边多出一根短横线」（中间页签两侧都会出现）。
  // 取 1px 时 6 + 1 = 7px，弧线外端与相邻页签竖边相接，多余横线消失。
  // **外侧边**（`atStart` / `atEnd`：该侧没有相邻页签，即页签条 = 内容板的左/右边缘）缩进
  // 一个**内容板倒角半径** 12px（`ml-3`/`mr-3`）：非活动页签不得压住内容板上角的圆弧，
  // 缩进 12px 后它的竖边正好落在圆角弧的起点上（与活动页签 18px = 12 + 凹角半径 6 同一原点）。
  const sideMargin =
    variant === "stretch"
      ? `${neighbors.prevActive ? "ml-px" : atStart ? "ml-3" : "ml-0.75"} ${neighbors.nextActive ? "mr-px" : atEnd ? "mr-3" : "mr-0.75"}`
      : "mx-0.75";
  return [
    `relative z-10 mt-[13px] self-stretch ${width} flex items-start justify-center overflow-hidden whitespace-nowrap rounded-[8px] border border-slate-300 bg-slate-200 ${sideMargin} px-4 pt-[5px] text-xs font-medium text-slate-500 shadow-[0_2px_4px_rgba(15,23,42,0.08)] hover:-translate-y-0.5 hover:bg-slate-100`,
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
 * 隐形量尺（invisible ruler）：让**同一组**页签等宽、且宽度只按最长标签占位。
 *
 * 用法：把本组件放进每个页签的内层 span（活动页签裁切用的那层）里，页签本身用
 * `folderTabClass(..., "stretch", ...)`。原理：量尺把**全部**标签按活动页签的字号
 * （`text-base` / `font-semibold`）叠在同一个网格单元里，于是它的 max-content 宽 = 最长标签宽；
 * 每个页签里放同一份量尺 → 各页签的 max-content 宽都相等 → 页签组自身宽度 = N × 最长标签宽，
 * 配合 `flex-1 basis-0` 平分即得严格等宽；页签组不做 `w-full`，所以整组靠左、不铺满整行。
 *
 * `h-0 overflow-hidden` 保证它只参与宽度计算、不占页签高度（页签高仍由 pt/pb + 行高决定）。
 * 列用 `minmax(0, max-content)`：量尺的 **max-content** 仍是「最长标签」（决定等宽），但
 * **min-content 为 0**、可以被压缩 —— 否则量尺会把每个页签的最小宽度锁死在最长标签上，
 * 窄屏下页签组撑破容器、末尾页签点不到。压缩时标签由页签内层 span 的 ellipsis 裁切。
 *
 * 另有一枚**下限探针** `RULER_MIN_PROBE`：四个汉字宽，保证再短的标签（如「买入」「赎回」）
 * 也不会窄成一条 —— 太短的标签不好看。探针与真实标签同字号同字体，所以它量出来的就是
 * 「四个字的宽度」；同样只抬高 max-content，`<sm` 窄屏仍可继续压缩。
 */
const RULER_MIN_PROBE = "宽度量尺";

export function FolderTabRuler({ labels }: { labels: readonly ReactNode[] }) {
  return (
    <span className="grid h-0 grid-cols-[minmax(0,max-content)] overflow-hidden text-base font-semibold" aria-hidden="true">
      <span className="col-start-1 row-start-1 whitespace-nowrap">{RULER_MIN_PROBE}</span>
      {labels.map((label, index) => (
        <span key={index} className="col-start-1 row-start-1 whitespace-nowrap">{label}</span>
      ))}
    </span>
  );
}

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
 * 注意：`variant="stretch"` 时页签条需要占满宽度；页签条容器自带 `pt-10`（内容板顶位置，
 * 与页签高无关，见文件头第 2 条）由调用方控制显示与否（重置/注册子态要收起页签条时，调用方自行判断，见登录页的 showReset 分支）。
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
          const prevActive = index > 0 && tabs[index - 1]?.id === activeId;
          const nextActive = index < lastIndex && tabs[index + 1]?.id === activeId;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={folderTabClass(active, atEnd, variant, index === 0, { prevActive, nextActive })}
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
