export const BATCH_IMPORT_PENDING_FILE_STORAGE_KEY = "batchImportPendingFile";

export type BatchImportPendingFileKind = "normal" | "fund";

export type BatchImportPendingFilePayload = {
  kind: BatchImportPendingFileKind;
  name: string;
  type: string;
  lastModified: number;
  dataBase64: string;
};

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export async function fileToBatchImportPayload(
  file: File,
  kind: BatchImportPendingFileKind,
): Promise<BatchImportPendingFilePayload> {
  return {
    kind,
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
    dataBase64: arrayBufferToBase64(await file.arrayBuffer()),
  };
}

export function batchImportPayloadToFile(payload: BatchImportPendingFilePayload) {
  return new File([base64ToArrayBuffer(payload.dataBase64)], payload.name, {
    type: payload.type,
    lastModified: payload.lastModified,
  });
}
