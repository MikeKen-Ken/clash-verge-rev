const assert = require("node:assert/strict");
const test = require("node:test");
const createLoader = require("./helpers/load-typescript.cjs");
const noop = async () => {};

function setup() {
  const calls = [];
  const module = createLoader({
    "@/services/cmds": {
      applyGroupProxyOrder: noop,
      clearProxyGroupManualSelection: noop,
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

test("finalization retains the verified backup instead of the failed score leader", async () => {
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
    undefined,
    new Map([
      ["offline", { delay: 0 }],
      ["healthy", { delay: 75 }],
    ]),
  );
  assert.deepEqual(calls, ["healthy", "healthy"]);
});

test("unmeasured, failed, over-timeout or manually overridden groups are not pinned", async () => {
  const { module, groups, calls } = setup();
  await module.applyStartupLiveConnectivityOrder(groups);
  await module.applyStartupLiveConnectivityOrder(
    groups,
    undefined,
    new Map([
      ["offline", { delay: 0 }],
      ["healthy", { delay: 1000 }],
    ]),
  );
  await module.applyStartupLiveConnectivityOrder(
    groups,
    { has: () => true },
    new Map([["healthy", { delay: 75 }]]),
  );
  assert.deepEqual(calls, []);
});
