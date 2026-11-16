import { showChoiceDialog } from "@/lib/client/confirm-dialog";

/**
 * 账单导入前的重复检查（客户端侧，唯一入口）。
 *
 * 服务端口径（见 lib/server/statement-import-duplicates.ts）：按「日期 + 交易身份」分组，
 * 转账的身份是 A→B（转出账户 → 转入账户，方向敏感），支出/收入/投资的身份是账户 + 类型；
 * 组内笔数一致、再比金额一致，才判定为重复。
 *
 * 由 StatementImportPreviewDialog 在确认时统一调用（所有导入入口共用），命中即询问用户
 * 是否覆盖。返回 "proceed" 表示可以继续导入（覆盖的话旧记录已经被软删），"cancel" 表示取消。
 */

type Translate = (key: string, params?: Record<string, string | number>) => string;

type DuplicateGroup = {
  accountId: string;
  accountName: string;
  date: string;
  count: number;
  recordIds: string[];
};

export type DuplicateGuardResult = "proceed" | "cancel";

export async function guardStatementDuplicateImport(
  items: Array<Record<string, unknown>>,
  t: Translate,
): Promise<DuplicateGuardResult> {
  if (!items.length) return "proceed";
  let data: { ok?: boolean; total?: number; groups?: DuplicateGroup[] } | null = null;
  try {
    const res = await fetch("/api/v1/statement/import/duplicates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, action: "check" }),
    });
    data = await res.json().catch(() => null);
  } catch {
    // 查重失败不能挡住导入：账单本身还是要能入账的。
    return "proceed";
  }
  const total = Number(data?.total ?? 0);
  if (!data?.ok || total <= 0) return "proceed";

  const groups = Array.isArray(data.groups) ? data.groups : [];
  const days = new Set(groups.map((group) => group.date)).size;
  const choice = await showChoiceDialog<"overwrite" | "keep">({
    title: t("statement.duplicate.title"),
    message: t("statement.duplicate.message", { count: total, days }),
    choices: [
      { value: "keep", label: t("statement.duplicate.keep") },
      { value: "overwrite", label: t("statement.duplicate.overwrite"), tone: "danger" },
    ],
    cancelLabel: t("common.cancel"),
  });
  if (!choice) return "cancel";
  if (choice === "keep") return "proceed";

  const recordIds = groups.flatMap((group) => group.recordIds ?? []);
  try {
    await fetch("/api/v1/statement/import/duplicates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, action: "delete", recordIds }),
    });
  } catch {
    // 删除失败时仍然继续：宁可多几条，也不要在用户点过覆盖之后什么都不导入。
  }
  return "proceed";
}
