import { getVersion } from "@tauri-apps/api/app";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openWebUrl } from "@/services/cmds";
import {
  compareVersions,
  normalizeVersion,
} from "@/services/update";
import { version as packageVersion } from "@root/package.json";

/** 自用 fork 无签名更新清单（autobuild 频道） */
const FORK_UPDATE_ENDPOINTS = [
  "https://github.com/MikeKen-Ken/clash-verge-rev/releases/download/autobuild/update.json",
  "https://gh-proxy.com/https://github.com/MikeKen-Ken/clash-verge-rev/releases/download/autobuild/update.json",
] as const;

type ForkUpdateManifest = {
  name?: string;
  notes?: string;
  pub_date?: string;
  platforms?: Record<string, { url?: string; signature?: string }>;
};

export type ForkUpdateInfo = {
  version: string;
  body: string;
  date: string;
  available: true;
  downloadUrl: string;
  downloadAndInstall: () => Promise<void>;
  close: () => Promise<void>;
};

const resolvePlatformKeys = (): string[] => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("windows")) {
    return ["windows-x86_64", "win64", "windows-x86", "windows-i686"];
  }
  if (ua.includes("mac")) {
    const isArm = ua.includes("arm") || ua.includes("aarch64");
    return isArm
      ? ["darwin-aarch64", "darwin-arm64", "darwin-x86_64"]
      : ["darwin-x86_64", "darwin-aarch64", "darwin-arm64"];
  }
  if (ua.includes("linux")) {
    return ["linux-x86_64", "linux-aarch64"];
  }
  return [];
};

const resolveDownloadUrl = (manifest: ForkUpdateManifest): string | null => {
  const platforms = manifest.platforms;
  if (!platforms) return null;
  for (const key of resolvePlatformKeys()) {
    const url = platforms[key]?.url?.trim();
    if (url) return url;
  }
  // 兜底：取任意带 url 的平台
  for (const entry of Object.values(platforms)) {
    const url = entry?.url?.trim();
    if (url) return url;
  }
  return null;
};

/**
 * 走 Tauri HTTP 插件（Rust 侧请求），绕过 WebView CORS。
 * 浏览器原生 fetch 访问 GitHub / 代理会因无 Access-Control-Allow-Origin 失败。
 */
const fetchManifest = async (endpoint: string): Promise<ForkUpdateManifest> => {
  const response = await tauriFetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-store",
    },
  });
  if (!response.ok) {
    const hint =
      response.status === 403
        ? "（可能触发 GitHub 速率限制）"
        : "";
    throw new Error(`更新清单请求失败: HTTP ${response.status}${hint}`);
  }
  return (await response.json()) as ForkUpdateManifest;
};

/** 优先运行时 getVersion，失败再回退 package.json */
const resolveLocalVersion = async (): Promise<string> => {
  try {
    const runtime = await getVersion();
    const normalized = normalizeVersion(runtime);
    if (normalized) {
      console.log("[fork-updater] Local version source=getVersion()", runtime);
      return normalized;
    }
  } catch (err) {
    console.log("[fork-updater] getVersion() failed; falling back to package.json", err);
  }
  const fallback = normalizeVersion(packageVersion);
  if (!fallback) {
    throw new Error(`本地版本无法解析：package.json=${packageVersion}`);
  }
  console.log("[fork-updater] Local version source=package.json", packageVersion);
  return fallback;
};

/**
 * 检查自用 fork 的 autobuild 更新（无签名）。
 * 有新版本时返回可打开安装包下载链接的对象；已是最新则返回 null。
 * 版本解析失败或清单拉取失败时抛错，禁止误报「已是最新」。
 */
export const checkForkUpdate = async (): Promise<ForkUpdateInfo | null> => {
  let lastError: unknown = null;
  let manifest: ForkUpdateManifest | null = null;

  for (const endpoint of FORK_UPDATE_ENDPOINTS) {
    try {
      manifest = await fetchManifest(endpoint);
      console.log("[fork-updater] Manifest fetched successfully", endpoint);
      break;
    } catch (err) {
      lastError = err;
      console.log("[fork-updater] Manifest fetch failed; trying next source", endpoint, err);
    }
  }

  if (!manifest) {
    throw lastError instanceof Error
      ? lastError
      : new Error("无法获取更新清单");
  }

  const localVersion = await resolveLocalVersion();
  const remoteRaw = manifest.name;
  const remoteVersion = normalizeVersion(remoteRaw);
  if (!remoteVersion) {
    throw new Error(
      `远程版本无法解析：name=${remoteRaw == null ? "空" : String(remoteRaw)}`,
    );
  }

  const comparison = compareVersions(remoteVersion, localVersion);
  console.log(
    "[fork-updater] 版本比较",
    { local: localVersion, remote: remoteVersion, comparison },
  );

  // 解析失败不得当成「已是最新」
  if (comparison === null) {
    throw new Error(
      `版本比较失败：local=${localVersion} remote=${remoteVersion}`,
    );
  }

  if (comparison <= 0) {
    return null;
  }

  const downloadUrl = resolveDownloadUrl(manifest);
  if (!downloadUrl) {
    throw new Error("更新清单中没有当前平台的安装包地址");
  }

  return {
    version: remoteVersion,
    body: manifest.notes ?? "",
    date: manifest.pub_date ?? "",
    available: true,
    downloadUrl,
    downloadAndInstall: async () => {
  console.log("[fork-updater] Opening installer download", downloadUrl);
      await openWebUrl(downloadUrl);
    },
    close: async () => {},
  };
};