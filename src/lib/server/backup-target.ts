import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { Client } from "basic-ftp";
import { createClient, type FileStat } from "webdav";

type SmbClient = import("smb3-client").Client;
let smbModulePromise: Promise<typeof import("smb3-client")> | null = null;

/**
 * `smb3-client` is ESM-only (`exports` has an "import" condition but no
 * "require"). Next server chunks and tsx scripts are CommonJS, where a normal
 * `import()` is rewritten to `require()` and fails. A native dynamic import
 * keeps ESM resolution while `outputFileTracingIncludes` makes sure the
 * package is copied into the standalone image.
 */
function loadSmbClient(): Promise<typeof import("smb3-client")> {
  if (!smbModulePromise) {
    const nativeImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<typeof import("smb3-client")>;
    smbModulePromise = nativeImport("smb3-client");
  }
  return smbModulePromise;
}

/**
 * Where automatic backups are written.
 *
 * Local targets use the filesystem (the legacy path). Network targets connect
 * out from the app process (WebDAV / FTP / SMB), so a Docker deployment does
 * not need a host bind mount or host-side ACL changes: the user only enters an
 * address, a directory and credentials in the settings page.
 *
 * Clients are borrowed from MIT-licensed projects instead of hand-rolling
 * protocol code: perry-mitchell/webdav-client, patrickjuchli/basic-ftp and
 * euricojardim/smb3-client (pure TypeScript SMB3 over TCP/445, Node 20+).
 * smb3-client is 0.2.x / alpha, so SMB support is experimental.
 */
export type BackupDestination = "local" | "webdav" | "ftp" | "smb";

export type RemoteBackupSettings = {
  /** WebDAV: URL or host:port; FTP: host; SMB: host, smb://... or \\host\share */
  url: string;
  /** FTP control port (21) / SMB port (445); ignored for WebDAV */
  port: number;
  username: string;
  password: string;
  /** WebDAV path / FTP login-relative dir / SMB "share/subdir" (first part is the share) */
  directory: string;
  /** WebDAV: default to HTTPS when no scheme; FTP: FTPS; ignored for SMB */
  secure: boolean;
  /** SMB NTLM domain / workgroup; leave empty for local accounts */
  domain: string;
};

export const DEFAULT_REMOTE_BACKUP_SETTINGS: RemoteBackupSettings = {
  url: "",
  port: 21,
  username: "",
  password: "",
  directory: "",
  secure: true,
  domain: "",
};

export type DiskInfo = {
  freeBytes: number;
  totalBytes: number;
};

export type BackupFileInfo = {
  name: string;
  mtimeMs: number;
};

export type BackupTarget = {
  /** Human-readable location, also used in error messages. Never contains a password. */
  location: string;
  probe(): Promise<void>;
  write(fileName: string, bytes: Buffer): Promise<void>;
  list(): Promise<BackupFileInfo[]>;
  remove(fileName: string): Promise<void>;
  disk(): Promise<DiskInfo | null>;
};

export type BackupTargetConfig = {
  destination: BackupDestination;
  path: string;
  remote: RemoteBackupSettings;
};

export type BackupPathFailure = Error & { code: "BACKUP_PATH_NOT_WRITABLE"; dir: string };

/**
 * Filesystem / protocol errors carry the failing target only in their message.
 * Tagging them lets the settings page show a specific hint instead of a bare
 * `EACCES: mkdir ...` or an opaque FTP/WebDAV status line.
 */
export function asBackupPathFailure(dir: string, error: unknown): BackupPathFailure {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(message), { code: "BACKUP_PATH_NOT_WRITABLE" as const, dir });
}

async function guarded<T>(location: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw asBackupPathFailure(location, error);
  }
}

export function defaultAutoBackupDir(): string {
  const dataDir = process.env.MMH_DATA_DIR || path.join(process.cwd(), "data");
  return path.join(dataDir, "backups");
}

/** Reject `..` and NUL in user-entered remote directories; keep leading `/`. */
export function normalizeRemoteDirectory(raw: string): string {
  const trimmed = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.includes("\0")) return "";
  const parts = trimmed.split("/").filter((part) => part && part !== "." && part !== "..");
  if (parts.length === 0) return "";
  const joined = parts.join("/");
  return trimmed.startsWith("/") ? `/${joined}` : joined;
}

