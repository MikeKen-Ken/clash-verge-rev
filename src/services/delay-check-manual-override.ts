/** 批量测速期间用户手动切换的组 → 节点；用于跳过自动切节点并保留 profile 手动选择记录 */
const overrides = new Map<string, string>();

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

export function snapshotDelayCheckManualOverrides(): ReadonlyMap<string, string> {
  return new Map(overrides);
}

export function clearDelayCheckManualOverrides(): void {
  overrides.clear();
}
