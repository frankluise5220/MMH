/**
 * 解析与组装 Base URL 的轻量工具。
 * 包含协议、地址、端口、路径四个部分，方便拆分输入。
 *
 * 注意：不要求完整的 URL；允许省略端口/路径。
 * 主要用于客户端表单的解析/回填。
 */

export interface ParsedUrl {
  protocol: string;   // "http:" | "https:"
  host: string;       // 不含端口
  port: string;       // 空字符串表示未填
  path: string;       // 含 "/" 前缀，如 "/v1"
}

/** 将 baseUrl 拆成四个独立字段；解析失败时返回安全的默认值 */
export function parseBaseUrl(raw: string | null | undefined): ParsedUrl {
  if (!raw) {
    return { protocol: "https:", host: "", port: "", path: "" };
  }
  try {
    const u = new URL(raw);
    return {
      protocol: u.protocol,          // e.g. "http:" or "https:"
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search + u.hash, // 保持完整的路径部分
    };
  } catch {
    return { protocol: "https:", host: "", port: "", path: "" };
  }
}

/** 将四个独立字段重新拼成完整 URL 字符串 */
export function buildBaseUrl(p: ParsedUrl): string {
  const host = p.host.trim();
  if (!host) return "";
  let base = `${p.protocol || "https:"}//${host}`;
  const port = p.port.trim();
  if (port) base += `:${port}`;
  const path = p.path.trim();
  if (path) {
    base += path;
  }
  return base;
}

/** HTTP / HTTPS */
export const PROTOCOL_OPTIONS = [
  { value: "https:", label: "HTTPS" },
  { value: "http:", label: "HTTP" },
] as const;

/** 常用端口快捷选项 */
export const PORT_SUGGESTIONS: { value: string; label: string; description: string }[] = [
  { value: "", label: "默认", description: "不填端口" },
  { value: "443", label: "443", description: "HTTPS 默认" },
  { value: "80", label: "80", description: "HTTP 默认" },
  { value: "11434", label: "11434", description: "Ollama" },
  { value: "3000", label: "3000", description: "本地开发" },
  { value: "8080", label: "8080", description: "代理/镜像" },
] as const;

/**
 * 从一组已填入的解析字段构造一个干净的 form data 对象。
 * 供外部保存时合并使用。
 */
export function assembledBaseUrl<T extends Record<string, unknown>>(
  partial: ParsedUrl,
  extra: Omit<T, "baseUrl"> & { baseUrl?: string },
): T & { baseUrl: string } {
  return {
    ...extra,
    baseUrl: buildBaseUrl(partial),
  } as unknown as T & { baseUrl: string };
}

/** 可选路径的常用提示 */
export const PATH_PLACEHOLDER = "/v1（可选）";