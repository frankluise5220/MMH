/**
 * 中国农业银行金穗信用卡电子对账单（HTML 邮件正文）解析器。
 *
 * 这种账单的特殊之处：
 * - 正文就是 HTML，没有附件；
 * - 表头是**竖排**的：每个列名独占一个 <tr>（交易日 / TDate / 入账日期 / PDate / …），
 *   通用的「一行里凑齐所有表头」识别器认不出来；
 * - 金额列写的是「入账金额/币种(支出为-)」：负数=支出、正数=入账（还款）；
 * - 邮件头 `charset=""`，真实编码只在 HTML <meta> 里写 gbk —— 这一层由
 *   `imap-client.ts` 的 charset 兜底先修好，本模块只处理正确的中文文本。
 *
 * 纯函数、不依赖数据库/网络，供 parse route 与 `check:abc-credit-card` 共用。
 */

export type AbchinaParsedItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  amount: number;
  outflow?: number;
  inflow?: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  counterparty?: string;
  institution?: string;
  category?: string;
  remark?: string;
  postedDate?: string;
  currency?: string;
  _meta?: {
    institutionName?: string;
    ownerName?: string;
    cardNumberMasked?: string;
    creditLimit?: number;
    statementAmount?: number;
    statementPeriodStart?: string;
    statementPeriodEnd?: string;
    statementDueDate?: string;
    /**
     * 卡别（与账户档案的 cardRole 同口径）：
     * - primary：账单抬头那张卡，账单的应还额/额度只属于它；
     * - supplementary：同一份账单里出现的其它卡号，即主卡的附属卡。
     * 抬头卡号缺失时判不出主卡，所有行一律 primary，不猜。
     */
    cardRole?: "primary" | "supplementary";
    /** 附属卡所属主卡的卡号后四位，供导入侧建立主卡/附属卡关系。 */
    primaryCardMasked?: string;
    /** 分期行的类型/分类由模板权威决定，下游归一化不得覆盖。 */
    templateLocked?: boolean;
  };
};

export type AbchinaAliasMatch = (text: string) => {
  counterparty?: string;
  category?: string;
  institution?: string;
};

function stripTags(html: string) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tableRows(html: string) {
  return String(html ?? "").match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];
}

