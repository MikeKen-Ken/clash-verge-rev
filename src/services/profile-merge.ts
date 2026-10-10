import YAML from "js-yaml";
import { mutate } from "swr";

import {
  createProfile,
  deleteProfile,
  enhanceProfiles,
  getProfiles,
  patchProfile,
  readProfileFile,
  saveProfileFile,
} from "@/services/cmds";
import { showNotice } from "@/services/notice-service";
import {
  resolveFlag,
  sortProxiesByConnectivity,
} from "@/services/proxy-region-sort";
import { debugLog } from "@/utils/debug";

const TRAFFIC_NODE_REGEX = /剩余流量|套餐到期|traffic|expire/i;
const LOCAL_BACKUP_DESC = "auto backup before merge";
const LOCAL_BACKUP_NAME_PATTERN = /^Local-backup-\d+$/i;
const LOCAL_BACKUP_KEEP = 2;

export const MERGE_INCLUSION_STORAGE_KEY = "profiles.mergeInclusion";

const buildGeneratedName = (
  flag: string,
  sourceName: string,
  index: number,
) => {
  const cleanedSourceName = sourceName.trim();
  const suffix = String(index).padStart(2, "0");
  return cleanedSourceName
    ? `${flag} ${cleanedSourceName} ${suffix}`
    : `${flag} ${suffix}`;
};

const ensureUniqueName = (baseName: string, usedNames: Set<string>) => {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  let duplicateIndex = 2;
  let nextName = `${baseName} #${duplicateIndex}`;
  while (usedNames.has(nextName)) {
    duplicateIndex += 1;
    nextName = `${baseName} #${duplicateIndex}`;
  }
  usedNames.add(nextName);
  return nextName;
};

const isValidProxyNode = (proxy: any) => {
  if (!proxy || typeof proxy !== "object") return false;
  if (typeof proxy.name !== "string" || !proxy.name.trim()) return false;
  if (TRAFFIC_NODE_REGEX.test(proxy.name)) return false;
  if (proxy.server === "127.0.0.1") return false;
  return true;
};

export const isLocalMergeBackup = (item: IProfileItem) =>
  item.type === "local" &&
  (LOCAL_BACKUP_NAME_PATTERN.test(item.name || "") ||
    item.desc === LOCAL_BACKUP_DESC);

export const filterMergeProfileItems = (items: IProfileItem[] | undefined) =>
  (items || []).filter(
    (item): item is IProfileItem =>
      !!item && (item.type === "local" || item.type === "remote"),
  );

export const loadMergeInclusionMap = (): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(MERGE_INCLUSION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, boolean>;
  } catch {
    return {};
  }
};

const rotateLocalBackups = async (targetRaw: string) => {
  // 必须从后端拉取最新列表，避免 SWR/React 闭包中的 profileItems 过期导致重复创建备份
  const freshProfiles = await getProfiles();
  const localItems = filterMergeProfileItems(freshProfiles?.items).filter(
    (item) => item.type === "local",
  );
  const backups = localItems.filter(isLocalMergeBackup);
  backups.sort((a, b) => (b.updated || 0) - (a.updated || 0));

  // 删除多余备份，仅保留最近两个（第三个将由本次新建）
  const keep = backups.slice(0, LOCAL_BACKUP_KEEP);
  const remove = backups.slice(LOCAL_BACKUP_KEEP);
  for (const item of remove) {
    await deleteProfile(item.uid);
  }

  const older = keep[1];
  const newer = keep[0];

  if (older) {
    await patchProfile(older.uid, { name: "Local-backup-0" });
  }
  if (newer) {
    await patchProfile(newer.uid, { name: "Local-backup-1" });
  }

  await createProfile(
    {
      type: "local",
      name: "Local-backup-2",
      desc: LOCAL_BACKUP_DESC,
      url: "",
      option: {
        with_proxy: false,
        self_proxy: false,
      },
    },
    targetRaw,
  );
};

let mergeInFlight: Promise<void> | null = null;

