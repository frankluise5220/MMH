"use client";

/**
 * 导入预览窗口的标题栏 —— 账单预览与基金预览**共用同一个组件**，两边的字号、行高、
 * 高度完全一致，切换页签时标题栏不会变高变矮、内容不会上下跳（用户 2026-10-30：
 * 「两边的字体应该一样大写，在切换标签时，不至于闪烁」）。
 *
 * 标题用 `text-base`（弹窗级标题的惯例字号，用户 2026-10-30：「主题字体应该大一点」），
 * 说明一行截断。**标题栏只放这两行**：账单侧原来的第三行（账单金额 / 账期 / 还款日）
 * 已挪进账单卡片内部顶部 —— 否则基金侧要么跟着留一行空白（用户：「下面空了一行」），
 * 要么两边高度差一行、切换时页签条又跳回去。
 */
export function ImportPreviewHeader({
  title,
  description,
  onClose,
  closeDisabled = false,
  closeLabel,
}: {
  title: string;
  description?: string | null;
  onClose: () => void;
  closeDisabled?: boolean;
  closeLabel: string;
}) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-semibold leading-6 text-slate-800">{title}</div>
        {description ? <div className="mt-0.5 truncate text-xs leading-4 text-slate-500">{description}</div> : null}
      </div>
      <button
        type="button"
        className="h-8 w-8 shrink-0 rounded-md border border-slate-300 text-slate-500 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onClose}
        disabled={closeDisabled}
        aria-label={closeLabel}
      >
        ×
      </button>
    </div>
  );
}
