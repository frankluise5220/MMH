"use client";

import type { ButtonHTMLAttributes, TdHTMLAttributes } from "react";
import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff, Info, Pencil, Plus, PlusCircle, Star, Trash2 } from "lucide-react";
import { APP_PREFS_EVENT, getSidebarHideInitialDataPreference } from "@/lib/client/appPreferences";
import { useI18n } from "@/lib/i18n";

/**
 * 设置页「说明文案」的显隐：跟随首次使用向导开关（`sidebarHideInitialData`）。
 * 新手期（向导还开着）显示解释文案；关掉向导后默认收起，界面只留必要信息。
 * 导出给需要自己渲染说明/提示的页面复用，避免各页各写一套判定。
 */
export function useHideSettingDescriptions() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const update = () => setHidden(getSidebarHideInitialDataPreference());
    update();
    window.addEventListener(APP_PREFS_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(APP_PREFS_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);

  return hidden;
}

export function SettingsPageHeader({
  title,
  description,
  count,
  actions,
  toolbar,
  sticky = false,
}: {
  title: string;
  description?: string;
  count?: number | string;
  actions?: React.ReactNode;
  toolbar?: React.ReactNode;
  sticky?: boolean;
}) {
  const { t } = useI18n();
  const hideDescriptions = useHideSettingDescriptions();
  const showDescription = Boolean(description) && !hideDescriptions;

  return (
    <div className={sticky ? "sticky top-0 z-20 border-b border-slate-200 bg-slate-50/95 pb-3 pt-1 backdrop-blur" : ""}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0" title={description && hideDescriptions ? description : undefined}>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
            {count !== undefined ? (
              <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] tabular-nums text-slate-500">
                {t("settings.scaffold.itemCount", { count })}
              </span>
            ) : null}
          </div>
          {showDescription ? <p className="mt-1 text-xs text-slate-500">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {toolbar ? <div className="mt-3 flex flex-wrap items-center gap-2">{toolbar}</div> : null}
    </div>
  );
}

/**
 * 悬浮说明：把「解释性长句」从表单里收进一个 i 图标，鼠标悬浮/键盘聚焦才显示。
 * 用原生 title（不参与布局，也不会被弹窗的滚动容器裁掉）。
 */
export function SettingsInfoHint({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  return (
    <span
      role="note"
      tabIndex={0}
      aria-label={text}
      title={text}
      className={`inline-flex shrink-0 cursor-help items-center text-slate-300 outline-none transition-colors hover:text-slate-500 focus-visible:text-slate-500 ${className ?? ""}`}
    >
      <Info className="h-3.5 w-3.5" />
    </span>
  );
}

export function SettingsPrimaryAddButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-10 w-full shrink-0 items-center justify-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3 text-sm font-medium text-blue-700 transition-colors active:bg-blue-100 md:h-8 md:w-auto md:rounded-md md:px-2.5 md:text-xs md:hover:bg-blue-100"
    >
      <Plus className="h-4 w-4 md:h-3.5 md:w-3.5" />
      {children}
    </button>
  );
}

export function SettingsActionButton({
  label,
  variant = "default",
  size = "default",
  icon,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: "default" | "edit" | "delete" | "view" | "hide" | "copy" | "add" | "defaultMark";
  size?: "default" | "sm";
  icon?: React.ReactNode;
}) {
  const toneClass =
    variant === "delete"
      ? "text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
      : variant === "edit"
        ? "text-slate-500 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
        : variant === "add" || variant === "defaultMark"
          ? "text-slate-500 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700"
          : "text-slate-500 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-700";
  const resolvedIcon = icon ?? (
    variant === "delete" ? <Trash2 className="h-3.5 w-3.5" />
      : variant === "edit" ? <Pencil className="h-3.5 w-3.5" />
        : variant === "view" ? <Eye className="h-3.5 w-3.5" />
          : variant === "hide" ? <EyeOff className="h-3.5 w-3.5" />
            : variant === "copy" ? <Copy className="h-3.5 w-3.5" />
              : variant === "add" ? <PlusCircle className="h-3.5 w-3.5" />
                : variant === "defaultMark" ? <Star className="h-3.5 w-3.5" />
                  : null
  );
  return (
    <button
      type="button"
      title={props.title ?? label}
      aria-label={props["aria-label"] ?? label}
      {...props}
      className={[
        "inline-flex shrink-0 items-center justify-center text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        // 移动端图标按钮放大到 40px 触摸热区；桌面表格行内仍是 28px 小图标。
        size === "sm"
          ? "h-6 w-6 rounded-md border border-transparent bg-transparent"
          : "h-10 w-10 rounded-lg border border-slate-200 bg-white md:h-7 md:w-7 md:rounded-md",
        // 图标跟着按钮走：手机 16px，桌面回到原来的 14px。
        "[&>svg]:h-4 [&>svg]:w-4 md:[&>svg]:h-3.5 md:[&>svg]:w-3.5",
        toneClass,
        className ?? "",
      ].join(" ")}
    >
      {resolvedIcon}
      {children ? <span className="sr-only">{children}</span> : null}
    </button>
  );
}

