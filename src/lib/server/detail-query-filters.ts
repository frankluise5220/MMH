import { Prisma } from "@prisma/client";

/**
 * 明细列表的**服务端**筛选 / 排序白名单。
 *
 * 为什么需要这一层：明细「全部」模式原本把整份数据拉进浏览器，表头漏斗和列排序
 * 都在内存里算（见 AdvancedDataTable 的 filteredRows / orderedRows）。4 万行已经是
 * 30 MB 量级，百万行没有任何可能拉到前端，所以筛选与排序必须下推成 SQL。
 *
 * 安全约束（务必遵守）：
 * - 列 key 只能来自下面的白名单，SQL 片段全部用 Prisma 模板拼接，绝不拼裸字符串；
 * - 比较值只接受字符串/数字并做长度与数量截断；
 * - 不使用 `::` 双冒号（fnOS / 群晖 包跑 SQLite，会在语法解析阶段直接报错），
 *   日期一律 `CAST(... AS TEXT)` 后按 `YYYY-MM-DD` 字符串比较。
 */

/** 可下推的筛选列。key 与前端明细列的 `key` 保持一致，路由层无需再翻译。 */
const DETAIL_FILTER_KEYS = [
  "date",
  "postedAt",
  "createdAt",
  "updatedAt",
  "type",
  "currency",
  "category",
  "account",
  "remark",
  "entryOrigin",
  "inflow",
  "outflow",
] as const;

type DetailFilterKey = (typeof DETAIL_FILTER_KEYS)[number];
export type DetailFilters = Partial<Record<DetailFilterKey, string[]>>;

/** 可下推的排序列。date 是默认排序（按生效日），其余为单列覆盖。 */
const DETAIL_SORT_KEYS = [
  "date",
  "postedAt",
  "amount",
  "inflow",
  "outflow",
  "createdAt",
  "updatedAt",
  "type",
  "currency",
  "category",
  "account",
  "remark",
  "entryOrigin",
] as const;

type DetailSortKey = (typeof DETAIL_SORT_KEYS)[number];
export type DetailSortState = { key: DetailSortKey; direction: "asc" | "desc" };

/** 单个筛选列最多保留多少个候选值（表头漏斗是枚举多选）。 */
const MAX_FILTER_VALUES = 200;
/** 单个候选值最大长度，防止超长字符串拖垮 SQL。 */
const MAX_FILTER_VALUE_LENGTH = 200;

const FILTER_KEY_SET = new Set<string>(DETAIL_FILTER_KEYS);
const SORT_KEY_SET = new Set<string>(DETAIL_SORT_KEYS);

function normalizeFilterValue(value: unknown) {
  if (value == null) return "";
  return String(value).trim().slice(0, MAX_FILTER_VALUE_LENGTH);
}

/** 把请求里的筛选 JSON 收敛成白名单结构；非法 key / 空值一律丢弃。 */
export function normalizeDetailFilters(raw: unknown): DetailFilters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: DetailFilters = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!FILTER_KEY_SET.has(key)) continue;
    const list = (Array.isArray(value) ? value : [value])
      .map(normalizeFilterValue)
      .filter(Boolean)
      .slice(0, MAX_FILTER_VALUES);
    if (list.length > 0) result[key as DetailFilterKey] = Array.from(new Set(list));
  }
  return result;
}


/**
 * 去掉日期区间筛选。
 *
 * 表头时间筛选器的滑轨两端必须按**全量**数据算：如果边界也跟着 `date` 筛选走，
 * 用户拖一次区间，滑轨就会收缩到刚选的范围，再也拖不回更早的日期。
 */
export function omitDetailDateFilter(filters: DetailFilters | null | undefined): DetailFilters | null {
  if (!filters?.date) return filters ?? null;
  const next: DetailFilters = { ...filters };
  delete next.date;
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * 工具栏「时间范围」双滑块 = **数据范围**，不是日期列的取值筛选。
 *
 * 两者的区别不是文案。日期列筛选（表头日期漏斗 / 双击日期输入）是「这一列的
 * 值落在区间内」，只作用于已经取回的行；时间范围是先把数据集本身裁到区间、
 * 再按范围取数 / 计数 / 算漏斗，因此它必须与 `filters` 完全独立：
 * - 写进 `filters.date` 的话，用户改一次日期列筛选就会把滑块范围冲掉；
 * - 反过来，拖一次滑块又看起来像是改了日期列的筛选。
 *
 * 所以范围单独翻页参数（`range=from~to`）下推 SQL，落在 `visible` 层的
 * `displayAt` 上，与 `filters.date` 取交集（范围是前提，列筛选是范围之内再挑）。
 */
export type DetailDateRange = { from: string; to: string };

const DATE_YMD = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDetailDateRange(fromRaw: unknown, toRaw: unknown): DetailDateRange | null {
  const from = DATE_YMD.test(String(fromRaw ?? "").trim()) ? String(fromRaw).trim() : "";
  const to = DATE_YMD.test(String(toRaw ?? "").trim()) ? String(toRaw).trim() : "";
  if (!from && !to) return null;
  // 上下界颠倒时以用户拖出来的先后为准，交换回正序，避免空结果让人以为没生效。
  if (from && to && from > to) return { from: to, to: from };
  return { from, to };
}

/** `range=2021-10-26~2026-10-26`；单边可省略（`2021-10-26~` / `~2026-10-26`）。 */
export function parseDetailDateRange(raw: string | null | undefined): DetailDateRange | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const [fromRaw = "", toRaw = ""] = text.split("~");
  return normalizeDetailDateRange(fromRaw, toRaw);
}


