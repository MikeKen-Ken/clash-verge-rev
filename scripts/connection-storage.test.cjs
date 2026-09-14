const assert = require("node:assert/strict");
const test = require("node:test");
const { IDBFactory } = require(
  process.env.FAKE_INDEXEDDB_MODULE || "fake-indexeddb",
);
const createLoader = require("./helpers/load-typescript.cjs");

function setup() {
  const indexedDB = new IDBFactory();
  const listeners = {};
  const document = {
    visibilityState: "visible",
    addEventListener: (name, fn) => {
      listeners[name] = fn;
    },
  };
  const storage = createLoader(
    {},
    {
      window: {
        indexedDB,
        addEventListener: (name, fn) => {
          listeners[name] = fn;
        },
      },
      document,
    },
  )("src/utils/closed-connections-storage.ts");
  async function records(write) {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("verge_connections", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("closed");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction("closed", write ? "readwrite" : "readonly");
      const store = tx.objectStore("closed");
      if (write)
        for (const [key, value] of Object.entries(write)) store.put(value, key);
      const list = store.get("list"),
        snapshot = store.get("snapshot");
      tx.oncomplete = () =>
        resolve({ list: list.result, snapshot: snapshot.result });
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return result;
  }
  return { storage, records, listeners, document };
}
const snapshot = (closedConnections = [{ id: "closed" }]) => ({
  uploadTotal: 12,
  downloadTotal: 24,
  activeConnections: [{ id: "active" }],
  closedConnections,
});

test("history is stored once and snapshot totals are not restored", async () => {
  const { storage, records } = setup();
  const data = snapshot();
  await storage.setClosedConnectionsInStorage(data.closedConnections);
  storage.setConnectionSnapshot(data);
  await storage.flushConnectionPersist();
  const saved = await records();
  assert.equal(saved.list.length, 1);
  assert.equal(Object.hasOwn(saved.snapshot, "closedConnections"), false);
  const restored = await storage.getConnectionSnapshot();
  assert.equal(restored.closedConnections[0].id, "closed");
  assert.equal(restored.activeConnections[0].id, "active");
  assert.equal(restored.uploadTotal, 0);
  assert.equal(restored.downloadTotal, 0);
});

test("legacy embedded history remains readable and migrates on save", async () => {
  const { storage, records } = setup();
  await records({ snapshot: snapshot() });
  const restored = await storage.getConnectionSnapshot();
  assert.equal(restored.closedConnections[0].id, "closed");
  storage.setConnectionSnapshot(restored);
  await storage.flushConnectionPersist();
  const saved = await records();
  assert.equal(saved.list[0].id, "closed");
  assert.equal(Object.hasOwn(saved.snapshot, "closedConnections"), false);
});

test("explicit empty history overrides legacy embedded history", async () => {
  const { storage, records } = setup();
  await records({ snapshot: snapshot(), list: [] });
  assert.equal(
    (await storage.getConnectionSnapshot()).closedConnections.length,
    0,
  );
  assert.equal((await storage.getClosedConnectionsFromStorage()).length, 0);
});

test("a clear wins over pending and in-flight older writes", async () => {
  const { storage } = setup();
  storage.setConnectionSnapshot(snapshot());
  const older = storage.flushConnectionPersist();
  await storage.setClosedConnectionsInStorage([], { immediate: true });
  await older;
  assert.equal(
    (await storage.getConnectionSnapshot()).closedConnections.length,
    0,
  );
});

test("hidden-page flush commits the latest coalesced snapshot", async () => {
  const { storage, listeners, document } = setup();
  storage.setConnectionSnapshot(snapshot());
  storage.setConnectionSnapshot(snapshot([{ id: "latest" }]));
  document.visibilityState = "hidden";
  listeners.visibilitychange();
  await storage.flushConnectionPersist();
  assert.equal(
    (await storage.getConnectionSnapshot()).closedConnections[0].id,
    "latest",
  );
});
