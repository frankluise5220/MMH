import zlib from "node:zlib";

/**
 * 备份包文件格式的唯一出入口。
 *
 * 为什么单独一个模块：备份包是**跨版本、跨设备、跨数据库引擎**的便携文档，
 * 「导出」和「恢复」必须是同一份契约的两端。此前格式逻辑散落在导出路由、
 * 自动备份、财智转换和恢复任务里，任何一处改动都可能让老包读不回来——
 * 2026-10 的 125MB 明文包把 3.3GB 的 NAS 拖进 swap、界面卡在 36% 十几分钟，
 * 就是「包体积与阻塞」无人负责的结果。
 *
 * 三条规则（由 scripts/check-backup-package.cjs 与 scripts/verify-backup-package.ts 把关）：
 *
 * 1. 写入只能走 `encodeBackupPackage`，读取只能走 `decodeBackupPackage`。
 *    任何一处直接把 payload 交给 JSON.stringify 写文件，都是绕过契约。
 * 2. 文件一律 gzip 压缩。检测方式是魔数 `1f 8b`，不依赖文件名或内部字段，
 *    因此老的明文包（formatVersion ≤ 4）不需要任何标记就能继续恢复。
 * 3. 读侧必须容忍**更老的明文包**：没有魔数就按 UTF-8 JSON 解析。
 *    向后兼容是承诺，向前兼容不是；新版包不保证旧版能读。
 *
 * 结构化数据本身的体积由导出端的列白名单决定（见 backup.ts / check-backup-coverage.cjs），
 * 这里只负责「同样的对象，压到最小且能被老版本语义正确还原」。
 */
export const BACKUP_PACKAGE_ENCODING = "gzip";
/** 加密包在信封上声明的载荷编码；老包没有这个字段，密文里直接是 JSON。 */
export const BACKUP_PAYLOAD_ENCODING = "gzip";
export const BACKUP_FILE_GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/** 一包 125MB 的明文 JSON 压到约 5MB：字段名、空占位和重复 id 占了 96% 的字节。 */
const BACKUP_GZIP_LEVEL = 6;

export function isGzipBackupPackage(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === BACKUP_FILE_GZIP_MAGIC[0] && bytes[1] === BACKUP_FILE_GZIP_MAGIC[1];
}

/**
 * 加密包的载荷也必须先压缩再加密（compress-then-encrypt）。
 * 顺序反了就等于没压：AES 出来的密文是均匀分布的高熵字节，再套 gzip 只能省掉 base64 的 33%，
 * 实测同一份账簿「先加密后压缩」是 120MB，「先压缩后加密」是 6MB。
 */
export function encodeBackupPayloadJson(value: unknown): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify(value), "utf8"), { level: BACKUP_GZIP_LEVEL });
}

export function decodeBackupPayloadJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(zlib.gunzipSync(bytes).toString("utf8"));
  } catch {
    throw new Error("备份包载荷解压失败，文件可能已损坏");
  }
}

/**
 * 把备份包对象编码成落盘/下载用的字节。导出、自动备份、财智转换都必须走这里，
 * 这样「包有多大、是否压缩、老版本能不能读」只有一个答案。
 */
export function encodeBackupPackage(value: unknown): Buffer {
  const json = JSON.stringify(value);
  if (typeof json !== "string") {
    throw new Error("备份包无法序列化：内容不是可写成 JSON 的对象");
  }
  return zlib.gzipSync(Buffer.from(json, "utf8"), { level: BACKUP_GZIP_LEVEL });
}

/**
 * 读取备份包字节。gzip 包用魔数识别，明文包（formatVersion ≤ 4）直接按 UTF-8 JSON 解析，
 * 两条分支返回的对象必须完全等价——这是 `check:backup-io` 的断言之一。
 */
export function decodeBackupPackage(bytes: Buffer | Uint8Array): unknown {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length === 0) {
    throw new Error("备份文件为空，请重新选择文件");
  }

  if (!isGzipBackupPackage(buffer)) {
    // 老包：明文 JSON。保持这条分支，历史备份才不需要任何迁移。
    return JSON.parse(buffer.toString("utf8"));
  }

  let json: string;
  try {
    json = zlib.gunzipSync(buffer).toString("utf8");
  } catch {
    throw new Error("备份文件已损坏或不是完整的 MMH 备份包，无法解压");
  }

  try {
    return JSON.parse(json);
  } catch {
    throw new Error("备份包解压后不是有效的 JSON，文件可能已损坏");
  }
}

/**
 * 二进制快照（SQLite 整库）在**加密之前**先压缩。
 *
 * 这条路径以前是把快照 base64 塞进信封再让外层 gzip 压，顺序反了：
 * 密文是高熵字节，外层 gzip 只能消掉 base64 的 33%。实测 77.8MB 的库
 * 「先加密后压」出包约 78MB，「先压后加密」约 13MB。
 */
export function encodeBackupSnapshotBytes(bytes: Buffer): Buffer {
  return zlib.gzipSync(bytes, { level: BACKUP_GZIP_LEVEL });
}

export function decodeBackupSnapshotBytes(bytes: Buffer): Buffer {
  try {
    return zlib.gunzipSync(bytes);
  } catch {
    throw new Error("备份包快照解压失败，文件可能已损坏");
  }
}

/** 明文文本入口，仅用于测试与历史数据；业务代码一律用 decodeBackupPackage。 */
export function decodeBackupPackageText(text: string): unknown {
  return JSON.parse(text);
}
