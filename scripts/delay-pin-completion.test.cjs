const assert = require("node:assert/strict");
const test = require("node:test");
const createLoader = require("./helpers/load-typescript.cjs");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("../node_modules/typescript");

// A pin is released only by the user's explicit unpin. Delay testing, reordering
// and startup ordering must neither create nor clear it.
function setup(initialPin = "") {
  let pin = initialPin;
  let clearCalls = 0;
  const module = createLoader({
    "@/services/cmds": {
      applyGroupProxyOrder: async () => {},
      clearProxyGroupManualSelection: async () => {
        clearCalls += 1;
        pin = "";
      },
      forceSelectGroupProxy: async (_, name) => {
        pin = name;
      },
    },
    "@/services/proxy-connectivity-stats": {
      hydrateConnectivityStatsFromDisk: async () => {},
      buildConnectivityScoreContext: () => ({}),
    },
    "@/services/proxy-region-sort": {
      sortProxiesByConnectivity: (names) => names,
    },
  })("src/services/proxy-live-connectivity-order.ts");
  return {
    module,
    getPin: () => pin,
    getClearCalls: () => clearCalls,
    select: (name) => {
      pin = name;
    },
  };
}

for (const initialPin of ["", "user-node"]) {
  test(`actual startup callback keeps the pin state (initial pin: "${initialPin}")`, async () => {
    const { module, getPin, getClearCalls } = setup(initialPin);
    let tracking = false;
    const source = fs.readFileSync(
      path.join(__dirname, "../src/providers/app-data-provider.tsx"),
      "utf8",
    );
    const start = source.indexOf("    const run = async () => {");
    const end = source.indexOf("    void run();", start);
    assert.ok(start >= 0 && end > start);
    const code = ts.transpileModule(source.slice(start, end) + "\nrun();", {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    await vm.runInNewContext(code, {
      ...module,
      urlTestOrFallback: [{ name: "Auto", type: "URLTest", all: ["node"] }],
      beginDelayCheckManualOverrideTracking: () => {
        tracking = true;
        return () => {
          tracking = false;
        };
      },
      hasDelayCheckManualOverride: () => false,
      refreshProxy: async () => {},
      buildConnectivityScoreContext: () => ({}),
      getGroupDelayTimeout: () => 1000,
      pollingCountRef: { current: 0 },
      scheduleNextPoll: () => {},
      delayManager: {
        beginBulkDelaySession() {},
        endBulkDelaySession() {},
        markGroupDelayTesting() {},
        async checkListDelay(_, group, timeout, options) {
          assert.equal(tracking, true);
          options.onNodeSettled("node", 50);
          options.bulkReuseMap.set("node", { delay: 50 });
        },
      },
      console,
      Map,
    });
    assert.equal(getPin(), initialPin);
    assert.equal(getClearCalls(), 0);
    assert.equal(tracking, false);
  });
}

for (const type of ["URLTest", "Fallback"]) {
  for (const startup of [false, true]) {
    for (const initialPin of ["", "user-node"]) {
      test(`${type} ${startup ? "startup" : "manual"} test keeps the pin (initial pin: "${initialPin}")`, async () => {
        const { module, getPin, getClearCalls } = setup(initialPin);
        const picker = module.createDelayTestEarlyPicker({
          groupName: "Auto",
          orderedNames: ["node"],
          timeoutMs: 1000,
        });
        picker.onResult("node", 50);
        await picker.flush();
        assert.equal(getPin(), initialPin, "early picking must not touch the pin");
        await module.stopDelayTestEarlyPickers([picker]);
        const groups = [{ name: "Auto", type, members: ["node"] }];
        if (startup) {
          await module.applyStartupLiveConnectivityOrder(groups);
        } else {
          await module.reorderGroupsAfterDelayTest({
            groups,
            manualOverrides: { has: () => false },
          });
        }
        assert.equal(getPin(), initialPin, "completion must not change the pin");
        assert.equal(getClearCalls(), 0, "nothing may release a pin automatically");
      });
    }
  }
}

test("interrupted delay testing never touches the pin", async () => {
  const { module, getPin, getClearCalls } = setup("user-node");
  const picker = module.createDelayTestEarlyPicker({
    groupName: "Auto",
    orderedNames: ["node"],
    timeoutMs: 1000,
  });
  try {
    picker.onResult("node", 50);
    await picker.flush();
    throw new Error("test interrupted");
  } catch {
  } finally {
    await module.stopDelayTestEarlyPickers([picker]);
  }
  assert.equal(getPin(), "user-node");
  assert.equal(getClearCalls(), 0);
});

test("a user selection during testing survives cleanup and completion", async () => {
  const { module, getPin, select, getClearCalls } = setup();
  let manual = false;
  const picker = module.createDelayTestEarlyPicker({
    groupName: "Auto",
    orderedNames: ["node"],
    timeoutMs: 1000,
    isCancelled: () => manual,
  });
  picker.onResult("node", 50);
  await picker.flush();
  manual = true;
  select("user-node");
  await module.stopDelayTestEarlyPickers([picker]);
  await module.reorderGroupsAfterDelayTest({
    groups: [{ name: "Auto", type: "URLTest", members: ["node"] }],
    manualOverrides: { has: () => manual },
  });
  assert.equal(getPin(), "user-node");
  assert.equal(getClearCalls(), 0);
});
