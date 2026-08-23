const BASE_TARGETS = ["DIRECT", "REJECT"] as const;

export function buildPolicyTargets(
  groups: IConfigData["proxy-groups"] | undefined,
): string[] {
  const targets: string[] = [...BASE_TARGETS];
  const seen = new Set<string>(targets);

  if (!Array.isArray(groups)) return targets;

  for (const group of groups) {
    const name = group?.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    targets.push(name);
  }

  return targets;
}

export function formatPolicyLabel(target: string): string {
  const builtInLabels: Record<string, string> = {
    DIRECT: "Direct",
    REJECT: "Reject",
    "REJECT-DROP": "Reject (drop)",
    PASS: "Pass",
  };
  if (builtInLabels[target]) return builtInLabels[target];

  return target
    .replaceAll("节点选择", "Proxy")
    .replaceAll("自动选择", "Auto")
    .replaceAll("故障转移", "Fallback")
    .replaceAll("负载均衡", "Load Balance")
    .replaceAll("手动选择", "Manual")
    .replaceAll("直连", "Direct")
    .replaceAll("拒绝", "Reject");
}
