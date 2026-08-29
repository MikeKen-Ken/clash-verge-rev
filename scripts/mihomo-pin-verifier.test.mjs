import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSidecarMatchesPin,
  binaryContainsPinnedVersion,
  cachedSidecarMatchesPin,
} from "./mihomo-pin-verifier.mjs";

test("validates the binary contents as well as the version marker", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mihomo-pin-"));
  const binaryPath = path.join(tempDir, "mihomo.bin");
  const versionPath = `${binaryPath}.version`;

  try {
    const prefix = Buffer.alloc(64 * 1024 - 1, 0x2e);
    await writeFile(
      binaryPath,
      Buffer.concat([prefix, Buffer.from("alpha-4be9e92-suffix")]),
    );
    await writeFile(versionPath, "alpha-4be9e92\n", "utf-8");

    assert.equal(
      await binaryContainsPinnedVersion(binaryPath, "alpha-4be9e92"),
      true,
    );
    assert.equal(
      await cachedSidecarMatchesPin(binaryPath, versionPath, "alpha-4be9e92"),
      true,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("rejects a stale binary even when its marker claims the pinned version", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mihomo-pin-"));
  const binaryPath = path.join(tempDir, "mihomo.bin");
  const versionPath = `${binaryPath}.version`;

  try {
    await writeFile(binaryPath, Buffer.from("prefix-alpha-d85d81d-suffix"));
    await writeFile(versionPath, "alpha-4be9e92\n", "utf-8");

    assert.equal(
      await cachedSidecarMatchesPin(binaryPath, versionPath, "alpha-4be9e92"),
      false,
    );
    await assert.rejects(
      assertSidecarMatchesPin(binaryPath, "alpha-4be9e92"),
      /does not contain pinned version/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
