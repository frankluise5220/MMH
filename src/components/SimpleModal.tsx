"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { ModalLayer } from "@/components/ModalLayer";
import { useI18n } from "@/lib/i18n";

/**
 * 轻量弹窗统一外壳（校准余额 / 校准份额 / 导出参数 / 小型确认窗）。
 *
 * **关闭入口只有右上角一个**：头部右侧的 X（`common.close`）。
 * 底部 `footer` 只放本窗的主操作（保存 / 确认 / 导出…），
 * **不要再摆「取消」** —— 它和右上角关闭是同一个动作，重复两个出口。
 * 这条与 `EntryModalShell` 的按钮行规则一致（见该文件头注释）。
 *
 * 需要页签、FT 卡片、高度锁定的记账窗请用 `EntryModalShell`；
 * 需要整表预览（列很多）的窗请各自实现，这里只收「小表单」。
 */
const WIDTH_CLASS = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
} as const;

export function SimpleModal({
  open,
  title,
  description,
  icon,
  width = "md",
  onClose,
  closeDisabled = false,
  children,
  footer,
  bodyClassName,
  panelClassName,
}: {
  open: boolean;
  title: ReactNode;
  /** 标题下方的说明文字（渲染在头部，与标题同块） */
  description?: ReactNode;
  /** 标题左侧的小图标 */
  icon?: ReactNode;
  width?: keyof typeof WIDTH_CLASS;
  onClose: () => void;
  /** 提交中禁用关闭（避免请求回来时窗口已经没了） */
  closeDisabled?: boolean;
  children: ReactNode;
  /** 底部主操作行，只放主操作，不要放「取消」 */
  footer?: ReactNode;
  bodyClassName?: string;
  panelClassName?: string;
}) {
  const { t } = useI18n();
  if (!open) return null;

  return (
    <ModalLayer className="app-modal-backdrop">
      <div className={`app-modal-panel ${WIDTH_CLASS[width]} ${panelClassName ?? ""}`.trim()}>
        <div className="modal-header">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              {icon}
              <span className="truncate">{title}</span>
            </div>
            {description ? (
              <div className="mt-1 text-xs font-normal text-slate-500">{description}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            className="secondary-button ml-2 h-8 w-8 shrink-0 px-0 disabled:opacity-50"
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4 shrink-0" />
          </button>
        </div>

        <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 ${bodyClassName ?? ""}`.trim()}>
          {children}
        </div>

        {footer ? (
          <div className="shrink-0 border-t border-slate-100 bg-white/95 px-4 py-3">
            <div className="flex items-center justify-end gap-2">{footer}</div>
          </div>
        ) : null}
      </div>
    </ModalLayer>
  );
}
