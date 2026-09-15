const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  loadConnectionMerge,
  connection,
} = require("./helpers/connection-fixture.cjs");
const merge = loadConnectionMerge();
const results = [];
for (const size of [100, 1000, 5000]) {
  for (const scenario of ["unchanged", "traffic", "churn"]) {
    let state = merge({
      connections: Array.from({ length: size }, (_, i) => connection(i)),
    });
    const timings = [];
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const cpuBefore = process.cpuUsage();
    for (let tick = 0; tick < 65; tick++) {
      const offset =
        scenario === "churn" ? tick * Math.max(1, Math.floor(size / 10)) : 0;
      const wire = JSON.stringify({
        connections: Array.from({ length: size }, (_, i) =>
          connection(i + offset, scenario === "unchanged" ? 0 : tick),
        ),
      });
      const start = performance.now();
      state = merge(JSON.parse(wire), state);
      if (tick >= 15) timings.push(performance.now() - start);
    }
    const cpu = process.cpuUsage(cpuBefore);
    global.gc?.();
    timings.sort((a, b) => a - b);
    results.push({
      size,
      scenario,
      samples: timings.length,
      p50Ms: timings[24],
      p95Ms: timings[47],
      maxMs: timings.at(-1),
      cpuMs: (cpu.user + cpu.system) / 1000,
      retainedHeapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
      activeRows: state.activeConnections.length,
      closedRows: state.closedConnections.length,
      budgetMs: 50,
      withinBudget: timings[47] <= 50,
    });
  }
}
const report = {
  observedAt: new Date().toISOString(),
  node: process.version,
  scope:
    "Synthetic production JSON parse and snapshot merge; excludes React rendering, IPC and real IndexedDB. CPU includes fixture creation; heap delta includes retained history, not a leak verdict.",
  gcAvailable: Boolean(global.gc),
  results,
};
const output = process.argv[2];
if (output) {
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--enforce") && results.some((r) => !r.withinBudget))
  process.exitCode = 1;
