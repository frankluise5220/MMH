import {
  isCreditCardRepaymentKeywordText,
  isCreditCardRepaymentLikeText,
} from "@/lib/statement/amount-direction";

/**
 * 信用卡还款行的付款方必须是「钱真正出来的那一侧」。
 *
 * 账单里的「自扣还款 / 自动还款 / 银联入账」描述的是「钱进了这张信用卡」，付款方
 * 通常不写、或只写一个尾号。早先预览在没有付款方时回退成主账户，于是同一笔转账
 * 两侧都是这张信用卡——信用卡给信用卡还款、本账户转账给自己，账面上凭白多出一笔
 * 不存在的转账。这里放两条与银行无关的通用规则：
 *
 *   1. 一笔转账的两侧不能是同一个账户（同 id、同尾号、同名字都算）；
 *   2. 信用卡还款的付款方只能是借记卡/电子钱包，导入时优先按「同机构借记卡」补全。
 *
 * 只做文本层面的判定，不碰数据库，方便被预览、批量导入和守卫脚本共用。
 */

const CREDIT_CARD_NAME_RE = /\u4fe1\u7528\u5361|\u8d37\u8bb0\u5361|credit\s*card/i;

/** 账户引用里可提取的四位尾号（`***1234` / `尾号1234` / `(1234)`）。 */
export function accountTail(value: string | null | undefined) {
  const raw = String(value ?? "");
  if (!raw) return "";
  const masked = raw.match(/\*{2,}(\d{4})(?!\d)/);
  if (masked?.[1]) return masked[1];
  const labeled = raw.match(/(?:\u5c3e\u53f7|\u672b\u56db\u4f4d|\u5361\u53f7\u672b\u56db\u4f4d)\s*[:\uff1a]?\s*(\d{4})(?!\d)/);
  if (labeled?.[1]) return labeled[1];
  const parenthesized = raw.match(/[(\uff08](\d{4})[)\uff09]\s*$/);
  return parenthesized?.[1] ?? "";
}

/**
 * 账户引用的归一键：全角转半角、去空白、去尾部「(尾号)」括号差异。
 * 有尾号的统一成 `tail:1234`，这样「招商银行信用卡(尾号1234)」与「尾号1234」能对上；
 * 没尾号的就比归一后的名字。
 */
export function accountReferenceKey(value: string | null | undefined) {
  const raw = String(value ?? "")
    .replace(/\u3000/g, " ")
    .replace(/\uff08/g, "(")
    .replace(/\uff09/g, ")")
    .replace(/\s+/g, "")
    .toLowerCase();
  if (!raw) return "";
  const tail = accountTail(raw);
  if (tail) return `tail:${tail}`;
  return raw.replace(/\([^)]*\)$/g, "");
}

/** 两个账户引用是否指同一张卡/同一个账户（尾号相同即同一张卡）。 */
export function isSameAccountReference(
  a: string | null | undefined,
  b: string | null | undefined,
) {
  const left = accountReferenceKey(a);
  const right = accountReferenceKey(b);
  if (!left || !right) return false;
  return left === right;
}

export function looksLikeCreditCardAccountName(name: string | null | undefined) {
  return CREDIT_CARD_NAME_RE.test(String(name ?? ""));
}

/** 这一行是不是还款语义（严格词表 + 宽口径「还款」字样，含「券」的补贴不算）。 */
export function isCreditCardRepaymentText(text: string | null | undefined) {
  const raw = String(text ?? "");
  if (!raw.trim()) return false;
  return isCreditCardRepaymentLikeText(raw) || isCreditCardRepaymentKeywordText(raw);
}

export type RepaymentSourceAccountLike = {
  id: string;
  name: string;
  kind?: string | null;
  isActive?: boolean | null;
  numberMasked?: string | null;
  Institution?: { id?: string | null; name?: string | null; shortName?: string | null } | null;
};

function normalizeInstitutionName(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/\u3000/g, " ")
    .replace(/[\s()\uff08\uff09]/g, "")
    .replace(/\u94f6\u884c$/, "")
    .toLowerCase();
}

function institutionMatches(
  account: RepaymentSourceAccountLike,
  institutionName: string,
) {
  const target = normalizeInstitutionName(institutionName);
  if (!target) return false;
  const names = [account.Institution?.name, account.Institution?.shortName]
    .map((value) => normalizeInstitutionName(value))
    .filter(Boolean);
  return names.some((name) => name === target || name.includes(target) || target.includes(name));
}

/**
 * 从账本里挑「同机构的借记卡」作为信用卡还款的付款方。
 *
 * 只在唯一命中时返回：同机构有两张以上借记卡时猜错比留空更糟，交给用户点选。
 * 电子钱包不参与自动补全——账单说的「同机构借记卡」就是银行卡，支付宝/微信
 * 这类钱包只在账单自己写明付款方式时才用。
 */
export function pickSameInstitutionDebitCard<A extends RepaymentSourceAccountLike>(
  accounts: readonly A[],
  options: {
    institutionName?: string | null;
    excludeIds?: readonly (string | null | undefined)[];
    excludeRefs?: readonly (string | null | undefined)[];
  },
): A | null {
  const institutionName = String(options.institutionName ?? "").trim();
  if (!institutionName) return null;
  const excludeIds = new Set((options.excludeIds ?? []).filter(Boolean) as string[]);
  const excludeRefs = new Set(
    (options.excludeRefs ?? []).map((value) => accountReferenceKey(value)).filter(Boolean),
  );
  const candidates = accounts.filter((account) => {
    if (account.kind !== "bank_debit") return false;
    if (account.isActive === false) return false;
    if (excludeIds.has(account.id)) return false;
    if (excludeRefs.has(accountReferenceKey(account.name))) return false;
    if (looksLikeCreditCardAccountName(account.name)) return false;
    return institutionMatches(account, institutionName);
  });
  return candidates.length === 1 ? candidates[0] : null;
}
