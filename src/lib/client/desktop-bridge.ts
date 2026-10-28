/**
 * Type surface for the Electron preload bridge (`electron/preload.cjs`).
 *
 * Only the Windows desktop build injects `window.mmhDesktop`. Web, Docker, NAS
 * and mobile builds never see it, so every consumer must treat a missing bridge
 * as "not the desktop app" and keep its normal behaviour.
 *
 * The global `Window.mmhDesktop` declaration lives here — one site — because two
 * pages declaring the same property with slightly different member lists is a
 * TypeScript merge error waiting to happen.
 */

/** Update lifecycle events pushed by the Electron main process. */
export type DesktopUpdateStatus =
  | { type: "available"; version: string }
  | { type: "not-available"; version: string }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "error"; message: string };

export type DesktopUpdateCheckResult = {
  ok: boolean;
  version?: string;
  upToDate?: boolean;
  /** This release cannot be delivered as files (new Electron) — reinstall needed. */
  requiresInstaller?: boolean;
  error?: string;
};

export type DesktopDownloadResult = {
  ok: boolean;
  version?: string;
  started?: boolean;
  resumed?: boolean;
  upToDate?: boolean;
  requiresInstaller?: boolean;
  error?: string;
};

export type MmhDesktopBridge = {
  checkForUpdates: () => Promise<DesktopUpdateCheckResult>;
  getVersion: () => Promise<string>;
  downloadUpdate: () => Promise<DesktopDownloadResult>;
  installUpdate: () => Promise<{ ok: boolean }>;
  showDownloadWindow: () => Promise<{ ok: boolean }>;
  onUpdateStatus: (callback: (status: DesktopUpdateStatus) => void) => () => void;
};

declare global {
  interface Window {
    mmhDesktop?: MmhDesktopBridge;
  }
}

/** The desktop bridge, or `null` on web / Docker / NAS / mobile builds. */
export function getDesktopBridge(): MmhDesktopBridge | null {
  if (typeof window === "undefined") return null;
  return window.mmhDesktop ?? null;
}
