import { useEffect, useRef } from "react";

import { useAppData } from "@/providers/app-data-context";
import {
  chooseConnectivityProbes,
  CONNECTIVITY_PROBE_INTERVAL_MS,
  type ConnectivityProbeCandidate,
} from "@/services/connectivity-maintenance";
import delayManager, { getGroupDelayTimeout } from "@/services/delay";
import { isAutoSelectGroupType } from "@/services/proxy-live-connectivity-order";

const SKIP_NAMES = new Set([
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "PASS",
  "COMPATIBLE",
]);

const GROUP_TYPES = new Set([
  "selector",
  "select",
  "urltest",
  "url-test",
  "fallback",
  "relay",
  "loadbalance",
  "load-balance",
]);

function historyTime(proxy: IProxyItem): number {
  const time = proxy.history?.[proxy.history.length - 1]?.time;
  if (!time) return 0;
  const parsed = Date.parse(time);
  return Number.isFinite(parsed) ? parsed : 0;
}

function collectProbeCandidates(proxies: {
  groups?: IProxyGroupItem[];
  global?: IProxyGroupItem;
}): ConnectivityProbeCandidate[] {
  const groups = [
    ...(proxies.groups ?? []),
    ...(proxies.global ? [proxies.global] : []),
  ];
  const byKey = new Map<string, ConnectivityProbeCandidate>();
  for (const group of groups) {
    if (!isAutoSelectGroupType(group.type)) continue;
    if (group.name === "Direct" || group.name === "Final") continue;
    const timeout = getGroupDelayTimeout(group, false);
    for (const proxy of group.all ?? []) {
      if (!proxy?.name || SKIP_NAMES.has(proxy.name)) continue;
      const type = proxy.type?.toLowerCase() ?? "";
      if (GROUP_TYPES.has(type)) continue;
      const url = delayManager.getTestUrlForOutbound(proxy.name, group.name);
      const key = `${proxy.name}\0${url}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        key,
        name: proxy.name,
        group: group.name,
        timeout,
        lastTest: historyTime(proxy),
      });
    }
  }
  return [...byKey.values()];
}

/**
 * Once a minute, probe up to two oldest url-test / fallback members.
 * Results update delay history and scores. The group walk order stays put.
 */
export function ConnectivityMaintenance() {
  const { proxies } = useAppData();
  const proxiesRef = useRef(proxies);
  const attemptsRef = useRef(new Map<string, number>());

  useEffect(() => {
    proxiesRef.current = proxies;
  }, [proxies]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        void tick();
      }, CONNECTIVITY_PROBE_INTERVAL_MS);
    };
    const tick = async () => {
      timer = undefined;
      if (stopped) return;
      try {
        const current = proxiesRef.current;
        if (current && !delayManager.isDelayBatchRunning()) {
          const now = Date.now();
          const selected = chooseConnectivityProbes(
            collectProbeCandidates(current),
            attemptsRef.current,
            now,
          );
          for (const candidate of selected) {
            attemptsRef.current.set(candidate.key, now);
          }
          for (const candidate of selected) {
            if (stopped || delayManager.isDelayBatchRunning()) break;
            await delayManager.checkDelay(
              candidate.name,
              candidate.group,
              candidate.timeout,
              { silentGlobal: true },
            );
          }
        }
      } catch (error) {
        console.warn("Connectivity maintenance probe failed:", error);
      } finally {
        if (!stopped) schedule();
      }
    };
    schedule();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  return null;
}
