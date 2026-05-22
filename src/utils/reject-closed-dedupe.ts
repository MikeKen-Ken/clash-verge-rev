const REJECT_CHAINS = new Set(["REJECT", "REJECT-DROP", "PASS"]);

export const isRejectOutbound = (conn: IConnectionsItem): boolean => {
  const chains = conn.chains ?? [];
  if (Array.isArray(chains)) {
    return chains.some((name) => REJECT_CHAINS.has(name));
  }
  const text = String(chains);
  const leaf = text.split("[")[0]?.trim() ?? "";
  return REJECT_CHAINS.has(leaf);
};

/** 相同目标（host → IP → 进程名）+ 相同规则原因；三者皆无时不 dedupe */
export const rejectDedupeKey = (conn: IConnectionsItem): string | null => {
  if (!isRejectOutbound(conn)) return null;
  const target =
    conn.metadata?.host ||
    conn.metadata?.destinationIP ||
    conn.metadata?.remoteDestination ||
    conn.metadata?.process ||
    "";
  if (!target) return null;
  return `${target}|${conn.rule ?? ""}|${conn.rulePayload ?? ""}|${conn.ruleDetail ?? ""}`;
};

export const upsertRejectClosed = (
  list: IConnectionsItem[],
  incoming: IConnectionsItem,
): IConnectionsItem[] => {
  const key = rejectDedupeKey(incoming);
  if (!key) return [...list, incoming];
  const idx = list.findIndex((item) => rejectDedupeKey(item) === key);
  if (idx < 0) return [...list, incoming];
  const existing = list[idx]!;
  const inAt = incoming.closedAt ?? new Date(incoming.start || 0).getTime();
  const exAt = existing.closedAt ?? new Date(existing.start || 0).getTime();
  if (inAt < exAt) return list;
  const next = [...list];
  next[idx] = incoming;
  return next;
};

export const compactRejectClosed = (
  list: IConnectionsItem[],
): IConnectionsItem[] => {
  let out: IConnectionsItem[] = [];
  for (const item of list) {
    out = upsertRejectClosed(out, item);
  }
  return out;
};
