const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const ts = require(path.join(root, "node_modules/typescript"));
const noop = () => {};
const asyncNoop = async () => {};

// Run the actual startup callback and DelayManager against a bounded IPC pool.
// Every probe succeeds in 700ms, below the configured 1000ms deadline; only
// excessive queueing can create timeouts. No live proxy or network is used.
async function scenario(automatic) {
  let active = 0,
    peak = 0,
    requests = 0;
  const pending = [];
  const jobs = [];
  function pump() {
    while (active < 175 && pending.length) {
      const resolve = pending.shift();
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        resolve({ delay: 700 });
        pump();
      }, 700);
    }
  }
  const modules = new Map();
  const stubs = {
    "@/services/proxy-connectivity-stats": {
      hydrateConnectivityStatsFromDisk: asyncNoop,
    },
    "@/utils/debug": { debugLog: noop },
    "tauri-plugin-mihomo-api": {
      delayProxyByName: () => {
        requests++;
        const job = new Promise((resolve) => {
          pending.push(resolve);
          pump();
        });
        jobs.push(job);
        return job;
      },
    },
  };
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    modules.set(file, exports);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    vm.runInNewContext(code, {
      exports,
      require: (id) =>
        stubs[id] ?? load(path.resolve(path.dirname(file), id + ".ts")),
      console,
      setTimeout,
      clearTimeout,
      Date,
      Map,
      Set,
      Promise,
      Math: Object.assign(Object.create(Math), { random: () => 0 }),
    });
    return exports;
  }
  const delay = load(path.join(root, "src/services/delay.ts"));
  delay.setDelayCheckConcurrency(150);
  const manager = delay.default;
  const names = Array.from({ length: 300 }, (_, i) => `node-${i}`);
  const groups = ["Auto", "NoHK", "Download"].map((name) => ({
    name,
    type: "Fallback",
    timeout: 1000,
    all: names,
  }));
  manager.syncProxyTopo({}, groups);
  if (!automatic) {
    await manager.checkListDelay(names, "Auto", 1000);
  } else {
    const source = fs.readFileSync(
      path.join(root, "src/providers/app-data-provider.tsx"),
      "utf8",
    );
    const start = source.indexOf("    const run = async () => {");
    const end = source.indexOf("    void run();", start);
    assert(start >= 0 && end > start, "Startup callback must be found");
    const snippet = source.slice(start, end) + "\nrun();";
    const code = ts.transpileModule(snippet, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    await vm.runInNewContext(code, {
      urlTestOrFallback: groups,
      delayManager: manager,
      refreshProxy: asyncNoop,
      applyStartupLiveConnectivityOrder: asyncNoop,
      memberNamesFromGroupAll: (x) => x,
      buildConnectivityScoreContext: () => ({}),
      orderedMemberNamesByConnectivity: (x) => x,
      createDelayTestEarlyPicker: () => ({ onResult: noop, flush: asyncNoop }),
      stopDelayTestEarlyPickers: asyncNoop,
      beginDelayCheckManualOverrideTracking: () => noop,
      hasDelayCheckManualOverride: () => false,
      pollingCountRef: { current: 0 },
      scheduleNextPoll: noop,
      getGroupDelayTimeout: delay.getGroupDelayTimeout,
      Map,
    });
  }
  const succeeded = names.filter(
    (name) => manager.getDelay(name, "Auto") > 0,
  ).length;
  console.log(
    JSON.stringify({
      mode: automatic ? "automatic startup" : "manual",
      succeeded,
      total: names.length,
      requests,
      peak,
    }),
  );
  await Promise.all(jobs);
  assert.equal(requests, 300, "Shared nodes must be tested once per session");
  assert(
    peak <= 150,
    "Automatic groups must share the configured worker budget",
  );
  return succeeded;
}
(async () => {
  assert.equal(await scenario(false), 300, "Manual baseline must pass");
  assert.equal(
    await scenario(true),
    300,
    "Automatic startup must preserve successful node results",
  );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
