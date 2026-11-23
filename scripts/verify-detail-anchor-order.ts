/**
 * 明细行序：校准余额行恒为当天最末，对账锁定行留在原位。
 *
 * 用户实际触发场景（lhh001，0.1.84）：**同一天里既对账又做余额校准**。
 * 以前两类行共用 `isAnchor DESC` 提权，谁先谁后取决于写入顺序：
 * - 校准行被挤到当天中间 → 其后几行余额整体跳变；
 * - 对账锁定行被当成「当天最后一笔」→ 看起来像锁了一整天。
 *
 * 现在只有「合成锚点」（source=balance_reconcile / initialization + 备注前缀）
 * 提到当天末尾，判断不掺 `reconciledBalance`（校准行自身也可能被锁定）。
 * 客户端比较器与 SQL 的 anchorRank 必须同口径，这里逐条钉住。
 */
import assert from "node:assert/strict";

void (async () => {
  const { compareDetailEntriesDesc } = await import("../src/lib/detail-entry-order");
  const { BALANCE_RECONCILE_SOURCE, BALANCE_INITIALIZATION_SOURCE, BALANCE_RECONCILE_TARGET_PREFIX } =
    await import("../src/lib/balance-reconcile");

  const DAY = "2026-11-20T00:00:00.000Z";
  type Row = Parameters<typeof compareDetailEntriesDesc>[0];

  const row = (patch: Partial<Row> & { id: string }): Row => ({
    date: DAY,
    type: "expense",
    ...patch,
  });
  const at = (hour: number) => new Date(`${DAY.slice(0, 10)}T${String(hour).padStart(2, "0")}:00:00.000Z`);

  const order = (rows: Row[]) => [...rows].sort((a, b) => compareDetailEntriesDesc(a, b)).map((item) => item.id);

  // 场景 1：同日 3 条普通行 + 1 条校准行，其中普通行 b 被对账锁定
  const plainA = row({ id: "a", dayOrder: 300, createdAt: at(9), reconciledBalance: null });
  const lockedB = row({ id: "b", dayOrder: 200, createdAt: at(11), reconciledBalance: 1234.56 });
  const plainC = row({ id: "c", dayOrder: 100, createdAt: at(13) });
  const calib = row({
    id: "calib",
    source: BALANCE_RECONCILE_SOURCE,
    toNote: `${BALANCE_RECONCILE_TARGET_PREFIX}5000.00`,
    createdAt: at(23),
  });

  assert.deepEqual(order([plainA, lockedB, plainC, calib]), ["calib", "a", "b", "c"]);
  assert.deepEqual(
    order([calib, lockedB, plainC, plainA]),
    ["calib", "a", "b", "c"],
    "行序必须与传入顺序无关",
  );

  // 场景 2：校准行自己被对账锁定，仍占当天 #1
  const lockedCalib = { ...calib, reconciledBalance: 5000 } as Row;
  assert.deepEqual(
    order([plainA, lockedB, lockedCalib]),
    ["calib", "a", "b"],
    "被锁定的校准行仍是日终行，另一条锁定行留在原位",
  );

  // 场景 3：期初余额行同口径
  const initial = row({
    id: "init",
    source: BALANCE_INITIALIZATION_SOURCE,
    toNote: `${BALANCE_RECONCILE_TARGET_PREFIX}0.00`,
  });
  assert.equal(order([plainA, plainC, initial])[0], "init");

  // 场景 4：没有锚点的一天，dayOrder 原样生效（回归：别把锁定行提权）
  assert.deepEqual(order([plainC, lockedB, plainA]), ["a", "b", "c"]);
  assert.deepEqual(order([lockedB]), ["b"]);

  // 场景 5：锚点行没有备注前缀（历史脏数据）不算锚点，不能乱提权
  const dirty = row({ id: "dirty", source: BALANCE_RECONCILE_SOURCE, toNote: null });
  assert.deepEqual(order([dirty, plainC, plainA]), ["a", "c", "dirty"]);

  console.log("verify-detail-anchor-order: all assertions passed");
})();
