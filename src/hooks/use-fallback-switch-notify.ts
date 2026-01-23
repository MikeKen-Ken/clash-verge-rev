import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppData } from "@/providers/app-data-context";
import { debugLog } from "@/utils/debug";

// 关闭连接操作的时间戳（此后一段时间内不发送 fallback 切换通知）
let closeConnectionsTimestamp = 0;

// 关闭连接后禁用通知的时长（毫秒）
const CLOSE_CONNECTIONS_NOTIFY_COOLDOWN = 10000; // 10秒

/**
 * 标记关闭连接操作开始
 * 在此后 10 秒内，fallback 切换不会发送通知
 */
export const markCloseConnectionsStarted = () => {
  closeConnectionsTimestamp = Date.now();
  debugLog(`[FallbackNotify] Close connections started at ${closeConnectionsTimestamp}`);
};

/**
 * 检查是否在关闭连接冷却期内
 */
export const isInCloseConnectionsCooldown = () => {
  if (closeConnectionsTimestamp === 0) return false;
  const elapsed = Date.now() - closeConnectionsTimestamp;
  return elapsed < CLOSE_CONNECTIONS_NOTIFY_COOLDOWN;
};

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
        
        // 如果在关闭连接冷却期内（10秒），不发送通知
        if (isInCloseConnectionsCooldown()) {
          const elapsed = Date.now() - closeConnectionsTimestamp;
          debugLog(
            `[FallbackNotify] Skipping notification (in cooldown, ${elapsed}ms elapsed)`
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