/**
 * 范围谓词。别名与 `buildDetailFilterSql` 一致（`c`），同样注入 `visible` 层，
 * 保证「总数 / 当前页 / 漏斗计数」三处口径统一。
 */
export function buildDetailDateRangeSql(range: DetailDateRange | null | undefined): Prisma.Sql {
  if (!range) return Prisma.empty;
  const predicates: Prisma.Sql[] = [];
  if (range.from) predicates.push(Prisma.sql`CAST(DATE(c."displayAt") AS TEXT) >= ${range.from}`);
  if (range.to) predicates.push(Prisma.sql`CAST(DATE(c."displayAt") AS TEXT) <= ${range.to}`);
  if (predicates.length === 0) return Prisma.empty;
  return Prisma.sql`AND ${Prisma.join(predicates, " AND ")}`;
}

/** `sort=amount:desc` 形式；非法值返回 null，回落到默认排序。 */
export function parseDetailSort(raw: string | null | undefined): DetailSortState | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const [key, dir] = text.split(":");
  if (!SORT_KEY_SET.has(key)) return null;
  return { key: key as DetailSortKey, direction: dir === "asc" ? "asc" : "desc" };
}


/** `2024-01-01~2024-12-31`、`2024-01-01`、`~2024-12-31` 三种写法。 */
function parseDateRange(value: string) {
  const [fromRaw, toRaw] = value.split("~");
  const from = /^\d{4}-\d{2}-\d{2}$/.test((fromRaw ?? "").trim()) ? fromRaw.trim() : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test((toRaw ?? "").trim()) ? toRaw.trim() : null;
  return { from, to };
}

