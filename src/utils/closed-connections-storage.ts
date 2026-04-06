/**
 * 已关闭连接持久化：使用 IndexedDB，避免 localStorage 容量与阻塞问题。
 * IndexedDB 容量大（通常数百 MB）、异步、不阻塞主线程。
 */

const DB_NAME = "verge_connections";
const DB_VERSION = 1;
const STORE_NAME = "closed";
const KEY = "list";
/** 完整连接快照（活跃+已关闭），用于重新进入连接页时恢复列表，避免空白 */
const SNAPSHOT_KEY = "snapshot";

export interface ConnectionSnapshot {
  uploadTotal: number;
  downloadTotal: number;
  activeConnections: IConnectionsItem[];
  closedConnections: IConnectionsItem[];
}

function openDb(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.reject(new Error("IndexedDB not available"));
  }
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

export async function getClosedConnectionsFromStorage(): Promise<
  IConnectionsItem[]
> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(KEY);
      req.onsuccess = () => {
        db.close();
        const value = req.result;
        if (value == null) {
          resolve([]);
          return;
        }
        const arr = Array.isArray(value) ? value : [];
        resolve(arr as IConnectionsItem[]);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return [];
  }
}

export function setClosedConnectionsInStorage(
  closed: IConnectionsItem[],
): Promise<void> {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.resolve();
  }
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(closed, KEY);
        req.onsuccess = () => {
          db.close();
          resolve();
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      }),
  ).catch((): void => {
    // ignore quota or other errors
  }) as Promise<void>;
}

export async function getConnectionSnapshot(): Promise<ConnectionSnapshot | null> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(SNAPSHOT_KEY);
      req.onsuccess = () => {
        db.close();
        const value = req.result;
        if (value == null || typeof value !== "object") {
          resolve(null);
          return;
        }
        const v = value as ConnectionSnapshot;
        // Cumulative totals come from the live core WebSocket; never rehydrate stale values from IndexedDB.
        resolve({
          uploadTotal: 0,
          downloadTotal: 0,
          activeConnections: Array.isArray(v.activeConnections) ? v.activeConnections : [],
          closedConnections: Array.isArray(v.closedConnections) ? v.closedConnections : [],
        });
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return null;
  }
}

export function setConnectionSnapshot(data: ConnectionSnapshot): void {
  if (typeof window === "undefined" || !window.indexedDB) {
    return;
  }
  const toStore: ConnectionSnapshot = {
    ...data,
    uploadTotal: 0,
    downloadTotal: 0,
  };
  openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(toStore, SNAPSHOT_KEY);
        req.onsuccess = () => {
          db.close();
          resolve();
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      }),
  ).catch((): void => {});
}
