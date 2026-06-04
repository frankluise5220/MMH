import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const MASTER_KEY_SETTING = "api_key_encryption_master";
let _masterKey: Buffer | null = null;

/**
 * 加密 API Key。在数据库存储层自动调用，API 路由无需感知。
 * 返回格式：base64(iv).base64(ciphertext).base64(tag)
 */
export function encrypt(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${encrypted.toString("base64")}.${tag.toString("base64")}`;
}

/**
 * 解密 API Key
 */
export function decrypt(encrypted: string, key: Buffer): string {
  const parts = encrypted.split(".");
  if (parts.length !== 3) throw new Error("invalid encrypted format");
  const iv = Buffer.from(parts[0], "base64");
  const ciphertext = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * 判断字符串是否已被加密（判断是否是 base64.base64.base64 格式）
 */
export function isEncrypted(s: string): boolean {
  return /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(s) && s.split(".").length === 3;
}

/**
 * 获取或创建主加密密钥（存在 systemSetting 表中）
 */
export async function getOrCreateMasterKey(): Promise<Buffer> {
  if (_masterKey) return _masterKey;
  const { prisma } = await import("@/lib/db/prisma");
  let setting = await prisma.systemSetting.findUnique({ where: { key: MASTER_KEY_SETTING } });
  if (setting && setting.value) {
    _masterKey = Buffer.from(setting.value, "base64");
    return _masterKey;
  }
  // 生成 256-bit 随机密钥
  _masterKey = crypto.randomBytes(32);
  await prisma.systemSetting.upsert({
    where: { key: MASTER_KEY_SETTING },
    create: { key: MASTER_KEY_SETTING, value: _masterKey.toString("base64") },
    update: { value: _masterKey.toString("base64") },
  });
  console.log("[encrypt] Generated new master encryption key");
  return _masterKey;
}
