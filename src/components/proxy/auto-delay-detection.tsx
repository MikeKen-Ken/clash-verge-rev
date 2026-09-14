import { useEffect, useRef } from "react";

import { useCurrentProxy } from "@/hooks/use-current-proxy";
import { useVerge } from "@/hooks/use-verge";
import { useAppData } from "@/providers/app-data-context";
import { startAutoDelayDetection } from "@/services/auto-delay-detection";
import delayManager, { getGroupDelayTimeout } from "@/services/delay";

const SKIP_NAMES = new Set([
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "PASS",
  "COMPATIBLE",
]);

/** Mounted inside the app data provider, so navigating away from Proxies keeps the timer alive. */
export function AutoDelayDetection() {
  const { verge } = useVerge();
  const { currentProxy, primaryGroupName, mode, refreshProxy } =
    useCurrentProxy();
  const { proxies } = useAppData();
  const runRef = useRef<(cancelled: () => boolean) => Promise<void>>(
    async () => {},
  );

  useEffect(() => {
    runRef.current = async (isCancelled) => {
      if (mode === "direct" || !currentProxy || !primaryGroupName || !proxies)
        return;
      let proxy: IProxyItem = currentProxy;
      let groupName = primaryGroupName;
      const visited = new Set<string>();
      while (proxy.now) {
        if (visited.has(proxy.name)) return;
        visited.add(proxy.name);
        groupName = proxy.name;
        const next = proxies.records[proxy.now];
        if (!next) return;
        proxy = next;
      }
      if (SKIP_NAMES.has(proxy.name)) return;
      // Do not overlap the same node's manual or startup test.
      if (delayManager.getDelayUpdate(proxy.name, groupName)?.delay === -2)
        return;
      const group =
        proxies.groups.find(
          (item: IProxyGroupItem) => item.name === groupName,
        ) ?? (proxies.global?.name === groupName ? proxies.global : undefined);
      if (isCancelled()) return;
      // Let a probe already sent to the core settle normally if disabled;
      // abandoning its result would leave the card stuck at "testing".
      await delayManager.checkDelay(
        proxy.name,
        groupName,
        getGroupDelayTimeout(group, group?.fixed === proxy.name),
      );
      if (!isCancelled()) await refreshProxy();
    };
  }, [currentProxy, primaryGroupName, mode, proxies, refreshProxy]);

  useEffect(() => {
    if (!verge?.enable_auto_delay_detection) return;
    return startAutoDelayDetection({
      intervalMinutes: verge.auto_delay_detection_interval_minutes,
      run: (isCancelled) => runRef.current(isCancelled),
      onError: (error) =>
        console.warn("Automatic delay detection failed:", error),
    });
  }, [
    verge?.enable_auto_delay_detection,
    verge?.auto_delay_detection_interval_minutes,
  ]);

  return null;
}
