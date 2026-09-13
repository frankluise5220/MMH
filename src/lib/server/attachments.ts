import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db/prisma";

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export type StoredAttachment = {
  id: string;
  name: string | null;
  mimeType: string | null;
  url: string | null;
  entryId: string;
};

function attachmentRoot() {
  return path.resolve(process.env.MMH_ATTACHMENT_DIR || path.join(process.cwd(), "data", "attachments"));
}

export function attachmentFilePath(id: string) {
  return path.join(attachmentRoot(), `${id}.bin`);
}

export function attachmentDownloadUrl(id: string) {
  return `/api/v1/attachments/${encodeURIComponent(id)}`;
}

export function sanitizeAttachmentName(name: string) {
  return name.replace(/[\\/:*?"<>|\x00-\x1F]+/g, "_").trim().slice(0, 180) || "attachment";
}

const ATTACHMENT_SNIFF_BYTES = 512;

// MIME types that browsers execute or render as active content. Files sniffing
// as one of these are rejected at upload; everything else is served with
// nosniff + CSP sandbox headers so even future types stay inert.
const ATTACHMENT_BLOCKED_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xml",
  "text/xml",
  "application/javascript",
  "text/javascript",
  "application/ecmascript",
  "text/ecmascript",
]);

/**
 * Content sniffing from the file's own bytes, never from the client-declared
 * type (browsers and attackers can send any Content-Type they like).
 * Mirrors Go's http.DetectContentType for the signatures that matter here.
 */
export function detectAttachmentMimeType(bytes: Uint8Array): string {
  const startsWith = (signature: number[], offset = 0) =>
    signature.every((byte, index) => bytes.length > offset + index && bytes[offset + index] === byte);
  const startsWithAscii = (text: string, offset = 0) => {
    for (let index = 0; index < text.length; index += 1) {
      if (bytes.length <= offset + index || bytes[offset + index] !== text.charCodeAt(index)) return false;
    }
    return true;
  };

  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithAscii("GIF87a") || startsWithAscii("GIF89a")) return "image/gif";
  if (startsWithAscii("RIFF") && startsWithAscii("WEBP", 8)) return "image/webp";
  if (startsWithAscii("%PDF-")) return "application/pdf";
  if (startsWith([0x50, 0x4b, 0x03, 0x04]) || startsWith([0x50, 0x4b, 0x05, 0x06]) || startsWith([0x50, 0x4b, 0x07, 0x08])) return "application/zip";
  if (startsWith([0x1f, 0x8b])) return "application/gzip";
  if (startsWith([0x25, 0x21])) return "application/postscript";
  if (bytes.length >= 12 && startsWithAscii("ftyp", 4)) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (/^(heic|heix|mif1|msf1|hevc|hevx)$/i.test(brand)) return "image/heic";
    return "video/mp4";
  }

  const head = bytes.subarray(0, Math.min(bytes.length, ATTACHMENT_SNIFF_BYTES));
  let looksTextual = head.length > 0;
  for (const byte of head) {
    if (byte === 0 || (byte < 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      looksTextual = false;
      break;
    }
  }
  if (looksTextual) {
    const text = Buffer.from(head).toString("utf8");
    const trimmed = text.replace(/^\uFEFF/, "").trimStart().toLowerCase();
    if (trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html") || trimmed.startsWith("<head") || trimmed.startsWith("<body")) {
      return "text/html";
    }
    if (trimmed.startsWith("<?xml") || trimmed.startsWith("<svg")) {
      return trimmed.includes("<svg") ? "image/svg+xml" : "text/xml";
    }
    if (trimmed.startsWith("<")) return "application/xml";
    return "text/plain";
  }
  return "application/octet-stream";
}

export function validateSniffedAttachmentMimeType(mimeType: string) {
  if (ATTACHMENT_BLOCKED_MIME_TYPES.has(mimeType)) {
    throw new Error("FILE_TYPE_NOT_ALLOWED");
  }
}

export function attachmentResponseItem(item: StoredAttachment) {
  return {
    id: item.id,
    name: item.name || "attachment",
    mimeType: item.mimeType || "application/octet-stream",
    url: attachmentDownloadUrl(item.id),
  };
}

export async function saveEntryAttachment(params: {
  entryId: string;
  householdId: string;
  file: File;
}) {
  const { entryId, householdId, file } = params;
  if (file.size <= 0) throw new Error("EMPTY_FILE");
  if (file.size > ATTACHMENT_MAX_BYTES) throw new Error("FILE_TOO_LARGE");

  const entry = await prisma.txRecord.findFirst({
    where: { id: entryId, householdId, deletedAt: null },
    select: { id: true },
  });
  if (!entry) throw new Error("ENTRY_NOT_FOUND");

  const id = randomUUID();
  const name = sanitizeAttachmentName(file.name || "attachment");
  const bytes = Buffer.from(await file.arrayBuffer());
  // The stored MIME type always comes from the sniffed bytes, so the download
  // route can serve an accurate Content-Type without trusting the client.
  const sniffedMimeType = detectAttachmentMimeType(bytes);
  validateSniffedAttachmentMimeType(sniffedMimeType);
  await mkdir(attachmentRoot(), { recursive: true });
  await writeFile(attachmentFilePath(id), bytes, { mode: 0o600 });
  const created = await prisma.attachment.create({
    data: {
      id,
      entryId,
      name,
      mimeType: sniffedMimeType,
      url: attachmentDownloadUrl(id),
    },
    select: { id: true, name: true, mimeType: true, url: true, entryId: true },
  });
  return attachmentResponseItem(created);
}

export async function readAttachmentFile(id: string, householdId: string) {
  const attachment = await prisma.attachment.findFirst({
    where: { id, transactions: { householdId, deletedAt: null } },
    select: { id: true, name: true, mimeType: true, url: true, entryId: true },
  });
  if (!attachment) return null;
  const bytes = await readFile(attachmentFilePath(id));
  return { attachment, bytes };
}

export async function deleteAttachmentFile(id: string, householdId: string) {
  const attachment = await prisma.attachment.findFirst({
    where: { id, transactions: { householdId, deletedAt: null } },
    select: { id: true },
  });
  if (!attachment) return false;
  await prisma.attachment.delete({ where: { id } });
  await unlink(attachmentFilePath(id)).catch(() => undefined);
  return true;
}
