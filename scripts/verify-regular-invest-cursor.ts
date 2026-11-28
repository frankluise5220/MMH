/**
 * 基金定投「执行 / 补记」的起点与墓碑口径守卫。
 *
 * 2026-11-25 用户报：日频定投（2026-10-30 起，已执行到 11-25）在明细里把旧期次删干净后，
 * 把「下个执行日」改成 2026-10-30 再点「执行」，只生成了 11-25 这一天的申购。
 * 根因：批量执行的起点取「最近一笔记录 + 一个周期」，用户改「下个执行日」完全不生效；
 * 于是每点一次执行只往未来推一期，历史永远补不回来，净值预加载也只从 lastRunDate 开始。
 *
 * 本守卫锁住 resolveFundBatchExecuteCursor 的口径：
 * - 起点 = 计划的「下个执行日」（用户唯一能拨动的游标）；
 * - 用户把游标拨回「上次执行 + 一个周期」之前时，早于上次执行日期的墓碑允许重做；
 * - 游标没回拨 / 墓碑正好落在最近一期时，墓碑照旧拦补记（刚删掉的期次不能被造回来）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveFundBatchExecuteCursor } from "../src/lib/server/regular-invest-plan";
import { calcNextScheduledRunDate } from "../src/lib/scheduled-task-date";
import { formatDateUtc } from "../src/lib/date-utils";
import type { IntervalUnit } from "@prisma/client";

const utc = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

/** 与 batch-execute 的 while 循环一致：逐日推进 + isBlocked 判定 */
function enumerate(cursor: ReturnType<typeof resolveFundBatchExecuteCursor>, end: Date) {
  const dates: string[] = [];
  let lastDuplicate: Date | null = null;
  let cur = cursor.startDate;
  while (cur <= end) {
    const key = formatDateUtc(cur);
    if (!cursor.isBlocked(key, cur)) dates.push(key);
    else if (!lastDuplicate || cur > lastDuplicate) lastDuplicate = cur;
    cur = calcNextScheduledRunDate(cur, "day" as IntervalUnit, 1, null, true, null);
  }
  return { dates, lastDuplicate };
}

