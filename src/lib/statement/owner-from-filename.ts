/**
 * 账单文件名前缀里的「所有人」。
 *
 * 「张四.支付宝交易明细(20260728-20261028).csv」→ 张四。
 * 导出文件里写的是导出者本人的姓名（付斌），但账可能是记在别人名下的账本里，
 * 这时以文件名前缀为准；没有前缀（普通导出文件名）就回退到账单内部记录的姓名。
 *
 * 这是所有账单平台共用的命名习惯，不是支付宝专属，所以从 alipay-template 里搬到这里。
 */
export function guessOwnerFromFilename(filename: string): string {
  const base = String(filename ?? "")
    .replace(/\.(csv|xls|xlsx)$/i, "")
    .trim();
  const ownerPrefix = base.match(/^([^.\s\-_()\u4e2d]{1,12})[.\u3002\uff0e]\s*(?:\u652f\u4ed8\u5b9d|\u5fae\u4fe1)/);
  if (ownerPrefix) return ownerPrefix[1];
  return "";
}
