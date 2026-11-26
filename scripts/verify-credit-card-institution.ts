/**
 * 信用卡账单的机构名 / 持卡人识别守卫。
 *
 * 2026-11-20 用户报「0.1.87 的历史更新里已经写了这两条修复，实际还在出问题」：
 * - 农商体系（农村商业银行 / 农商银行 / 农村信用社 / 江苏农信）没有统一到账本
 *   的「农商银行」口径，通用 HTML 模板拼出「信用卡信用卡」；
 * - 「尊敬的 付斌 先生，您好」这类写法认不出持卡人，账单落不到既有账户。
 *
 * 覆盖：发卡行识别、持卡人识别、账户名收敛、落回既有账户。
 */
import { detectStatementBankName, isRuralBankName } from "../src/lib/statement/credit-card-institution";
import { extractStatementOwnerName } from "../src/lib/statement/statement-owner-name";
import { parseImportPaymentCardAccount, resolveImportAccountFromList } from "../src/lib/account-import-match";
import {
  createCreditBillAccountResolver,
  getCreditBillAccountIds,
  normalizeAccountCardRole,
  normalizeCreditBillMode,
} from "../src/lib/server/credit-card-institution-settings";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (Object.is(actual, expected)) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}  期望 ${String(expected)}，实际 ${String(actual)}`);
}

// 发卡行：农商体系一律「农商银行」
check("江苏农村商业银行 -> 农商银行", detectStatementBankName("江苏农村商业银行信用卡电子账单"), "农商银行");
check("农商银行简写 -> 农商银行", detectStatementBankName("江苏省农商银行"), "农商银行");
check("农村信用社 -> 农商银行", detectStatementBankName("XX市农村信用社 对账单"), "农商银行");
check("江苏农信 -> 农商银行", detectStatementBankName("江苏农信 电子账单"), "农商银行");
check("江苏农商信用卡 -> 农商银行", detectStatementBankName("江苏农商信用卡"), "农商银行");
check("非农商银行不受影响", detectStatementBankName("招商银行信用卡"), "招商银行");
check("中国工商银行 -> 工商银行", detectStatementBankName("中国工商银行"), "工商银行");
// 「信用卡」不是机构名：认不出就该留空，由账单头部的机构行补齐
check("信用卡不当作机构名", detectStatementBankName("信用卡 电子账单 2026-11"), "");
check("isRuralBankName 农商", isRuralBankName("江苏农村商业银行"), true);
check("isRuralBankName 非农商", isRuralBankName("招商银行"), false);

// 持卡人
check("尊敬的 付斌 先生，您好", extractStatementOwnerName("尊敬的 付斌 先生，您好："), "付斌");
check("尊敬的付斌先生：", extractStatementOwnerName("尊敬的付斌先生："), "付斌");
check("抬头式「付斌 先生」", extractStatementOwnerName("付斌 先生\n账单周期 2026-11"), "付斌");
check("尊敬的客户 不算姓名", extractStatementOwnerName("尊敬的客户，您好"), "");
check("持卡人：付斌", extractStatementOwnerName("持卡人：付斌"), "付斌");

// 账户名收敛
const ruralCredit = parseImportPaymentCardAccount("江苏农村商业银行信用卡(2058)", "付斌");
check("农村商业银行信用卡 机构名", ruralCredit?.institutionName, "农商银行");
check("农村商业银行信用卡 账户名", ruralCredit?.accountName, "付斌农商银行信用卡(2058)");
const ruralUnion = parseImportPaymentCardAccount("农村信用社信用卡(2058)", "付斌");
check("农村信用社信用卡 账户名", ruralUnion?.accountName, "付斌农商银行信用卡(2058)");
const icbcDebit = parseImportPaymentCardAccount("中国工商银行储蓄卡(5516)", "付斌");
check("非农商银行保留原文全称", icbcDebit?.accountName, "付斌中国工商银行储蓄卡(5516)");
// 「江苏农商联合银行」是独立法人机构，不能被并进「农商银行」
const ruralUnionBank = parseImportPaymentCardAccount("江苏农商联合银行储蓄卡(5516)", "墨斗鱼");
check("江苏农商联合银行 保留原文", ruralUnionBank?.accountName, "墨斗鱼江苏农商联合银行储蓄卡(5516)");

// 落回既有账户
const accounts = [
  {
    id: "acc-rural-credit",
    name: "付斌的农商银行信用卡(2058)",
    kind: "bank_credit",
    isActive: true,
    Institution: { name: "农商银行", shortName: "农商行" },
    AccountGroup: { name: "付斌" },
  },
  {
    id: "acc-icbc-debit",
    name: "付斌的中国工商银行储蓄卡(5516)",
    kind: "bank_debit",
    isActive: true,
    Institution: { name: "中国工商银行", shortName: "工行" },
    AccountGroup: { name: "付斌" },
  },
];
for (const text of [
  "付斌的农商银行信用卡(2058)",
  "付斌江苏农村商业银行信用卡(2058)",
  "付斌农商银行信用卡(2058)",
]) {
  check(`落回既有农商信用卡账户：${text}`, resolveImportAccountFromList(text, accounts)?.id, "acc-rural-credit");
}

// ── 附属卡（2026-11-22）：账单模式归一化 + 账单组口径 ──
check("账单模式归一：supplementary", normalizeCreditBillMode("supplementary"), "supplementary");
check("账单模式归一：consolidated", normalizeCreditBillMode("consolidated"), "consolidated");
check("账单模式归一：未知值回落 separate", normalizeCreditBillMode("unknown"), "separate");
check("卡别归一：supplementary", normalizeAccountCardRole("supplementary"), "supplementary");
check("卡别归一：primary", normalizeAccountCardRole("primary"), "primary");
check("卡别归一：存量/未知值回落 primary", normalizeAccountCardRole(undefined), "primary");

type BillRow = {
  id: string;
  householdId: string;
  institutionId: string | null;
  groupId: string;
  kind: string;
  creditBillMode: string;
  cardRole?: string | null;
  primaryCardId: string | null;
};

function mockBillWriter(rows: BillRow[]) {
  const matches = (row: BillRow, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true;
    if (Array.isArray(where.OR) && !where.OR.some((part) => matches(row, part as Record<string, unknown>))) return false;
    for (const [key, cond] of Object.entries(where)) {
      if (key === "OR") continue;
      const value = (row as unknown as Record<string, unknown>)[key];
      if (cond && typeof cond === "object" && !Array.isArray(cond)) {
        const op = cond as Record<string, unknown>;
        if ("in" in op && !(op.in as string[]).includes(String(value))) return false;
        if ("not" in op && value === op.not) return false;
      } else if (value !== cond) return false;
    }
    return true;
  };
  return {
    account: {
      findFirst: async ({ where }: { where?: Record<string, unknown> }) =>
        rows.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: { id?: string } }) => {
        const found = rows.filter((row) => matches(row, where));
        if (orderBy?.id === "asc") found.sort((a, b) => a.id.localeCompare(b.id));
        return found;
      },
    },
  } as never;
}

const hid = "h1";
const inst = "i1";
const owner = "g1";
const credit = (
  id: string,
  mode: string,
  primaryCardId: string | null = null,
  institutionId: string | null = inst,
  groupId = owner,
  cardRole = "primary",
): BillRow => ({
  id, householdId: hid, institutionId, groupId, kind: "bank_credit", creditBillMode: mode, cardRole, primaryCardId,
});
const billIds = async (rows: BillRow[], id: string) => {
  const row = rows.find((item) => item.id === id) as Parameters<typeof getCreditBillAccountIds>[1];
  return (await getCreditBillAccountIds(mockBillWriter(rows), row)).join(",");
};
const snapshotBillIds = (rows: BillRow[], id: string) => {
  const row = rows.find((item) => item.id === id) as Parameters<typeof getCreditBillAccountIds>[1];
  return createCreditBillAccountResolver(
    rows as Parameters<typeof createCreditBillAccountResolver>[0],
  )(row).join(",");
};

void (async () => {
  const separateOnly = [credit("solo", "separate")];
  check("独立账单仍只有自己", await billIds(separateOnly, "solo"), "solo");
  check("Snapshot resolves a separate bill", snapshotBillIds(separateOnly, "solo"), "solo");

  const consolidated = [credit("a", "consolidated"), credit("b", "consolidated")];
  check("合并账单组不受影响", await billIds(consolidated, "b"), "a,b");
  check("Snapshot resolves consolidated bills", snapshotBillIds(consolidated, "b"), "a,b");

  const withSupplementary = [...consolidated, credit("s", "supplementary", "a")];
  check("附属卡并入主卡所在合并账单", await billIds(withSupplementary, "s"), "a,b,s");
  check("Snapshot resolves supplementary and consolidated cards", snapshotBillIds(withSupplementary, "s"), "a,b,s");
  check("主卡账单包含其附属卡", await billIds(withSupplementary, "a"), "a,b,s");
  check("合并组另一张卡也看到同一份账单", await billIds(withSupplementary, "b"), "a,b,s");

  // 2026-11-22 用户裁定：副卡无条件合并，账单模式对副卡不再可选（cardRole 才是口径）。
  const roleDriven = [credit("main2", "consolidated"), credit("sub2", "separate", "main2", inst, owner, "supplementary")];
  check("卡别=副卡即使账单模式是独立也并入主卡", await billIds(roleDriven, "sub2"), "main2,sub2");
  check("主卡侧同样看到卡别副卡", await billIds(roleDriven, "main2"), "main2,sub2");
  check("卡别副卡不能当主卡", await billIds([
    credit("subA", "separate", "subB", inst, owner, "supplementary"),
    credit("subB", "separate", "subA", inst, owner, "supplementary"),
  ], "subA"), "subA");

  const separatePrimary = [credit("m", "separate"), credit("x", "supplementary", "m")];
  check("主卡是独立账单时 = 主卡 + 附属卡", await billIds(separatePrimary, "x"), "m,x");
  check("主卡侧也含附属卡", await billIds(separatePrimary, "m"), "m,x");

  check("主卡缺失退化为单卡", await billIds([credit("orphan", "supplementary", "missing")], "orphan"), "orphan");
  check("Snapshot falls back when primary is missing", snapshotBillIds([credit("orphan", "supplementary", "missing")], "orphan"), "orphan");
  check("附属卡不可再挂附属卡", await billIds([
    credit("s1", "supplementary", "s2"),
    credit("s2", "supplementary", "s1"),
  ], "s1"), "s1");
  check("跨 household 的主卡无效", await billIds([
    { ...credit("main", "separate"), householdId: "h2" },
    credit("cross", "supplementary", "main"),
  ], "cross"), "cross");
  check("Snapshot rejects a primary from another household", snapshotBillIds([
    { ...credit("main", "separate"), householdId: "h2" },
    credit("cross", "supplementary", "main"),
  ], "cross"), "cross");
  check("Snapshot keeps household groups isolated", snapshotBillIds([
    credit("h1-card", "consolidated"),
    { ...credit("h2-card", "consolidated"), householdId: "h2" },
  ], "h1-card"), "h1-card");

  const batchedSnapshot = [
    credit("batch-main-a", "consolidated"),
    credit("batch-main-b", "consolidated"),
    credit("batch-sub", "supplementary", "batch-main-a"),
  ];
  const resolveBatch = createCreditBillAccountResolver(
    batchedSnapshot as Parameters<typeof createCreditBillAccountResolver>[0],
  );
  check("Snapshot resolver can be reused for a primary", resolveBatch(batchedSnapshot[0] as never).join(","), "batch-main-a,batch-main-b,batch-sub");
  check("Snapshot resolver can be reused for a supplementary card", resolveBatch(batchedSnapshot[2] as never).join(","), "batch-main-a,batch-main-b,batch-sub");

  if (failures > 0) {
    console.error(`\n${failures} 个用例失败`);
    process.exit(1);
  }
  console.log("\n全部通过");
})();
