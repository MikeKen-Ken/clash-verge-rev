import { invoke } from "@tauri-apps/api/core";

/** 与 connection-table.tsx 中 useLocalStorage 键名一致 */
export const CONNECTION_TABLE_ORDER_KEY = "connection-table-order";
export const CONNECTION_TABLE_VISIBILITY_KEY = "connection-table-visibility";

export type ConnectionTableVisibility = Record<string, boolean>;

export interface ConnectionTableUiState {
  order: string[] | null;
  visibility: ConnectionTableVisibility | null;
}

export function readConnectionTableOrderFromStorage(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(CONNECTION_TABLE_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((f) => typeof f === "string")
      : [];
  } catch {
    return [];
  }
}

export function readConnectionTableVisibilityFromStorage(): ConnectionTableVisibility {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(CONNECTION_TABLE_VISIBILITY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: ConnectionTableVisibility = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === false) result[key] = false;
    }
    return result;
  } catch {
    return {};
  }
}

export function writeConnectionTableOrderToStorage(order: string[]) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(CONNECTION_TABLE_ORDER_KEY, JSON.stringify(order));
}

export function writeConnectionTableVisibilityToStorage(
  visibility: ConnectionTableVisibility,
) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    CONNECTION_TABLE_VISIBILITY_KEY,
    JSON.stringify(visibility),
  );
}

/** 将列顺序与列勾选状态同步到磁盘，供备份 zip 打包 */
export async function syncConnectionTableUiToBackupFile(options?: {
  order?: string[];
  visibility?: ConnectionTableVisibility;
}) {
  const order = options?.order ?? readConnectionTableOrderFromStorage();
  const visibility =
    options?.visibility ?? readConnectionTableVisibilityFromStorage();
  await invoke<void>("save_connection_table_ui", { order, visibility });
}

/** 从磁盘读取还原后的连接表 UI 并写回 localStorage */
export async function applyConnectionTableUiFromBackupFile() {
  const state = await invoke<ConnectionTableUiState>("get_connection_table_ui");
  if (state.order?.length) {
    writeConnectionTableOrderToStorage(state.order);
  }
  if (state.visibility != null) {
    writeConnectionTableVisibilityToStorage(state.visibility);
  }
}

/** 创建任意备份前调用，确保 zip 包含最新连接表 UI 状态 */
export async function prepareBackupUiPreferences() {
  await syncConnectionTableUiToBackupFile();
}