let failures = 0;
function assert(name: string, ok: boolean, detail: string) {
  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}  <-- ${detail}`);
  }
}

const today = utc("2026-11-25");

// 场景 1：用户实际数据。10-30 起日频已执行到 11-25，旧期次（10-30~11-24）全被删成墓碑，
// 又把下个执行日拨回 10-30 后点「执行」。期望：10-30~11-24 重新补出，11-25 不重复。
const tombstoned = ["2026-10-30", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
  "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17",
  "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24"];
const cursor1 = resolveFundBatchExecuteCursor({
  nextRunDate: utc("2026-10-30"),
  lastRunDate: utc("2026-11-25"),
  latestRecordDate: utc("2026-11-25"),
  startDate: utc("2026-10-30"),
  intervalUnit: "day" as IntervalUnit,
  intervalValue: 1,
  existingDates: new Set([...tombstoned, "2026-11-25"]),
  liveDates: new Set(["2026-11-25"]),
});
const run1 = enumerate(cursor1, today);
assert("起点 = 下个执行日 2026-10-30", formatDateUtc(cursor1.startDate) === "2026-10-30", formatDateUtc(cursor1.startDate));
assert("识别出「游标被显式回拨」", cursor1.cursorMovedBack, String(cursor1.cursorMovedBack));
assert("回拨后重新补出 18 期（10-30~11-24）", run1.dates.length === 18, run1.dates.join(","));
assert("已存在的 11-25 不重复生成", !run1.dates.includes("2026-11-25"), run1.dates.join(","));
assert(
  "补记后游标越过 11-25（下一期 11-26）",
  !!run1.lastDuplicate &&
    formatDateUtc(calcNextScheduledRunDate(run1.lastDuplicate, "day" as IntervalUnit, 1, null, true, null)) === "2026-11-26",
  run1.lastDuplicate ? formatDateUtc(run1.lastDuplicate) : "null",
);

// 场景 2：日常执行（游标没回拨）。用户删掉 11-25，游标停在 11-26 → 墓碑生效。
const cursor2 = resolveFundBatchExecuteCursor({
  nextRunDate: utc("2026-11-26"),
  lastRunDate: utc("2026-11-25"),
  latestRecordDate: utc("2026-11-25"),
  startDate: utc("2026-10-30"),
  intervalUnit: "day" as IntervalUnit,
  intervalValue: 1,
  existingDates: new Set(tombstoned.concat("2026-11-25")),
  liveDates: new Set<string>(),
});
const run2 = enumerate(cursor2, today);
assert("游标未回拨时墓碑生效（被删的期次不再补出）", run2.dates.length === 0, run2.dates.join(","));

// 场景 2b：游标正好停在被删的最近一期 → 仍然不重造。
const cursor2b = resolveFundBatchExecuteCursor({
  nextRunDate: utc("2026-11-25"),
  lastRunDate: utc("2026-11-25"),
  latestRecordDate: utc("2026-11-25"),
  startDate: utc("2026-10-30"),
  intervalUnit: "day" as IntervalUnit,
  intervalValue: 1,
  existingDates: new Set(["2026-11-25"]),
  liveDates: new Set<string>(),
});
const run2b = enumerate(cursor2b, today);
assert("刚删掉的最近一期不会被补回来", run2b.dates.length === 0, run2b.dates.join(","));

// 场景 3：把游标往前拨（跳过一段时间）→ 不生成游标之前的期次。
const cursor3 = resolveFundBatchExecuteCursor({
  nextRunDate: utc("2026-11-20"),
  lastRunDate: utc("2026-11-19"),
  latestRecordDate: utc("2026-11-19"),
  startDate: utc("2026-10-30"),
  intervalUnit: "day" as IntervalUnit,
  intervalValue: 1,
  existingDates: new Set(["2026-11-19"]),
  liveDates: new Set(["2026-11-19"]),
});
const run3 = enumerate(cursor3, today);
assert("起点 = 用户设定的 11-20", formatDateUtc(cursor3.startDate) === "2026-11-20", formatDateUtc(cursor3.startDate));
assert("不生成 11-20 之前的期次", run3.dates[0] === "2026-11-20", run3.dates.join(","));

// 场景 4：老数据没有游标 → 退回「最近记录 + 一个周期」（11-20 → 11-23，跳过休市）。
const cursor4 = resolveFundBatchExecuteCursor({
  nextRunDate: null,
  lastRunDate: utc("2026-11-20"),
  latestRecordDate: utc("2026-11-20"),
  startDate: utc("2026-10-30"),
  intervalUnit: "day" as IntervalUnit,
  intervalValue: 1,
  existingDates: new Set(["2026-11-20"]),
  liveDates: new Set(["2026-11-20"]),
});
assert("无游标时起点 = 最近记录 + 一个周期", formatDateUtc(cursor4.startDate) === "2026-11-23", formatDateUtc(cursor4.startDate));

// 场景 5：回拨到上次执行日当天 → 该日墓碑照旧拦着，只补真正到期的 11-25。
const cursor5 = resolveFundBatchExecuteCursor({
  nextRunDate: utc("2026-11-24"),
  lastRunDate: utc("2026-11-24"),
  latestRecordDate: utc("2026-11-24"),
  startDate: utc("2026-10-30"),
  intervalUnit: "day" as IntervalUnit,
  intervalValue: 1,
  existingDates: new Set(["2026-11-24"]),
  liveDates: new Set<string>(),
});
const run5 = enumerate(cursor5, today);
assert("上次执行日当天的墓碑仍生效", run5.dates.length === 1 && run5.dates[0] === "2026-11-25", run5.dates.join(","));

// ── 净值预加载范围守卫（2026-11-26）─────────────────────────────────────────
// 用户报「点执行全部，卡了几分钟」。根因不是数据库：执行全部会对**每个**执行中的
// 基金计划逐个调 /api/v1/fund/preload-nav，而那次生产环境的容器 DNS 单次 4s，
// 59 个计划 = 4 分钟；其中绝大多数计划的「下个执行日」还在未来，根本不用预加载
// （旧实现把起点「夹」到 today，于是照样回源一次今天的净值）。
const clientSource = readFileSync(
  join(process.cwd(), "src/app/(sidebar)/regular-invest/RegularInvestClient.tsx"),
  "utf8",
);
const preloadCalls = clientSource.match(/\/api\/v1\/fund\/preload-nav/g)?.length ?? 0;
assert("批量执行不再逐个计划预加载净值", preloadCalls === 1, `preload-nav 调用点 = ${preloadCalls} 处`);
assert(
  "预加载范围在「没有到期期次」时短路为 null",
  clientSource.includes("function navPreloadRange(") && clientSource.includes("if (start > endDate) return null;"),
  "缺少 navPreloadRange 的未来游标短路",
);
assert(
  "预加载请求带超时（不让外网慢把执行拖住）",
  clientSource.includes("signal: AbortSignal.timeout("),
  "preload-nav 缺少 AbortSignal.timeout",
);

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`);
  process.exit(1);
}
console.log("\n全部通过");