export function SettingsSection({
  title,
  description,
  count,
  actions,
  mobileActions,
  children,
}: {
  title: string;
  description?: string;
  count?: number | string;
  actions?: React.ReactNode;
  /** 手机端的同组操作（筛选、新增…），整行显示；桌面隐藏，仍用 `actions`。 */
  mobileActions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const hideDescriptions = useHideSettingDescriptions();
  const showDescription = Boolean(description) && !hideDescriptions;

  return (
    <section className="panel-surface overflow-hidden">
      <div className="panel-header gap-3">
        <div className="min-w-0" title={description && hideDescriptions ? description : undefined}>
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-slate-800">{title}</div>
            {count !== undefined ? <span className="text-xs tabular-nums text-slate-400">({count})</span> : null}
          </div>
          {showDescription ? <div className="mt-1 text-xs text-slate-500">{description}</div> : null}
        </div>
        {actions ? (
          // 传了 mobileActions 的页面，表头操作只在桌面出现；没传的页面行为不变。
          <div className={`${mobileActions ? "hidden desktop:flex" : "flex"} shrink-0 items-center gap-2`}>{actions}</div>
        ) : null}
      </div>
      {/* 手机端：表头放不下的筛选/新增单独占一行，整行满宽才好按 */}
      {mobileActions ? (
        <div className="flex flex-col gap-2 border-b border-slate-100 px-3 pb-3 desktop:hidden">{mobileActions}</div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * 移动端列表容器：设置页里的表格在小屏上既挤又没有点击热区，
 * 用「一行一张卡」代替（`desktop:hidden`，桌面表格照旧）。
 * 卡片内容由调用方决定，这里只统一分隔线与卡片内边距。
 */
export function SettingsMobileList({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-slate-100 desktop:hidden">{children}</div>;
}

/** 移动端列表里的一行：左侧选择框 + 主副信息 + 右侧操作。 */
export function SettingsMobileRow({
  selected,
  onToggleSelect,
  onPress,
  selectLabel,
  title,
  meta,
  actions,
}: {
  selected?: boolean;
  onToggleSelect?: (next: boolean) => void;
  /** 整行点击（例如标签页的「双击进明细」，手机上改成单点）。 */
  onPress?: () => void;
  selectLabel?: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-start gap-3 px-3 py-3 ${onPress ? "cursor-pointer active:bg-slate-50" : ""}`}
      onClick={onPress}
      role={onPress ? "button" : undefined}
    >
      {onToggleSelect ? (
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onToggleSelect(event.target.checked)}
          aria-label={selectLabel}
          className="mt-2 h-5 w-5 shrink-0 accent-blue-600"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-900">{title}</div>
        {meta ? <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">{meta}</div> : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-1" onClick={(event) => event.stopPropagation()}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function SettingsTable({
  minWidth = 760,
  maxWidth = "full",
  className,
  children,
}: {
  minWidth?: number;
  maxWidth?: number | "full";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={[
        "w-full overflow-hidden rounded-md border border-slate-200 bg-white",
        className ?? "",
      ].join(" ")}
      style={maxWidth === "full" ? undefined : { maxWidth: `${maxWidth}px` }}
    >
      <div className="overflow-auto">
        <table className="w-full table-fixed border-separate border-spacing-0" style={{ minWidth: `min(100%, ${minWidth}px)` }}>
          {children}
        </table>
      </div>
    </div>
  );
}

export function SettingsTh({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "right" | "center";
}) {
  return (
    <th
      className={[
        "border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
      ].join(" ")}
    >
      {children}
    </th>
  );
}

export function SettingsTd({
  children,
  align,
  className,
  ...tdProps
}: {
  children: React.ReactNode;
  align?: "right" | "center";
  className?: string;
} & TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      {...tdProps}
      className={[
        "border-b border-slate-100 px-3 py-2 text-xs text-slate-600",
        align === "right" ? "text-right tabular-nums" : align === "center" ? "text-center" : "text-left",
        className ?? "",
      ].join(" ")}
    >
      {children}
    </td>
  );
}

export function SettingsEmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-slate-400">
        {children}
      </td>
    </tr>
  );
}

export function SettingsRowActions({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-end gap-1.5">{children}</div>;
}

