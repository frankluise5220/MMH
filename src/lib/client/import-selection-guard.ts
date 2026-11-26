import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { shouldConfirmPartialImport, skippedImportableCount } from "@/lib/client/import-selection";

/**
 * 「确认导入」前的少选确认。
 *
 * 预览表的勾选默认是全选可导入行，但用户筛选、逐行取消勾选、批量改字段之后，
 * 常常只剩一小部分被勾上，而按钮上的数字（例如「确认导入 3 条」）很容易被当成
 * 「就导这 3 条」的最终确认——结果文件里另外几十条悄悄没入账，事后很难发现。
 * 所以只要还有可导入记录没勾选，就先问一句，让用户明确选择：
 *
 *   - 「返回勾选」：回到预览继续补勾（返回 false）
 *   - 「只导入 N 条」：确认按当前勾选导入（返回 true）
 *
 * 注意 selectedReady 必须是「已勾选且可导入」的条数，readyTotal 是「全部可导入」的条数；
 * 不可导入行（缺账户/缺分类等）两边都不计，否则会把必然跳过的行当成漏选来报。
 */

type Translate = (key: string, params?: Record<string, string | number>) => string;

export async function guardPartialImportSelection({
  readyTotal,
  selectedReady,
  t,
}: {
  readyTotal: number;
  selectedReady: number;
  t: Translate;
}): Promise<boolean> {
  const ready = Math.max(0, Math.floor(readyTotal));
  const selected = Math.max(0, Math.floor(selectedReady));
  if (!shouldConfirmPartialImport(ready, selected)) return selected > 0;

  const skipped = skippedImportableCount(ready, selected);
  return showConfirmDialog({
    title: t("importSelection.partialTitle", { count: skipped }),
    message: t("importSelection.partialMessage", { selected, total: ready, skipped }),
    confirmLabel: t("importSelection.partialConfirm", { count: selected }),
    cancelLabel: t("importSelection.partialBack"),
  });
}
