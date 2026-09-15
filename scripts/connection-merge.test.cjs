const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadConnectionMerge,
  connection,
} = require("./helpers/connection-fixture.cjs");

test("unchanged active snapshots retain rows and traffic changes keep metadata", () => {
  const merge = loadConnectionMerge();
  const first = merge({ connections: [connection(1)] });
  const unchanged = merge({ connections: [connection(1)] }, first);
  assert.equal(unchanged.activeConnections, first.activeConnections);
  const traffic = merge({ connections: [connection(1, 1)] }, unchanged);
  assert.equal(
    traffic.activeConnections[0].metadata,
    first.activeConnections[0].metadata,
  );
  assert.equal(traffic.activeConnections[0].curDownload, 100);
});

test("churn moves missing rows into bounded history while keeping surviving order", () => {
  const merge = loadConnectionMerge();
  let previous = merge({ connections: [connection(1), connection(2)] });
  const next = merge({ connections: [connection(3), connection(2)] }, previous);
  assert.deepEqual(
    Array.from(next.activeConnections, (c) => c.id),
    ["2", "3"],
  );
  assert.deepEqual(
    Array.from(next.closedConnections, (c) => c.id),
    ["1"],
  );
  for (let i = 0; i < 70; i++) {
    previous = merge(
      {
        connections: Array.from({ length: 100 }, (_, n) =>
          connection(i * 100 + n),
        ),
      },
      previous,
    );
    assert.ok(previous.closedConnections.length <= 5000);
  }
});