export function normalizeRemoteBackupSettings(raw: unknown): RemoteBackupSettings {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  let port = Number(obj.port ?? DEFAULT_REMOTE_BACKUP_SETTINGS.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) port = DEFAULT_REMOTE_BACKUP_SETTINGS.port;
  return {
    url: String(obj.url ?? "").trim(),
    port,
    username: String(obj.username ?? "").trim(),
    // A password may legitimately contain leading/trailing spaces: do not trim.
    password: typeof obj.password === "string" ? obj.password : "",
    directory: normalizeRemoteDirectory(String(obj.directory ?? "")),
    secure: obj.secure !== false,
    domain: String(obj.domain ?? "").trim(),
  };
}

function safeRemoteFileName(fileName: string): string {
  const base = path.posix.basename(String(fileName ?? ""));
  if (!base || base === "." || base === ".." || base.includes("\0")) {
    throw new Error(`invalid backup file name: ${fileName}`);
  }
  return base;
}

function nearestExistingDir(target: string): string {
  let current = path.resolve(target);
  for (let i = 0; i < 64; i++) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export async function getPathDiskInfo(target: string): Promise<DiskInfo | null> {
  try {
    const stats = await fs.promises.statfs(nearestExistingDir(target));
    return {
      freeBytes: Number(stats.bavail ?? stats.bfree) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch {
    return null;
  }
}

export function formatDiskBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function safeUrlDisplay(raw: string, defaultProtocol: string): string {
  // UNC paths (\\host\share\dir) are common for SMB; normalise them so URL
  // parsing can still extract a host without ever echoing credentials.
  const value = String(raw ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!value) return "?";
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `${defaultProtocol}${value}`);
    parsed.username = "";
    parsed.password = "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "?";
  }
}

export function describeBackupTarget(config: BackupTargetConfig): string {
  if (config.destination === "local") return config.path || defaultAutoBackupDir();
  const remote = config.remote;
  const dir = normalizeRemoteDirectory(remote.directory);
  const suffix = dir ? (dir.startsWith("/") ? dir : `/${dir}`) : "";
  const defaultProtocol = config.destination === "ftp" ? "ftp://" : config.destination === "smb" ? "smb://" : "https://";
  return `${config.destination.toUpperCase()} ${safeUrlDisplay(remote.url, defaultProtocol)}${suffix}`;
}

function localTarget(dir: string): BackupTarget {
  const location = dir || defaultAutoBackupDir();
  return {
    location,
    probe: () =>
      guarded(location, async () => {
        await fs.promises.mkdir(location, { recursive: true });
        const probeName = `.mmh-probe-${crypto.randomUUID()}.tmp`;
        await fs.promises.writeFile(path.join(location, probeName), Buffer.alloc(0), { mode: 0o600 });
        await fs.promises.rm(path.join(location, probeName), { force: true });
      }),
    write: (fileName, bytes) =>
      guarded(location, async () => {
        await fs.promises.mkdir(location, { recursive: true });
        await fs.promises.writeFile(path.join(location, safeRemoteFileName(fileName)), bytes, { mode: 0o600 });
      }),
    list: () =>
      guarded(location, async () => {
        const entries = await fs.promises.readdir(location, { withFileTypes: true });
        const files: BackupFileInfo[] = [];
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          try {
            const stat = await fs.promises.stat(path.join(location, entry.name));
            files.push({ name: entry.name, mtimeMs: stat.mtimeMs });
          } catch {
            files.push({ name: entry.name, mtimeMs: 0 });
          }
        }
        return files;
      }),
    remove: (fileName) => guarded(location, () => fs.promises.rm(path.join(location, safeRemoteFileName(fileName)))),
    disk: () => getPathDiskInfo(location),
  };
}

function parseEndpoint(rawUrl: string, defaultProtocol: string, allowedProtocols: string[]): URL {
  const url = String(rawUrl ?? "").trim();
  if (!url) throw new Error("远程备份服务器地址不能为空");
  const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `${defaultProtocol}${url}`);
  if (!allowedProtocols.includes(parsed.protocol)) throw new Error("远程备份服务器地址协议不支持");
  if (parsed.username || parsed.password) throw new Error("请把用户名和口令填在单独字段，不要写在地址里");
  return parsed;
}

