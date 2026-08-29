import fs from "fs";
import fsp from "fs/promises";

export async function binaryContainsPinnedVersion(binaryPath, version) {
  const needle = Buffer.from(version, "utf-8");
  if (needle.length === 0) return false;

  let carry = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(binaryPath)) {
    const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    if (data.indexOf(needle) !== -1) return true;
    carry = data.subarray(Math.max(0, data.length - needle.length + 1));
  }
  return false;
}

export async function cachedSidecarMatchesPin(
  binaryPath,
  versionPath,
  expectedVersion,
) {
  const recordedVersion = await fsp
    .readFile(versionPath, "utf-8")
    .then((value) => value.trim())
    .catch(() => "");
  if (recordedVersion !== expectedVersion) return false;
  return binaryContainsPinnedVersion(binaryPath, expectedVersion);
}

export async function assertSidecarMatchesPin(binaryPath, expectedVersion) {
  if (await binaryContainsPinnedVersion(binaryPath, expectedVersion)) return;
  throw new Error(
    `Downloaded Mihomo sidecar does not contain pinned version ${expectedVersion}`,
  );
}
