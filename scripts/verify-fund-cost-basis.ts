/**
 * 基金持仓成本口径（moving_avg / fifo / lifo）回归守卫。
 *
 * 背景（2026-11-26 用户报告）：把「开放基金」账户的成本口径从移动加权改成先进先出后，
 * 519066 的持仓成本显示 43943.21，而该基金实际剩余批次成本是 28515.63
 * （基金公司 APP 的 27100 是移动加权口径）。根因在 calcByFifo 的赎回分支：
 * 每次赎回都从全量买入行重扫出一份 lot 队列算成本，而批次表 codeLots 另走一条路，
 * 已经赎回吃掉的份额被重复计入，成本扣减与剩余批次脱节，越赎越偏。
 *
 * 运行：npx tsx scripts/verify-fund-cost-basis.ts
 */
process.env.DATABASE_URL ??= "postgresql://guard:guard@127.0.0.1:5432/guard";

type Entry = {
  id: string;
  fundCode: string;
  amount: number;
  fee: number;
  arrivalAmount: number | null;
  units: number | null;
  subtype: string;
  source: string | null;
  isPending: boolean;
  confirmDate: string | null;
  arrivalDate: string | null;
  netBuyAmount: number | null;
};

let seq = 0;
function buy(date: string, gross: number, units: number, opts: { source?: string; code?: string } = {}): Entry {
  seq += 1;
  return {
    id: `b${seq}`,
    fundCode: opts.code ?? "519066",
    amount: -Math.abs(gross),
    fee: 0,
    arrivalAmount: null,
    units,
    subtype: "buy",
    source: opts.source ?? "manual",
    isPending: false,
    confirmDate: date,
    arrivalDate: date,
    netBuyAmount: Math.abs(gross),
  };
}

function redeem(date: string, units: number, proceeds: number, opts: { code?: string } = {}): Entry {
  seq += 1;
  return {
    id: `r${seq}`,
    fundCode: opts.code ?? "519066",
    amount: Math.abs(proceeds),
    fee: 0,
    arrivalAmount: Math.abs(proceeds),
    units,
    subtype: "redeem",
    source: "manual",
    isPending: false,
    confirmDate: date,
    arrivalDate: date,
    netBuyAmount: null,
  };
}

const failures: string[] = [];

function approx(actual: number | undefined, expected: number, label: string, tol = 0.005) {
  const a = actual ?? 0;
  if (Math.abs(a - expected) > tol) failures.push(`${label}: expected ${expected}, got ${a}`);
}

type Lot = { units: number; cpu: number };

const calcDate = (e: Entry) =>
  e.subtype === "buy"
    ? (e.confirmDate ?? e.arrivalDate ?? "")
    : (e.confirmDate ?? e.arrivalDate ?? "");

/** 参考实现：唯一批次队列，赎回只吃当前剩余批次（排序规则与主实现一致）。 */
function refLots(entries: Entry[], lifo: boolean) {
  const lots: Lot[] = [];
  let units = 0;
  let cost = 0;
  const realized = new Map<string, number>();
  const sorted = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const d = calcDate(a.e).localeCompare(calcDate(b.e));
      return d !== 0 ? d : a.i - b.i;
    })
    .map((x) => x.e);
  for (const e of sorted) {
    const u = e.units ?? 0;
    if (e.subtype === "buy") {
      if (u > 0) {
        const c = Math.abs(e.netBuyAmount ?? e.amount);
        lots.push({ units: u, cpu: c / u });
        units += u;
        cost += c;
      }
      continue;
    }
    if (e.subtype !== "redeem") continue;
    const queue = lifo ? [...lots].reverse() : lots;
    let need = u;
    let out = 0;
    for (const lot of queue) {
      if (need <= 0) break;
      const take = Math.min(lot.units, need);
      out += take * lot.cpu;
      lot.units -= take;
      need -= take;
    }
    for (let i = lots.length - 1; i >= 0; i -= 1) if (lots[i].units <= 1e-9) lots.splice(i, 1);
    units = Math.max(0, units - (u - need));
    cost = Math.max(0, cost - out);
    realized.set(e.id, Math.abs(e.arrivalAmount ?? e.amount) - out);
  }
  return { units, cost, realized, lots };
}

