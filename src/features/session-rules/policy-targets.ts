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
  if (target === "DIRECT") return "直连";
  if (target === "REJECT") return "拒绝";
  return target;
}
