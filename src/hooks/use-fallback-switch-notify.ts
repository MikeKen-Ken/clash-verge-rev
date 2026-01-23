import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppData } from "@/providers/app-data-context";
import { debugLog } from "@/utils/debug";

// 全局标志：是否正在执行关闭连接操作（此时不发送 fallback 切换通知）
let isClosingConnections = false;

/**
 * 设置关闭连接状态
 * 当设置为 true 时，fallback 切换不会发送通知
 */
export const setClosingConnectionsState = (state: boolean) => {
  isClosingConnections = state;
  debugLog(`[FallbackNotify] Closing connections state set to: ${state}`);
};

/**
 * 获取当前关闭连接状态
 */
export const getClosingConnectionsState = () => isClosingConnections;

/**
 * Hook to monitor fallback/urltest proxy group switches and send notifications
 * Only sends notifications when the switch is NOT triggered by close-all-connections
 */
export const useFallbackSwitchNotify = () => {
  const { proxies: proxiesData } = useAppData();
  
  // 保存上一次的代理组状态
  const previousGroupsRef = useRef<Map<string, string>>(new Map());
  // 是否已初始化（跳过首次加载）
  const isInitializedRef = useRef(false);

  useEffect(() => {
    if (!proxiesData?.groups) return;

    const currentGroups = new Map<string, string>();
    
    // 收集当前所有 Fallback 和 URLTest 类型组的 now 值
    for (const group of proxiesData.groups) {
      if (["URLTest", "Fallback"].includes(group.type) && group.now) {
        currentGroups.set(group.name, group.now);
      }
    }

    // 首次加载，只保存状态不检测变化
    if (!isInitializedRef.current) {
      previousGroupsRef.current = currentGroups;
      isInitializedRef.current = true;
      debugLog("[FallbackNotify] Initialized with groups:", Object.fromEntries(currentGroups));
      return;
    }

    // 检测变化
    const previousGroups = previousGroupsRef.current;
    
    for (const [groupName, currentNow] of currentGroups) {
      const previousNow = previousGroups.get(groupName);
      
      // 检测到节点切换
      if (previousNow && previousNow !== currentNow) {
        debugLog(
          `[FallbackNotify] Detected switch in group ${groupName}: ${previousNow} -> ${currentNow}`
        );
        
        // 如果正在执行关闭连接操作，不发送通知
        if (isClosingConnections) {
          debugLog(
            `[FallbackNotify] Skipping notification (closing connections in progress)`
          );
        } else {
          // 发送 fallback 切换通知
          invoke("notify_fallback_proxy_switched", {
            group: groupName,
            from: previousNow,
            to: currentNow,
          })
            .then(() => {
              debugLog(`[FallbackNotify] Notification sent for group ${groupName}`);
            })
            .catch((error) => {
              console.error(`[FallbackNotify] Failed to send notification:`, error);
            });
        }
      }
    }

    // 更新保存的状态
    previousGroupsRef.current = currentGroups;
  }, [proxiesData?.groups]);
};
