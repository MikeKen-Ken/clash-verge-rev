import { applyGroupProxyOrder } from "@/services/cmds";
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
  /** Drain automatic-order writes. Delay testing never owns a manual pin. */
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
        // Let the core choose the first healthy member; never persist a manual
        // selection merely because a test completed before another one.
        await applyGroupProxyOrder(groupName, input.orderedNames);
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
    async flush() {
      await queue;
    },
  };
}

/** Stop automatic-order updates and drain requests already in flight. */
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
 * Startup reorders groups. It never releases a pin: only the user's explicit
 * unpin does that.
 */
export async function applyStartupLiveConnectivityOrder(
  groups: Array<{
    name: string;
    type?: string;
    members: string[];
    timeout?: number;
  }>,
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
 * 测速后按积分重排。测速永远不会解除固定：只有用户手动取消才会。
 */
export async function reorderGroupsAfterDelayTest(input: {
  groups: Array<{ name: string; type?: string; members: string[] }>;
  manualOverrides: { has(name: string): boolean };
}): Promise<void> {
  await applyLiveConnectivityOrderForGroups(
    input.groups,
    undefined,
    input.manualOverrides,
  );
}
