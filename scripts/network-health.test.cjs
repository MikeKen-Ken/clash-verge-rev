const test = require("node:test");
const assert = require("node:assert/strict");
const load = require("./helpers/load-typescript.cjs")({});
const { sanitizeNetworkHealth } = load("src/utils/network-health.ts");

test("health export drops secrets, free-form errors, names and unknown actions", () => {
  const at = "2026-09-14T00:00:00Z";
  const report = sanitizeNetworkHealth({
    observedAt: at,
    secret: "PRIVATE",
    error: "PRIVATE",
    lastTrafficAt: "PRIVATE",
    switches: -1,
    events: [
      { at, action: "dns-reset", reason: "PRIVATE", durationMs: 3 },
      { at, action: "PRIVATE" },
      { at: "PRIVATE", action: "switch" },
    ],
  });
  assert.equal(report.events.length, 1);
  assert.equal(report.lastTrafficAt, undefined);
  assert.equal(report.switches, 0);
  assert.ok(!JSON.stringify(report).includes("PRIVATE"));
});

test("bounded events and no invented traffic evidence after recovery", () => {
  const report = sanitizeNetworkHealth({
    events: Array.from({ length: 1000 }, () => ({
      at: "2026-09-14T00:00:00Z",
      action: "route-reset",
    })),
  });
  assert.equal(report.events.length, 64);
  assert.equal(report.lastTrafficAt, undefined);
});
