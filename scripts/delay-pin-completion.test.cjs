const assert = require("node:assert/strict");
const test = require("node:test");
const createLoader = require("./helpers/load-typescript.cjs");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("../node_modules/typescript");

function setup() {
  let pin = "";
  const module = createLoader({
    "@/services/cmds": {
      applyGroupProxyOrder: async () => {},
      clearProxyGroupManualSelection: async () => {
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
    select: (name) => {
      pin = name;
    },
  };
}

for (const userSelects of [false, true]) {
  test(`actual startup callback preserves the final pin state (user selects: ${userSelects})`, async () => {
    const { module, getPin, select } = setup();
    let manual = false;
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
      hasDelayCheckManualOverride: () => manual,
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
          // Let the temporary selection finish, then model an explicit choice.
          await Promise.resolve();
          await Promise.resolve();
          if (userSelects) {
            manual = true;
            select("user-node");
          }
        },
      },
      console,
      Map,
    });
    assert.equal(getPin(), userSelects ? "user-node" : "");
    assert.equal(tracking, false);
  });
}

for (const type of ["URLTest", "Fallback"]) {
  for (const startup of [false, true]) {
    test(`${type} ${startup ? "startup" : "manual"} test ends without a pin`, async () => {
      const { module, getPin } = setup();
      const picker = module.createDelayTestEarlyPicker({
        groupName: "Auto",
        orderedNames: ["node"],
        timeoutMs: 1000,
      });
      picker.onResult("node", 50);
      await picker.flush();
      assert.equal(getPin(), "node", "temporary pin is allowed during testing");
      await module.stopDelayTestEarlyPickers([picker]);
      const groups = [{ name: "Auto", type, members: ["node"] }];
      if (startup) {
        await module.applyStartupLiveConnectivityOrder(
          groups,
          undefined,
          new Map([["node", { delay: 50 }]]),
        );
      } else {
        await module.switchGroupsAfterDelayTest({
          groups,
          firstSuccessByGroup: new Map([["Auto", "node"]]),
          manualOverrides: { has: () => false },
        });
      }
      assert.equal(
        getPin(),
        "",
        "completion must not leave or recreate a test pin",
      );
    });
  }
}

test("exception cleanup releases the temporary pin", async () => {
  const { module, getPin } = setup();
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
  assert.equal(getPin(), "");
});

test("a user selection during testing survives cleanup and completion", async () => {
  const { module, getPin, select } = setup();
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
  await module.switchGroupsAfterDelayTest({
    groups: [{ name: "Auto", type: "URLTest", members: ["node"] }],
    firstSuccessByGroup: new Map([["Auto", "node"]]),
    manualOverrides: { has: () => manual },
  });
  assert.equal(getPin(), "user-node");
});
