/** One authoritative closed-history record, with throttled atomic snapshot writes. */
const DB_NAME = "verge_connections";
const DB_VERSION = 1;
const STORE_NAME = "closed";
const KEY = "list";
const SNAPSHOT_KEY = "snapshot";
export const CONNECTION_PERSIST_THROTTLE_MS = 30_000;

export interface ConnectionSnapshot {
  uploadTotal: number;
  downloadTotal: number;
  activeConnections: IConnectionsItem[];
  closedConnections: IConnectionsItem[];
}
export interface ConnectionPersistOptions {
  immediate?: boolean;
}
type StoredSnapshot = Omit<ConnectionSnapshot, "closedConnections">;
let pendingClosed: IConnectionsItem[] | null = null;
let pendingSnapshot: StoredSnapshot | null = null;
let latestClosed: IConnectionsItem[] | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lifecycleHooked = false;
let writes: Promise<void> = Promise.resolve();

function openDb(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.reject(new Error("IndexedDB not available"));
  }
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME))
        db.createObjectStore(STORE_NAME);
    };
  });
}

function schedulePersist() {
  if (!lifecycleHooked && typeof window !== "undefined") {
    lifecycleHooked = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void flushConnectionPersist();
    });
    window.addEventListener("pagehide", () => {
      void flushConnectionPersist();
    });
  }
  if (timer == null) {
    timer = setTimeout(() => {
      void flushConnectionPersist();
    }, CONNECTION_PERSIST_THROTTLE_MS);
  }
}

async function writeNow(
  closed: IConnectionsItem[] | null,
  snapshot: StoredSnapshot | null,
) {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      // Request success is not a commit: an aborted transaction must not resolve early.
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
      const store = tx.objectStore(STORE_NAME);
      if (closed != null) store.put(closed, KEY);
      if (snapshot != null) store.put(snapshot, SNAPSHOT_KEY);
    });
  } finally {
    db.close();
  }
}

/** Serialize flushes so an older write cannot overtake an explicit clear. */
export function flushConnectionPersist(): Promise<void> {
  if (timer != null) clearTimeout(timer);
  timer = null;
  const closed = pendingClosed;
  const snapshot = pendingSnapshot;
  pendingClosed = null;
  pendingSnapshot = null;
  if (closed == null && snapshot == null) return writes;
  writes = writes
    .then(() => writeNow(closed, snapshot))
    .catch(() => {
      // Best-effort storage; allow a later snapshot to retry after a failure.
      if (latestClosed === closed) latestClosed = null;
    });
  return writes;
}

export function setClosedConnectionsInStorage(
  closed: IConnectionsItem[],
  options?: ConnectionPersistOptions,
): Promise<void> {
  latestClosed = closed;
  pendingClosed = closed;
  schedulePersist();
  return options?.immediate ? flushConnectionPersist() : Promise.resolve();
}

export function setConnectionSnapshot(
  data: ConnectionSnapshot,
  options?: ConnectionPersistOptions,
): void {
  // Immutable snapshots reuse history when it has not changed.
  if (latestClosed !== data.closedConnections) {
    latestClosed = data.closedConnections;
    pendingClosed = data.closedConnections;
  }
  pendingSnapshot = {
    uploadTotal: 0,
    downloadTotal: 0,
    activeConnections: data.activeConnections,
  };
  schedulePersist();
  if (options?.immediate) void flushConnectionPersist();
}

async function readState(): Promise<{
  snapshot: ConnectionSnapshot | null;
  closed: IConnectionsItem[];
}> {
  await writes;
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const snapshotRequest = store.get(SNAPSHOT_KEY);
      const closedRequest = store.get(KEY);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => {
        const raw = snapshotRequest.result as ConnectionSnapshot | undefined;
        // Legacy embedded history is a fallback only. An explicit empty list wins.
        const closed = Array.isArray(closedRequest.result)
          ? closedRequest.result
          : Array.isArray(raw?.closedConnections)
            ? raw.closedConnections
            : [];
        resolve({
          closed,
          snapshot:
            raw && typeof raw === "object"
              ? {
                  uploadTotal: 0,
                  downloadTotal: 0,
                  activeConnections: Array.isArray(raw.activeConnections)
                    ? raw.activeConnections
                    : [],
                  closedConnections: closed,
                }
              : null,
        });
      };
    });
  } finally {
    db.close();
  }
}

export async function getConnectionSnapshot(): Promise<ConnectionSnapshot | null> {
  try {
    return (await readState()).snapshot;
  } catch {
    return null;
  }
}
export async function getClosedConnectionsFromStorage(): Promise<
  IConnectionsItem[]
> {
  try {
    return (await readState()).closed;
  } catch {
    return [];
  }
}