export function generateMergedProfile(
  inclusionOverride?: Record<string, boolean>,
): Promise<void> {
  if (mergeInFlight) return mergeInFlight;
  mergeInFlight = runGenerateMergedProfile(inclusionOverride).finally(() => {
    mergeInFlight = null;
  });
  return mergeInFlight;
}

async function runGenerateMergedProfile(
  inclusionOverride?: Record<string, boolean>,
) {
  showNotice.info("Starting profile merge", 1500);
  const freshProfiles = await getProfiles();
  const items = filterMergeProfileItems(freshProfiles?.items);
  const inclusion = inclusionOverride ?? loadMergeInclusionMap();
  const targetIndex = items.findIndex(
    (item) => item.type === "local" && !isLocalMergeBackup(item),
  );
  if (targetIndex === -1) {
    showNotice.error("No local target profile found");
    return;
  }

  const targetProfile = items[targetIndex];
  const sourceProfiles = items
    .slice(targetIndex + 1)
    .filter((item) => item.type === "remote" && inclusion[item.uid] !== false);

  if (!sourceProfiles.length) {
    showNotice.error("No remote subscriptions selected for merging");
    return;
  }

  try {
    const targetRaw = await readProfileFile(targetProfile.uid);
    const targetYaml = YAML.load(targetRaw) as Record<string, any>;
    if (!targetYaml || typeof targetYaml !== "object") {
      throw new Error("Target profile content is invalid");
    }

    const generatedGroupNames: string[] = [];
    const generatedProxies: any[] = [];
    const usedNames = new Set<string>();

    for (const source of sourceProfiles) {
      const sourceRaw = await readProfileFile(source.uid);
      const sourceYaml = YAML.load(sourceRaw) as Record<string, any>;
      const sourceProxiesRaw = Array.isArray(sourceYaml?.proxies)
        ? sourceYaml.proxies.filter(isValidProxyNode)
        : [];
      const sourceProxies = sortProxiesByConnectivity(sourceProxiesRaw, (proxy) =>
        String(proxy?.name || ""),
      );

      const sourceDisplayName = source.name || source.desc || source.uid;
      const localFlagCounters = new Map<string, number>();
      let droppedCount = 0;

      for (const proxy of sourceProxies) {
        const proxyName = String(proxy?.name || "");
        const flag = resolveFlag(proxyName);
        // 中文关键字未命中：归属无法确定，直接丢弃，不进入合并结果
        if (!flag) {
          droppedCount += 1;
          continue;
        }
        const nextIndex = (localFlagCounters.get(flag) || 0) + 1;
        localFlagCounters.set(flag, nextIndex);
        const baseName = buildGeneratedName(flag, sourceDisplayName, nextIndex);
        const generatedName = ensureUniqueName(baseName, usedNames);

        generatedGroupNames.push(generatedName);
        generatedProxies.push({
          ...proxy,
          name: generatedName,
        });
      }

      if (droppedCount > 0) {
        debugLog(
          `[ProfileMerge] ${sourceDisplayName}: skipped ${droppedCount} nodes without a matching country keyword`,
        );
      }
    }

    if (!generatedProxies.length) {
      throw new Error("No valid proxies generated from source subscriptions");
    }

    const profileGroups = Array.isArray(targetYaml["proxy-groups"])
      ? targetYaml["proxy-groups"]
      : [];
    const firstNodeGroup = profileGroups.find(
      (group: any) => group?.name === "🚀 节点选择",
    );
    if (firstNodeGroup && typeof firstNodeGroup === "object") {
      firstNodeGroup.proxies = generatedGroupNames;
    }

    targetYaml.proxies = generatedProxies;

    await rotateLocalBackups(targetRaw);

    const nextText = YAML.dump(targetYaml, {
      lineWidth: -1,
      noRefs: true,
    });
    await saveProfileFile(targetProfile.uid, nextText);
    await enhanceProfiles();
    await mutate("getProfiles");
    showNotice.success(
      `Merge complete: processed ${sourceProfiles.length} remote profiles`,
      3000,
    );
  } catch (err: any) {
    showNotice.error(
      `Failed to generate merged profile: ${String(err?.message || err)}`,
    );
  }
}
