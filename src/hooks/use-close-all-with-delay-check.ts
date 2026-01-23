import { useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { delayGroup, healthcheckProxyProvider, selectNodeForGroup } from "tauri-plugin-mihomo-api";
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
    let firstGroupName: string | null = null;
    
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
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

      // 记录第一个组
      if (firstGroupName === null) {
        firstGroupName = group.name;
      }

      const url = delayManager.getUrl(group.name);
      debugLog(
        `[CloseAll] Checking delays for group ${group.name}, ${groupProxyNames.length} proxies`,
      );

      try {
        // 如果不是第一个组，尝试复用第一个组的测试结果
        if (groupIndex > 0 && firstGroupName) {
          let reusedCount = 0;
          const proxiesToTest: string[] = [];

          for (const proxyName of groupProxyNames) {
            // 检查第一个组是否有该节点的测试结果
            const firstGroupResult = delayManager.getDelayUpdate(proxyName, firstGroupName);
            
            if (firstGroupResult && firstGroupResult.delay !== -1 && firstGroupResult.delay !== -2) {
              // 复用第一个组的结果，直接设置到当前组
              delayManager.setDelay(
                proxyName,
                group.name,
                firstGroupResult.delay,
                { elapsed: firstGroupResult.elapsed }
              );
              reusedCount++;
              debugLog(
                `[CloseAll] Reused delay result for ${proxyName}: ${firstGroupResult.delay}ms (from group ${firstGroupName})`,
              );
            } else {
              // 第一个组没有结果，需要测试
              proxiesToTest.push(proxyName);
            }
          }

          debugLog(
            `[CloseAll] Group ${group.name}: reused ${reusedCount}/${groupProxyNames.length} results from first group`,
          );

          // 只测试第一个组没有结果的节点
          if (proxiesToTest.length > 0) {
            debugLog(
              `[CloseAll] Testing ${proxiesToTest.length} proxies that were not in first group`,
            );
            await delayManager.checkListDelay(proxiesToTest, group.name, timeout);
          } else {
            debugLog(`[CloseAll] All proxies reused from first group, skipping test`);
          }
        } else {
          // 第一个组，正常测试所有节点
          debugLog(`[CloseAll] Starting checkListDelay for group ${group.name}`);
          await delayManager.checkListDelay(groupProxyNames, group.name, timeout);
          debugLog(`[CloseAll] checkListDelay completed for group ${group.name}`);
        }
        
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

    // 自动切换到每个组第一个连接成功的节点（只处理 URLTest 和 Fallback，不处理 Selector）
    for (const group of groups) {
      if (!group.all || group.all.length === 0) continue;
      if (!["URLTest", "Fallback"].includes(group.type)) continue;

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
            
            // 发送 fallback 节点切换通知
            try {
              await invoke("notify_fallback_node_switched", {
                groupName: group.name,
                nodeName: firstSuccessProxy,
              });
              debugLog(`[CloseAll] Fallback notification sent for group ${group.name}`);
            } catch (error) {
              console.error("[CloseAll] Failed to send fallback notification:", error);
            }
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