function rowCells(rowHtml: string) {
  return [...rowHtml.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
    .map((match) => stripTags(match[1]));
}

function parseMoney(value: string): number | null {
  const normalized = String(value ?? "")
    .replace(/,/g, "")
    .replace(/[￥¥]/g, "")
    .replace(/\/?\s*\b(?:RMB|CNY|USD|HKD)\b/gi, "")
    .trim();
  const match = normalized.match(/^([+-]?\d+(?:\.\d{1,2})?)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount : null;
}

function ymd(value: string) {
  const match = String(value ?? "").trim().match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return undefined;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) {
    return undefined;
  }
  return `${y}-${m}-${d}`;
}

export function isAbchinaCreditCardStatement(text: string) {
  const compact = String(text ?? "").replace(/\s+/g, "");
  return /农业银行|金穗信用卡|金穗贷记卡|abchina/i.test(compact)
    && /交易明细|入账金额\/币种|账单周期|StatementInformation/i.test(compact)
    && /<tr[\s>]/i.test(String(text ?? ""));
}

type Meta = NonNullable<AbchinaParsedItem["_meta"]>;

function extractMeta(plain: string, html: string): Meta {
  const meta: Meta = { institutionName: "农业银行" };

  const owner = plain.match(/尊敬的\s*([\u4e00-\u9fa5]{2,4})\s*(?:先生|女士)/);
  if (owner) meta.ownerName = owner[1];

  const card = plain.match(/卡号\s*[:：]?\s*(?:\d{6})?\*{2,}(\d{4})/)
    ?? plain.match(/卡号后四位\s*[:：]?\s*(\d{4})/);
  if (card) meta.cardNumberMasked = card[1];

  const cycle = plain.match(/账单周期\s*[:：]?\s*(\d{8})\s*[-~至—]\s*(\d{8})/);
  if (cycle) {
    meta.statementPeriodStart = ymd(cycle[1]);
    meta.statementPeriodEnd = ymd(cycle[2]);
  }

  const due = plain.match(/到期还款日\s*[:：]?\s*(\d{8})/);
  if (due) meta.statementDueDate = ymd(due[1]);

  // 「币种 | 本期应还款额 | 最低还款额 | 信用额度」与数值行是两行，
  // 按列号取同一列的下一行值，纯文本正则会把所有数字连一起取错列。
  // 注意中文表头下面还夹着一行英文译文（Curr / New Balance / …），
  // 所以要往下找到第一行该列真能解析出金额的，而不是死取下一行。
  const rows = tableRows(html).map(rowCells);
  const labelRowIndex = rows.findIndex((cells) => cells.some((cell) => /信用额度|Credit Limit/i.test(cell)));
  if (labelRowIndex >= 0) {
    const labels = rows[labelRowIndex];
    for (const [key, matcher] of [
      ["creditLimit", /信用额度|Credit Limit/i],
      ["statementAmount", /本期应还款额|New Balance/i],
    ] as const) {
      const column = labels.findIndex((cell) => matcher.test(cell));
      if (column < 0) continue;
      for (let offset = 1; offset <= 3 && labelRowIndex + offset < rows.length; offset += 1) {
        const value = parseMoney(rows[labelRowIndex + offset]?.[column] ?? "");
        if (value === null) continue;
        if (key === "creditLimit" && value >= 1000) meta.creditLimit = value;
        if (key === "statementAmount") meta.statementAmount = Math.abs(value);
        break;
      }
    }
  }

  return meta;
}

const SECTION_START_RE = /【?交易明细】?/;
const INSTALLMENT_START_RE = /【?分期明细】?/;
const SECTION_END_RE = /温馨提示|账单说明|积分|安全提示|版权所有|客户服务热线/;
const REPAYMENT_RE = /银联入账|转账|转入|还款|付款尾号|扣款尾号|自动还款|卡卡转账/i;
/** 银行分期统一三级分类（与 default-categories 的 SYSTEM_BANK_INSTALLMENT_EXPENSE_CATEGORY 一致）。 */
const BANK_INSTALLMENT_CATEGORY = "银行分期";

function paymentTail(text: string) {
  return text.match(/(?:付款|扣款|还款)?尾号[:：]?\s*(\d{2,8})/)?.[1] ?? "";
}

/**
 * 农行的「分期计划」：`【分期明细】` 是独立小节，8 列为
 * 分期类型 | 分期日期 | 分期总本金 | 总期数 | 当期期数 | 剩余期数 | 本期应还本金 | 剩余本金。
 *
 * 记账口径（用户 2026-11-23 裁定）：一笔商户分期在明细里拆成三条，数字全部来自原表——
 *   ① 正常消费 -5698（钱花在商户，分类走普通消费）
 *   ② 分期冲抵 +5698（这笔消费转成分期本金，冲掉①，不重复计支出）
 *   ③ 分期本金 -950（本期应还本金；之后的期数由各自账单的【分期明细】补）
 * 三条净额 -950，与「本期应还 1325.20 = 其它消费 375.20 + 分期本金 950」对齐。
 * 若本期账单里只有计划、没有对应的消费行（分期发生在往期），只补当期本金一条，
 * 绝不凭空再造消费与冲抵。
 */
export type AbchinaInstallmentPlan = {
  type: string;
  date: string;
  totalPrincipal: number;
  totalPeriods: number;
  currentPeriod: number;
  remainingPeriods: number;
  currentPrincipal: number;
  remainingPrincipal: number;
};

function money(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

/**
 * 分期计划的两条备注：原表数字（总本金/期数/分期日/本期应还/剩余）都要能对上。
 * 原消费行不写任何分期信息——它就是一笔正常消费，摘要照原表。
 */
function installmentRemarks(plan: AbchinaInstallmentPlan, description: string) {
  return {
    offset: `${description}（分期冲抵：转分期本金 ${money(plan.totalPrincipal)}，分 ${plan.totalPeriods} 期，分期日 ${plan.date}）`,
    principal: `${description}（分期本金 ${plan.currentPeriod}/${plan.totalPeriods}，本期应还 ${money(plan.currentPrincipal)}，剩余本金 ${money(plan.remainingPrincipal)}）`,
  };
}

function collectInstallmentPlans(rows: string[]): Map<string, AbchinaInstallmentPlan[]> {
  const plans = new Map<string, AbchinaInstallmentPlan[]>();
  let inInstallment = false;
  for (const row of rows) {
    const rowText = stripTags(row);
    if (!inInstallment) {
      if (INSTALLMENT_START_RE.test(rowText)) inInstallment = true;
      continue;
    }
    if (SECTION_END_RE.test(rowText)) break;
    const cells = rowCells(row).map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 6) continue;
    const date = ymd(cells[1] ?? "");
    const totalPrincipal = parseMoney(cells[2] ?? "");
    if (!date || totalPrincipal === null) continue;
    const plan: AbchinaInstallmentPlan = {
      type: cells[0] ?? "",
      date,
      totalPrincipal: Math.abs(totalPrincipal),
      totalPeriods: Number(cells[3]) || 0,
      currentPeriod: Number(cells[4]) || 0,
      remainingPeriods: Number(cells[5]) || 0,
      currentPrincipal: parseMoney(cells[6] ?? "") ?? 0,
      remainingPrincipal: parseMoney(cells[7] ?? "") ?? 0,
    };
    const key = `${date}|${plan.totalPrincipal}`;
    plans.set(key, [...(plans.get(key) ?? []), plan]);
  }
  return plans;
}

/**
 * 解析农行金穗信用卡 HTML 账单。识别不出交易时返回空数组，让上层继续走别的模板。
 */
export function parseAbchinaCreditCardStatement(
  text: string,
  matchAlias: AbchinaAliasMatch = () => ({}),
): AbchinaParsedItem[] {
  if (!isAbchinaCreditCardStatement(text)) return [];

  const plain = stripTags(text);
  const meta = extractMeta(plain, text);
  const last4Header = meta.cardNumberMasked;
  const items: AbchinaParsedItem[] = [];
  const seen = new Set<string>();
  const rows = tableRows(text);
  const installmentPlans = collectInstallmentPlans(rows);
  /** 本期交易明细里出现过全额本金的计划（date|总本金），用于区分「本期新分期」与「往期分期的续期」。 */
  const matchedInstallmentKeys = new Set<string>();
  /** 本期出现过的消费金额，做一次兜底，避免续期行与本已落地的消费行重复。 */
  const spentAmounts = new Set<number>();
  let inTransactions = false;

  for (const row of rows) {
    const rowText = stripTags(row);
    if (!inTransactions) {
      // 农行把「【交易明细】」和竖排表头各自放在独立 <tr> 里，
      // 用小节标题进场即可；表头行没有 8 位日期，后面自然跳过。
      if (SECTION_START_RE.test(rowText)) inTransactions = true;
      continue;
    }
    // 「【分期明细】」出现在交易明细之后，是计划追踪而非新交易，到此为止。
    if (INSTALLMENT_START_RE.test(rowText) || SECTION_END_RE.test(rowText)) break;

    const cells = rowCells(row).map((cell) => cell.trim());
    while (cells.length > 0 && !cells[0]) cells.shift();
    if (cells.length < 6) continue;

    const date = ymd(cells[0] ?? "");
    if (!date) continue;
    const postedDate = ymd(cells[1] ?? "") ?? date;
    const cardLast4 = (cells[2] ?? "").match(/\d{4}/)?.[0] ?? meta.cardNumberMasked ?? "";

    // 列数依邮件模板而变：交易地点为空时少一格。从尾部定位金额列更稳。
    const settledRaw = cells[cells.length - 1] ?? "";
    const transactionRaw = cells[cells.length - 2] ?? "";
    const middle = cells.slice(3, Math.max(3, cells.length - 2));
    const typeLabel = middle[0] ?? "";
    const location = middle.slice(1).join(" ").trim();
    const settled = parseMoney(settledRaw);
    const transactionAmount = parseMoney(transactionRaw);
    const amount = settled ?? transactionAmount;
    if (amount === null || amount === 0) continue;

    const description = [typeLabel, location].filter(Boolean).join(" ").trim();
    if (!description) continue;

    const tail = paymentTail(description);
    const isRepayment = REPAYMENT_RE.test(description) || (amount > 0 && !!tail);
    const type: AbchinaParsedItem["type"] = isRepayment ? "transfer" : amount > 0 ? "income" : "expense";
    const absAmount = Math.abs(amount);
    const alias = matchAlias(description);
    const tailAccount = tail
      ? (/银联入账|银联/i.test(description) ? `银联入账尾号${tail}` : `尾号${tail}`)
      : "";
    const cardAccount = `农业银行信用卡(${cardLast4})`;
    const key = `${date}|${postedDate}|${cardLast4}|${description}|${absAmount}|${type}`;

    // 分期本金行（交易明细里 typeLabel 含「分期」且金额等于分期总本金）
    const plan = /分期/.test(typeLabel)
      ? (installmentPlans.get(`${date}|${absAmount}`) ?? [])[0]
      : undefined;
    if (plan) matchedInstallmentKeys.add(`${date}|${absAmount}`);
    else if (type === "expense") spentAmounts.add(absAmount);

    // 账单单头的「本期应还款额 / 账单周期 / 到期还款日 / 信用额度」只属于
    // 表头那张卡（主卡，如 6308）。一份农行账单会带出主卡 + 附属卡（如 6316）的
    // 全部交易，若把这些单头数字复制到附属卡的每笔，导入建账单锁定时会把主卡的
    // 应还额错挂到附属卡账户上。所以只有表头卡的行才带单头字段。
    const isHeaderCard = !last4Header || cardLast4 === last4Header;
    // 卡别：账单抬头那张卡是主卡，同一份账单里冒出来的其它卡号是它的附属卡。
    // 抬头卡号缺失时无从判断，一律按主卡算，绝不靠 BIN/户名去猜。
    const cardRole: "primary" | "supplementary" =
      last4Header && cardLast4 && cardLast4 !== last4Header ? "supplementary" : "primary";
    const metaForRow: Meta = isHeaderCard
      ? { ...meta, cardNumberMasked: cardLast4 }
      : { institutionName: meta.institutionName, ownerName: meta.ownerName, cardNumberMasked: cardLast4 };
    metaForRow.cardRole = cardRole;
    if (cardRole === "supplementary") metaForRow.primaryCardMasked = last4Header;
    const rowMeta: Meta = { ...metaForRow, templateLocked: plan ? true : undefined };

    const pushRow = (input: {
      key: string;
      type: AbchinaParsedItem["type"];
      amount: number;
      outflow?: number;
      inflow?: number;
      category?: string;
      remark: string;
      rawDescription?: string;
    }) => {
      if (seen.has(input.key)) return;
      seen.add(input.key);
      items.push({
        rawText: `${date} ${input.rawDescription ?? description} ${settledRaw || transactionRaw}`.trim(),
        type: input.type,
        date,
        amount: input.amount,
        outflow: input.outflow,
        inflow: input.inflow,
        account: cardAccount,
        // 「约定还款」「卡卡转账」这类还款行账单里不写资金来源，
        // 不能拿本卡卡号冒充付款账户（否则就成了自己转自己）；有尾号才填。
        fromAccount: input.type === "transfer" ? tailAccount || undefined : undefined,
        toAccount: input.type === "transfer" ? cardAccount : undefined,
        counterparty: alias.counterparty,
        institution: alias.institution,
        category: input.category,
        remark: input.remark,
        postedDate,
        currency: /USD|RMB|CNY/i.test(settledRaw) ? "CNY" : undefined,
        _meta: rowMeta,
      });
    };

    if (!plan) {
      pushRow({
        key,
        type,
        amount: absAmount,
        outflow: type === "expense" ? absAmount : undefined,
        inflow: type !== "expense" ? absAmount : undefined,
        category: alias.category,
        remark: `${description}${postedDate !== date ? `（入账日 ${postedDate}）` : ""}`,
      });
      continue;
    }

    // 商户分期按银行实际入账拆三条：消费 / 冲抵 / 本期本金。
    // 分类沿用这笔消费的正常分类（分期只是付款方式，不是花钱的去向），
    // 三条净额等于「本期应还本金」，后续期由各自账单的【分期明细】续。
    // 消费行不写分期口径，原摘要是「商户分期 X」就照抄；分期信息只写在冲抵行。
    const notes = installmentRemarks(plan, description);
    pushRow({
      key: `${key}|spend`,
      type: "expense",
      amount: absAmount,
      outflow: absAmount,
      category: alias.category,
      remark: `${description}${postedDate !== date ? `（入账日 ${postedDate}）` : ""}`,
    });
    pushRow({
      key: `${key}|offset`,
      type: "expense",
      amount: absAmount,
      inflow: absAmount,
      category: alias.category,
      remark: notes.offset,
      rawDescription: `${description}（分期冲抵）`,
    });
    if (plan.currentPrincipal > 0) {
      pushRow({
        key: `${key}|principal`,
        type: "expense",
        amount: plan.currentPrincipal,
        outflow: plan.currentPrincipal,
        category: alias.category ?? BANK_INSTALLMENT_CATEGORY,
        remark: notes.principal,
        rawDescription: `${description}（第 ${plan.currentPeriod} 期本金）`,
      });
    }
  }

  // 只在【分期明细】里出现的计划（消费发生在往期账单）：本期只补当期应还本金一条。
  // 金额取「本期应还本金」，提前结清那种（当期 2/6、剩余 0）就是结清额。
  for (const [planKey, planList] of installmentPlans) {
    if (matchedInstallmentKeys.has(planKey)) continue;
    for (const plan of planList) {
      if (!(plan.currentPrincipal > 0)) continue;
      // 兜底：本期若已有同额消费行落地，说明匹配只是日期/字段对不上，别再补。
      if (spentAmounts.has(plan.totalPrincipal)) continue;
      const date = meta.statementPeriodEnd ?? plan.date;
      const key = `${date}|installment|${plan.date}|${plan.totalPrincipal}|${plan.currentPeriod}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cardLast4 = meta.cardNumberMasked ?? "";
      items.push({
        rawText: `${date} 分期本金 ${plan.currentPeriod}/${plan.totalPeriods} ${money(plan.currentPrincipal)}`,
        type: "expense",
        date,
        amount: plan.currentPrincipal,
        outflow: plan.currentPrincipal,
        account: cardLast4 ? `农业银行信用卡(${cardLast4})` : "农业银行信用卡",
        category: BANK_INSTALLMENT_CATEGORY,
        remark: `${plan.type || "商户分期"}（分期本金 ${plan.currentPeriod}/${plan.totalPeriods}，总本金 ${money(plan.totalPrincipal)}，分期日 ${plan.date}，剩余本金 ${money(plan.remainingPrincipal)}）`,
        postedDate: date,
        _meta: { ...meta, cardNumberMasked: cardLast4 || undefined, cardRole: "primary", templateLocked: true },
      });
    }
  }

  return items;
}
