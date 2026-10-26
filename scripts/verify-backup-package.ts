/**
 * 备份包格式的运行期关卡：编码 → 解码必须无损，老包必须仍能读，体积必须有预算。
 *
 * 静态规则在 scripts/check-backup-package.cjs（调用方有没有绕过编码器）；这里验证
 * src/lib/server/backup-package.ts 本身的行为是否仍然成立：
 *
 *   1. 往返：decode(encode(x)) 深等于 x —— 导出与恢复是同一份契约的两端；
 *   2. 编码确实压缩：文件头是 gzip 魔数，且宽表（每行 70% 是 null）压缩比 ≥ 10 倍；
 *      这条防的是「有人为了好调试把编码改回 JSON.stringify」，那正好把 125MB 的包和
 *      恢复时的内存峰值一起带回来；
 *   3. 老包可读：无魔数的明文 JSON（formatVersion ≤ 4）走回退分支，结果与压缩包一致；
 *   4. 坏包有明确报错：损坏的 gzip、空文件都必须抛业务可读的错误，而不是解析器的堆栈。
 *
 * 用法：`npm run check:backup-io`（已接入 npm run check:backup）。
 */
import assert from "node:assert/strict";

import {
  BACKUP_FILE_GZIP_MAGIC,
  decodeBackupPackage,
  decodeBackupPayloadJson,
  encodeBackupPackage,
  encodeBackupPayloadJson,
  isGzipBackupPackage,
} from "@/lib/server/backup-package";

const log = (message: string) => console.log(`[backup-io] ${message}`);

/** 一笔宽表交易：真实备份里 76 个字段约 70% 是 null，体积几乎全耗在字段名和空占位上。 */
function wideTransaction(index: number) {
  return {
    id: `tx_${String(index).padStart(6, "0")}`,
    householdId: "hh_target_0001",
    accountId: "acct_0001",
    toAccountId: null,
    categoryId: "cat_0001",
    date: "2026-10-26T00:00:00.000Z",
    postedAt: null,
    type: index % 3 === 0 ? "transfer" : "expense",
    amount: "1234.56",
    note: `第 ${index} 笔`,
    bondSubtype: null,
    bondName: null,
    bondAnnualRate: null,
    bondInterest: null,
    bondArrivalDate: null,
    bondConfirmDate: null,
    bondFee: null,
    depositAnnualRate: null,
    depositInterest: null,
    depositMaturityAction: null,
    fundCode: null,
    fundNav: null,
    fundUnits: null,
    metalTypeId: null,
    metalUnitId: null,
    metalQuantity: null,
    insuranceAction: null,
    insuranceProductId: null,
    reconciledAt: null,
    reconciledBalance: null,
    reimbursementDifferenceAmount: null,
    reimbursementDifferenceCategoryName: null,
    deletedAt: null,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  };
}

function buildPayload(rowCount: number) {
  const transactions = Array.from({ length: rowCount }, (_, index) => wideTransaction(index));
  return {
    app: "MMH" as const,
    formatVersion: 4,
    exportedAt: "2026-10-26T00:00:00.000Z",
    scope: { householdId: "hh_source_0001", householdName: "默认", backupScope: "household" as const },
    counts: { accounts: 1, transactions: rowCount },
    data: {
      household: { id: "hh_source_0001", name: "默认", baseCurrency: "CNY" },
      transactions,
      accounts: [{ id: "acct_0001", name: "现金", type: "cash", balance: "100.00" }],
    },
  };
}

function main() {
  const payload = buildPayload(3000);

  // 1. 往返无损：备份是便携文档，导出端加的任何变换都必须在读侧被完整还原。
  const encoded = encodeBackupPackage(payload);
  assert.ok(isGzipBackupPackage(encoded), "encodeBackupPackage 必须产出 gzip 包（魔数 1f 8b）。");
  assert.equal(encoded[0], BACKUP_FILE_GZIP_MAGIC[0]);
  assert.equal(encoded[1], BACKUP_FILE_GZIP_MAGIC[1]);
  assert.deepEqual(decodeBackupPackage(encoded), payload, "decode(encode(payload)) 必须与 payload 完全一致。");
  log(`往返无损：${payload.data.transactions.length} 条宽表交易`);

  // 2. 体积预算：宽表 JSON 压缩比必须 ≥ 10 倍，低于这个数量级说明压缩被绕过了。
  const rawBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  const ratio = rawBytes / encoded.length;
  assert.ok(
    ratio >= 10,
    `压缩比只有 ${ratio.toFixed(1)} 倍（${rawBytes} → ${encoded.length} 字节）：备份包必须保持 gzip，` +
      "否则 12 万笔的账簿会重新变成 100MB+ 的文件，恢复时的内存峰值也跟着回来。",
  );
  log(`压缩比 ${ratio.toFixed(1)} 倍（${(rawBytes / 1024 / 1024).toFixed(1)}MB → ${(encoded.length / 1024).toFixed(0)}KB）`);

  // 3. 老包可读：formatVersion ≤ 4 的明文包没有魔数，必须走 UTF-8 JSON 回退分支。
  const legacyPlain = Buffer.from(JSON.stringify(payload), "utf8");
  assert.ok(!isGzipBackupPackage(legacyPlain), "明文包不应被误判为 gzip。");
  assert.deepEqual(
    decodeBackupPackage(legacyPlain),
    payload,
    "明文老包必须与压缩包解析出完全相同的对象：跨版本恢复靠的就是这条分支。",
  );
  log("老包回退：明文 JSON（formatVersion 4）解析结果与压缩包一致");

  // 3b. 加密包：载荷先压缩再加密（compress-then-encrypt），顺序反了就等于没压。
  const payloadBytes = encodeBackupPayloadJson(payload);
  assert.ok(isGzipBackupPackage(payloadBytes), "加密路径的载荷必须同样压缩（gzip 魔数）。");
  assert.deepEqual(decodeBackupPayloadJson(payloadBytes), payload, "加密路径的载荷往返必须无损。");
  const payloadRatio = rawBytes / payloadBytes.length;
  assert.ok(
    payloadRatio >= 10,
    `加密载荷压缩比只有 ${payloadRatio.toFixed(1)} 倍：` +
      "密文是高熵字节，若先加密再压缩，125MB 的账簿仍是 120MB（实测），必须先压缩后加密。",
  );
  log(`加密载荷压缩比 ${payloadRatio.toFixed(1)} 倍（同一份数据，先压后加密）`);

  // 4. 坏包必须有可读的报错。
  const corrupted = Buffer.from(encoded);
  corrupted.fill(0x00, 40, 120);
  assert.throws(
    () => decodeBackupPackage(corrupted),
    /损坏|无法解压/,
    "损坏的 gzip 包必须抛出可读错误（提示文件损坏），而不是 zlib 的原始异常。",
  );
  assert.throws(() => decodeBackupPackage(Buffer.alloc(0)), /为空/, "空文件必须给出明确提示。");
  log("坏包与空文件：报错可读");

  log("PASS");
}

main();
