import { invoke } from "@tauri-apps/api/core";

import {
  CUSTOM_PROXY_ORDER_STORAGE_KEY,
  DEFAULT_CUSTOM_PROXY_ORDER,
  parseCustomProxyOrderText,
} from "@/services/proxy-region-sort";

const STORAGE_KEY = "proxy.connectivityStats";

/** 将 localStorage 中的联通统计同步到数据目录，供 generate/reload 时写入核心顺序（不触发 reload）。 */
export async function syncConnectivityStatsToDisk(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ??
      JSON.stringify({ v: 2, data: {} });
    await invoke<void>("sync_connectivity_stats_file", { rawJson: raw });
  } catch {
    // ignore sync failure
  }
}

/** 将节点地区排序偏好同步到数据目录（不触发 reload）。 */
export async function syncProxyRegionOrderToDisk(
  customOrder?: string[],
): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    let order = customOrder;
    if (!order || order.length === 0) {
      const saved = localStorage.getItem(CUSTOM_PROXY_ORDER_STORAGE_KEY);
      order =
        saved && saved.trim()
          ? parseCustomProxyOrderText(saved)
          : [...DEFAULT_CUSTOM_PROXY_ORDER];
    }
    if (order.length === 0) return;
    await invoke<void>("sync_proxy_region_order", { customOrder: order });
  } catch {
    // ignore sync failure
  }
}

/** 启动时一次性同步统计与地区顺序到磁盘。 */
export async function syncConnectivityPersistenceToDisk(): Promise<void> {
  await Promise.all([
    syncConnectivityStatsToDisk(),
    syncProxyRegionOrderToDisk(),
  ]);
}
