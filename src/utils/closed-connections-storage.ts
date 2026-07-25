/**
 * 已关闭连接持久化：使用 IndexedDB，避免 localStorage 容量与阻塞问题。
 * IndexedDB 容量大（通常数百 MB）、异步、不阻塞主线程。
 *
 * 写盘采用节流：连接 WS 约每秒刷新，完整快照可达数十 MB，
 * 禁止同步每帧写入；合并为间隔写盘，并在切后台时刷出挂起数据。
 */

const DB_NAME = "verge_connections";
const DB_VERSION = 1;
const STORE_NAME = "closed";
const KEY = "list";
/** 完整连接快照（活跃+已关闭），用于重新进入连接页时恢复列表，避免空白 */
const SNAPSHOT_KEY = "snapshot";

/** 写盘最小间隔（毫秒）：连续变更时最多按此频率落盘 */
export const CONNECTION_PERSIST_THROTTLE_MS = 30_000;

export interface ConnectionSnapshot {
  uploadTotal: number;
  downloadTotal: number;
  activeConnections: IConnectionsItem[];
  closedConnections: IConnectionsItem[];
}

export interface ConnectionPersistOptions {
  /** 立即写盘（清除列表、主动 flush），跳过节流 */
  immediate?: boolean;
}

let pendingClosed: IConnectionsItem[] | null = null;
let pendingSnapshot: ConnectionSnapshot | null = null;
let closedTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let lifecycleHooked = false;

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

function ensureLifecycleFlush() {
  if (lifecycleHooked || typeof window === "undefined") return;
  lifecycleHooked = true;
  const onHidden = () => {
    if (document.visibilityState === "hidden") {
      void flushConnectionPersist();
    }
  };
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", () => {
    void flushConnectionPersist();
  });
}

function writeClosedNow(closed: IConnectionsItem[]): Promise<void> {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.resolve();
  }
  return openDb()
    .then(
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
    )
    .catch((): void => {
      // ignore quota or other errors
    }) as Promise<void>;
}

function writeSnapshotNow(data: ConnectionSnapshot): Promise<void> {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.resolve();
  }
  const toStore: ConnectionSnapshot = {
    ...data,
    uploadTotal: 0,
    downloadTotal: 0,
  };
  return openDb()
    .then(
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
    )
    .catch((): void => { }) as Promise<void>;
}

function scheduleClosedPersist() {
  if (closedTimer != null) return;
  closedTimer = setTimeout(() => {
    closedTimer = null;
    const data = pendingClosed;
    pendingClosed = null;
    if (data == null) return;
    void writeClosedNow(data).then(() => {
      if (pendingClosed != null) scheduleClosedPersist();
    });
  }, CONNECTION_PERSIST_THROTTLE_MS);
}

function scheduleSnapshotPersist() {
  if (snapshotTimer != null) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    const data = pendingSnapshot;
    pendingSnapshot = null;
    if (data == null) return;
    void writeSnapshotNow(data).then(() => {
      if (pendingSnapshot != null) scheduleSnapshotPersist();
    });
  }, CONNECTION_PERSIST_THROTTLE_MS);
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
  options?: ConnectionPersistOptions,
): Promise<void> {
  ensureLifecycleFlush();
  if (options?.immediate) {
    pendingClosed = null;
    if (closedTimer != null) {
      clearTimeout(closedTimer);
      closedTimer = null;
    }
    return writeClosedNow(closed);
  }
  pendingClosed = closed;
  scheduleClosedPersist();
  return Promise.resolve();
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
          activeConnections: Array.isArray(v.activeConnections)
            ? v.activeConnections
            : [],
          closedConnections: Array.isArray(v.closedConnections)
            ? v.closedConnections
            : [],
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

export function setConnectionSnapshot(
  data: ConnectionSnapshot,
  options?: ConnectionPersistOptions,
): void {
  ensureLifecycleFlush();
  const toStore: ConnectionSnapshot = {
    ...data,
    uploadTotal: 0,
    downloadTotal: 0,
  };
  if (options?.immediate) {
    pendingSnapshot = null;
    if (snapshotTimer != null) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    void writeSnapshotNow(toStore);
    return;
  }
  pendingSnapshot = toStore;
  scheduleSnapshotPersist();
}

/** 立即写出挂起的已关闭列表与快照（切后台 / 卸载时调用） */
export async function flushConnectionPersist(): Promise<void> {
  if (closedTimer != null) {
    clearTimeout(closedTimer);
    closedTimer = null;
  }
  if (snapshotTimer != null) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  const closed = pendingClosed;
  pendingClosed = null;
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;
  const tasks: Promise<void>[] = [];
  if (closed != null) tasks.push(writeClosedNow(closed));
  if (snapshot != null) tasks.push(writeSnapshotNow(snapshot));
  if (tasks.length === 0) return;
  await Promise.all(tasks);
}
