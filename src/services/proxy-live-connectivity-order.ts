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
    if (!(delay > 0 && delay < input.timeoutMs)) return;
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
 * 启动时按积分重排 url-test/fallback。url-test 钉第一个可用节点；fallback 清钉。
 */
export async function applyStartupLiveConnectivityOrder(
  groups: Array<{ name: string; type?: string; members: string[] }>,
  manualOverrides?: { has(name: string): boolean },
): Promise<void> {
  const targets = groups.filter(
    (group) =>
      !manualOverrides?.has(group.name) &&
      isAutoSelectGroupType(group.type) &&
      group.name !== "Direct" &&
      group.name !== "Final",
  );
  if (targets.length === 0) {
    return;
  }
  await hydrateConnectivityStatsFromDisk();
  const scoreContext = buildConnectivityScoreContext();
  const orderedTargets = targets.map((group) => ({
    ...group,
    members: orderedMemberNamesByConnectivity(group.members, scoreContext),
  }));
  await applyLiveConnectivityOrderForGroups(
    orderedTargets,
    scoreContext,
    manualOverrides,
  );
  await Promise.allSettled(
    orderedTargets.map(async (group) => {
      if (manualOverrides?.has(group.name)) return;
      const type = group.type?.toLowerCase();
      if (type === "fallback") {
        await clearProxyGroupManualSelection(group.name);
        return;
      }
      const first = group.members.find(
        (name) => name && name !== "DIRECT" && name !== "REJECT",
      );
      if (first) {
        await forceSelectGroupProxy(group.name, first);
      }
    }),
  );
}

export async function applyLiveConnectivityOrderForGroups(
  groups: Array<{ name: string; type?: string; members: string[] }>,
  providedScoreContext?: ConnectivityScoreContext,
  manualOverrides?: { has(name: string): boolean },
): Promise<Map<string, boolean>> {
  if (!providedScoreContext) {
    await hydrateConnectivityStatsFromDisk();
  }
  const scoreContext = providedScoreContext ?? buildConnectivityScoreContext();
  const results = new Map<string, boolean>();
  for (const group of groups) {
    if (
      manualOverrides?.has(group.name) ||
      !isAutoSelectGroupType(group.type)
    ) {
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
 * 测速后按积分重排。url-test 钉本轮第一个成功的评分节点；fallback 清钉后走列表。
 * 测速期间用户手动选过的组不改钉。
 */
export async function switchGroupsAfterDelayTest(input: {
  groups: Array<{ name: string; type?: string; members: string[] }>;
  firstSuccessByGroup?: Map<string, string>;
  manualOverrides: { has(name: string): boolean };
  extraUnpinNames?: string[];
  selectReason?: string;
}): Promise<void> {
  const { groups, firstSuccessByGroup, manualOverrides, extraUnpinNames } =
    input;
  await applyLiveConnectivityOrderForGroups(groups, undefined, manualOverrides);

  const ops: Array<Promise<unknown>> = [];
  for (const group of groups) {
    if (manualOverrides.has(group.name)) continue;
    const type = group.type?.toLowerCase();
    if (type === "url-test" || type === "urltest") {
      const pin = firstSuccessByGroup?.get(group.name);
      if (pin) {
        ops.push(forceSelectGroupProxy(group.name, pin));
      }
      continue;
    }
    if (type === "fallback") {
      ops.push(clearProxyGroupManualSelection(group.name));
    }
  }
  for (const name of extraUnpinNames ?? []) {
    if (manualOverrides.has(name)) continue;
    if (groups.some((group) => group.name === name)) continue;
    ops.push(clearProxyGroupManualSelection(name));
  }
  await Promise.allSettled(ops);
}
