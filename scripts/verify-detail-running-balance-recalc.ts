/**
 * 明细「余额」列删除后重算的口径校验。
 *
 * 运行：npm run check:running-balance
 *
 * 覆盖的口径（与 src/lib/detail-running-balance.ts 的分支一一对应）：
 *   ① 当前列表就是账户全部历史 → 从头整段重折叠
 *   ② 分页窗口 + 普通删除 → 增量修正
 *   ③ 分页窗口 + 删的是校准锚点行 → 常量平移（target − 锚点前一条未删行的余额）
 *   ④ 校准日之前删流水 → 校准之后**不能**被挪位（旧实现在这里算错）
 *   ⑤ 被删锚点之前没有任何已加载行 → complete=false，交回上层按页重取
 *
 * 期望值不依赖被测代码，而是手工按「余额 = 逐条折叠」重算出来的真值。
 */

import {
  recalculateLoadedRunningBalances,
  removeEntriesAndUpdateRunningBalances,
  type RunningBalanceEntry,
} from "../src/lib/detail-running-balance";

type Case = {
  name: string;
  entries: RunningBalanceEntry[];
  deletedIds: string[];
  /** 期望：id → 删除后的余额。未列出的行必须保持原值。 */
  expected: Record<string, number>;
  complete?: boolean;
};

let failed = 0;
let passed = 0;

/** 按「余额 = 逐条折叠」算出真值，用来构造用例的初始 runningBalance。 */
function foldBalances(entries: RunningBalanceEntry[], accountId: string): RunningBalanceEntry[] {
  return recalculateLoadedRunningBalances(
    entries.map((entry) => ({ ...entry, runningBalance: null })),
    accountId,
    null,
  );
}

function entry(
  id: string,
  day: string,
  amount: number,
  extra: Partial<RunningBalanceEntry> = {},
): RunningBalanceEntry {
  return {
    id,
    date: `${day}T00:00:00.000Z`,
    amount,
    type: amount >= 0 ? "income" : "expense",
    accountId: "acc",
    toAccountId: null,
    source: null,
    fundSubtype: null,
    fundProductType: null,
    postedAt: null,
    createdAt: `${day}T00:00:00.000Z`,
    dayOrder: 0,
    ...extra,
  };
}

/** 期初余额 / 余额校准锚点行：把余额钉成 target。 */
function anchor(id: string, day: string, target: number): RunningBalanceEntry {
  return entry(id, day, 0, {
    type: "income",
    source: "balance_reconcile",
    toNote: `balance_reconcile_target:${target.toFixed(2)}`,
  });
}

/** 备注带了校准目标值、但来源不是「余额校准 / 期初」：服务端 SQL 不当它是锚点。 */
function fakeAnchor(id: string, day: string, target: number): RunningBalanceEntry {
  return entry(id, day, 0, {
    type: "income",
    source: "manual",
    toNote: `balance_reconcile_target:${target.toFixed(2)}`,
  });
}

function runCase(testCase: Case) {
  const accountId = "acc";
  const result = removeEntriesAndUpdateRunningBalances(
    testCase.entries,
    new Set(testCase.deletedIds),
    accountId,
    null,
  );

  const problems: string[] = [];
  const remaining = result.entries.filter((item) => !testCase.deletedIds.includes(item.id));
  if (remaining.length !== result.entries.length) {
    problems.push("已删行仍然留在结果里");
  }
  for (const item of result.entries) {
    const expected = testCase.expected[item.id];
    if (expected == null) continue;
    if (Math.abs((item.runningBalance ?? Number.NaN) - expected) > 0.005) {
      problems.push(
        `${item.id}: 期望 ${expected}，实际 ${item.runningBalance}`,
      );
    }
  }
  const expectedComplete = testCase.complete ?? true;
  if (result.complete !== expectedComplete) {
    problems.push(`complete: 期望 ${expectedComplete}，实际 ${result.complete}`);
  }

  if (problems.length > 0) {
    failed += 1;
    console.error(`✗ ${testCase.name}`);
    for (const problem of problems) console.error(`    ${problem}`);
    return;
  }
  passed += 1;
  console.log(`✓ ${testCase.name}`);
}

// ── 基线：E1(+100) → A(校准 500) → E2(−50) ───────────────────────────────
const base = foldBalances(
  [entry("E1", "2026-01-01", 100), anchor("A", "2026-02-01", 500), entry("E2", "2026-03-01", -50)],
  "acc",
);

// 分页窗口（不是账户起点，首行余额 450 ≠ 自身贡献 20，确保走增量分支②③）
// + 中间夹一条校准锚点：
//   W0(+20, 余 450) → W1(+30, 余 480) → A2(校准 500, 余 500) → W2(−20, 余 480)
const window: RunningBalanceEntry[] = [
  { ...entry("W0", "2026-03-01", 20), runningBalance: 450 },
  { ...entry("W1", "2026-04-01", 30), runningBalance: 480 },
  { ...anchor("A2", "2026-05-01", 500), runningBalance: 500 },
  { ...entry("W2", "2026-06-01", -20), runningBalance: 480 },
];

