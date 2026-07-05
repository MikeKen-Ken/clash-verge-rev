import { isLanSourceIp } from "@/features/lan-devices/model";

import type { SessionRuleCandidate } from "./types";

export function buildRuleCandidates(
  conn: IConnectionsItem,
): SessionRuleCandidate[] {
  const candidates: SessionRuleCandidate[] = [];
  const { metadata } = conn;

  const processName = metadata.process?.trim();
  if (processName) {
    candidates.push({
      ruleType: "PROCESS-NAME",
      payload: processName,
      label: processName,
      category: "进程",
    });
  }

  const processPath = metadata.processPath?.trim();
  if (processPath && processPath !== processName) {
    candidates.push({
      ruleType: "PROCESS-PATH",
      payload: processPath,
      label: processPath,
      category: "进程路径",
    });
  }

  const host = metadata.host?.trim();
  if (host) {
    candidates.push({
      ruleType: "DOMAIN-SUFFIX",
      payload: host,
      label: host,
      category: "域名",
    });
  }

  const sourceIp = metadata.sourceIP?.trim();
  if (sourceIp && isLanSourceIp(sourceIp)) {
    candidates.push({
      ruleType: "SRC-IP-CIDR",
      payload: `${sourceIp}/32`,
      label: sourceIp,
      category: "来源设备",
    });
  }

  return candidates;
}
