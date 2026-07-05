import { invoke } from "@tauri-apps/api/core";

const STORAGE_KEY = "proxy.connectivityStats";

/** 串行化磁盘同步，避免 reload 时读到未写完的统计文件 */
let persistenceSyncChain: Promise<void> = Promise.resolve();

function enqueuePersistenceSync(task: () => Promise<void>): void {
  persistenceSyncChain = persistenceSyncChain.then(task).catch(() => {});
}

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

/** 启动时同步联通统计到磁盘。 */
export async function syncConnectivityPersistenceToDisk(): Promise<void> {
  await syncConnectivityStatsToDisk();
}

/** 测速记统计后调度异步同步（不阻塞 UI）。 */
export function scheduleConnectivityPersistenceSync(): void {
  enqueuePersistenceSync(() => syncConnectivityPersistenceToDisk());
}

/** 在触发配置 generate/reload 前调用，确保磁盘统计与 UI 一致。 */
export async function flushConnectivityPersistenceSync(): Promise<void> {
  enqueuePersistenceSync(() => syncConnectivityPersistenceToDisk());
  await persistenceSyncChain;
}
