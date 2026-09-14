const assert = require("node:assert/strict");
const test = require("node:test");
const createLoader = require("./helpers/load-typescript.cjs");

function setup() {
  let verge = {
    enable_auto_delay_detection: false,
    auto_delay_detection_interval_minutes: 2,
  };
  let current = {
    currentProxy: { name: "A" },
    primaryGroupName: "Auto",
    mode: "rule",
    refreshProxy: async () => {},
  };
  let snapshot = {
    records: {},
    groups: [{ name: "Auto", timeout: 1000 }],
    global: null,
  };
  let checking = false;
  const requests = [],
    schedules = [],
    effects = [],
    refs = [];
  let cursor = 0,
    refCursor = 0,
    pendingEffects = [];
  const react = {
    useRef: (initial) =>
      refs[refCursor++] ?? (refs[refCursor - 1] = { current: initial }),
    useEffect: (effect, deps) => {
      const index = cursor++,
        previous = effects[index];
      if (
        !previous ||
        deps.some((dep, i) => !Object.is(dep, previous.deps[i]))
      ) {
        pendingEffects.push(() => {
          previous?.cleanup?.();
          effects[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
  const module = createLoader({
    react,
    "@/hooks/use-verge": { useVerge: () => ({ verge }) },
    "@/hooks/use-current-proxy": { useCurrentProxy: () => current },
    "@/providers/app-data-context": {
      useAppData: () => ({ proxies: snapshot }),
    },
    "@/services/delay": {
      default: {
        getDelayUpdate: () => (checking ? { delay: -2 } : undefined),
        checkDelay: async (name, group, timeout) => {
          requests.push({ name, group, timeout });
        },
      },
      getGroupDelayTimeout: (g) => g?.timeout ?? 5000,
    },
    "@/services/auto-delay-detection": {
      startAutoDelayDetection: (options) => {
        const entry = { ...options, stopped: false };
        schedules.push(entry);
        return () => {
          entry.stopped = true;
        };
      },
    },
  })("src/components/proxy/auto-delay-detection.tsx");
  function render() {
    cursor = 0;
    refCursor = 0;
    pendingEffects = [];
    module.AutoDelayDetection();
    pendingEffects.forEach((effect) => effect());
  }
  return {
    render,
    requests,
    schedules,
    settings: (patch) => {
      verge = { ...verge, ...patch };
    },
    current: (patch) => {
      current = { ...current, ...patch };
    },
    snapshot: (value) => {
      snapshot = value;
    },
    checking: (value) => {
      checking = value;
    },
    unmount: () => effects.forEach((effect) => effect.cleanup?.()),
    fire: () => schedules.at(-1).run(() => schedules.at(-1).stopped),
  };
}

test("toggle and interval control the timer while ticks use the latest selection", async () => {
  const app = setup();
  app.render();
  assert.equal(app.schedules.length, 0);
  app.settings({ enable_auto_delay_detection: true });
  app.render();
  assert.equal(app.schedules[0].intervalMinutes, 2);
  await app.fire();
  app.current({ currentProxy: { name: "B" } });
  app.render();
  assert.equal(
    app.schedules.length,
    1,
    "proxy refresh must not reset the timer",
  );
  await app.fire();
  assert.deepEqual(
    app.requests.map((x) => x.name),
    ["A", "B"],
  );
  app.settings({ auto_delay_detection_interval_minutes: 3 });
  app.render();
  assert.equal(app.schedules[0].stopped, true);
  assert.equal(app.schedules[1].intervalMinutes, 3);
  app.settings({ enable_auto_delay_detection: false });
  app.render();
  assert.equal(app.schedules[1].stopped, true);
  app.settings({ enable_auto_delay_detection: true });
  app.render();
  app.unmount();
  assert.equal(app.schedules[2].stopped, true);
});

test("skips direct mode, preset nodes and overlapping checks; follows nested selection", async () => {
  const app = setup();
  app.settings({ enable_auto_delay_detection: true });
  app.render();
  app.current({ mode: "direct" });
  app.render();
  await app.fire();
  app.current({ mode: "rule", currentProxy: { name: "DIRECT" } });
  app.render();
  await app.fire();
  app.current({ currentProxy: { name: "A" } });
  app.checking(true);
  app.render();
  await app.fire();
  assert.equal(app.requests.length, 0);
  app.checking(false);
  app.current({ currentProxy: { name: "Nested", now: "Leaf" } });
  app.snapshot({
    records: { Leaf: { name: "Leaf" } },
    groups: [{ name: "Nested", timeout: 1500 }],
  });
  app.render();
  await app.fire();
  assert.deepEqual(app.requests, [
    { name: "Leaf", group: "Nested", timeout: 1500 },
  ]);
  app.unmount();
});
