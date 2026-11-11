import { parseItems, parseLedgerLines, parseTransactionSuccessReminder, type ParsedItem } from "@/lib/ai/parser";

/**
 * 守卫「一次给多条记录」的解析行为。
 *
 * 背景：batch_table 规则分支把用户原文直接交给 parseItems，原文不是 JSON，
 * 旧实现会兜底成一笔、金额取最后一个数字，并被前端当成单笔静默入库。
 * 这里锁住这些契约：
 *   1. 多行带日期 → 逐行切分，条数正确、金额不串行；
 *   2. 一行里塞多笔（按日期锚点二次切分）也要切开，不能只留最后一笔；
 *   3. 无年份日期（11月01日 / 行首 11-01）按业务年补全；
 *   4. 汇总行、分隔线不算流水；尾号卡号不算金额；
 *   5. 多笔一律 directImport=false（必须人工确认）；
 *   6. 单行自然语言仍是单笔（不误伤）；
 *   7. 模型返回的 JSON 仍按原样解析（不被逐行逻辑截胡）。
 */

const now = new Date("2026-11-11T10:00:00+08:00");
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
}

function amounts(items: ParsedItem[]) {
  return items.map((item) => item.amount);
}

console.log("[1] 三行带日期");
{
  const text = "2026-11-01 早餐 15\n2026-11-02 打车 32\n2026-11-03 超市 120";
  const out = parseItems(text, now, text);
  check("条数为 3", out.items.length === 3, out.items.length);
  check("金额逐行对应", JSON.stringify(amounts(out.items)) === JSON.stringify([15, 32, 120]), amounts(out.items));
  check("日期逐行对应", out.items.map((i) => i.date).join(",") === "2026-11-01,2026-11-02,2026-11-03", out.items.map((i) => i.date));
  check("directImport=false", out.directImport === false, out.directImport);
}

console.log("[2] 三行带竖线列");
{
  const text = "2026-11-01 | 早餐 | 15\n2026-11-02 | 打车 | 32\n2026-11-03 | 超市 | 120";
  const out = parseItems(text, now, text);
  check("条数为 3", out.items.length === 3, out.items.length);
  check("金额逐行对应", JSON.stringify(amounts(out.items)) === JSON.stringify([15, 32, 120]), amounts(out.items));
  check("备注去掉了分隔符", out.items.every((i) => !/\|/.test(i.remark ?? "")), out.items.map((i) => i.remark));
}

console.log("[3] 卡号/尾号不当金额");
{
  const text = "2026-11-01 尾号3833 午餐 42\n2026-11-02 尾号9988 咖啡 28";
  const out = parseItems(text, now, text);
  check("条数为 2", out.items.length === 2, out.items.length);
  check("金额取的是消费额", JSON.stringify(amounts(out.items)) === JSON.stringify([42, 28]), amounts(out.items));
}

console.log("[4] 单行自然语言保持单笔");
{
  const text = "早餐15";
  const out = parseItems(text, now, text);
  check("条数为 1", out.items.length === 1, out.items.length);
  check("金额为 15", out.items[0]?.amount === 15, out.items[0]?.amount);
  check("parseLedgerLines 不接管单行", parseLedgerLines(text, now) === null);
}

console.log("[5] 模型 JSON 仍按原样解析");
{
  const raw = '```json\n{"operation":"create","items":[{"rawText":"早餐","type":"expense","date":"2026-11-01","amount":15},{"rawText":"打车","type":"expense","date":"2026-11-02","amount":32}]}\n```';
  const out = parseItems(raw, now, "早餐15 打车32");
  check("条数为 2", out.items.length === 2, out.items.length);
  check("金额为 15/32", JSON.stringify(amounts(out.items)) === JSON.stringify([15, 32]), amounts(out.items));
}

console.log("[6] 无年份日期（11月01日 / 行首 11-01）");
{
  const md = parseItems("11月01日 早餐 15\n11月02日 打车 32", now, "11月01日 早餐 15\n11月02日 打车 32");
  check("11月01日 解析出 2 条", md.items.length === 2, md.items.length);
  check("11月01日 补成当年日期", md.items[0]?.date === "2026-11-01", md.items[0]?.date);
  check("备注不残留「月 日」", md.items.every((i) => !/月|日/.test(i.remark ?? "")), md.items.map((i) => i.remark));

  const head = "11-01 早餐 15\n11-02 打车 32";
  const out = parseItems(head, now, head);
  check("行首 11-01 解析出 2 条", out.items.length === 2, out.items.length);
  check("行首 11-01 金额不被日期串号", JSON.stringify(amounts(out.items)) === JSON.stringify([15, 32]), amounts(out.items));
}

