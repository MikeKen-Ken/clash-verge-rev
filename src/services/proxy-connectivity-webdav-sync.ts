import {
  mergeConnectivityStatsWebdav,
  type ConnectivityWebdavSyncResult,
} from "@/services/cmds";
import { hydrateConnectivityStatsFromDisk } from "@/services/proxy-connectivity-stats";

let activeSync: Promise<ConnectivityWebdavSyncResult> | null = null;

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
  return (
    isConnectivityWebdavConfigured(verge) && isConnectivityWebdavHttps(verge)
  );
}

export async function mergeConnectivityStatsNow(): Promise<ConnectivityWebdavSyncResult> {
  if (activeSync) return activeSync;
  activeSync = (async () => {
    const result = await mergeConnectivityStatsWebdav();
    await hydrateConnectivityStatsFromDisk();
    return result;
  })().finally(() => {
    activeSync = null;
  });
  return activeSync;
}