/** 金额区间只接受数字，非数字整条丢弃（避免把用户手输的文本塞进 DECIMAL 比较）。 */
function parseAmountRange(value: string) {
  const [fromRaw, toRaw] = value.split("~");
  const toNumber = (text: string | undefined) => {
    const trimmed = (text ?? "").trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const from = toNumber(fromRaw);
  const to = toNumber(toRaw);
  if (from == null && to == null) return null;
  return { from, to };
}

/**
 * 生成作用在 `visible` 层（别名 `c`）的筛选谓词。
 *
 * 注入点选 `visible` 是刻意的：`countEntries` 直接 `FROM "visible"`，分页取数
 * `FROM "ordered"`（`ordered` 由 `visible` 派生且不增删行），在这一层过滤能保证
 * 「总数」与「当前页」口径永远一致；若放到 `displayed` / `ordered`，计数与分页
 * 会各算一次口径，翻页时总对不上。
 */
export function buildDetailFilterSql(filters: DetailFilters | null | undefined): Prisma.Sql {
  if (!filters) return Prisma.empty;
  const predicates: Prisma.Sql[] = [];

  const dateColumnFilter = (column: Prisma.Sql, values: string[]) => {
    const ranges = values.map(parseDateRange).filter((range) => range.from || range.to);
    ranges.forEach((range) => {
      if (range.from) predicates.push(Prisma.sql`CAST(DATE(${column}) AS TEXT) >= ${range.from}`);
      if (range.to) predicates.push(Prisma.sql`CAST(DATE(${column}) AS TEXT) <= ${range.to}`);
    });
  };

  for (const [key, values] of Object.entries(filters) as Array<[DetailFilterKey, string[]]>) {
    if (!values || values.length === 0) continue;
    switch (key) {
      case "date":
        dateColumnFilter(Prisma.sql`c."displayAt"`, values);
        break;
      case "postedAt":
        dateColumnFilter(Prisma.sql`COALESCE(c."postedAt", c."date")`, values);
        break;
      case "createdAt":
        dateColumnFilter(Prisma.sql`c."createdAt"`, values);
        break;
      case "updatedAt":
        dateColumnFilter(Prisma.sql`c."updatedAt"`, values);
        break;
      case "inflow":
      case "outflow": {
        const ranges = values.map(parseAmountRange).filter((range): range is { from: number | null; to: number | null } => !!range);
        const flowSql = key === "inflow"
          ? Prisma.sql`CASE WHEN c."amount" > 0 THEN c."amount" ELSE NULL END`
          : Prisma.sql`CASE WHEN c."amount" < 0 THEN -c."amount" ELSE NULL END`;
        ranges.forEach((range) => {
          if (range.from != null) predicates.push(Prisma.sql`${flowSql} >= ${range.from}`);
          if (range.to != null) predicates.push(Prisma.sql`${flowSql} <= ${range.to}`);
        });
        break;
      }
      case "type":
        predicates.push(Prisma.sql`CAST(c."type" AS TEXT) IN (${Prisma.join(values)})`);
        break;
      case "currency":
        predicates.push(Prisma.sql`CAST(COALESCE(c."currency", 'CNY') AS TEXT) IN (${Prisma.join(values)})`);
        break;
      case "category":
        predicates.push(Prisma.sql`COALESCE(c."categoryName", '') IN (${Prisma.join(values)})`);
        break;
      case "account":
        // 表头漏斗的候选值是展示名（含机构前缀），因此列与名两种值都要能命中。
        predicates.push(Prisma.sql`(
          CAST(c."accountId" AS TEXT) IN (${Prisma.join(values)})
          OR COALESCE(c."accountName", '') IN (${Prisma.join(values)})
        )`);
        break;
      case "remark":
        predicates.push(Prisma.sql`COALESCE(c."note", '') IN (${Prisma.join(values)})`);
        break;
      case "entryOrigin":
        predicates.push(Prisma.sql`COALESCE(c."source", '') IN (${Prisma.join(values)})`);
        break;
      default:
        break;
    }
  }

  if (predicates.length === 0) return Prisma.empty;
  return Prisma.sql`AND ${Prisma.join(predicates, " AND ")}`;
}

/**
 * 单列排序的 SQL 片段（别名 `o`，即 `ordered` 层）。
 *
 * 只在「无逐笔余额」的多账户视图（全部收支等）生效：单账户明细的余额列必须按
 * 时间顺序折叠，任意改排序都会让余额对不上，调用方需自行忽略。
 */
export function buildDetailOrderBySql(sort: DetailSortState | null | undefined): Prisma.Sql | null {
  if (!sort || !SORT_KEY_SET.has(sort.key)) return null;
  const dir = sort.direction === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  switch (sort.key) {
    case "date":
      return Prisma.sql`o."dayKey" ${dir}, o."id" DESC`;
    case "postedAt":
      return Prisma.sql`o."postedAt" ${dir}, o."id" DESC`;
    case "amount":
      return Prisma.sql`o."amount" ${dir}, o."id" DESC`;
    case "inflow":
      return Prisma.sql`CASE WHEN o."amount" > 0 THEN o."amount" ELSE NULL END ${dir}, o."id" DESC`;
    case "outflow":
      return Prisma.sql`CASE WHEN o."amount" < 0 THEN -o."amount" ELSE NULL END ${dir}, o."id" DESC`;
    case "createdAt":
      return Prisma.sql`o."createdAt" ${dir}, o."id" DESC`;
    case "updatedAt":
      return Prisma.sql`o."updatedAt" ${dir}, o."id" DESC`;
    case "type":
      return Prisma.sql`CAST(o."type" AS TEXT) ${dir}, o."id" DESC`;
    case "currency":
      return Prisma.sql`COALESCE(o."currency", 'CNY') ${dir}, o."id" DESC`;
    case "category":
      return Prisma.sql`COALESCE(o."categoryName", '') ${dir}, o."id" DESC`;
    case "account":
      return Prisma.sql`COALESCE(o."accountName", '') ${dir}, o."id" DESC`;
    case "remark":
      return Prisma.sql`COALESCE(o."note", '') ${dir}, o."id" DESC`;
    case "entryOrigin":
      return Prisma.sql`COALESCE(o."source", '') ${dir}, o."id" DESC`;
    default:
      return null;
  }
}

/** 表头漏斗的候选列（服务端 distinct）。与 DETAIL_FILTER_KEYS 中可枚举的列一致。 */
export const DETAIL_FACET_COLUMNS: Array<{ key: DetailFilterKey; expression: Prisma.Sql }> = [
  { key: "type", expression: Prisma.sql`CAST(c."type" AS TEXT)` },
  { key: "currency", expression: Prisma.sql`CAST(COALESCE(c."currency", 'CNY') AS TEXT)` },
  { key: "category", expression: Prisma.sql`COALESCE(c."categoryName", '')` },
  { key: "account", expression: Prisma.sql`COALESCE(c."accountName", '')` },
  { key: "remark", expression: Prisma.sql`COALESCE(c."note", '')` },
  { key: "entryOrigin", expression: Prisma.sql`COALESCE(c."source", '')` },
];
