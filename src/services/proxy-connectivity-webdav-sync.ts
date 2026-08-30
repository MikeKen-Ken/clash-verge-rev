import {
  mergeConnectivityStatsWebdav,
  type ConnectivityWebdavSyncResult,
} from "@/services/cmds";
import { hydrateConnectivityStatsFromDisk } from "@/services/proxy-connectivity-stats";

const LAST_SYNC_KEY = "proxy.connectivityWebdavLastSyncAt";
const MIN_INTERVAL_HOURS = 1;
const DEFAULT_INTERVAL_HOURS = 24;

let activeSync: Promise<ConnectivityWebdavSyncResult> | null = null;

function normalizedIntervalHours(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INTERVAL_HOURS;
  return Math.max(
    MIN_INTERVAL_HOURS,
    Math.round(value ?? DEFAULT_INTERVAL_HOURS),
  );
}

function readLastSyncAt(): number {
  if (typeof localStorage === "undefined") return 0;
  const value = Number(localStorage.getItem(LAST_SYNC_KEY) ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function writeLastSyncAt(value: number): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(LAST_SYNC_KEY, String(value));
  }
}

function isHttpsWebdavUrl(url?: string | null): boolean {
  return (url?.trim().toLowerCase() ?? "").startsWith("https://");
}

export function isConnectivityWebdavConfigured(
  verge?: Pick<
    IVergeConfig,
    "webdav_url" | "webdav_username" | "webdav_password"
  > | null,
): boolean {
  return Boolean(
    verge?.webdav_url?.trim() &&
      verge.webdav_username?.trim() &&
      verge.webdav_password,
  );
}

export function isConnectivityWebdavHttps(
  verge?: Pick<IVergeConfig, "webdav_url"> | null,
): boolean {
  return isHttpsWebdavUrl(verge?.webdav_url);
}

export function isConnectivityWebdavReady(
  verge?: Pick<
    IVergeConfig,
    "webdav_url" | "webdav_username" | "webdav_password"
  > | null,
): boolean {
  return isConnectivityWebdavConfigured(verge) && isConnectivityWebdavHttps(verge);
}

export async function mergeConnectivityStatsNow(): Promise<ConnectivityWebdavSyncResult> {
  if (activeSync) return activeSync;
  activeSync = (async () => {
    const result = await mergeConnectivityStatsWebdav();
    await hydrateConnectivityStatsFromDisk();
    writeLastSyncAt(result.lastSyncAt || Date.now());
    return result;
  })().finally(() => {
    activeSync = null;
  });
  return activeSync;
}

export async function mergeConnectivityStatsIfDue(
  intervalHours?: number,
): Promise<void> {
  const intervalMs = normalizedIntervalHours(intervalHours) * 60 * 60 * 1000;
  if (Date.now() - readLastSyncAt() < intervalMs) return;
  await mergeConnectivityStatsNow();
}

export function connectivitySyncCheckPeriodMs(intervalHours?: number): number {
  const intervalMs = normalizedIntervalHours(intervalHours) * 60 * 60 * 1000;
  return Math.min(intervalMs, 5 * 60 * 1000);
}
