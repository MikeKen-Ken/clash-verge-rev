import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppData } from "@/providers/app-data-context";
import { useProfiles } from "@/hooks/use-profiles";
import { debugLog } from "@/utils/debug";

// 关闭连接操作的时间戳（此后一段时间内不发送 fallback 切换通知）
let closeConnectionsTimestamp = 0;

// TUN/系统代理模式切换的时间戳
let proxyModeChangeTimestamp = 0;

// 手动测速操作的时间戳
let manualDelayCheckTimestamp = 0;

// 手动选择节点操作的时间戳
let manualProxySelectionTimestamp = 0;

// 关闭连接后禁用通知的时长（毫秒）
const CLOSE_CONNECTIONS_NOTIFY_COOLDOWN = 10000; // 10秒

// TUN/系统代理模式切换后禁用通知的时长（毫秒）
const PROXY_MODE_CHANGE_NOTIFY_COOLDOWN = 60000; // 1分钟

// 手动测速后禁用通知的时长（毫秒）
const MANUAL_DELAY_CHECK_NOTIFY_COOLDOWN = 10000; // 10秒

// 手动选择节点后禁用通知的时长（毫秒）
const MANUAL_PROXY_SELECTION_NOTIFY_COOLDOWN = 10000; // 10秒

/**
 * 标记关闭连接操作开始
 * 在此后 10 秒内，fallback 切换不会发送通知
 */
export const markCloseConnectionsStarted = () => {
  closeConnectionsTimestamp = Date.now();
  debugLog(`[FallbackNotify] Close connections started at ${closeConnectionsTimestamp}`);
};

/**
 * 标记 TUN/系统代理模式切换
 * 在此后 1 分钟内，fallback 切换不会发送通知
 */
export const markProxyModeChanged = () => {
  proxyModeChangeTimestamp = Date.now();
  debugLog(`[FallbackNotify] Proxy mode changed at ${proxyModeChangeTimestamp}`);
};

/**
 * 标记手动测速操作开始
 * 在此后 10 秒内，fallback 切换不会发送通知
 */
export const markManualDelayCheckStarted = () => {
  manualDelayCheckTimestamp = Date.now();
  debugLog(`[FallbackNotify] Manual delay check started at ${manualDelayCheckTimestamp}`);
};

/**
 * 标记手动选择节点操作开始
 * 在此后 10 秒内，fallback 切换不会发送通知（避免误报「节点自动切换」）
 */
export const markManualProxySelectionStarted = () => {
  manualProxySelectionTimestamp = Date.now();
  debugLog(`[FallbackNotify] Manual proxy selection started at ${manualProxySelectionTimestamp}`);
};

/**
 * 检查是否在任何冷却期内
 */
export const isInNotifyCooldown = () => {
  const now = Date.now();
  
  // 检查关闭连接冷却期（10秒）
  if (closeConnectionsTimestamp > 0) {
    const closeElapsed = now - closeConnectionsTimestamp;
    if (closeElapsed < CLOSE_CONNECTIONS_NOTIFY_COOLDOWN) {
      return { inCooldown: true, reason: "close_connections", elapsed: closeElapsed };
    }
  }
  
  // 检查代理模式切换冷却期（1分钟）
  if (proxyModeChangeTimestamp > 0) {
    const modeElapsed = now - proxyModeChangeTimestamp;
    if (modeElapsed < PROXY_MODE_CHANGE_NOTIFY_COOLDOWN) {
      return { inCooldown: true, reason: "proxy_mode_change", elapsed: modeElapsed };
    }
  }
  
  // 检查手动测速冷却期（10秒）
  if (manualDelayCheckTimestamp > 0) {
    const delayElapsed = now - manualDelayCheckTimestamp;
    if (delayElapsed < MANUAL_DELAY_CHECK_NOTIFY_COOLDOWN) {
      return { inCooldown: true, reason: "manual_delay_check", elapsed: delayElapsed };
    }
  }
  
  // 检查手动选择节点冷却期（10秒）
  if (manualProxySelectionTimestamp > 0) {
    const selectionElapsed = now - manualProxySelectionTimestamp;
    if (selectionElapsed < MANUAL_PROXY_SELECTION_NOTIFY_COOLDOWN) {
      return { inCooldown: true, reason: "manual_proxy_selection", elapsed: selectionElapsed };
    }
  }
  
  return { inCooldown: false, reason: null, elapsed: 0 };
};

/**
 * Hook to monitor fallback/urltest proxy group switches and send notifications
 * Only sends notifications when the switch is NOT triggered by close-all-connections
 */
export const useFallbackSwitchNotify = () => {
  const { proxies: proxiesData } = useAppData();
  const { current, patchCurrent, mutateProfiles } = useProfiles();

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
          `[FallbackNotify] Detected switch in group ${groupName}: ${previousNow} -> ${currentNow}`,
        );

        // 始终同步 profile.selected：核心已切走则清空该组的手动选择，使 UI 显示真实当前节点（含手动选择失败后核心切走的情况）
        if (current) {
          const selected = current.selected ?? [];
          const next = selected.filter((s: { name?: string }) => s.name !== groupName);
          if (next.length !== selected.length) {
            console.log("[FallbackNotify] 核心已切换，清空该组手动选择记录以更新 UI", {
              组名: groupName,
              "核心当前节点": currentNow,
            });
            patchCurrent({ selected: next })
              .then(() => mutateProfiles())
              .catch(() => {});
          }
        }

        // 检查是否在冷却期内（仅用于是否弹通知，不影响上面同步）
        const cooldownStatus = isInNotifyCooldown();
        if (cooldownStatus.inCooldown) {
          debugLog(
            `[FallbackNotify] Skipping notification (${cooldownStatus.reason}, ${cooldownStatus.elapsed}ms elapsed)`,
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
            .catch((error: unknown) => {
              console.error(`[FallbackNotify] Failed to send notification:`, error);
            });
        }
      }
    }

    // 更新保存的状态
    previousGroupsRef.current = currentGroups;
  }, [proxiesData?.groups, current, patchCurrent, mutateProfiles]);
};