async function main() {
  const { calculateFundPositionsFromEntries } = await import("../src/lib/fund/recalcPosition");

  // ── 场景 1：两次赎回，第二次必须从「剩余批次」扣成本（旧实现会多扣/漏扣） ──
  const s1 = [
    buy("2015-01-05", 1000, 1000),
    buy("2016-01-05", 1000, 500),
    buy("2017-01-05", 0, 100, { source: "dividend" }), // 分红再投：份额入账、成本 0
    redeem("2018-01-05", 1200, 2200), // 吃 1000@1 + 200@2 → 成本 1400
    redeem("2019-01-05", 200, 500), // 吃 200@2 → 成本 400
  ];
  const fifo1 = calculateFundPositionsFromEntries(s1, 2, "fifo");
  const h1 = fifo1.holdings.get("519066");
  approx(h1?.units, 200, "场景1 fifo units");
  approx(h1?.cost, 200, "场景1 fifo cost（剩余 100 份@2 + 100 份分红再投@0）");
  const ref1 = refLots(s1, false);
  approx(h1?.cost, ref1.cost, "场景1 fifo cost 与参考实现一致");

  // ── 场景 2：无赎回时三种口径给出同一成本 ──
  const s2 = [buy("2024-01-02", 900, 300), buy("2024-02-02", 1200, 400)];
  for (const method of ["moving_avg", "fifo", "lifo"]) {
    const h = calculateFundPositionsFromEntries(s2, 2, method).holdings.get("519066");
    approx(h?.cost, 2100, `场景2 ${method} cost`);
    approx(h?.units, 700, `场景2 ${method} units`);
  }

  // ── 场景 3：赎回超出持仓不得产生负份额 / 负成本 / NaN 收益 ──
  const s3 = [buy("2024-01-02", 1000, 1000), redeem("2024-03-01", 1500, 1800)];
  const fifo3 = calculateFundPositionsFromEntries(s3, 2, "fifo");
  const h3 = fifo3.holdings.get("519066");
  approx(h3?.units, 0, "场景3 fifo units 归零");
  approx(h3?.cost, 0, "场景3 fifo cost 归零");
  const r3 = fifo3.realizedProfitByEntryId.get(s3[1]!.id) ?? 0;
  if (!Number.isFinite(r3)) failures.push("场景3 realizedProfit 出现非数值");

  // ── 场景 4：分红再投批次参与 FIFO 顺序（先买先出，不受 0 成本影响） ──
  const s4 = [buy("2024-01-02", 0, 500, { source: "dividend" }), buy("2024-02-02", 1000, 500), redeem("2024-03-02", 500, 900)];
  const fifo4 = calculateFundPositionsFromEntries(s4, 2, "fifo");
  approx(fifo4.holdings.get("519066")?.cost, 1000, "场景4 fifo 吃掉 0 成本批次后剩 500@2");
  const lifo4 = calculateFundPositionsFromEntries(s4, 2, "lifo");
  approx(lifo4.holdings.get("519066")?.cost, 0, "场景4 lifo 吃掉后买的批次，剩 0 成本份额");

  // ── 场景 5：多次赎回（模拟 519066 的 5 次）逐步与参考实现对齐 ──
  const s5 = [
    buy("2015-08-05", 500, 242.84),
    buy("2016-03-02", 1000, 621.73),
    buy("2018-01-15", 0, 793.21, { source: "dividend" }),
    buy("2019-06-26", 65, 25.11),
    redeem("2019-07-01", 12928.87, 33925.35),
    buy("2020-03-18", 1000, 405.29),
    buy("2021-02-17", 450, 97.35),
    redeem("2021-03-07", 3316.42, 12274.08),
    redeem("2021-04-20", 206.5, 823.72),
    buy("2022-05-11", 350, 122.75),
    redeem("2022-10-10", 2889.03, 8260.27),
    buy("2024-10-16", 450, 183.79),
    buy("2025-06-22", 3835, 1615.59),
    redeem("2026-03-22", 6393.91, 19328.7),
  ];
  for (const method of ["fifo", "lifo"] as const) {
    const res = calculateFundPositionsFromEntries(s5, 2, method);
    const h = res.holdings.get("519066");
    const ref = refLots(s5, method === "lifo");
    approx(h?.units, ref.units, `场景5 ${method} units`);
    approx(h?.cost, ref.cost, `场景5 ${method} cost`);
    for (const e of s5) {
      if (e.subtype !== "redeem") continue;
      approx(res.realizedProfitByEntryId.get(e.id), ref.realized.get(e.id) ?? 0, `场景5 ${method} 赎回 ${e.confirmDate} 已实现收益`);
    }
  }

  // ── 场景 6：伪随机序列（固定种子）与参考实现逐项一致 ──
  let seed = 20261126;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const random: Entry[] = [];
  let day = 1;
  let held = 0;
  for (let i = 0; i < 60; i += 1) {
    day += 3;
    const date = `20${String(10 + Math.floor(day / 300)).padStart(2, "0")}-${String(1 + ((day % 12) + 1)).padStart(2, "0")}-${String(1 + (day % 27)).padStart(2, "0")}`;
    if (held < 50 || rand() < 0.6) {
      const units = Math.round(50 + rand() * 950);
      const nav = 1 + rand() * 3;
      random.push(buy(date, Math.round(units * nav * 100) / 100, units));
      held += units;
    } else {
      const units = Math.round(20 + rand() * Math.min(held, 600));
      random.push(redeem(date, units, Math.round(units * (1 + rand() * 3) * 100) / 100));
      held -= units;
    }
  }
  for (const method of ["fifo", "lifo"] as const) {
    const res = calculateFundPositionsFromEntries(random, 2, method);
    const h = res.holdings.get("519066");
    const ref = refLots(random, method === "lifo");
    approx(h?.units, ref.units, `场景6 ${method} units`);
    approx(h?.cost, ref.cost, `场景6 ${method} cost`);
  }

  if (failures.length > 0) {
    console.error("fund cost basis guard FAILED");
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("fund cost basis guard PASS (fifo/lifo 赎回批次、分红再投、超卖、随机序列)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
