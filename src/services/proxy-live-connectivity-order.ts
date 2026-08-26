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
import {
  selectNodeForGroup,
  type SelectNodeForGroupCallReason,
} from "@/services/proxy-select-node";

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

export function createDelayTestEarlyPicker(input: {
  groupName: string;
  orderedNames: string[];
  timeoutMs: number;
  isCancelled?: () => boolean;
}) {
  const passed = new Set<string>();
  let best: string | null = null;
  let queue: Promise<void> = Promise.resolve();

  const pick = (name: string, delay: number) => {
    if (input.isCancelled?.()) return;
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
      if (input.isCancelled?.() || best !== node) return;
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

  return { onResult: pick };
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
 * 重排失败时才 PUT 固定到积分最高的成功节点，且不再清钉。
 */
export async function switchGroupsAfterDelayTest(input: {
  groups: Array<{ name: string; type?: string; members: string[] }>;
  firstSuccessByGroup: Map<string, string>;
  manualOverrides: { has(name: string): boolean };
  extraUnpinNames?: string[];
  selectReason: SelectNodeForGroupCallReason;
}): Promise<Set<string>> {
  const keepPinned = new Set<string>();
  const orderTargets = input.groups.filter(
    (group) => !input.manualOverrides.has(group.name),
  );
  const orderResults = await applyLiveConnectivityOrderForGroups(orderTargets);

  for (const [groupName, node] of input.firstSuccessByGroup) {
    if (input.manualOverrides.has(groupName)) continue;
    if (orderResults.get(groupName) === true) continue;
    try {
      await selectNodeForGroup(groupName, node, { reason: input.selectReason });
      keepPinned.add(groupName);
    } catch (error) {
      console.warn(
        `[LiveConnectivityOrder] fallback pin failed: ${groupName} -> ${node}`,
        error,
      );
    }
  }

  const unpinNames = new Set<string>(input.extraUnpinNames ?? []);
  for (const group of input.groups) {
    unpinNames.add(group.name);
  }
  const toUnpin = [...unpinNames].filter(
    (name) => !input.manualOverrides.has(name) && !keepPinned.has(name),
  );
  await Promise.allSettled(
    toUnpin.map((name) => clearProxyGroupManualSelection(name)),
  );
  return keepPinned;
}
