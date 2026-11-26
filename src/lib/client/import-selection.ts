/**
 * 导入预览的勾选统计（纯函数，不碰 DOM，方便守卫脚本直接断言）。
 *
 * 「可导入记录」= 通过行级校验、真的会被写库的行；「已选可导入」= 其中被勾上的。
 * 两者相减就是用户点「确认导入」时会被静默丢掉的条数。
 */
export function skippedImportableCount(readyTotal: number, selectedReady: number) {
  const ready = Number.isFinite(readyTotal) ? Math.max(0, Math.floor(readyTotal)) : 0;
  const selected = Number.isFinite(selectedReady) ? Math.max(0, Math.floor(selectedReady)) : 0;
  return Math.max(0, ready - selected);
}

/** 只有「已选中至少一条、且还有可导入记录没勾选」时才需要打断用户。 */
export function shouldConfirmPartialImport(readyTotal: number, selectedReady: number) {
  return selectedReady > 0 && skippedImportableCount(readyTotal, selectedReady) > 0;
}
