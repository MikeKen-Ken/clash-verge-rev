import { useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { delayGroup, healthcheckProxyProvider, selectNodeForGroup } from "tauri-plugin-mihomo-api";
import { useAppData } from "@/providers/app-data-context";
import delayManager, {
  DEFAULT_GROUP_TIMEOUT_MS,
  type DelayUpdate,
} from "@/services/delay";
import { debugLog } from "@/utils/debug";
import { closeConnectionsExcludingDirect } from "@/utils/close-connections";
import { markCloseConnectionsStarted } from "@/hooks/use-fallback-switch-notify";

/**
 * Hook to handle close all connections with delay checks
 * Listens to the hotkey event and triggers delay checks for all groups before closing connections
 */
export const useCloseAllWithDelayCheck = () => {
  const { proxies: proxiesData } = useAppData();

  const handleCloseAllWithDelayCheck = useCallback(async () => {
    // 标记关闭连接开始，在此后 10 秒内禁用 fallback 切换通知
    markCloseConnectionsStarted();
    
    try {
      if (!proxiesData?.groups) {
        debugLog("[CloseAll] No proxy groups available, closing connections directly (excluding DIRECT)");
        await closeConnectionsExcludingDirect();
        return;
      }

      debugLog(`[CloseAll] Starting delay checks for ${proxiesData.groups.length} groups`);

      const groups = proxiesData.groups;
      const bulkReuseMap = new Map<string, DelayUpdate>();

      // 收集所有 provider
      const allProviders = new Set<string>();
      groups.forEach((group: IProxyGroupItem) => {
        if (group.all) {
          group.all.forEach((proxy: IProxyItem | string) => {
            const proxyName = typeof proxy === "string" ? proxy : proxy.name;
            if (!proxyName) return;
            const proxyRecord = proxiesData.records?.[proxyName];
            if (proxyRecord?.provider) allProviders.add(proxyRecord.provider);
          });
        }
      });

      // Check provider delays
      if (allProviders.size > 0) {
        debugLog(`[CloseAll] Checking delays for ${allProviders.size} providers`);
        await Promise.allSettled(
          [...allProviders].map((provider) => healthcheckProxyProvider(provider)),
        );
      }

      // 顺序测速；同名同 URL + 超时在会话内复用（对齐核心侧出站共享语义）
      for (const group of groups as IProxyGroupItem[]) {
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
        const timeout = group?.timeout ?? DEFAULT_GROUP_TIMEOUT_MS;
        debugLog(
          `[CloseAll] Checking delays for group ${group.name}, ${groupProxyNames.length} proxies`,
        );

        try {
          // 触发 core 侧 health check 以清除 fixed 选择，不等待结果
          delayGroup(group.name, url, timeout)
            .then((result: Record<string, unknown>) => {
              debugLog(
                `[CloseAll] delayGroup returned ${Object.keys(result || {}).length} results for group ${group.name}`,
              );
            })
            .catch((error: unknown) => {
              debugLog(`[CloseAll] delayGroup error for group ${group.name}:`, error);
            });

          await delayManager.checkListDelay(groupProxyNames, group.name, timeout, {
            bulkReuseMap,
          });
          debugLog(`[CloseAll] Completed delay check for group ${group.name}`);
        } catch (error) {
          console.error(`[CloseAll] Delay check error for group ${group.name}:`, error);
        }
      }
      debugLog("[CloseAll] All delay checks completed, closing connections (excluding DIRECT)");

      // 自动切换到每个组第一个连接成功的节点（只处理 URLTest 和 Fallback，不处理 Selector）
      for (const group of groups) {
        if (!group.all || group.all.length === 0) continue;
        if (!["URLTest", "Fallback"].includes(group.type)) continue;

        const timeout = group?.timeout ?? DEFAULT_GROUP_TIMEOUT_MS;

        // 按照组中节点的原始顺序（group.all）查找第一个连接成功的节点
        // 这样可以确保选择的是排序最靠前的成功节点
        let firstSuccessProxy: string | null = null;
        
        for (const proxy of group.all) {
          const proxyName = typeof proxy === "string" ? proxy : proxy.name;
          if (!proxyName) continue;
          
          // 跳过 DIRECT、REJECT 和 provider 节点
          if (proxyName === "DIRECT" || proxyName === "REJECT") continue;
          const proxyRecord = proxiesData.records?.[proxyName];
          if (proxyRecord?.provider) continue;
          
          // 检查该节点是否连接成功
          const delayUpdate = delayManager.getDelayUpdate(proxyName, group.name);
          if (delayUpdate) {
            const delay = delayUpdate.delay;
            const delayText = delayManager.formatDelay(delay, timeout);
            
            // 判断是否连接成功：不是T、E、-、testing，且delay > 0
            if (
              delayText !== "T" &&
              delayText !== "E" &&
              delayText !== "-" &&
              delayText !== "testing" &&
              delay > 0 &&
              delay < timeout &&
              delay <= 1e5
            ) {
              // 找到第一个连接成功的节点（按原始顺序）
              firstSuccessProxy = proxyName;
              debugLog(
                `[CloseAll] Found first success proxy for group ${group.name}: ${proxyName} (delay: ${delay}ms)`,
              );
              break;
            }
          }
        }

        // 如果找到连接成功的节点，且当前节点不是它，则切换
        if (firstSuccessProxy) {
          const currentProxy = group.now;
          if (currentProxy !== firstSuccessProxy) {
            try {
              debugLog(
                `[CloseAll] Auto-switching group ${group.name}: ${currentProxy || "none"} -> ${firstSuccessProxy}`,
              );
              await selectNodeForGroup(group.name, firstSuccessProxy);
              debugLog(`[CloseAll] Successfully switched group ${group.name} to ${firstSuccessProxy}`);
            } catch (error) {
              console.error(
                `[CloseAll] Failed to switch group ${group.name} to ${firstSuccessProxy}:`,
                error,
              );
            }
          } else {
            debugLog(
              `[CloseAll] Group ${group.name} already using first success proxy: ${firstSuccessProxy}`,
            );
          }
        } else {
          debugLog(`[CloseAll] No success proxy found for group ${group.name}, skipping switch`);
        }
      }

      // Close all connections except those using DIRECT
      await closeConnectionsExcludingDirect();
      
      // 发送完成通知
      try {
        await invoke("notify_close_all_completed");
        debugLog("[CloseAll] Notification sent successfully");
      } catch (error) {
        console.error("[CloseAll] Failed to send notification:", error);
      }
    } catch (error) {
      console.error("[CloseAll] Error during close all connections:", error);
    }
    // 注意：不需要重置关闭连接状态，因为使用基于时间的冷却期（10秒）
  }, [proxiesData]);

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
