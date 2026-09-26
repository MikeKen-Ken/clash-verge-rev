const test = require("node:test");
const assert = require("node:assert/strict");
const createLoader = require("./helpers/load-typescript.cjs");

function loadAccept() {
  return createLoader()("src/utils/native-confirm.ts").acceptNativeConfirm;
}

test("a confirm promise that resolves no does not authorize the clear", async () => {
  const accept = loadAccept();
  assert.equal(await accept(() => Promise.resolve(false), "clear"), false);
});

test("a confirm promise that resolves yes authorizes the clear", async () => {
  const accept = loadAccept();
  assert.equal(await accept(() => Promise.resolve(true), "clear"), true);
});

test("a synchronous no still blocks the clear", async () => {
  const accept = loadAccept();
  assert.equal(await accept(() => false, "clear"), false);
});
