const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://mmh-fs:mmh-fs@192.168.5.148:5433/mmh?schema=public" });

async function main() {
  let r = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('TransactionEntry', 'EntryTag', 'Attachment') ORDER BY table_name`);
  console.log("Remaining old tables:", r.rows.map(x => x.table_name));
  
  r = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'Attachment' AND table_schema = 'public'`);
  console.log("Attachment columns:", r.rows.map(x => x.column_name));
  
  // Make sure TransactionEntry is dropped
  await pool.query('DROP TABLE IF EXISTS "TransactionEntry" CASCADE');
  console.log("Ensured TransactionEntry dropped");
  
  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
