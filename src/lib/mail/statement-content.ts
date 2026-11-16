/**
 * 把一封账单邮件整理成「送去 /api/v1/statement/parse 的文本」。
 *
 * 规则：附件（PDF / Excel）里的文字优先，而且是独占。
 *
 * 以前的实现是「邮件 HTML + 【附件：xxx】+ 附件文字」拼成一整段。这对解析器是
 * 灾难：`parseStructuredStatement` 只要看到 `<...>` 标签就改走 HTML 账单分支，
 * 认不出信用卡表头时整段 return []，后面的附件文字根本没机会被读；上层于是拿到
 * 0 条，兜底成一条 amount=0 的 unparsed 记录。实测平安银行电子账单就是这样：
 * 混在 HTML 里 → 1 条空记录；只用 PDF 文字 → 16 条明细全部识别。
 *
 * 邮件正文只是「您的账单已生成」的通知，明细一定在附件里，所以有附件文字时
 * 不再混入正文，避免两种格式互相污染。
 */
export type StatementMailContentSource = {
  html?: string | null;
  text?: string | null;
  attachments?: ReadonlyArray<{
    filename?: string | null;
    text?: string | null;
  }> | null;
};

export function buildStatementMailContent(mail: StatementMailContentSource | null | undefined): string {
  const attachmentText = (mail?.attachments ?? [])
    .filter((attachment) => attachment.text?.trim())
    .map((attachment) => `【附件：${attachment.filename || "未命名 PDF"}】\n${attachment.text!.trim()}`)
    .join("\n\n");

  if (attachmentText.trim()) return attachmentText;
  return mail?.html?.trim() || mail?.text?.trim() || "";
}
