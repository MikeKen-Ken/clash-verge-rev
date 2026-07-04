const PRIMARY_GROUP_KEYWORDS = [
  "auto",
  "select",
  "proxy",
  "节点选择",
  "自动选择",
];

/** 规则模式下推断主代理组（与首页当前节点卡片逻辑一致） */
export const resolvePrimaryGroupName = (
  groups: Array<{ name: string }>,
): string | null => {
  if (!groups.length) return null;

  const matched = groups.find((group) =>
    PRIMARY_GROUP_KEYWORDS.some((keyword) =>
      group.name.toLowerCase().includes(keyword.toLowerCase()),
    ),
  );
  if (matched) return matched.name;

  const nonGlobal = groups.find((group) => group.name !== "GLOBAL");
  return nonGlobal?.name ?? groups[0]?.name ?? null;
};

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
