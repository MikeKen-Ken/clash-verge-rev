const test = require("node:test");
const assert = require("node:assert/strict");
const createLoader = require("./helpers/load-typescript.cjs");

test("failed outcomes cannot be reported as a successful update", () => {
  const { checkProfileOutcome } = createLoader({
    "@tauri-apps/api/core": {},
    swr: {},
  })("src/services/profile-activation.ts");
  assert.throws(() => checkProfileOutcome("downloadFailed"), /download failed/);
  assert.throws(
    () => checkProfileOutcome("activationFailed"),
    /activation failed/,
  );
  assert.doesNotThrow(() => checkProfileOutcome("applied"));
  assert.doesNotThrow(() => checkProfileOutcome("downloadSucceeded"));
});

test("activation retry invokes only activation and refreshes state even on failure", async () => {
  const calls = [];
  const { retryProfileActivation } = createLoader({
    "@tauri-apps/api/core": {
      invoke: async (command, args) => {
        calls.push([command, args.index]);
        return "activationFailed";
      },
    },
    swr: { mutate: async (key) => calls.push(["refresh", key]) },
  })("src/services/profile-activation.ts");
  await assert.rejects(retryProfileActivation("current"), /activation failed/);
  assert.deepEqual(calls, [
    ["retry_profile_activation", "current"],
    ["refresh", "profileActivation"],
  ]);
});
