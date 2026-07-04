/** 沿 group.now 链解析到最终叶子出站名（与 ProxyGroups 组头展示逻辑一致） */
export const resolveLeafProxyName = (
  startName: string,
  groupNowMap: Map<string, string>,
): string => {
  if (!startName) return startName;
  let current = startName;
  const visited = new Set<string>();
  while (groupNowMap.has(current) && !visited.has(current)) {
    visited.add(current);
    const next = groupNowMap.get(current)!;
    if (next === current) break;
    current = next;
  }
  return current;
};

export const buildGroupNowMap = (
  groups: Array<{ name?: string; now?: string | null }> | undefined,
): Map<string, string> => {
  if (!groups?.length) return new Map();
  return new Map(
    groups
      .filter((g) => g.name != null && g.now != null && g.now !== "")
      .map((g) => [g.name!, g.now!] as [string, string]),
  );
};
