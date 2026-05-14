import fs from "fs";
import fsp from "fs/promises";
import { createRequire } from "module";
import path from "path";

import AdmZip from "adm-zip";

const target = process.argv.slice(2)[0];
const ARCH_MAP = {
  "x86_64-pc-windows-msvc": "x64",
  "aarch64-pc-windows-msvc": "arm64",
};

const PROCESS_MAP = {
  x64: "x64",
  arm64: "arm64",
};
const arch = target ? ARCH_MAP[target] : PROCESS_MAP[process.arch];
/// Script for ci
/// 打包绿色版/便携版 (only Windows)
async function resolvePortable() {
  if (process.platform !== "win32") return;

  const releaseDir = target
    ? `./src-tauri/target/${target}/release`
    : `./src-tauri/target/release`;
  const configDir = path.join(releaseDir, ".config");

  if (!fs.existsSync(releaseDir)) {
    throw new Error("could not found the release dir");
  }

  await fsp.mkdir(configDir, { recursive: true });
  if (!fs.existsSync(path.join(configDir, "PORTABLE"))) {
    await fsp.writeFile(path.join(configDir, "PORTABLE"), "");
  }
  const zip = new AdmZip();

  const releaseEntries = await fsp.readdir(releaseDir);
  /** 优先固定名 verge-mihomo-custom.exe；否则为 Tauri externalBin 默认名 verge-mihomo-custom-<triple>.exe */
  const tripleName = target
    ? `verge-mihomo-custom-${target}.exe`
    : null;
  const customSidecar =
    (releaseEntries.includes("verge-mihomo-custom.exe") &&
      "verge-mihomo-custom.exe") ||
    (tripleName &&
      releaseEntries.includes(tripleName) &&
      tripleName) ||
    releaseEntries.find(
      (f) =>
        f.startsWith("verge-mihomo-custom-") &&
        f.endsWith(".exe") &&
        f !== "verge-mihomo-custom.exe",
    );
  if (!customSidecar) {
    throw new Error(
      "verge-mihomo-custom sidecar not found in release dir (expected verge-mihomo-custom.exe or verge-mihomo-custom-<triple>.exe)",
    );
  }

  zip.addLocalFile(path.join(releaseDir, "clash-verge.exe"));
  zip.addLocalFile(path.join(releaseDir, customSidecar));
  zip.addLocalFolder(path.join(releaseDir, "resources"), "resources");
  zip.addLocalFolder(configDir, ".config");

  const require = createRequire(import.meta.url);
  const packageJson = require("../package.json");
  const { version } = packageJson;
  const zipFile = `Clash.Verge_${version}_${arch}_portable.zip`;
  zip.writeZip(zipFile);
  console.log("[INFO]: create portable zip successfully");
}

resolvePortable().catch(console.error);
