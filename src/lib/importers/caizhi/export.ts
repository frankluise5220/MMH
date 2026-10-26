import { buildBackupFileName, encryptBackupPayload, type HouseholdBackupPayload } from "@/lib/server/backup";
import { encodeBackupPackage } from "@/lib/server/backup-package";
import { buildMmhBackupPayloadFromCaizhi } from "@/lib/importers/caizhi/mapper";
import { parseCaizhiBackupBuffer } from "@/lib/importers/caizhi/parser";
import type { CaizhiConversionOptions, CaizhiConversionSummary } from "@/lib/importers/caizhi/types";

type CaizhiBackupExportResult = {
  fileName: string;
  bytes: Buffer;
  summary: CaizhiConversionSummary;
};

export async function convertCaizhiBackupToMmhBackup(
  buffer: Buffer,
  sourceFileName: string,
  passphrase: string,
  options: CaizhiConversionOptions = {},
): Promise<CaizhiBackupExportResult> {
  const trimmedPassphrase = passphrase.trim();
  if (!trimmedPassphrase) {
    throw new Error("Backup passphrase is required for converted MMH backup files");
  }

  const parsed = parseCaizhiBackupBuffer(buffer, sourceFileName);
  const converted = buildMmhBackupPayloadFromCaizhi(parsed, options);
  const encryptedPayload = await encryptBackupPayload(converted.payload as HouseholdBackupPayload, { passphrase: trimmedPassphrase });
  const fileName = buildBackupFileName(
    converted.payload.scope.householdName,
    converted.payload.exportedAt,
    "mmh-backup",
  );

  return {
    fileName,
    bytes: encodeBackupPackage(encryptedPayload),
    summary: converted.summary,
  };
}
