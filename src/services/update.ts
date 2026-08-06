import {
  check,
  type CheckOptions,
  type Update,
} from "@tauri-apps/plugin-updater";

import { version as appVersion } from "@root/package.json";

export type VersionParts = {
  main: number[];
  pre: (number | string)[];
  /** build metadata（+ 之后），用于 autobuild 等同版可更新判定 */
  build: (number | string)[];
};

const SEMVER_FULL_REGEX =
  /^\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SEMVER_SEARCH_REGEX =
  /v?\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/i;

export const normalizeVersion = (
  input: string | null | undefined,
): string | null => {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
};

export const ensureSemver = (
  input: string | null | undefined,
): string | null => {
  const normalized = normalizeVersion(input);
  if (!normalized) return null;
  return SEMVER_FULL_REGEX.test(normalized) ? normalized : null;
};

export const extractSemver = (
  input: string | null | undefined,
): string | null => {
  if (typeof input !== "string") return null;
  const match = input.match(SEMVER_SEARCH_REGEX);
  if (!match) return null;
  return normalizeVersion(match[0]);
};

const parseDotTokens = (part: string | undefined): (number | string)[] => {
  if (!part) return [];
  return part.split(".").map((token) => {
    // 仅纯数字标识符按数值比较；含字母的（如 git short hash）保持字符串，避免 parseInt 截断
    if (/^\d+$/.test(token)) return Number.parseInt(token, 10);
    return token;
  });
};

/**
 * 拆分版本：先分离 build metadata（+），再分离 prerelease（-）。
 * 切勿把 +build 当成 prerelease，否则同主版本的 autobuild 会永远小于正式版。
 */
export const splitVersion = (version: string | null): VersionParts | null => {
  if (!version) return null;

  const plusIndex = version.indexOf("+");
  const core = plusIndex >= 0 ? version.slice(0, plusIndex) : version;
  const buildPart = plusIndex >= 0 ? version.slice(plusIndex + 1) : "";

  const dashIndex = core.indexOf("-");
  const mainPart = dashIndex >= 0 ? core.slice(0, dashIndex) : core;
  const prePart = dashIndex >= 0 ? core.slice(dashIndex + 1) : "";

  const main = mainPart
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((num) => (Number.isNaN(num) ? 0 : num));

  return {
    main,
    pre: parseDotTokens(prePart),
    build: parseDotTokens(buildPart),
  };
};

/** 按 semver 标识符规则比较一段 token 序列（用于 pre / build） */
const compareIdentSequences = (
  a: (number | string)[],
  b: (number | string)[],
): number => {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const aToken = a[i];
    const bToken = b[i];
    if (aToken === undefined) return -1;
    if (bToken === undefined) return 1;

    if (typeof aToken === "number" && typeof bToken === "number") {
      if (aToken > bToken) return 1;
      if (aToken < bToken) return -1;
      continue;
    }

    // 数字标识符优先级低于字母数字（与 semver pre 规则一致）
    if (typeof aToken === "number") return -1;
    if (typeof bToken === "number") return 1;

    if (aToken > bToken) return 1;
    if (aToken < bToken) return -1;
  }
  return 0;
};

const compareVersionParts = (a: VersionParts, b: VersionParts): number => {
  const length = Math.max(a.main.length, b.main.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a.main[i] ?? 0) - (b.main[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  // prerelease：无 pre 的正式版 > 有 pre 的预发布版
  if (a.pre.length === 0 && b.pre.length !== 0) return 1;
  if (a.pre.length !== 0 && b.pre.length === 0) return -1;
  if (a.pre.length !== 0 && b.pre.length !== 0) {
    const preCmp = compareIdentSequences(a.pre, b.pre);
    if (preCmp !== 0) return preCmp;
  }

  // build metadata：官方 semver 忽略；autobuild 频道需要同主版本下比较 +ab.*
  // 无 build < 有 build；两边都有则按标识符序列比较
  if (a.build.length === 0 && b.build.length === 0) return 0;
  if (a.build.length === 0) return -1;
  if (b.build.length === 0) return 1;
  return compareIdentSequences(a.build, b.build);
};

export const compareVersions = (
  a: string | null,
  b: string | null,
): number | null => {
  const partsA = splitVersion(a);
  const partsB = splitVersion(b);
  if (!partsA || !partsB) return null;
  return compareVersionParts(partsA, partsB);
};

export const resolveRemoteVersion = (update: Update): string | null => {
  const raw = update.rawJson ?? {};
  
  // 优先从 rawJson.name 提取（autobuild 版本号通常在这里，包含完整的 +build 部分）
  const nameVersion = extractSemver(
    typeof raw.name === "string" ? raw.name : null,
  );
  if (nameVersion) return nameVersion;
  
  // 其次从 update.version 提取
  const primary = ensureSemver(update.version);
  if (primary) return primary;

  const fallbackPrimary = extractSemver(update.version);
  if (fallbackPrimary) return fallbackPrimary;

  // 然后从 rawJson.version 提取
  const rawVersion = ensureSemver(
    typeof raw.version === "string" ? raw.version : null,
  );
  if (rawVersion) return rawVersion;

  // 最后从 tag_name 提取
  const tagVersion = extractSemver(
    typeof raw.tag_name === "string" ? raw.tag_name : null,
  );
  if (tagVersion) return tagVersion;

  return null;
};

const localVersionNormalized = normalizeVersion(appVersion);

export const checkUpdateSafe = async (
  options?: CheckOptions,
): Promise<Update | null> => {
  const result = await check({ ...(options ?? {}), allowDowngrades: false });
  if (!result) return null;

  const remoteVersion = resolveRemoteVersion(result);
  const comparison = compareVersions(remoteVersion, localVersionNormalized);

  if (comparison !== null && comparison <= 0) {
    try {
      await result.close();
    } catch (err) {
      console.warn("[updater] failed to close stale update resource", err);
    }
    return null;
  }

  return result;
};

export type { CheckOptions };
