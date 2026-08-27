import { execSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import zlib from "zlib";

import AdmZip from "adm-zip";
import { glob } from "glob";
import { HttpsProxyAgent } from "https-proxy-agent";
import fetch from "node-fetch";
import { extract } from "tar";

import { log_debug, log_error, log_info, log_success } from "./utils.mjs";

/**
 * Prebuild script with optimization features:
 * 1. Skip downloading mihomo core if it already exists (unless --force is used)
 * 2. Cache version information for 1 hour to avoid repeated version checks
 * 3. Use file hash to detect changes and skip unnecessary chmod/copy operations
 * 4. Use --force or -f flag to force re-download and update all resources
 *
 */

const cwd = process.cwd();
const TEMP_DIR = path.join(cwd, "node_modules/.verge");
const FORCE = process.argv.includes("--force") || process.argv.includes("-f");
const VERSION_CACHE_FILE = path.join(TEMP_DIR, ".version_cache.json");
const HASH_CACHE_FILE = path.join(TEMP_DIR, ".hash_cache.json");

const PLATFORM_MAP = {
  "x86_64-pc-windows-msvc": "win32",
  "i686-pc-windows-msvc": "win32",
  "aarch64-pc-windows-msvc": "win32",
  "x86_64-apple-darwin": "darwin",
  "aarch64-apple-darwin": "darwin",
  "x86_64-unknown-linux-gnu": "linux",
  "i686-unknown-linux-gnu": "linux",
  "aarch64-unknown-linux-gnu": "linux",
  "armv7-unknown-linux-gnueabihf": "linux",
  "riscv64gc-unknown-linux-gnu": "linux",
  "loongarch64-unknown-linux-gnu": "linux",
};
const ARCH_MAP = {
  "x86_64-pc-windows-msvc": "x64",
  "i686-pc-windows-msvc": "ia32",
  "aarch64-pc-windows-msvc": "arm64",
  "x86_64-apple-darwin": "x64",
  "aarch64-apple-darwin": "arm64",
  "x86_64-unknown-linux-gnu": "x64",
  "i686-unknown-linux-gnu": "ia32",
  "aarch64-unknown-linux-gnu": "arm64",
  "armv7-unknown-linux-gnueabihf": "arm",
  "riscv64gc-unknown-linux-gnu": "riscv64",
  "loongarch64-unknown-linux-gnu": "loong64",
};

const arg1 = process.argv.slice(2)[0];
const arg2 = process.argv.slice(2)[1];
const target = arg1 === "--force" || arg1 === "-f" ? arg2 : arg1;
const { platform, arch } = target
  ? { platform: PLATFORM_MAP[target], arch: ARCH_MAP[target] }
  : process;

const SIDECAR_HOST = target
  ? target
  : execSync("rustc -vV")
    .toString()
    .match(/(?<=host: ).+(?=\s*)/g)[0];

function parseJsonText(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

function readJsonFileSync(filePath) {
  return parseJsonText(fs.readFileSync(filePath, "utf-8"));
}

// =======================
// Version Cache
// =======================
async function loadVersionCache() {
  try {
    if (fs.existsSync(VERSION_CACHE_FILE)) {
      const data = await fsp.readFile(VERSION_CACHE_FILE, "utf-8");
      return parseJsonText(data);
    }
  } catch (err) {
    log_debug("Failed to load version cache:", err.message);
  }
  return {};
}
async function saveVersionCache(cache) {
  try {
    await fsp.mkdir(TEMP_DIR, { recursive: true });
    await fsp.writeFile(VERSION_CACHE_FILE, JSON.stringify(cache, null, 2));
    log_debug("Version cache saved");
  } catch (err) {
    log_debug("Failed to save version cache:", err.message);
  }
}
async function getCachedVersion(key) {
  const cache = await loadVersionCache();
  const cached = cache[key];
  if (cached && Date.now() - cached.timestamp < 3600000) {
    log_info(`Using cached version for ${key}: ${cached.version}`);
    return cached.version;
  }
  return null;
}
async function setCachedVersion(key, version) {
  const cache = await loadVersionCache();
  cache[key] = { version, timestamp: Date.now() };
  await saveVersionCache(cache);
}

// =======================
// Hash Cache & File Hash
// =======================
async function calculateFileHash(filePath) {
  try {
    const fileBuffer = await fsp.readFile(filePath);
    const hashSum = createHash("sha256");
    hashSum.update(fileBuffer);
    return hashSum.digest("hex");
  } catch (ignoreErr) {
    return null;
  }
}
async function loadHashCache() {
  try {
    if (fs.existsSync(HASH_CACHE_FILE)) {
      const data = await fsp.readFile(HASH_CACHE_FILE, "utf-8");
      return parseJsonText(data);
    }
  } catch (err) {
    log_debug("Failed to load hash cache:", err.message);
  }
  return {};
}
async function saveHashCache(cache) {
  try {
    await fsp.mkdir(TEMP_DIR, { recursive: true });
    await fsp.writeFile(HASH_CACHE_FILE, JSON.stringify(cache, null, 2));
    log_debug("Hash cache saved");
  } catch (err) {
    log_debug("Failed to save hash cache:", err.message);
  }
}
async function hasFileChanged(filePath, targetPath) {
  if (FORCE) return true;
  if (!fs.existsSync(targetPath)) return true;
  const hashCache = await loadHashCache();
  const sourceHash = await calculateFileHash(filePath);
  const targetHash = await calculateFileHash(targetPath);
  if (!sourceHash || !targetHash) return true;
  const cacheKey = targetPath;
  const cachedHash = hashCache[cacheKey];
  if (cachedHash === sourceHash && sourceHash === targetHash) {
    return false;
  }
  return true;
}
async function updateHashCache(targetPath) {
  const hashCache = await loadHashCache();
  const hash = await calculateFileHash(targetPath);
  if (hash) {
    hashCache[targetPath] = hash;
    await saveHashCache(hashCache);
  }
}

// =======================
// 单一自定义内核（MikeKen-Ken fork，钉死当前对接版本）
// =======================
// 仅打包 `verge-mihomo-custom`，下载自自有仓库 MikeKen-Ken/mihomo。
// 版本以 scripts/mihomo.pin.json 为准（与 Android gitlink 对齐），不再跟随浮动 version.txt。
const META_CUSTOM_PIN_PATH = path.join(cwd, "scripts/mihomo.pin.json");
const META_CUSTOM_PIN = readJsonFileSync(META_CUSTOM_PIN_PATH);
const META_CUSTOM_ROLLING_TAG = META_CUSTOM_PIN.releaseTag || "Prerelease-Alpha";
let META_CUSTOM_VERSION;
const META_CUSTOM_RELEASE_CACHE = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMetaCustomReleaseTagCandidates() {
  const tags = [];
  const pinnedVersion = String(META_CUSTOM_PIN.version || "").trim();
  if (pinnedVersion) tags.push(pinnedVersion);
  if (!tags.includes(META_CUSTOM_ROLLING_TAG)) tags.push(META_CUSTOM_ROLLING_TAG);
  return tags;
}

function getMetaCustomDownloadUrl(releaseTag, fileName) {
  return `https://github.com/${META_CUSTOM_PIN.repo}/releases/download/${releaseTag}/${fileName}`;
}

function getMetaCustomReleaseTagApi(releaseTag) {
  return `https://api.github.com/repos/${META_CUSTOM_PIN.repo}/releases/tags/${releaseTag}`;
}

function createFetchOptions() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const options = {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "clash-verge-rev-prebuild",
    },
  };
  if (token) {
    options.headers.Authorization = `Bearer ${token}`;
  }
  const httpProxy =
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy;
  if (httpProxy) options.agent = new HttpsProxyAgent(httpProxy);
  return options;
}