const cases: Case[] = [
  {
    // ① 列表就是账户全部历史 → 整段重折叠
    name: "① 全量列表：删中间一条，其后整体平移",
    entries: base,
    deletedIds: ["E1"],
    // 校准锚点把余额钉在 500，E1 的删除影响不到它之后
    expected: { A: 500, E2: 450 },
  },
  {
    // ②③ 分页窗口 + 校准日之前删流水：只有校准点**之前**的行跟着变，
    //   校准点及其之后**不能**被挪位。
    //   旧实现会把 A2 算成 500 − 20 = 480、W2 算成 480 − 20 = 460
    name: "②③ 分页窗口：校准日之前删流水，校准点之后保持不动",
    entries: window,
    deletedIds: ["W0"],
    expected: { W1: 460, A2: 500, W2: 480 },
  },
  {
    name: "②③ 分页窗口：校准日之前删中间一条，同理不越校准点",
    entries: window,
    deletedIds: ["W1"],
    expected: { W0: 450, A2: 500, W2: 480 },
  },
  {
    // ②③ 分页窗口 + 删校准锚点：Δ = target − 锚点前一条未删行的余额 = 500 − 480
    name: "②③ 分页窗口：删校准锚点，其后平移常量 20",
    entries: window,
    deletedIds: ["A2"],
    expected: { W0: 450, W1: 480, W2: 460 },
  },
  {
    // ②③ 分页窗口 + 校准之后删流水：锚点行不动
    name: "②③ 分页窗口：校准之后删流水，锚点行不动",
    entries: window,
    deletedIds: ["W2"],
    expected: { W0: 450, W1: 480, A2: 500 },
  },
  {
    // ② 分页窗口（列表不是从账户起点开始）+ 普通删除
    name: "② 分页窗口：删最旧一条，其后整体减去其贡献",
    entries: [
      { ...entry("M1", "2026-04-01", 30), runningBalance: 480 },
      { ...entry("M2", "2026-05-01", -20), runningBalance: 460 },
      { ...entry("M3", "2026-06-01", 5), runningBalance: 465 },
    ],
    deletedIds: ["M1"],
    expected: { M2: 430, M3: 435 },
  },
  {
    // ② 删中间的，只有更后的行受影响
    name: "② 分页窗口：删中间一条，之前的行不动",
    entries: [
      { ...entry("M1", "2026-04-01", 30), runningBalance: 480 },
      { ...entry("M2", "2026-05-01", -20), runningBalance: 460 },
      { ...entry("M3", "2026-06-01", 5), runningBalance: 465 },
    ],
    deletedIds: ["M2"],
    expected: { M1: 480, M3: 485 },
  },
  {
    // ③ 删的是锚点行：其后整体平移 (target − 锚点前一条未删行的余额)
    //    Δ = 500 − 100 = 400 → E2: 450 − 400 = 50
    name: "③ 删校准锚点行：其后整体平移常量",
    entries: base,
    deletedIds: ["A"],
    expected: { E1: 100, E2: 50 },
  },
  {
    // ④ 校准日之前删流水：校准之后**不能**被挪位（旧实现会把 E2 算成 350）
    name: "④ 校准日之前删流水：校准之后的余额保持不动",
    entries: base,
    deletedIds: ["E1"],
    expected: { A: 500, E2: 450 },
  },
  {
    // ④ 变体：锚点之后删流水
    name: "④ 校准日之后删流水：锚点行不动，其后平移",
    entries: base,
    deletedIds: ["E2"],
    expected: { E1: 100, A: 500 },
  },
  {
    // ⑤ 被删锚点之前没有任何已加载行 → 拿不到基准，必须交回上层重取
    name: "⑤ 被删锚点之前无已加载行：complete=false",
    entries: [
      { ...anchor("A", "2026-02-01", 500), runningBalance: 500 },
      { ...entry("E2", "2026-03-01", -50), runningBalance: 450 },
    ],
    deletedIds: ["A"],
    expected: {},
    complete: false,
  },
  {
    // 锚点判定必须与服务端 SQL 一致：只认来源是「余额校准 / 期初余额」的行。
    // 备注带了目标值但来源不对 → 不是锚点，删它之前的流水要一直影响到它之后。
    // 若误判为锚点，FAKE 会停在 450、F1 停在 480（与刷新后的服务端结果不一致）。
    name: "锚点口径：来源不是校准/期初的行不算锚点",
    entries: [
      { ...entry("F0", "2026-03-01", 20), runningBalance: 450 },
      { ...fakeAnchor("FAKE", "2026-04-01", 999), runningBalance: 450 },
      { ...entry("F1", "2026-05-01", 30), runningBalance: 480 },
    ],
    deletedIds: ["F0"],
    expected: { FAKE: 430, F1: 460 },
  },
  {
    // 边界：删掉的行不在当前页 → 原地返回，complete=true
    name: "边界：删除集合不含本页任何行 → 原样返回",
    entries: base,
    deletedIds: ["NOT_LOADED"],
    expected: { E1: 100, A: 500, E2: 450 },
  },
  {
    // 批量删除：删锚点 + 删它之后的普通行（段内锚点只认最后一个）
    name: "批量：同时删锚点与其后一条",
    entries: base,
    deletedIds: ["A", "E2"],
    expected: { E1: 100 },
  },
];

console.log("明细余额删除重算 · 口径校验");
console.log("");
for (const testCase of cases) runCase(testCase);
console.log("");
console.log(`通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exit(1);
