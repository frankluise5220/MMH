import type { ReactNode } from "react";

/**
 * 全局图标 sprite。
 *
 * 为什么要有它：lucide-react 每个实例都输出一整份 `<svg xmlns=... viewBox=...
 * stroke-width="2" ...><path d="..."/></svg>`，一个 400~500 字节。表格的行拖拽
 * 手柄是 60 个完全相同的 grip-vertical（29KB），筛选标签的关闭按钮是 40 多个完全
 * 相同的 x（12KB）—— 同一张图被重复画了几十遍。
 *
 * 这里把「形状」抽成 `<symbol>`，只在文档里定义一次（`<IconSprite />`，由
 * `app/layout.tsx` 注入），使用处只留 `<use href="#mmh-i-xxx" />`。
 *
 * 只放**高频重复、且形状固定**的图标。一次性出现的图标留在 lucide，
 * 换过来只会多一层间接、省不到字节。
 */
const SPRITE_ICONS: Record<string, ReactNode> = {
  // lucide: grip-vertical
  "grip-vertical": (
    <>
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="5" r="1" />
      <circle cx="9" cy="19" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="5" r="1" />
      <circle cx="15" cy="19" r="1" />
    </>
  ),
  // lucide: x
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
};

export type SpriteIconName = keyof typeof SPRITE_ICONS;

/**
 * 文档级定义，只需在 layout 里渲染一次。
 * 0×0 且 `position:absolute`，不参与布局；`aria-hidden` 保证读屏不念。
 */
export function IconSprite() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-mmh-icon-sprite
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
    >
      {Object.entries(SPRITE_ICONS).map(([name, children]) => (
        <symbol
          key={name}
          id={`mmh-i-${name}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {children}
        </symbol>
      ))}
    </svg>
  );
}

/**
 * 引用 sprite 里的图标。
 * 保留 `lucide lucide-<name>` 类名：现有样式/测试若按类名选中图标，行为不变。
 */
export function SpriteIcon({ name, className }: { name: SpriteIconName; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`lucide lucide-${name}${className ? ` ${className}` : ""}`}
    >
      <use href={`#mmh-i-${name}`} />
    </svg>
  );
}
