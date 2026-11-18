/**
 * 「转换交易」会话。
 *
 * 明细页选中一条记录 → 点「转换」→ 选目标交易类型 → 打开该类型的新建窗（带入
 * 资金账户 / 日期 / 金额 / 备注）→ 用户保存成功 → 删除原记录。
 *
 * 录入窗是彼此独立的组件（各自监听 `mmh:*:create`），唯一能把「这次新建」和
 * 「被转换的原记录」串起来的信息就是 requestId：点「转换」时按 requestId 登记
 * 会话，各录入窗新建成功后派发 `<ns>:create:success`（detail 只带 requestId），
 * 监听器据此取回会话并删除原记录。所以这里只放一个 requestId → 会话的映射，
 * 不做任何 fetch / 状态订阅。
 */

/**
 * 目标类型只允许是**录入窗里真实存在的页签 / 入口**（2026-11-17 用户裁定）：
 * - 记账窗的 FT 页签是 支出 / 收入 / 代付 / 转账 四个；信用卡还款不是独立类型，
 *   它就是一笔「转账」（资金账户 → 信用卡账户），所以这里没有 credit_repay。
 * - 往来款窗只有「借款 / 还款」两个页签：借入 ↔ 借出、还款 ↔ 收款是同一个页签的
 *   两种流向（由往来款账户落在流出侧还是流入侧决定），所以往来目标是 2 个而不是 4 个。
 */
export type EntryConversionTargetKey =
  | "expense"
  | "income"
  | "advance"
  | "transfer"
  | "fund"
  | "metal"
  | "wealth"
  | "bond"
  | "deposit"
  | "insurance"
  | "stock"
  | "liability_borrow"
  | "liability_repay";

export type EntryConversionSession = {
  /** 被转换的原记录（保存成功后删除）。 */
  sourceEntryId: string;
  targetKey: EntryConversionTargetKey;
  /** 目标交易的中文/当前语言名称，用于删除后的提示文案。 */
  targetLabel: string;
};

/**
 * 目标交易保存成功时各录入窗派发的事件名。detail 统一为 `{ requestId }`。
 *
 * 记账窗与投资窗共用 `mmh:create-transaction:success`（InvestmentFormModal 也用它），
 * 其余录入窗各自派发 `<ns>:create:success`；新增目标类型时两边都要登记。
 */
export const ENTRY_CONVERSION_SUCCESS_EVENTS = [
  "mmh:create-transaction:success",
  "mmh:wealth:create:success",
  "mmh:bond:create:success",
  "mmh:deposit:create:success",
  "mmh:insurance:create:success",
  "mmh:stock:create:success",
  "mmh:settlement:create:success",
] as const;

const sessions = new Map<string, EntryConversionSession>();

function nextConversionRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `conv-${crypto.randomUUID()}`;
  }
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createEntryConversionRequestId() {
  return nextConversionRequestId();
}

export function beginEntryConversion(requestId: string, session: EntryConversionSession) {
  sessions.set(requestId, session);
}

export function cancelEntryConversion(requestId: string) {
  sessions.delete(requestId);
}

/**
 * 该 requestId 是不是「转换交易」发起的新建。
 *
 * 转换窗保存后要删掉原记录，因此没有「保存并再记一笔」这种留在原地继续记的语义，
 * 各录入窗据此把该按钮藏掉。只在窗口打开时判断一次（`takeEntryConversion`
 * 会在保存成功后把会话删掉，渲染期反复查询会得到 false）。
 */
export function isEntryConversionRequest(requestId: string | null | undefined) {
  const key = String(requestId ?? "").trim();
  return key.length > 0 && sessions.has(key);
}

/** 取出并移除会话（每个 requestId 只结算一次，避免「保存并再记一笔」重复删除）。 */
export function takeEntryConversion(requestId: string | null | undefined): EntryConversionSession | null {
  const key = String(requestId ?? "").trim();
  if (!key) return null;
  const session = sessions.get(key);
  if (!session) return null;
  sessions.delete(key);
  return session;
}
