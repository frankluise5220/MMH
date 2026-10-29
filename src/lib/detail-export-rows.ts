/**
 * 「资金明细」导出行的**唯一**生成点。
 *
 * 两条导出路径必须逐列一致，所以都走这里：
 *  - 表格自带的那份行（RSC 已经算好，`page.tsx` 直接传进来）；
 *  - 按用户选的交易日期范围重新取数（`/api/v1/transactions/detail?export=1`），
 *    它不受表格显示范围 / 分页 / 当前页影响。
 *
 * 纯函数、不碰 prisma：RSC 与 API 路由都可以直接调用。导出需要的视图口径
 * （资金侧账户、金额符号、生效日、账户标签）由调用方以回调注入。
 */
import { counterpartyQualifiedAccountName } from "@/lib/account-display";
import { kindLabel } from "@/lib/account-kinds";
import { getInsuranceDetailCategoryName, getInsuranceDetailNote } from "@/lib/insurance/detail-display";
import { getInvestmentCategoryName } from "@/lib/investment-category";
import { systemCategoryLabel } from "@/lib/system-category-labels";

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** 导出用账户形状：只读字段，Prisma 行与接口行都能直接传。 */
export type ExportAccountLike = {
  name?: string | null;
  kind?: string | null;
  numberMasked?: string | null;
  Institution?: { name?: string | null; shortName?: string | null } | null;
  AccountGroup?: { name?: string | null } | null;
  Counterparty?: { name?: string | null; shortName?: string | null } | null;
} | null | undefined;

/**
 * 导出用明细行形状。
 *
 * 标签既可能来自 Prisma 行（`EntryTag`），也可能来自明细接口（`entryTags`），
 * 两种都要认，否则「重新按区间取数」导出的标签列会整列空掉。
 */
export type DetailExportEntryLike = {
  readonly id?: string | null;
  readonly type?: string | null;
  readonly accountId?: string | null;
  readonly toAccountId?: string | null;
  readonly categoryId?: string | null;
  readonly categoryName?: string | null;
  readonly fundProductType?: string | null;
  readonly fundSubtype?: string | null;
  readonly fundName?: string | null;
  readonly insuranceProductId?: string | null;
  readonly insuranceAction?: string | null;
  readonly insuranceProductName?: string | null;
  readonly source?: string | null;
  readonly note?: string | null;
  readonly toNote?: string | null;
  readonly counterpartyInstitutionName?: string | null;
  readonly account?: { readonly kind?: string | null } | null;
  readonly toAccount?: { readonly kind?: string | null } | null;
  readonly EntryTag?: ReadonlyArray<{ readonly Tag?: { readonly name?: string | null } | null } | null> | null;
  readonly entryTags?: ReadonlyArray<{ readonly Tag?: { readonly name?: string | null } | null } | null> | null;
};

export function formatTransactionTypeLabel(t: TranslateFn, type?: string | null) {
  if (type === "expense") return t("transaction.type.expense");
  if (type === "income") return t("transaction.type.income");
  if (type === "advance") return t("txForm.advance");
  if (type === "transfer") return t("transaction.type.transfer");
  if (type === "investment") return t("transaction.type.investment");
  return String(type ?? "");
}

export function buildCategoryExportLabels(
  t: TranslateFn,
  categories: Array<{ id: string; name: string; type: string; parentId: string | null }>,
) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const memo = new Map<string, string[]>();
  // Root category names are user data stored in the DB; keep the Chinese names for matching.
  const rootLabels = new Set(["支出", "收入", "转账", "代付", "投资"]);

  function pathNames(id: string): string[] {
    const cached = memo.get(id);
    if (cached) return cached;
    const c = byId.get(id);
    if (!c) return [];
    const seen = new Set<string>();
    const names: string[] = [];
    let cur: typeof c | undefined = c;
    while (cur) {
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      names.push(cur.name);
      if (!cur.parentId) break;
      const parent = byId.get(cur.parentId);
      if (!parent) break;
      if (parent.type !== cur.type) break;
      cur = parent;
    }
    names.reverse();
    memo.set(id, names);
    return names;
  }

  const labelById = new Map<string, string>();
  for (const c of categories) {
    const names = pathNames(c.id);
    const exportNames = [...names];
    if (exportNames[0] === formatTransactionTypeLabel(t, c.type) || rootLabels.has(exportNames[0] ?? "")) {
      exportNames.shift();
    }
    labelById.set(c.id, exportNames.map((name) => systemCategoryLabel(name, t)).join("."));
  }
  return labelById;
}

/**
 * 导出里的「账户」身份串（所有者·机构·尾号/名称·类型）。
 *
 * 与界面上的账户标签无关：界面标签跟随「显示 → 账户显示格式」设置，导出要的是
 * 可读且不随设置漂移的完整身份串（guardrail 已显式豁免本函数）。
 */
export function exportAccountLabel(account: ExportAccountLike, fallbackName?: string | null) {
  const owner = account?.kind === "loan" ? "" : account?.AccountGroup?.name?.trim() || "";
  const institution = account?.Institution?.shortName?.trim() || account?.Institution?.name?.trim() || "";
  const accountName = account?.name?.trim() || fallbackName?.trim() || "";
  const isSettlementOrLoan = account?.kind === "loan" || account?.kind === "settlement";
  const qualifiedName = isSettlementOrLoan ? counterpartyQualifiedAccountName(accountName, account?.Counterparty) : accountName;
  const tailOrName = account?.numberMasked?.trim() || qualifiedName;
  const accountType = account?.kind ? kindLabel(account.kind) : "";
  return [owner, institution, tailOrName, accountType].filter(Boolean).join("·");
}

