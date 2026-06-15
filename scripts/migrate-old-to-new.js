const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://mmh-fs:mmh-fs@192.168.5.148:5433/mmh?schema=public" });

async function main() {
  // 1. 给 transactions 表加新列 (如果不存在)
  const adds = [
    `ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "currency" VARCHAR NOT NULL DEFAULT 'CNY'`,
    `ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "status" VARCHAR NOT NULL DEFAULT 'posted'`,
    `ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "paymentChannelId" VARCHAR`,
    `ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "paymentChannelName" VARCHAR`,
  ];
  for (const sql of adds) {
    try { await pool.query(sql); console.log("Added column: " + sql.substring(0, 60) + "..."); }
    catch (e) { console.log("Skipped: " + e.message.substring(0, 60)); }
  }

  // 2. 迁移数据：TransctionEntry → transactions
  // 先查有多少条
  let r = await pool.query(`SELECT COUNT(*) as cnt FROM "TransactionEntry"`);
  const total = Number(r.rows[0].cnt);
  console.log("\nTransactionEntry rows: " + total);

  if (total > 0) {
    // 检查哪些已经迁移了
    r = await pool.query(`
      SELECT COALESCE(MAX("createdAt")::text, 'none') as max_d FROM "transactions"
    `);
    console.log("Existing max createdAt in transactions: " + r.rows[0].max_d);

    // 迁移：按 transactionId 分组，每行 TransactionEntry 生成一条 TxRecord
    // 对于同一个 LedgerTransaction 的多条分录，生成对应的多条 TxRecord
    await pool.query(`
      INSERT INTO "transactions" (
        id, date, type, amount, "accountId", "accountName",
        "toAccountId", "toAccountName", currency, status,
        "categoryId", "categoryName",
        "fundCode", "fundProductType",
        "statementMonth", note,
        "createdAt", "updatedAt"
      )
      SELECT
        te.id,
        lt.date,
        lt.type::text::"TransactionType",
        te.amount,
        te."accountId",
        te."accountName",
        te."toAccountId",
        te."toAccountName",
        COALESCE(te.currency, 'CNY'),
        COALESCE(lt.status, 'posted')::text::"TransactionStatus",
        te."categoryId",
        te."categoryName",
        te."fundCode",
        te."fundProductType"::"FundProductType",
        te."statementMonth",
        te.memo,
        te."createdAt",
        te."updatedAt"
      FROM "TransactionEntry" te
      JOIN "LedgerTransaction" lt ON lt.id = te."transactionId"
      WHERE NOT EXISTS (
        SELECT 1 FROM "transactions" t2 WHERE t2.id = te.id
      )
    `);
    console.log("Migration done.");
  }

  // 3. 迁移 EntryTag → 指向 transactions
  r = await pool.query(`SELECT COUNT(*) as cnt FROM "EntryTag"`);
  console.log("\nEntryTag rows: " + r.rows[0].cnt);
  if (Number(r.rows[0].cnt) > 0) {
    try {
      // Drop old FK, add new FK
      await pool.query(`ALTER TABLE "EntryTag" DROP CONSTRAINT IF EXISTS "EntryTag_entryId_fkey"`);
      await pool.query(`ALTER TABLE "EntryTag" ADD CONSTRAINT "EntryTag_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "transactions"(id) ON DELETE CASCADE`);
      console.log("EntryTag FK updated.");
    } catch (e) { console.log("EntryTag FK: " + e.message.substring(0, 80)); }
  }

  // 4. 迁移 Attachment → 指向 transactions
  r = await pool.query(`SELECT COUNT(*) as cnt FROM "Attachment"`);
  console.log("\nAttachment rows: " + r.rows[0].cnt);
  if (Number(r.rows[0].cnt) > 0) {
    try {
      // Rename transactionId to entryId
      await pool.query(`ALTER TABLE "Attachment" ADD COLUMN IF NOT EXISTS "entryId" VARCHAR`);
      await pool.query(`UPDATE "Attachment" SET "entryId" = "transactionId"`);
      await pool.query(`ALTER TABLE "Attachment" DROP CONSTRAINT IF EXISTS "Attachment_transactionId_fkey"`);
      await pool.query(`ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "transactions"(id) ON DELETE CASCADE`);
      console.log("Attachment FK updated.");
    } catch (e) { console.log("Attachment: " + e.message.substring(0, 80)); }
  }

  // 5. 更新 FundEntry 的 txRecord 关联
  r = await pool.query(`
    SELECT COUNT(*) as cnt FROM "FundEntry" fe
    LEFT JOIN "transactions" t ON t."fundEntryId" = fe.id
    WHERE t.id IS NULL
  `);
  console.log("\nFundEntry without matching transaction: " + r.rows[0].cnt);

  // 6. Verify
  r = await pool.query(`SELECT COUNT(*) as cnt FROM "transactions"`);
  console.log("\ntransactions table total: " + r.rows[0].cnt);

  r = await pool.query(`SELECT COUNT(*) as cnt FROM "FundEntry"`);
  console.log("FundEntry total: " + r.rows[0].cnt);

  console.log("\nDone. Now can drop old tables.");
  await pool.end();
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
