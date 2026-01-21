import { useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { delayGroup, healthcheckProxyProvider } from "tauri-plugin-mihomo-api";
import { useAppData } from "@/providers/app-data-context";
import { useVerge } from "@/hooks/use-verge";
import delayManager from "@/services/delay";
import { debugLog } from "@/utils/debug";
import { closeConnectionsExcludingDirect } from "@/utils/close-connections";

/**
 * Hook to handle close all connections with delay checks
 * Listens to the hotkey event and triggers delay checks for all groups before closing connections
 */
export const useCloseAllWithDelayCheck = () => {
  const { proxies: proxiesData } = useAppData();
  const { verge } = useVerge();

  const handleCloseAllWithDelayCheck = useCallback(async () => {
    if (!proxiesData?.groups) {
      debugLog("[CloseAll] No proxy groups available, closing connections directly (excluding DIRECT)");
      await closeConnectionsExcludingDirect();
      return;
    }

    debugLog(`[CloseAll] Starting delay checks for ${proxiesData.groups.length} groups`);

    const timeout = verge?.default_latency_timeout || 10000;
    const groups = proxiesData.groups;

    // Get all proxies and providers from all groups
    const allProxyNames: string[] = [];
    const allProviders = new Set<string>();

    groups.forEach((group: IProxyGroupItem) => {
      if (group.all) {
        group.all.forEach((proxy: IProxyItem | string) => {
          const proxyName = typeof proxy === "string" ? proxy : proxy.name;
          if (!proxyName) return;
          
          const proxyRecord = proxiesData.records?.[proxyName];
          if (proxyRecord?.provider) {
            allProviders.add(proxyRecord.provider);
          } else if (proxyName !== "DIRECT" && proxyName !== "REJECT") {
            allProxyNames.push(proxyName);
          }
        });
      }
    });

    debugLog(
      `[CloseAll] Found ${allProxyNames.length} proxies and ${allProviders.size} providers`,
    );

    // Check provider delays
    if (allProviders.size > 0) {
      debugLog(`[CloseAll] Checking delays for ${allProviders.size} providers`);
      await Promise.allSettled(
        [...allProviders].map((provider) => healthcheckProxyProvider(provider)),
      );
    }

    // Check delays for each group - 串行执行避免并发过高
    for (const group of groups) {
      if (!group.all || group.all.length === 0) continue;

      const groupProxyNames = group.all
        .map((proxy: IProxyItem | string) => typeof proxy === "string" ? proxy : proxy.name)
        .filter((proxyName: string | undefined): proxyName is string => {
          if (!proxyName) return false;
          const proxy = proxiesData.records?.[proxyName];
          return (
            !proxy?.provider &&
            proxyName !== "DIRECT" &&
            proxyName !== "REJECT"
          );
        });

      if (groupProxyNames.length === 0) continue;

      const url = delayManager.getUrl(group.name);
      debugLog(
        `[CloseAll] Checking delays for group ${group.name}, ${groupProxyNames.length} proxies`,
      );

      try {
        // 串行执行：主要等待 checkListDelay 完成（它会等待所有代理测试完成）
        // delayGroup 作为辅助，但不阻塞下一个组的开始
        // 确保当前组的所有代理测试都完成后再进行下一个组，避免多个组同时测试
        debugLog(`[CloseAll] Starting checkListDelay for group ${group.name}`);
        await delayManager.checkListDelay(groupProxyNames, group.name, timeout);
        debugLog(`[CloseAll] checkListDelay completed for group ${group.name}`);
        
        // delayGroup 作为辅助测试，不阻塞流程
        delayGroup(group.name, url, timeout)
          .then((result) => {
            debugLog(
              `[CloseAll] delayGroup returned ${Object.keys(result || {}).length} results for group ${group.name}`,
            );
          })
          .catch((error) => {
            debugLog(`[CloseAll] delayGroup error for group ${group.name}:`, error);
          });
        
        debugLog(`[CloseAll] Completed delay check for group ${group.name}`);
      } catch (error) {
        console.error(`[CloseAll] Delay check error for group ${group.name}:`, error);
      }
    }
    debugLog("[CloseAll] All delay checks completed, closing connections (excluding DIRECT)");

    // Close all connections except those using DIRECT
    await closeConnectionsExcludingDirect();
  }, [proxiesData, verge?.default_latency_timeout]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        unlisten = await listen("verge://close-all-connections", () => {
          debugLog("[CloseAll] Received close all connections event");
          void handleCloseAllWithDelayCheck();
        });
        debugLog("[CloseAll] Listener registered for close all connections event");
      } catch (error) {
        console.error("[CloseAll] Failed to register listener:", error);
      }
    };

    void setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [handleCloseAllWithDelayCheck]);
};
