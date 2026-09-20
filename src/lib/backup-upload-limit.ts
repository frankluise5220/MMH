/** Web restore upload ceiling shared with Next.js proxy body buffering. */
export const RESTORE_UPLOAD_LIMIT_MB = 512;
export const RESTORE_UPLOAD_LIMIT_BYTES = RESTORE_UPLOAD_LIMIT_MB * 1024 * 1024;
export const RESTORE_UPLOAD_LIMIT_CONFIG = `${RESTORE_UPLOAD_LIMIT_MB}mb`;
export const RESTORE_UPLOAD_LIMIT_LABEL = `${RESTORE_UPLOAD_LIMIT_MB}MB`;
