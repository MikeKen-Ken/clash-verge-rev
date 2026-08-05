import { openWebUrl } from "@/services/cmds";
import {
  compareVersions,
  normalizeVersion,
} from "@/services/update";
import { version as appVersion } from "@root/package.json";

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

const localVersionNormalized = normalizeVersion(appVersion);

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

const fetchManifest = async (endpoint: string): Promise<ForkUpdateManifest> => {
  const response = await fetch(endpoint, {
    method: "GET",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`更新清单请求失败: ${response.status}`);
  }
  return (await response.json()) as ForkUpdateManifest;
};

/**
 * 检查自用 fork 的 autobuild 更新（无签名）。
 * 有新版本时返回可打开安装包下载链接的对象；已是最新则返回 null。
 */
export const checkForkUpdate = async (): Promise<ForkUpdateInfo | null> => {
  let lastError: unknown = null;
  let manifest: ForkUpdateManifest | null = null;

  for (const endpoint of FORK_UPDATE_ENDPOINTS) {
    try {
      manifest = await fetchManifest(endpoint);
      break;
    } catch (err) {
      lastError = err;
      console.log("[fork-updater] 清单拉取失败，尝试下一源", endpoint, err);
    }
  }

  if (!manifest) {
    throw lastError instanceof Error
      ? lastError
      : new Error("无法获取更新清单");
  }

  const remoteVersion = normalizeVersion(manifest.name);
  const comparison = compareVersions(remoteVersion, localVersionNormalized);
  if (comparison === null || comparison <= 0) {
    return null;
  }

  const downloadUrl = resolveDownloadUrl(manifest);
  if (!downloadUrl) {
    throw new Error("更新清单中没有当前平台的安装包地址");
  }

  return {
    version: remoteVersion ?? manifest.name ?? "",
    body: manifest.notes ?? "",
    date: manifest.pub_date ?? "",
    available: true,
    downloadUrl,
    downloadAndInstall: async () => {
      console.log("[fork-updater] 打开安装包下载", downloadUrl);
      await openWebUrl(downloadUrl);
    },
    close: async () => {},
  };
};