function webDavTarget(remote: RemoteBackupSettings): BackupTarget {
  const parsed = parseEndpoint(remote.url, remote.secure ? "https://" : "http://", ["http:", "https:"]);
  const baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  const client = createClient(baseUrl, {
    username: remote.username || undefined,
    password: remote.password || undefined,
  });
  const dir = normalizeRemoteDirectory(remote.directory);
  const dirPath = dir ? (dir.startsWith("/") ? dir : `/${dir}`) : "/";
  const location = `WebDAV ${baseUrl}${dirPath === "/" ? "/" : dirPath}`;
  const filePath = (fileName: string) => `${dirPath === "/" ? "" : dirPath}/${safeRemoteFileName(fileName)}`;
  const ensureDir = async () => {
    if (dirPath !== "/") await client.createDirectory(dirPath, { recursive: true });
  };

  return {
    location,
    probe: () =>
      guarded(location, async () => {
        await ensureDir();
        const probeName = filePath(`.mmh-probe-${crypto.randomUUID()}.tmp`);
        await client.putFileContents(probeName, Buffer.from("mmh"));
        await client.deleteFile(probeName);
      }),
    write: (fileName, bytes) =>
      guarded(location, async () => {
        await ensureDir();
        await client.putFileContents(filePath(fileName), bytes, { overwrite: true });
      }),
    list: () =>
      guarded(location, async () => {
        const items = (await client.getDirectoryContents(dirPath)) as FileStat[];
        return items
          .filter((item) => item.type === "file")
          .map((item) => ({ name: item.basename, mtimeMs: Date.parse(item.lastmod) || 0 }));
      }),
    remove: (fileName) => guarded(location, () => client.deleteFile(filePath(fileName))),
    disk: () => Promise.resolve(null),
  };
}

type FtpEndpoint = { host: string; port: number; secure: boolean };

function parseFtpEndpoint(remote: RemoteBackupSettings): FtpEndpoint {
  const raw = String(remote.url ?? "").trim();
  if (!raw) throw new Error("远程备份服务器地址不能为空");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `ftp://${raw}`;
  const parsed = new URL(withScheme);
  if (parsed.username || parsed.password) throw new Error("请把用户名和口令填在单独字段，不要写在地址里");
  if (!parsed.hostname) throw new Error("远程备份服务器地址格式不正确");
  const port = remote.port || Number(parsed.port) || 21;
  return { host: parsed.hostname, port, secure: remote.secure };
}

function ftpTarget(remote: RemoteBackupSettings): BackupTarget {
  const endpoint = parseFtpEndpoint(remote);
  const dir = normalizeRemoteDirectory(remote.directory);
  const location = `FTP ${endpoint.host}:${endpoint.port}${dir ? (dir.startsWith("/") ? dir : `/${dir}`) : "/"}`;

  async function withFtp<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client(30_000);
    try {
      await client.access({
        host: endpoint.host,
        port: endpoint.port,
        user: remote.username,
        password: remote.password,
        secure: endpoint.secure,
      });
      if (dir) await client.ensureDir(dir);
      return await fn(client);
    } finally {
      client.close();
    }
  }

  return {
    location,
    probe: () =>
      guarded(location, () =>
        withFtp(async (client) => {
          const probeName = `.mmh-probe-${crypto.randomUUID()}.tmp`;
          await client.uploadFrom(Readable.from([Buffer.from("mmh")]), probeName);
          await client.remove(probeName);
        }),
      ),
    write: (fileName, bytes) =>
      guarded(location, async () => {
        await withFtp((client) => client.uploadFrom(Readable.from([bytes]), safeRemoteFileName(fileName)));
      }),
    list: () =>
      guarded(location, () =>
        withFtp(async (client) => {
          const items = await client.list();
          return items
            .filter((item) => item.isFile)
            .map((item) => ({
              name: item.name,
              mtimeMs: item.modifiedAt instanceof Date ? item.modifiedAt.getTime() : 0,
            }));
        }),
      ),
    remove: (fileName) =>
      guarded(location, async () => {
        await withFtp((client) => client.remove(safeRemoteFileName(fileName)));
      }),
    disk: () => Promise.resolve(null),
  };
}

type SmbEndpoint = { host: string; port: number; directory: string };

