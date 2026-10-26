import { formatMoneyYuan } from "@/lib/format";

/** 「关联记录」候选的最小字段集（新建窗 / 单据编辑 / 单据关联三处共用）。 */
type ReimbursementCandidateSearchable = {
  date: string;
  amount: number;
  categoryName?: string | null;
  note?: string | null;
};

/**
 * 按关键字过滤「关联记录」候选。
 *
 * 取数口径是「转入该应收往来款账户的全部款项」，一个账户可能有上百条候选
 * （含全部手工 / 导入转账），而三个窗的候选列表都没有分页，只能靠关键字定位：
 * 日期（`2026-04`）、分类、备注、金额（`358` 与 `358.00` 都能命中）。
 * 空关键字原样返回，不改变服务端给的排序。
 */
export function filterReimbursementCandidates<T extends ReimbursementCandidateSearchable>(
  candidates: T[],
  query: string,
): T[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return candidates;
  return candidates.filter((candidate) => {
    const haystack = [
      candidate.date,
      candidate.categoryName ?? "",
      candidate.note ?? "",
      String(candidate.amount),
      formatMoneyYuan(candidate.amount),
    ].join(" ").toLowerCase();
    return haystack.includes(keyword);
  });
}
