/**
 * 明细「查找」窗的条件模型（客户端表单 ↔ 服务端 filters ↔ URL 参数）。
 *
 * 为什么单独一层：查找与时间轴（`range`）属于**同一级**筛选——都是先把数据集
 * 裁一遍再取数 / 计数，不是在已取回的行上做列筛选。所以条件必须能序列化成
 * 服务端白名单里的 `filters`（见 `detail-query-filters.ts`），并且能写进 URL，
 * 首屏（RSC）与客户端翻页才会用同一套口径。
 *
 * 这里刻意不 import `detail-query-filters.ts`：那份文件依赖 Prisma，客户端
 * 组件引用它会把服务端运行时拖进 bundle（`check:client-boundary` 会报）。
 */

export type DetailSearchFlow = "" | "in" | "out";

export const DETAIL_SEARCH_TYPES = ["expense", "income", "transfer", "investment"] as const;
export type DetailSearchType = (typeof DETAIL_SEARCH_TYPES)[number];

export type DetailSearchForm = {
  keyword: string;
  from: string;
  to: string;
  flow: DetailSearchFlow;
  amountFrom: string;
  amountTo: string;
  types: DetailSearchType[];
  accountIds: string[];
  categoryIds: string[];
};

/** 服务端过滤条件的形态（与 `DetailFilters` 结构一致，值一律是字符串数组）。 */
export type DetailSearchFilters = Record<string, string[]>;

const DATE_YMD = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_SET = new Set<string>(DETAIL_SEARCH_TYPES);

export function emptyDetailSearchForm(): DetailSearchForm {
  return {
    keyword: "",
    from: "",
    to: "",
    flow: "",
    amountFrom: "",
    amountTo: "",
    types: [],
    accountIds: [],
    categoryIds: [],
  };
}

function text(value: unknown, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function ymd(value: unknown) {
  const normalized = text(value, 10);
  return DATE_YMD.test(normalized) ? normalized : "";
}

function amountText(value: unknown) {
  const normalized = text(value, 20).replace(/,/g, "");
  return /^\d*(\.\d*)?$/.test(normalized) ? normalized : "";
}

function idList(value: unknown, max = 200) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => text(item, 120))
        .filter(Boolean)
        .slice(0, max),
    ),
  );
}

/** 把任意输入（URL 参数 / 旧状态）收敛成合法表单；非法值和超长文本直接丢弃。 */
export function normalizeDetailSearchForm(raw: unknown): DetailSearchForm {
  const form = emptyDetailSearchForm();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return form;
  const record = raw as Record<string, unknown>;
  form.keyword = text(record.keyword);
  form.from = ymd(record.from);
  form.to = ymd(record.to);
  form.flow = record.flow === "in" || record.flow === "out" ? record.flow : "";
  form.amountFrom = amountText(record.amountFrom);
  form.amountTo = amountText(record.amountTo);
  form.types = (Array.isArray(record.types) ? record.types : [])
    .map((item) => text(item, 40))
    .filter((item): item is DetailSearchType => TYPE_SET.has(item));
  form.accountIds = idList(record.accountIds);
  form.categoryIds = idList(record.categoryIds);
  if (form.from && form.to && form.from > form.to) {
    [form.from, form.to] = [form.to, form.from];
  }
  const fromNumber = Number(form.amountFrom);
  const toNumber = Number(form.amountTo);
  if (form.amountFrom && form.amountTo && Number.isFinite(fromNumber) && Number.isFinite(toNumber) && fromNumber > toNumber) {
    [form.amountFrom, form.amountTo] = [form.amountTo, form.amountFrom];
  }
  return form;
}

/** 没有生效条件时返回 null —— 调用方据此把 URL 参数删掉，别留一个 `{}` 尾巴。 */
export function parseDetailSearchParam(raw: string | null | undefined): DetailSearchForm | null {
  const source = text(raw, 4000);
  if (!source) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const form = normalizeDetailSearchForm(parsed);
  return detailSearchFormIsEmpty(form) ? null : form;
}

export function serializeDetailSearchForm(form: DetailSearchForm | null | undefined): string {
  if (!form || detailSearchFormIsEmpty(form)) return "";
  return JSON.stringify(normalizeDetailSearchForm(form));
}

export function detailSearchFormIsEmpty(form: DetailSearchForm | null | undefined): boolean {
  if (!form) return true;
  return detailSearchFormConditionCount(form) === 0;
}

/** 生效的条件组数（弹窗按钮上的「查找 N 项」用它，不是值的个数）。 */
export function detailSearchFormConditionCount(form: DetailSearchForm | null | undefined): number {
  if (!form) return 0;
  let count = 0;
  if (form.keyword) count += 1;
  if (form.from || form.to) count += 1;
  if (form.amountFrom || form.amountTo) count += 1;
  if (form.types.length > 0) count += 1;
  if (form.accountIds.length > 0) count += 1;
  if (form.categoryIds.length > 0) count += 1;
  return count;
}

/** 表单 → 服务端 filters。金额方向决定用 inflow / outflow / amount（绝对值）。 */
export function detailSearchFormToFilters(form: DetailSearchForm | null | undefined): DetailSearchFilters | null {
  if (!form) return null;
  const normalized = normalizeDetailSearchForm(form);
  const filters: DetailSearchFilters = {};
  if (normalized.keyword) filters.keyword = [normalized.keyword];
  if (normalized.from || normalized.to) filters.date = [`${normalized.from}~${normalized.to}`];
  if (normalized.amountFrom || normalized.amountTo) {
    const key = normalized.flow === "in" ? "inflow" : normalized.flow === "out" ? "outflow" : "amount";
    filters[key] = [`${normalized.amountFrom}~${normalized.amountTo}`];
  }
  if (normalized.types.length > 0) filters.type = [...normalized.types];
  if (normalized.accountIds.length > 0) filters.account = [...normalized.accountIds];
  if (normalized.categoryIds.length > 0) filters.categoryId = [...normalized.categoryIds];
  return Object.keys(filters).length > 0 ? filters : null;
}

/** 一份「字符串数组」字典（表头列筛选、服务端 filters 都是这个形状）。 */
export type DetailFilterDict = Record<string, string[]>;

function normalizeFilterDict(raw: unknown, max: number, valueMax: number): DetailFilterDict | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const result: DetailFilterDict = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const list = Array.from(
      new Set(value.map((item) => text(item, valueMax)).filter(Boolean)),
    ).slice(0, max);
    if (list.length > 0) result[text(key, 40)] = list;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * URL 上的 `filters`：**服务端口径**（account 是 id、categoryId 是 id、remark 是文本…），
 * RSC 首屏、客户端翻页、导出都用它。非法或空返回 null。
 */
export function parseDetailFiltersParam(raw: string | null | undefined): DetailFilterDict | null {
  const source = text(raw, 8000);
  if (!source) return null;
  try {
    return normalizeFilterDict(JSON.parse(source), 50, 200);
  } catch {
    return null;
  }
}

/**
 * URL 上的 `tableFilters`：表头漏斗的**展示值**口径（用户勾选的文本），只用来恢复
 * 漏斗的勾选态；真正下推查询的是翻译后的 `filters`。
 */
export function parseDetailTableFiltersParam(raw: string | null | undefined): DetailFilterDict | null {
  const source = text(raw, 8000);
  if (!source) return null;
  try {
    return normalizeFilterDict(JSON.parse(source), 200, 200);
  } catch {
    return null;
  }
}