function parseSmbEndpoint(remote: RemoteBackupSettings): SmbEndpoint {
  const raw = String(remote.url ?? "").trim();
  if (!raw) throw new Error("SMB 服务器地址不能为空");
  let host = "";
  let directory = normalizeRemoteDirectory(remote.directory);
  let urlPort = 445;
  if (raw.startsWith("\\\\")) {
    const parts = raw.replace(/\\/g, "/").split("/").filter(Boolean);
    host = parts.shift() ?? "";
    const rest = parts.join("/");
    if (rest) directory = normalizeRemoteDirectory(rest);
  } else {
    const parsed = new URL(/^smb:\/\//i.test(raw) ? raw : `smb://${raw}`);
    if (parsed.username || parsed.password) throw new Error("请把用户名和口令填在单独字段，不要写在地址里");
    host = parsed.hostname;
    urlPort = Number(parsed.port) || 445;
    if (parsed.pathname && parsed.pathname !== "/") {
      directory = normalizeRemoteDirectory(decodeURIComponent(parsed.pathname));
    }
  }
  // SMB paths are "share/subdir": a leading slash would make the first
  // segment empty and break tree connect.
  directory = directory.replace(/^\/+/, "");
  if (!host) throw new Error("SMB 服务器地址格式不正确");
  if (!directory) throw new Error("请填写 SMB 共享名/目录（如 FTP/mmh-test-backups）");
  // The shared settings object defaults `port` to 21 (FTP); do not silently
  // use that for SMB unless the user explicitly changed it.
  const configuredPort = remote.port > 0 && remote.port !== DEFAULT_REMOTE_BACKUP_SETTINGS.port ? remote.port : 0;
  return { host, port: configuredPort || urlPort, directory };
}

function smbTarget(remote: RemoteBackupSettings): BackupTarget {
  const endpoint = parseSmbEndpoint(remote);
  const dir = endpoint.directory;
  const location = `SMB \\\\${endpoint.host}\\${dir.replace(/\//g, "\\")}`;
  const filePath = (fileName: string) => `${dir}/${safeRemoteFileName(fileName)}`;

  async function ensureDir(client: SmbClient): Promise<void> {
    const parts = dir.split("/").filter(Boolean);
    let current = parts[0];
    for (const part of parts.slice(1)) {
      current += `/${part}`;
      try {
        await client.mkdir(current);
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== "EEXIST") throw error;
      }
    }
  }

  async function withSmb<T>(fn: (client: SmbClient) => Promise<T>): Promise<T> {
    const { Client: SmbClientCtor } = await loadSmbClient();
    const client = new SmbClientCtor({
      host: endpoint.host,
      port: endpoint.port,
      domain: remote.domain || "",
      username: remote.username,
      password: remote.password,
      connectTimeout: 10_000,
      requestTimeout: 30_000,
      signing: "if-offered",
      encryption: "if-offered",
    });
    try {
      await client.connect();
      await ensureDir(client);
      return await fn(client);
    } finally {
      try {
        await client.close();
      } catch {
        // Never let a teardown error mask the original failure.
      }
    }
  }

  return {
    location,
    probe: () =>
      guarded(location, () =>
        withSmb(async (client) => {
          const probeName = filePath(`.mmh-probe-${crypto.randomUUID()}.tmp`);
          await client.writeFile(probeName, Buffer.from("mmh"));
          await client.rm(probeName);
        }),
      ),
    write: (fileName, bytes) => guarded(location, () => withSmb((client) => client.writeFile(filePath(fileName), bytes))),
    list: () =>
      guarded(location, () =>
        withSmb(async (client) => {
          const entries = await client.readdir(dir, { withFileTypes: true });
          const files: BackupFileInfo[] = [];
          for (const entry of entries) {
            if (!entry.isFile()) continue;
            try {
              const stat = await client.stat(`${dir}/${entry.name}`);
              files.push({ name: entry.name, mtimeMs: stat.mtime instanceof Date ? stat.mtime.getTime() : 0 });
            } catch {
              files.push({ name: entry.name, mtimeMs: 0 });
            }
          }
          return files;
        }),
      ),
    remove: (fileName) => guarded(location, () => withSmb((client) => client.rm(filePath(fileName)))),
    disk: () => Promise.resolve(null),
  };
}

export function createBackupTarget(config: BackupTargetConfig): BackupTarget {
  switch (config.destination) {
    case "webdav":
      return webDavTarget(config.remote);
    case "ftp":
      return ftpTarget(config.remote);
    case "smb":
      return smbTarget(config.remote);
    default:
      return localTarget(config.path);
  }
}
