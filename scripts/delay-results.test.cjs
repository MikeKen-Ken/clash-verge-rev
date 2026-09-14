const assert = require("node:assert/strict");
const test = require("node:test");
const createLoader = require("./helpers/load-typescript.cjs");
const noop = async () => {};
const load = () =>
  createLoader({
    "@/services/proxy-connectivity-stats": {
      hydrateConnectivityStatsFromDisk: noop,
    },
    "@/utils/debug": { debugLog: noop },
    "tauri-plugin-mihomo-api": {
      delayProxyByName: async () => ({ delay: 75 }),
    },
  })("src/services/delay.ts").default;

test("new automatic success replaces cached timeout in cards and shared lookups", () => {
  const manager = load();
  const cached = manager.setDelay("node", "group", 0);
  const proxy = {
    name: "node",
    history: [
      { time: new Date(cached.updatedAt + 1000).toISOString(), delay: 75 },
    ],
  };
  assert.equal(manager.getDelayFix(proxy, "group"), 75);
  assert.equal(manager.getProxyDelayUpdate(proxy, "group").delay, 75);
  manager.syncProxyTopo({ node: proxy }, []);
  assert.equal(manager.getDelayUpdate("node", "group").delay, 75);
});

test("new automatic failure replaces cached success, older history does not", () => {
  const manager = load();
  const cached = manager.setDelay("node", "group", 75);
  const proxy = {
    name: "node",
    history: [
      { time: new Date(cached.updatedAt - 1000).toISOString(), delay: 0 },
    ],
  };
  assert.equal(manager.getDelayFix(proxy, "group"), 75);
  proxy.history[0].time = new Date(cached.updatedAt + 1000).toISOString();
  assert.equal(manager.getDelayFix(proxy, "group"), 1e6);
});

test("in-flight tests and valid cache survive stale or malformed snapshots", () => {
  const manager = load();
  const cached = manager.setDelay("node", "group", -2);
  const proxy = {
    name: "node",
    history: [
      { time: new Date(cached.updatedAt + 1000).toISOString(), delay: 75 },
    ],
  };
  assert.equal(manager.getDelayFix(proxy, "group"), -2);
  manager.setDelay("node", "group", 80);
  proxy.history[0].time = "invalid";
  assert.equal(manager.getDelayFix(proxy, "group"), 80);
});
