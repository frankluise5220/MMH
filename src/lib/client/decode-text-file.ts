/**
 * 账单 CSV 的编码探测。
 *
 * 支付宝、微信等平台在 Windows 上导出的账单仍是 GBK/GB18030（Excel 直接打开的产物），
 * 而 `File.text()` / `Response.text()` 一律按 UTF-8 解码：拿到的是整表乱码，
 * 表头别名匹配全部失效，模板识别随之落空，预览就是一堆错位列。
 *
 * 判定顺序：BOM → UTF-8 严格解码 → GB18030（GBK 超集） → GBK → UTF-8 兜底。
 */

function hasBom(bytes: Uint8Array, bom: readonly number[]) {
  if (bytes.length < bom.length) return false;
  return bom.every((value, index) => bytes[index] === value);
}

function decodeWith(bytes: Uint8Array, encoding: string) {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return null;
  }
}

/** 按 BOM / UTF-8 / GB18030 顺序把原始字节解码成文本。 */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (hasBom(bytes, [0xef, 0xbb, 0xbf])) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (hasBom(bytes, [0xff, 0xfe])) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (hasBom(bytes, [0xfe, 0xff])) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }

  try {
    // 严格模式：GBK 字节几乎必然包含非法 UTF-8 序列，抛错即说明不是 UTF-8。
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // 非 UTF-8，继续按中文编码尝试。
  }

  for (const encoding of ["gb18030", "gbk"]) {
    const decoded = decodeWith(bytes, encoding);
    if (decoded !== null) return decoded;
  }

  return new TextDecoder("utf-8").decode(bytes);
}

/** 读取文本型上传文件（CSV 等），自动处理 UTF-8 / GBK 编码差异。 */
export async function decodeTextFile(file: File): Promise<string> {
  return decodeTextBytes(new Uint8Array(await file.arrayBuffer()));
}
