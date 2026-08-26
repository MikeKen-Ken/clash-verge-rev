import {
  applyGroupProxyOrder,
  clearProxyGroupManualSelection,
  forceSelectGroupProxy,
} from "@/services/cmds";
import {
  buildConnectivityScoreContext,
  hydrateConnectivityStatsFromDisk,
  type ConnectivityScoreContext,
} from "@/services/proxy-connectivity-stats";
import { sortProxiesByConnectivity } from "@/services/proxy-region-sort";

export function isAutoSelectGroupType(type?: string): boolean {
  const normalized = type?.toLowerCase();
  return (
    normalized === "url-test" ||
    normalized === "urltest" ||
    normalized === "fallback"
  );
}

export function memberNamesFromGroupAll(
  members: Array<string | { name?: string; provider?: string }> | undefined,
): string[] {
  if (!members?.length) return [];
  const names: string[] = [];
  for (const item of members) {
    const name = typeof item === "string" ? item : item?.name;
    if (!name || name === "DIRECT" || name === "REJECT") continue;
    if (typeof item !== "string" && item.provider) continue;
    names.push(name);
  }
  return names;
}

export function orderedMemberNamesByConnectivity(
  names: string[],
  scoreContext?: ConnectivityScoreContext,
): string[] {
  return sortProxiesByConnectivity(
    names.filter(Boolean),
    (name) => name,
    scoreContext,
  );
}

export type DelayTestEarlyPicker = {
  onResult: (name: string, delay: number) => void;
  stop: () => void;
  flush: () => Promise<void>;
};

export function createDelayTestEarlyPicker(input: {
  groupName: string;
  orderedNames: string[];
  timeoutMs: number;
  isCancelled?: () => boolean;
}): DelayTestEarlyPicker {
  const passed = new Set<string>();
  let best: string | null = null;
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;

  const pick = (name: string, delay: number) => {
    if (stopped || input.isCancelled?.()) return;
    if (!name || name === "DIRECT" || name === "REJECT") return;
    if (!(delay > 0 && delay <= input.timeoutMs)) return;
    passed.add(name);
    let next: string | null = null;
    for (const candidate of input.orderedNames) {
      if (passed.has(candidate)) {
        next = candidate;
        break;
      }
    }
    if (!next || next === best) return;
    best = next;
    const groupName = input.groupName;
    const node = next;
    queue = queue.then(async () => {
      if (stopped || input.isCancelled?.() || best !== node) return;
      try {
        await forceSelectGroupProxy(groupName, node);
      } catch (error) {
        console.warn(
          `[LiveConnectivityOrder] early pick failed: ${groupName} -> ${node}`,
          error,
        );
      }
    });
  };

  return {
    onResult: pick,
    stop() {
      stopped = true;
    },
    flush() {
      return queue;
    },
  };
}

/** 停止提前切节点，并等已发出的固定请求结束，避免测速清钉后又被钉回去。 */
export async function stopDelayTestEarlyPickers(
  pickers: Array<DelayTestEarlyPicker | null | undefined>,
): Promise<void> {
  await Promise.all(
    pickers.map(async (picker) => {
      if (!picker) return;
      picker.stop();
      await picker.flush();
    }),
  );
}

export async function applyLiveConnectivityOrderToGroup(
  groupName: string,
  memberNames: string[],
  scoreContext?: ConnectivityScoreContext,
): Promise<boolean> {
  const sorted = sortProxiesByConnectivity(
    memberNames.filter(Boolean),
    (name) => name,
    scoreContext,
  );
  if (sorted.length <= 1) {
    return true;
  }
  try {
    await applyGroupProxyOrder(groupName, sorted);
    return true;
  } catch (error) {
    console.warn(
      `[LiveConnectivityOrder] failed to reorder "${groupName}"`,
      error,
    );
    return false;
  }
}

/**
 * 启动时按积分重排 url-test/fallback 并清钉，立刻走评分第一的节点，不必等测速。
 */
export async function applyStartupLiveConnectivityOrder(
  groups: Array<{ name: string; type?: string; members: string[] }>,
): Promise<void> {
  const targets = groups.filter(
    (group) =>
      isAutoSelectGroupType(group.type) &&
      group.name !== "Direct" &&
      group.name !== "Final",
  );
  if (targets.length === 0) {
    return;
  }
  await applyLiveConnectivityOrderForGroups(targets);
  await Promise.allSettled(
    targets.map((group) => clearProxyGroupManualSelection(group.name)),
  );
}

export async function applyLiveConnectivityOrderForGroups(
  groups: Array<{ name: string; type?: string; members: string[] }>,
): Promise<Map<string, boolean>> {
  await hydrateConnectivityStatsFromDisk();
  const scoreContext = buildConnectivityScoreContext();
  const results = new Map<string, boolean>();
  for (const group of groups) {
    if (!isAutoSelectGroupType(group.type)) {
      continue;
    }
    results.set(
      group.name,
      await applyLiveConnectivityOrderToGroup(
        group.name,
        group.members,
        scoreContext,
      ),
    );
  }
  return results;
}

/**
 * 测速后先把运行中的 url-test/fallback 组按积分重排，再清钉。
 * 清钉后 Fallback 会选重排列表里第一个当前可用节点。
 * 测速期间用户手动选过的组不清钉；其余组测速结束后必须取消固定。
 */
export async function switchGroupsAfterDelayTest(input: {
  groups: Array<{ name: string; type?: string; members: string[] }>;
  firstSuccessByGroup?: Map<string, string>;
  manualOverrides: { has(name: string): boolean };
  extraUnpinNames?: string[];
  selectReason?: string;
}): Promise<void> {
  const { groups, manualOverrides, extraUnpinNames } = input;
  const orderTargets = groups.filter(
    (group) => !manualOverrides.has(group.name),
  );
  await applyLiveConnectivityOrderForGroups(orderTargets);

  const unpinNames = new Set<string>(extraUnpinNames ?? []);
  for (const group of groups) {
    unpinNames.add(group.name);
  }
  const toUnpin = [...unpinNames].filter(
    (name) => !manualOverrides.has(name),
  );
  await Promise.allSettled(
    toUnpin.map((name) => clearProxyGroupManualSelection(name)),
  );
}
