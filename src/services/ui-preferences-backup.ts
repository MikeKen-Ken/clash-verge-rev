import { invoke } from "@tauri-apps/api/core";

/** 与 connection-table.tsx 中 useLocalStorage 键名一致 */
export const CONNECTION_TABLE_ORDER_KEY = "connection-table-order";

export function readConnectionTableOrderFromStorage(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(CONNECTION_TABLE_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f) => typeof f === "string") : [];
  } catch {
    return [];
  }
}

export function writeConnectionTableOrderToStorage(order: string[]) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(CONNECTION_TABLE_ORDER_KEY, JSON.stringify(order));
}

/** 将当前列顺序同步到磁盘，供备份 zip 打包 */
export async function syncConnectionTableOrderToBackupFile(
  order?: string[],
) {
  const resolved = order ?? readConnectionTableOrderFromStorage();
  await invoke<void>("save_connection_table_order", { order: resolved });
}

/** 从磁盘读取还原后的列顺序并写回 localStorage（应用启动或还原后调用） */
export async function applyConnectionTableOrderFromBackupFile() {
  const order = await invoke<string[] | null>("get_connection_table_order");
  if (!order?.length) return;
  writeConnectionTableOrderToStorage(order);
}

/** 创建任意备份前调用，确保 zip 包含最新列顺序 */
export async function prepareBackupUiPreferences() {
  await syncConnectionTableOrderToBackupFile();
}
