#!/usr/bin/env node
/**
 * 备份包格式门禁（静态检查）。
 *
 * 为什么需要它：备份包是唯一一个「导出」和「恢复」必须永远互认的产物，而它的读写曾经散落在
 * 导出路由、自动备份、财智转换和恢复任务四处。任何一处改回 JSON.stringify，老包就可能读不回来，
 * 或者包体积悄悄涨回百 MB 级——2026-10-26 那次 125MB 明文包直接把 3.3GB 的 NAS 拖进 swap、
 * 恢复界面卡在 36% 十几分钟，就是这条契约没人守的结果。
 *
 * 规则（与 src/lib/server/backup-package.ts 头部注释一致）：
 *   1. 字节只由 encodeBackupPackage 产出、只由 decodeBackupPackage 读入；
 *   2. 文件一律 gzip，靠魔数识别，不依赖文件名或包内字段；
 *   3. 读侧必须保留「无魔数 = 明文 JSON」的回退分支，老包无需迁移；
 *   4. 格式变更必须同步抬高 BACKUP_FORMAT_VERSION。
 *
 * 行为验证（真实编解码、压缩比、老包可读）在 scripts/verify-backup-package.ts（npm run check:backup-io）。
 *
 * Usage: node scripts/check-backup-package.cjs   （已接入 npm run check:backup）
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const packageSource = read("src/lib/server/backup-package.ts");
const backupSource = read("src/lib/server/backup.ts");
const routeSource = read("src/app/api/v1/settings/backup/route.ts");
const autoBackupSource = read("src/lib/server/auto-backup.ts");
const caizhiSource = read("src/lib/importers/caizhi/export.ts");

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

// 1. 唯一的编解码出入口
expect(
  packageSource.includes("export function encodeBackupPackage"),
  "backup-package.ts 必须导出 encodeBackupPackage：导出/自动备份/财智转换都只能通过它落盘。",
);
expect(
  packageSource.includes("export function decodeBackupPackage"),
  "backup-package.ts 必须导出 decodeBackupPackage：恢复只能通过它读取，否则老包的兼容判断会再次散落。",
);
expect(
  packageSource.includes("0x1f") && packageSource.includes("0x8b"),
  "backup-package.ts 必须用 gzip 魔数（0x1f 0x8b）识别压缩包，而不是依赖文件名或包内字段。",
);
expect(packageSource.includes("gunzipSync"), "decodeBackupPackage 必须支持解压 gzip 包。");
expect(
  packageSource.includes('JSON.parse(buffer.toString("utf8"))'),
  "decodeBackupPackage 必须保留明文回退分支：formatVersion ≤ 4 的老包没有魔数，必须照原样解析。",
);

// 2. 格式版本
const versionMatch = /export const BACKUP_FORMAT_VERSION = (\d+)/.exec(backupSource);
const version = versionMatch ? Number(versionMatch[1]) : 0;
expect(version >= 5, `BACKUP_FORMAT_VERSION 必须 ≥ 5（当前 ${version}）：5 起包文件一律 gzip，改格式必须抬版本号。`);

// 3. 写入路径
expect(
  routeSource.includes("encodeBackupPackage("),
  "备份导出路由必须用 encodeBackupPackage 生成响应字节。",
);
expect(
  !/new Response\(\s*JSON\.stringify\(/.test(routeSource),
  "备份导出路由不得直接 JSON.stringify：那会绕过 gzip，把包体积和恢复内存又推回百 MB 级。",
);
expect(
  (autoBackupSource.match(/encodeBackupPackage\(/g) || []).length >= 2,
  "自动备份的两条路径（整库快照与按账簿）都必须用 encodeBackupPackage 写文件。",
);
expect(
  caizhiSource.includes("encodeBackupPackage(encryptedPayload)"),
  "财智转换产出的 .mmh-backup 也必须走 encodeBackupPackage，否则转换出来的包与导出包格式不一致。",
);

// 4. 读取路径
expect(routeSource.includes("decodeBackupPackage("), "恢复路由必须通过 decodeBackupPackage 读取备份包。");
expect(
  !routeSource.includes('readFile(uploadedFilePath, "utf8")'),
  '恢复路由不得用 readFile(..., "utf8") 读包：压缩包会被当成 UTF-8 文本，直接解析失败。',
);

// 5. 旧入口彻底移除，避免两条并行路径
const legacyName = "serializeEncryptedBackupPackage";
for (const [file, source] of [
  ["src/lib/server/backup.ts", backupSource],
  ["src/app/api/v1/settings/backup/route.ts", routeSource],
  ["src/lib/server/auto-backup.ts", autoBackupSource],
  ["src/lib/importers/caizhi/export.ts", caizhiSource],
]) {
  expect(!source.includes(`export function ${legacyName}`), `${file} 不得再提供 ${legacyName}。`);
  expect(
    !new RegExp(`\\b${legacyName}\\(`).test(source),
    `${file} 仍在调用 ${legacyName}：包格式必须只有一条路径。`,
  );
}

if (failures.length > 0) {
  console.error("Backup package format check FAILED:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Backup package format check passed: gzip-only encode/decode, BACKUP_FORMAT_VERSION=${version}, legacy plain-text read kept.`,
);
