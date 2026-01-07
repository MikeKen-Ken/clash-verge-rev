import { useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { closeAllConnections } from "tauri-plugin-mihomo-api";
import { delayGroup, healthcheckProxyProvider } from "tauri-plugin-mihomo-api";
import { useProxiesData } from "@/hooks/use-clash-data";
import { useVerge } from "@/hooks/use-verge";
import delayManager from "@/services/delay";
import { debugLog } from "@/utils/debug";

/**
 * Hook to handle close all connections with delay checks
 * Listens to the hotkey event and triggers delay checks for all groups before closing connections
 */
export const useCloseAllWithDelayCheck = () => {
  const { proxies: proxiesData } = useProxiesData();
  const { verge } = useVerge();

  const handleCloseAllWithDelayCheck = useCallback(async () => {
    if (!proxiesData?.groups) {
      debugLog("[CloseAll] No proxy groups available, closing connections directly");
      await closeAllConnections();
      return;
    }

    debugLog(`[CloseAll] Starting delay checks for ${proxiesData.groups.length} groups`);

    const timeout = verge?.default_latency_timeout || 10000;
    const groups = proxiesData.groups;

    // Get all proxies and providers from all groups
    const allProxyNames: string[] = [];
    const allProviders = new Set<string>();

    groups.forEach((group) => {
      if (group.all) {
        group.all.forEach((proxyName) => {
          const proxy = proxiesData.records?.[proxyName];
          if (proxy?.provider) {
            allProviders.add(proxy.provider);
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

    // Check delays for each group
    const delayCheckPromises = groups.map(async (group) => {
      if (!group.all || group.all.length === 0) return;

      const groupProxyNames = group.all
        .filter((name) => {
          const proxy = proxiesData.records?.[name];
          return (
            !proxy?.provider &&
            name !== "DIRECT" &&
            name !== "REJECT"
          );
        });

      if (groupProxyNames.length === 0) return;

      const url = delayManager.getUrl(group.name);
      debugLog(
        `[CloseAll] Checking delays for group ${group.name}, ${groupProxyNames.length} proxies`,
      );

      try {
        await Promise.race([
          delayManager.checkListDelay(groupProxyNames, group.name, timeout),
          delayGroup(group.name, url, timeout),
        ]);
        debugLog(`[CloseAll] Completed delay check for group ${group.name}`);
      } catch (error) {
        console.error(`[CloseAll] Delay check error for group ${group.name}:`, error);
      }
    });

    // Wait for all delay checks to complete
    await Promise.allSettled(delayCheckPromises);
    debugLog("[CloseAll] All delay checks completed, closing connections");

    // Close all connections
    await closeAllConnections();
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
