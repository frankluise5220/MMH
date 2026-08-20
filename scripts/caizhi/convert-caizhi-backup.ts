import fs from "node:fs";
import path from "node:path";
import { convertCaizhiBackupToMmhBackup } from "../../src/lib/importers/caizhi/export";

function usage() {
  return [
    "Usage:",
    "  npx tsx scripts/caizhi/convert-caizhi-backup.ts <input.mh8-or-mdb> <output.mmh-backup> <backup-passphrase> [household-name]",
  ].join("\n");
}

async function main() {
  const [, , inputPath, outputPath, passphrase, householdName] = process.argv;
  if (!inputPath || !outputPath || !passphrase) {
    throw new Error(usage());
  }

  const input = path.resolve(inputPath);
  const output = path.resolve(outputPath);
  const buffer = fs.readFileSync(input);
  const result = await convertCaizhiBackupToMmhBackup(
    buffer,
    path.basename(input),
    passphrase,
    { householdName: householdName ?? null },
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, result.json, "utf8");
  process.stdout.write(`${JSON.stringify({ output, fileName: result.fileName, summary: result.summary }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
