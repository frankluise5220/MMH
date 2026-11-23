/**
 * 对账锁定 / 解锁必须「就地改行」，不能触发整份重取。
 *
 * 背景：这两列（reconciledAt / reconciledBalance）是唯一会变的东西，行集合、日期、
 * 金额、账户、排序、逐笔余额都不变。早先它被归类为「结构变化」，BasicDetailPanel
 * 于是重新拉当前页，「全部」视图更是整份重拉几万行 —— 用户点一次锁要等好几秒。
 * 现在服务端在响应里回传落库值，前端用 applyReconcileRecords 按 id 合并。
 *
 * 守卫点：① 事件分档必须仍是 "text"；② 合并只覆盖这两列、不动其它字段；
 * ③ 幂等（同样的值再合一次要返回原数组引用，免得无谓 setState）。
 */
import assert from "node:assert/strict";

void (async () => {
  const { applyReconcileRecords, classifyFinanceEntryChange } = await import("../src/lib/client/refresh");

  assert.equal(classifyFinanceEntryChange({ reason: "entry-reconcile", entryIds: ["a"] }), "text");
  assert.equal(
    classifyFinanceEntryChange({ reason: "entry-edit", entryIds: ["a"], balanceChanged: true }),
    "structure",
  );

  type Row = {
    id: string;
    amount: number;
    runningBalance: number;
    reconciledAt?: string | null;
    reconciledBalance?: number | null;
  };
  const rows: Row[] = [
    { id: "a", amount: 10, runningBalance: 10 },
    { id: "b", amount: 20, runningBalance: 30 },
  ];

  const lockedAt = "2026-11-23T02:00:00.000Z";
  const patched = applyReconcileRecords(rows, [{ id: "a", reconciledAt: lockedAt, reconciledBalance: 10 }]);
  assert.notEqual(patched, rows);
  assert.deepEqual(patched[0], {
    id: "a",
    amount: 10,
    runningBalance: 10,
    reconciledAt: lockedAt,
    reconciledBalance: 10,
  });
  assert.equal(patched[1], rows[1], "未命中的行必须保持同一引用");

  assert.equal(
    applyReconcileRecords(patched, [{ id: "a", reconciledAt: lockedAt, reconciledBalance: 10 }]),
    patched,
    "幂等：同样的落库值不应产生新数组",
  );

  const unlocked = applyReconcileRecords(patched, [{ id: "a", reconciledAt: null, reconciledBalance: null }]);
  assert.equal(unlocked[0].reconciledAt, null);
  assert.equal(unlocked[0].reconciledBalance, null);
  assert.equal(unlocked[0].amount, 10, "解锁不能把金额带掉");
  assert.equal(unlocked[0].runningBalance, 10, "解锁不能把逐笔余额带掉");

  assert.equal(
    applyReconcileRecords(rows, [{ id: "zzz", reconciledAt: lockedAt, reconciledBalance: 1 }]),
    rows,
    "本页没有该行时原样返回",
  );

  console.log("verify-reconcile-inplace-patch: all assertions passed");
})();
