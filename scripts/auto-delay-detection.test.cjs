const assert = require("node:assert/strict");
const test = require("node:test");
const createLoader = require("./helpers/load-typescript.cjs");
const { startAutoDelayDetection } = createLoader({})(
  "src/services/auto-delay-detection.ts",
);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function clock() {
  let next = 0;
  const timers = new Map();
  return {
    timers,
    setTimer: (fn, ms) => {
      timers.set(++next, { fn, ms });
      return next;
    },
    clearTimer: (id) => timers.delete(id),
    fire: () => {
      const [id, { fn }] = timers.entries().next().value;
      timers.delete(id);
      fn();
    },
  };
}

test("uses configured minutes, never overlaps, and stops after disable", async () => {
  const time = clock();
  let finish,
    calls = 0,
    cancelled;
  const stop = startAutoDelayDetection({
    intervalMinutes: 2,
    ...time,
    onError: assert.fail,
    run: async (check) => {
      calls++;
      cancelled = check;
      await new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  assert.equal(calls, 0);
  assert.equal([...time.timers.values()][0].ms, 120000);
  time.fire();
  assert.equal(calls, 1);
  assert.equal(time.timers.size, 0);
  stop();
  assert.equal(cancelled(), true);
  finish();
  await flush();
  assert.equal(time.timers.size, 0);
});

test("continues after failure and a changed interval replaces the old timer", async () => {
  const time = clock();
  let errors = 0;
  const stop = startAutoDelayDetection({
    intervalMinutes: 1,
    ...time,
    run: async () => {
      throw Error("offline");
    },
    onError: () => {
      errors++;
    },
  });
  time.fire();
  await flush();
  assert.equal(errors, 1);
  assert.equal(time.timers.size, 1);
  stop();
  assert.equal(time.timers.size, 0);
  const stopNew = startAutoDelayDetection({
    intervalMinutes: 3,
    ...time,
    run: async () => {},
    onError: assert.fail,
  });
  assert.equal([...time.timers.values()][0].ms, 180000);
  stopNew();
});