console.log("[7] 汇总行与分隔线不算流水");
{
  const text = "====================\n2026-11-01 早餐 15\n2026-11-02 打车 32\n合计 47";
  const out = parseItems(text, now, text);
  check("条数为 2（合计行被跳过）", out.items.length === 2, out.items.length);
  check("金额为 15/32", JSON.stringify(amounts(out.items)) === JSON.stringify([15, 32]), amounts(out.items));
}

console.log("[8] 银行短信三连仍走专用解析");
{
  const text = [
    "交易成功提醒",
    "交易时间：11月01日 08:00",
    "交易金额：15.00",
    "交易商户：早餐店",
    "交易成功提醒",
    "交易时间：11月02日 09:00",
    "交易金额：32.00",
    "交易商户：出租车",
  ].join("\n");
  const out = parseTransactionSuccessReminder(text, now);
  check("条数为 2", out?.items.length === 2, out?.items.length);
  check("金额为 15/32", JSON.stringify(out ? amounts(out.items) : []) === JSON.stringify([15, 32]), out ? amounts(out.items) : []);
}

console.log("[9] 一行挤三笔：切段后反向校验同格式");
{
  // now 故意与原文日期不同：日期若仍等于 11-11，说明取自原文而不是「今天」兜底。
  const laterNow = new Date("2026-12-20T10:00:00+08:00");
  const text = "2026-11-11 45.50 生活费 浦发信用卡人民币 2026-11-11 37.10 邮储信用卡 生活费 2026-11-11 生活费 36.12 邮储信用卡_庆华";
  const out = parseItems(text, laterNow, text);
  check("条数为 3", out.items.length === 3, out.items.length);
  check("金额逐笔分开", JSON.stringify(amounts(out.items)) === JSON.stringify([45.5, 37.1, 36.12]), amounts(out.items));
  check("日期取自原文", out.items.every((item) => item.date === "2026-11-11"), out.items.map((item) => item.date));
  check("directImport=false", out.directImport === false, out.directImport);

  // 反验要拦住的形态：区间描述被日期锚点切成「没有金额的一段 + 有金额的一段」。
  const range = "2026-11-01 到 2026-11-30 共消费 1000 元";
  const rangeOut = parseItems(range, laterNow, range);
  check("区间描述不切段", rangeOut.items.length === 1, rangeOut.items.length);

  // 纯日期、没有金额与描述的两段，同样不能当成两笔。
  const bare = "2026-11-01 2026-11-02";
  const bareOut = parseItems(bare, laterNow, bare);
  check("纯日期不切段", bareOut.items.length === 1, bareOut.items.length);

  // 45.50 若被当成「45 月 50 日」，金额会被日期吞掉。
  const decimals = "2026-11-05 45.50 早餐 2026-11-06 37.10 午餐";
  const decOut = parseItems(decimals, laterNow, decimals);
  check("小数金额不被当日期", JSON.stringify(amounts(decOut.items)) === JSON.stringify([45.5, 37.1]), amounts(decOut.items));

  // 卡名只写在其中一段：流水常省略账户后缀，不能因此判成不同格式。
  const mixed = "2026-11-01 早餐 15 浦发信用卡 2026-11-02 打车 32";
  const mixedOut = parseItems(mixed, laterNow, mixed);
  check("账户词不一致仍切 2 条", mixedOut.items.length === 2, mixedOut.items.length);

  // 一段里两个金额（带余额列）：形态不可靠，宁可整行交回上层，不做牺牲性切分。
  const twoAmounts = "2026-11-01 早餐 15 余额 300 2026-11-02 打车 32";
  const taOut = parseItems(twoAmounts, laterNow, twoAmounts);
  check("一段两个金额不切段", taOut.items.length === 1, taOut.items.length);
}

if (failed > 0) {
  console.error(`\nai ledger parse: ${failed} 处不符合预期`);
  process.exit(1);
}
console.log("\nai ledger parse ok");