export function stripExportCategoryRootLabel(value?: string | null) {
  const text = value?.trim() ?? "";
  return ["支出", "收入", "转账", "代付", "投资"].includes(text) ? "" : text;
}

export function detailExportHeader(t: TranslateFn) {
  return [
    t("detail.column.date"),
    t("detailView.column.type"),
    t("detail.column.category"),
    t("detail.column.outflow"),
    t("detail.column.inflow"),
    t("common.account"),
    t("batchImport.field.counterAccount"),
    t("detail.column.counterparty"),
    t("detail.column.tags"),
    t("detail.column.remark"),
  ];
}

/** 导出行的视图口径：全部由调用方按「单账户 / 全部收支」各自的口径注入。 */
export type DetailExportRowContext<T extends DetailExportEntryLike = DetailExportEntryLike> = {
  t: TranslateFn;
  /** 分类 id → 导出用完整路径（`buildCategoryExportLabels`） */
  categoryExportLabels: Map<string, string>;
  /** 是否信用卡还款行（分类列显示「信用卡还款」） */
  isCreditCardRepayment: (entry: T) => boolean;
  /** 资金侧账户 id：决定备注取哪一侧、以及是否记在对手方那一侧 */
  flowAccountIdOf: (entry: T) => string | null | undefined;
  /** 表格「账户」列显示的那一侧账户 id */
  tableAccountIdOf: (entry: T) => string | null | undefined;
  /** 表格口径金额：流出为负、流入为正 */
  flowAmountOf: (entry: T) => number;
  /** 生效日（YYYY-MM-DD） */
  dateOf: (entry: T) => string;
  /** 账户 id → 导出身份串 */
  accountLabelOf: (accountId?: string | null) => string;
};

function entryTagNames(entry: DetailExportEntryLike) {
  const source = entry.entryTags ?? entry.EntryTag ?? [];
  return source
    .map((item) => item?.Tag?.name?.trim() || "")
    .filter(Boolean)
    .join("、");
}

function exportCategoryNameOf<T extends DetailExportEntryLike>(entry: T, ctx: DetailExportRowContext<T>) {
  const { t } = ctx;
  if (ctx.isCreditCardRepayment(entry)) return t("transaction.category.creditCardRepayment");
  if (entry.categoryId) {
    return ctx.categoryExportLabels.get(entry.categoryId)
      ?? systemCategoryLabel(stripExportCategoryRootLabel(entry.categoryName), t);
  }
  if (entry.type === "investment") {
    if (entry.source === "insurance") return getInsuranceDetailCategoryName(entry);
    return systemCategoryLabel(stripExportCategoryRootLabel(entry.categoryName), t)
      || systemCategoryLabel(getInvestmentCategoryName(entry), t)
      || "";
  }
  if (entry.categoryName) return systemCategoryLabel(stripExportCategoryRootLabel(entry.categoryName), t);
  if (entry.type === "income" && entry.source === "advance") {
    return t("systemCategory.reimbursement");
  }
  return systemCategoryLabel(stripExportCategoryRootLabel(entry.categoryName), t);
}

function exportTypeNameOf<T extends DetailExportEntryLike>(entry: T, ctx: DetailExportRowContext<T>) {
  if (entry.source === "insurance") return getInsuranceDetailCategoryName(entry);
  if ((entry.source === "advance" || entry.source === "reimbursement") && entry.type !== "expense") {
    return ctx.t("txForm.advance");
  }
  return formatTransactionTypeLabel(ctx.t, entry.type);
}

function exportNoteOf<T extends DetailExportEntryLike>(entry: T, ctx: DetailExportRowContext<T>) {
  const fromNote = (entry.note ?? "").trim();
  const receiverNote = (entry.toNote ?? "").trim();
  const flowAccountId = ctx.flowAccountIdOf(entry);
  const displayNote = !flowAccountId
    ? fromNote
    : entry.toAccountId === flowAccountId
      ? (receiverNote || fromNote)
      : fromNote;
  return getInsuranceDetailNote({
    source: entry.source,
    fundName: entry.fundName,
    fundSubtype: entry.fundSubtype,
    note: displayNote,
  });
}

/** 逐行生成资金明细导出行（不含表头）。顺序即传入顺序。 */
export function buildDetailExportRows<T extends DetailExportEntryLike>(
  entries: readonly T[],
  ctx: DetailExportRowContext<T>,
): Array<{ id: string; row: string[] }> {
  return entries.map((entry, index) => {
    const amount = ctx.flowAmountOf(entry);
    const outflow = amount < 0 ? String(-amount) : "";
    const inflow = amount > 0 ? String(amount) : "";
    const tableAccountId = ctx.tableAccountIdOf(entry);
    const isToSide = Boolean(tableAccountId && entry.toAccountId === tableAccountId);
    const accountLabel = ctx.accountLabelOf(isToSide ? entry.toAccountId : entry.accountId);
    const counterAccountLabel = entry.type === "transfer" || entry.type === "investment"
      ? ctx.accountLabelOf(isToSide ? entry.accountId : entry.toAccountId)
      : "";
    return {
      id: String(entry.id ?? index),
      row: [
        ctx.dateOf(entry),
        exportTypeNameOf(entry, ctx),
        exportCategoryNameOf(entry, ctx),
        outflow,
        inflow,
        accountLabel,
        counterAccountLabel,
        entry.counterpartyInstitutionName ?? "",
        entryTagNames(entry),
        exportNoteOf(entry, ctx),
      ],
    };
  });
}
