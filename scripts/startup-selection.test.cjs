const assert = require("node:assert/strict");
const test = require("node:test");
const createLoader = require("./helpers/load-typescript.cjs");
const noop = async () => {};

function setup() {
  const calls = [];
  const module = createLoader({
    "@/services/cmds": {
      applyGroupProxyOrder: noop,
      clearProxyGroupManualSelection: async () => {
        calls.push('CLEAR');
      },
      forceSelectGroupProxy: async (group, name) => {
        calls.push(name);
      },
    },
    "@/services/proxy-connectivity-stats": {
      hydrateConnectivityStatsFromDisk: noop,
      buildConnectivityScoreContext: () => ({}),
    },
    "@/services/proxy-region-sort": {
      sortProxiesByConnectivity: (names) => names,
    },
  })("src/services/proxy-live-connectivity-order.ts");
  const groups = [
    {
      name: "Auto",
      type: "URLTest",
      members: ["offline", "healthy"],
      timeout: 1000,
    },
  ];
  return { module, groups, calls };
}

test("delay testing never creates or clears a manual pin", async () => {
  const { module, groups, calls } = setup();
  const picker = module.createDelayTestEarlyPicker({
    groupName: "Auto",
    orderedNames: groups[0].members,
    timeoutMs: 1000,
  });
  picker.onResult("offline", 0);
  picker.onResult("healthy", 75);
  await picker.flush();
  await module.stopDelayTestEarlyPickers([picker]);
  await module.applyStartupLiveConnectivityOrder(
    groups,
  );
  assert.deepEqual(calls, []);
});

test("startup ordering never pins or unpins any group", async () => {
  const { module, groups, calls } = setup();
  await module.applyStartupLiveConnectivityOrder(groups);
  await module.applyStartupLiveConnectivityOrder(
    groups,
    { has: () => true },
  );
  assert.deepEqual(calls, []);
});