async function fetchText(url, options) {
  const response = await fetch(url, {
    ...options,
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return (await response.text()).trim();
}

async function fetchAlphaRelease(releaseTag, options) {
  if (META_CUSTOM_RELEASE_CACHE.has(releaseTag)) {
    return META_CUSTOM_RELEASE_CACHE.get(releaseTag);
  }
  const releaseTagApi = getMetaCustomReleaseTagApi(releaseTag);
  const response = await fetch(releaseTagApi, {
    ...options,
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${releaseTagApi}: ${response.status}`);
  }
  const release = await response.json();
  META_CUSTOM_RELEASE_CACHE.set(releaseTag, release);
  return release;
}

async function downloadAlphaAssetViaApi(fileName, outPath, options) {
  // Pin bumps often land while mihomo CI is still publishing the immutable
  // tag. Drop stale API payloads so retries can see a just-published release.
  META_CUSTOM_RELEASE_CACHE.clear();
  const releaseTags = getMetaCustomReleaseTagCandidates();
  let lastError;

  for (const releaseTag of releaseTags) {
    try {
      const release = await fetchAlphaRelease(releaseTag, options);
      const asset = release.assets?.find((item) => item.name === fileName);
      if (!asset) {
        const available = (release.assets || [])
          .map((item) => item.name)
          .filter((name) => name.startsWith("mihomo-"))
          .join(", ");
        lastError = new Error(
          `Release ${releaseTag} missing asset ${fileName}${available ? `; available: ${available}` : ""}`,
        );
        continue;
      }
      const assetResp = await fetch(asset.url, {
        ...options,
        method: "GET",
        headers: {
          ...options.headers,
          Accept: "application/octet-stream",
        },
      });
      if (!assetResp.ok) {
        lastError = new Error(
          `Failed to download alpha asset ${fileName} from ${releaseTag}: status ${assetResp.status}`,
        );
        continue;
      }
      const buf = Buffer.from(await assetResp.arrayBuffer());
      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      await fsp.writeFile(outPath, buf);
      log_success(`download finished via API (${releaseTag}): ${fileName}`);
      return;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `Alpha release asset not found: ${fileName}. Tried tags: ${releaseTags.join(", ")}. ` +
      `Prerelease-Alpha only keeps the latest build; pin version must match an immutable tag or current rolling release. ` +
      `${lastError?.message || ""}`.trim(),
  );
}

// 资产名前缀须与 MikeKen-Ken/mihomo CI 产物一致：
// mihomo-{goos}-{output}-{version}.{zip|gz}
const META_CUSTOM_ASSET_MAP = {
  "win32-x64": "mihomo-windows-amd64",
  "darwin-arm64": "mihomo-darwin-arm64",
  "linux-x64": "mihomo-linux-amd64",
  "linux-arm64": "mihomo-linux-arm64",
};

// =======================
// Resolve pinned custom mihomo version（自有仓库，不跟浮动 tip）
// =======================
async function getLatestCustomVersion() {
  const pinned = String(META_CUSTOM_PIN.version || "").trim();
  if (!pinned) {
    log_error(`mihomo pin missing version: ${META_CUSTOM_PIN_PATH}`);
    process.exit(1);
  }
  META_CUSTOM_VERSION = pinned;
  log_info(
    `MikeKen-Ken mihomo pinned: ${META_CUSTOM_VERSION} (commit ${String(META_CUSTOM_PIN.commit || "").slice(0, 8)})`,
  );
  await setCachedVersion("META_CUSTOM_VERSION", META_CUSTOM_VERSION);
}

// =======================
// Validate availability
// =======================
if (!META_CUSTOM_ASSET_MAP[`${platform}-${arch}`]) {
  throw new Error(
    `mihomo custom unsupported platform "${platform}-${arch}"`,
  );
}

// =======================
// Build meta objects
// =======================
function clashMetaCustom() {
  const assetBase = META_CUSTOM_ASSET_MAP[`${platform}-${arch}`];
  const isWin = platform === "win32";
  const urlExt = isWin ? "zip" : "gz";
  const zipFile = `${assetBase}-${META_CUSTOM_VERSION}.${urlExt}`;
  const [primaryReleaseTag] = getMetaCustomReleaseTagCandidates();
  return {
    name: "verge-mihomo-custom",
    // Tauri externalBin 要求 src-tauri/sidecar 下文件名为 verge-mihomo-custom-<host-triple>(.exe)，与「仅 verge-mihomo-custom.exe」不是同一命名规则。
    targetFile: `verge-mihomo-custom-${SIDECAR_HOST}${isWin ? ".exe" : ""}`,
    exeFile: `${assetBase}${isWin ? ".exe" : ""}`,
    zipFile,
    downloadURL: getMetaCustomDownloadUrl(primaryReleaseTag, zipFile),
    downloadURLCandidates: getMetaCustomReleaseTagCandidates().map((releaseTag) =>
      getMetaCustomDownloadUrl(releaseTag, zipFile),
    ),
  };
}

// =======================
// download helper (增强：status + magic bytes)
// =======================
async function downloadFile(url, outPath, urlCandidates = [url]) {
  const options = createFetchOptions();
  let lastError;

  for (const candidateUrl of urlCandidates) {
    const response = await fetch(candidateUrl, {
      ...options,
      method: "GET",
      headers: { "Content-Type": "application/octet-stream" },
    });
    if (!response.ok) {
      if (response.status === 404) {
        const fileName = decodeURIComponent(candidateUrl.split("/").pop() || "");
        if (fileName) {
          try {
            await downloadAlphaAssetViaApi(fileName, outPath, options);
            return;
          } catch (err) {
            lastError = err;
            continue;
          }
        }
      }
      const body = await response.text().catch(() => "");
      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      await fsp.writeFile(outPath, body);
      lastError = new Error(
        `Failed to download ${candidateUrl}: status ${response.status}`,
      );
      continue;
    }

    const buf = Buffer.from(await response.arrayBuffer());
    await fsp.mkdir(path.dirname(outPath), { recursive: true });

    // 简单 magic 字节检查
    if (candidateUrl.endsWith(".gz") || candidateUrl.endsWith(".tgz")) {
      if (!(buf[0] === 0x1f && buf[1] === 0x8b)) {
        await fsp.writeFile(outPath, buf);
        lastError = new Error(
          `Downloaded file for ${candidateUrl} is not a valid gzip (magic mismatch).`,
        );
        continue;
      }
    } else if (candidateUrl.endsWith(".zip")) {
      if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
        await fsp.writeFile(outPath, buf);
        lastError = new Error(
          `Downloaded file for ${candidateUrl} is not a valid zip (magic mismatch).`,
        );
        continue;
      }
    }

    await fsp.writeFile(outPath, buf);
    log_success(`download finished: ${candidateUrl}`);
    return;
  }

  throw lastError || new Error(`Failed to download ${url}`);
}

// =======================
// resolveSidecar (支持 zip / tgz / gz)
// =======================
async function resolveSidecar(binInfo) {
  const { name, targetFile, zipFile, exeFile, downloadURL, downloadURLCandidates } =
    binInfo;
  const sidecarDir = path.join(cwd, "src-tauri", "sidecar");
  const sidecarPath = path.join(sidecarDir, targetFile);
  await fsp.mkdir(sidecarDir, { recursive: true });

  if (!FORCE && fs.existsSync(sidecarPath)) {
    log_success(`"${name}" already exists, skipping download`);
    return;
  }

  const tempDir = path.join(TEMP_DIR, name);
  const tempZip = path.join(tempDir, zipFile);
  const tempExe = path.join(tempDir, exeFile);
  await fsp.mkdir(tempDir, { recursive: true });

  try {
    if (!fs.existsSync(tempZip)) {
      await downloadFile(
        downloadURL,
        tempZip,
        downloadURLCandidates?.length ? downloadURLCandidates : [downloadURL],
      );
    }

    if (zipFile.endsWith(".zip")) {
      const zip = new AdmZip(tempZip);
      zip.getEntries().forEach((entry) => {
        log_debug(`"${name}" entry: ${entry.entryName}`);
      });
      zip.extractAllTo(tempDir, true);
      // 尝试按 exeFile 重命名，否则找第一个可执行文件
      if (fs.existsSync(tempExe)) {
        await fsp.rename(tempExe, sidecarPath);
      } else {
        // 搜索候选
        const files = await fsp.readdir(tempDir);
        const candidate = files.find(
          (f) =>
            f === path.basename(exeFile) ||
            f.endsWith(".exe") ||
            !f.includes("."),
        );
        if (!candidate)
          throw new Error(`Expected binary not found in ${tempDir}`);
        await fsp.rename(path.join(tempDir, candidate), sidecarPath);
      }
      if (platform !== "win32") execSync(`chmod 755 ${sidecarPath}`);
      log_success(`unzip finished: "${name}"`);
    } else if (zipFile.endsWith(".tgz")) {
      await extract({ cwd: tempDir, file: tempZip });
      const files = await fsp.readdir(tempDir);
      log_debug(`"${name}" extracted files:`, files);
      // 优先寻找给定 exeFile 或已知前缀
      let extracted = files.find(
        (f) =>
          f === path.basename(exeFile) ||
          f.startsWith("虚空终端-") ||
          !f.includes("."),
      );
      if (!extracted) extracted = files[0];
      if (!extracted) throw new Error(`Expected file not found in ${tempDir}`);
      await fsp.rename(path.join(tempDir, extracted), sidecarPath);
      execSync(`chmod 755 ${sidecarPath}`);
      log_success(`tgz processed: "${name}"`);
    } else {
      // .gz
      const readStream = fs.createReadStream(tempZip);
      const writeStream = fs.createWriteStream(sidecarPath);
      await new Promise((resolve, reject) => {
        readStream
          .pipe(zlib.createGunzip())
          .on("error", (e) => {
            log_error(`gunzip error for ${name}:`, e.message);
            reject(e);
          })
          .pipe(writeStream)
          .on("finish", () => {
            if (platform !== "win32") execSync(`chmod 755 ${sidecarPath}`);
            resolve();
          })
          .on("error", (e) => {
            log_error(`write stream error for ${name}:`, e.message);
            reject(e);
          });
      });
      log_success(`gz binary processed: "${name}"`);
    }
  } catch (err) {
    await fsp.rm(sidecarPath, { recursive: true, force: true });
    throw err;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function resolveResource(binInfo) {
  const { file, downloadURL, localPath } = binInfo;
  const resDir = path.join(cwd, "src-tauri/resources");
  const targetPath = path.join(resDir, file);

  if (!FORCE && fs.existsSync(targetPath) && !downloadURL && !localPath) {
    log_success(`"${file}" already exists, skipping`);
    return;
  }

  if (downloadURL) {
    if (!FORCE && fs.existsSync(targetPath)) {
      log_success(`"${file}" already exists, skipping download`);
      return;
    }
    await fsp.mkdir(resDir, { recursive: true });
    await downloadFile(downloadURL, targetPath);
    await updateHashCache(targetPath);
  }

  if (localPath) {
    if (!(await hasFileChanged(localPath, targetPath))) {
      return;
    }
    await fsp.mkdir(resDir, { recursive: true });
    await fsp.copyFile(localPath, targetPath);
    await updateHashCache(targetPath);
    log_success(`Copied file: ${file}`);
  }

  log_success(`${file} finished`);
}

// SimpleSC.dll (win plugin)
const resolvePlugin = async () => {
  const url =
    "https://nsis.sourceforge.io/mediawiki/images/e/ef/NSIS_Simple_Service_Plugin_Unicode_1.30.zip";
  const tempDir = path.join(TEMP_DIR, "SimpleSC");
  const tempZip = path.join(
    tempDir,
    "NSIS_Simple_Service_Plugin_Unicode_1.30.zip",
  );
  const tempDll = path.join(tempDir, "SimpleSC.dll");
  const pluginDir = path.join(process.env.APPDATA || "", "Local/NSIS");
  const pluginPath = path.join(pluginDir, "SimpleSC.dll");
  await fsp.mkdir(pluginDir, { recursive: true });
  await fsp.mkdir(tempDir, { recursive: true });
  if (!FORCE && fs.existsSync(pluginPath)) return;
  try {
    if (!fs.existsSync(tempZip)) {
      await downloadFile(url, tempZip);
    }
    const zip = new AdmZip(tempZip);
    zip
      .getEntries()
      .forEach((entry) => log_debug(`"SimpleSC" entry`, entry.entryName));
    zip.extractAllTo(tempDir, true);
    if (fs.existsSync(tempDll)) {
      await fsp.cp(tempDll, pluginPath, { recursive: true, force: true });
      log_success(`unzip finished: "SimpleSC"`);
    } else {
      // 如果 dll 名称不同，尝试找到 dll
      const files = await fsp.readdir(tempDir);
      const dll = files.find((f) => f.toLowerCase().endsWith(".dll"));
      if (dll) {
        await fsp.cp(path.join(tempDir, dll), pluginPath, {
          recursive: true,
          force: true,
        });
        log_success(`unzip finished: "SimpleSC" (found ${dll})`);
      } else {
        throw new Error("SimpleSC.dll not found in zip");
      }
    }
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
};

// service chmod (保留并使用 glob)
const resolveServicePermission = async () => {
  const serviceExecutables = [
    "clash-verge-service*",
    "clash-verge-service-install*",
    "clash-verge-service-uninstall*",
  ];
  const resDir = path.join(cwd, "src-tauri/resources");
  const hashCache = await loadHashCache();
  let hasChanges = false;

  for (const f of serviceExecutables) {
    const files = glob.sync(path.join(resDir, f));
    for (const filePath of files) {
      if (fs.existsSync(filePath)) {
        const currentHash = await calculateFileHash(filePath);
        const cacheKey = `${filePath}_chmod`;
        if (!FORCE && hashCache[cacheKey] === currentHash) {
          continue;
        }
        try {
          execSync(`chmod 755 ${filePath}`);
          log_success(`chmod finished: "${filePath}"`);
        } catch (e) {
          log_error(`chmod failed for ${filePath}:`, e.message);
        }
        hashCache[cacheKey] = currentHash;
        hasChanges = true;
      }
    }
  }

  if (hasChanges) {
    await saveHashCache(hashCache);
  }
};

// =======================
// Other resource resolvers (service, mmdb, geosite, geoip, enableLoopback)
// =======================
/** 本地子模块：整条服务链路只编这里，不再下载上游 release。 */
const SERVICE_CRATE_DIR = path.join(cwd, "vendor/clash-verge-service-ipc");
const SERVICE_BIN_NAMES = [
  "clash-verge-service",
  "clash-verge-service-install",
  "clash-verge-service-uninstall",
];

function serviceResourceFileName(binBase) {
  const ext = platform === "win32" ? ".exe" : "";
  // Linux 走 externalBin，资源文件名需带 target triple
  const suffix = platform === "linux" ? "-" + SIDECAR_HOST : "";
  return binBase + suffix + ext;
}

function serviceBuildOutputPath(binBase) {
  const ext = platform === "win32" ? ".exe" : "";
  return path.join(
    SERVICE_CRATE_DIR,
    "target",
    SIDECAR_HOST,
    "release",
    binBase + ext,
  );
}

function readServiceSourceStamp() {
  try {
    return execSync("git rev-parse HEAD", { cwd: SERVICE_CRATE_DIR })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

/**
 * 从 vendor/clash-verge-service-ipc 编译三个服务二进制并复制到 resources。
 */
const buildLocalServiceBins = async () => {
  if (!fs.existsSync(path.join(SERVICE_CRATE_DIR, "Cargo.toml"))) {
    throw new Error(
      `未找到本地服务源码: ${SERVICE_CRATE_DIR}（请先初始化子模块 vendor/clash-verge-service-ipc）`,
    );
  }

  const resDir = path.join(cwd, "src-tauri/resources");
  await fsp.mkdir(resDir, { recursive: true });

  const stamp = `${readServiceSourceStamp()}:${SIDECAR_HOST}`;
  const stampFile = path.join(TEMP_DIR, `.service_build_stamp_${SIDECAR_HOST}`);
  const targets = SERVICE_BIN_NAMES.map((name) => ({
    name,
    out: serviceBuildOutputPath(name),
    dest: path.join(resDir, serviceResourceFileName(name)),
  }));

  let stampOk = false;
  try {
    if (!FORCE && fs.existsSync(stampFile)) {
      const prev = (await fsp.readFile(stampFile, "utf-8")).trim();
      stampOk = prev === stamp && targets.every((t) => fs.existsSync(t.dest));
    }
  } catch {
    stampOk = false;
  }

  if (stampOk) {
    log_success(
      `本地服务已是当前源码 (${stamp.split(":")[0].slice(0, 8)})，跳过编译`,
    );
    return;
  }

  log_info(
    `正在从本地子模块编译 clash-verge-service*（target=${SIDECAR_HOST}, features=standalone）`,
  );
  const binArgs = SERVICE_BIN_NAMES.flatMap((name) => ["--bin", name]);
  execSync(
    [
      "cargo",
      "build",
      "--release",
      "--target",
      SIDECAR_HOST,
      "--features",
      "standalone",
      ...binArgs,
    ].join(" "),
    {
      cwd: SERVICE_CRATE_DIR,
      stdio: "inherit",
      env: process.env,
      shell: true,
    },
  );

  for (const t of targets) {
    if (!fs.existsSync(t.out)) {
      throw new Error(`服务编译产物缺失: ${t.out}`);
    }
    await fsp.copyFile(t.out, t.dest);
    await updateHashCache(t.dest);
    log_success(`已复制本地服务: ${path.basename(t.dest)}`);
  }

  await fsp.mkdir(TEMP_DIR, { recursive: true });
  await fsp.writeFile(stampFile, stamp, "utf-8");
  log_success("本地服务编译完成（未使用上游 release）");
};

const resolveMmdb = () =>
  resolveResource({
    file: "Country.mmdb",
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country.mmdb`,
  });
const resolveGeosite = () =>
  resolveResource({
    file: "geosite.dat",
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat`,
  });
const resolveGeoIP = () =>
  resolveResource({
    file: "geoip.dat",
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat`,
  });
const resolveEnableLoopback = () =>
  resolveResource({
    file: "enableLoopback.exe",
    downloadURL: `https://github.com/Kuingsmile/uwp-tool/releases/download/latest/enableLoopback.exe`,
  });

const resolveSetDnsScript = () =>
  resolveResource({
    file: "set_dns.sh",
    localPath: path.join(cwd, "scripts/set_dns.sh"),
  });
const resolveUnSetDnsScript = () =>
  resolveResource({
    file: "unset_dns.sh",
    localPath: path.join(cwd, "scripts/unset_dns.sh"),
  });

// =======================
// Tasks
// =======================
const tasks = [
  {
    name: "verge-mihomo-custom",
    func: () =>
      getLatestCustomVersion().then(() => resolveSidecar(clashMetaCustom())),
    // Immutable tag can lag the pin by 1–2 minutes; 5 instant retries always lose that race.
    retry: 8,
    retryDelayMs: 15000,
  },
  { name: "plugin", func: resolvePlugin, retry: 5, winOnly: true },
  // 一次编出 service / install / uninstall，避免重复 cargo
  { name: "service_local", func: buildLocalServiceBins, retry: 2 },
  { name: "mmdb", func: resolveMmdb, retry: 5 },
  { name: "geosite", func: resolveGeosite, retry: 5 },
  { name: "geoip", func: resolveGeoIP, retry: 5 },
  {
    name: "enableLoopback",
    func: resolveEnableLoopback,
    retry: 5,
    winOnly: true,
  },
  {
    name: "service_chmod",
    func: resolveServicePermission,
    retry: 5,
    unixOnly: platform === "linux" || platform === "darwin",
  },
  {
    name: "set_dns_script",
    func: resolveSetDnsScript,
    retry: 5,
    macosOnly: true,
  },
  {
    name: "unset_dns_script",
    func: resolveUnSetDnsScript,
    retry: 5,
    macosOnly: true,
  },
];

async function runTask() {
  const task = tasks.shift();
  if (!task) return;
  if (task.unixOnly && platform === "win32") return runTask();
  if (task.winOnly && platform !== "win32") return runTask();
  if (task.macosOnly && platform !== "darwin") return runTask();
  if (task.linuxOnly && platform !== "linux") return runTask();

  for (let i = 0; i < task.retry; i++) {
    try {
      await task.func();
      break;
    } catch (err) {
      log_error(`task::${task.name} try ${i} ==`, err.message);
      if (i === task.retry - 1) throw err;
      const delay = Number(task.retryDelayMs) || 0;
      if (delay > 0) {
        log_info(`task::${task.name} retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  return runTask();
}

runTask();
