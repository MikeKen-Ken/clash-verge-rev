/** 批量测速期间用户手动切换的组 → 节点；用于跳过自动切节点并保留 profile 手动选择记录 */
const overrides = new Map<string, string>();
let activeTrackingSessions = 0;

export function beginDelayCheckManualOverrideTracking(): () => void {
  if (activeTrackingSessions === 0) {
    overrides.clear();
  }
  activeTrackingSessions += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeTrackingSessions = Math.max(0, activeTrackingSessions - 1);
    if (activeTrackingSessions === 0) {
      overrides.clear();
    }
  };
}

export function isDelayCheckManualOverrideTracking(): boolean {
  return activeTrackingSessions > 0;
}

export function markDelayCheckManualOverride(
  groupName: string,
  proxyName: string,
): void {
  overrides.set(groupName, proxyName);
}

export function getDelayCheckManualOverride(
  groupName: string,
): string | undefined {
  return overrides.get(groupName);
}

export function hasDelayCheckManualOverride(groupName: string): boolean {
  return overrides.has(groupName);
}
