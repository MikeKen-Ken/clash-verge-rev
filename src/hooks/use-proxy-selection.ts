import { useCallback, useMemo } from "react";
import {
  closeConnection,
  getConnections,
  selectNodeForGroup,
} from "tauri-plugin-mihomo-api";

import { markManualProxySelectionStarted } from "@/hooks/use-fallback-switch-notify";
import { useProfiles } from "@/hooks/use-profiles";
import { useVerge } from "@/hooks/use-verge";
import { syncTrayProxySelection } from "@/services/cmds";
import { debugLog } from "@/utils/debug";

// 缓存连接清理
const cleanupConnections = async (previousProxy: string) => {
  try {
    const { connections } = await getConnections();
    const cleanupPromises = (connections ?? [])
      .filter((conn) => conn.chains.includes(previousProxy))
      .map((conn) => closeConnection(conn.id));

    if (cleanupPromises.length > 0) {
      await Promise.allSettled(cleanupPromises);
      debugLog(`[ProxySelection] 清理了 ${cleanupPromises.length} 个连接`);
    }
  } catch (error) {
    console.warn("[ProxySelection] 连接清理失败:", error);
  }
};

interface ProxySelectionOptions {
  onSuccess?: () => void;
  onError?: (error: any) => void;
  enableConnectionCleanup?: boolean;
}

// 代理选择 Hook
export const useProxySelection = (options: ProxySelectionOptions = {}) => {
  const { current, patchCurrent } = useProfiles();
  const { verge } = useVerge();

  const { onSuccess, onError, enableConnectionCleanup = true } = options;

  // 缓存
  const config = useMemo(
    () => ({
      autoCloseConnection: verge?.auto_close_connection ?? false,
      enableConnectionCleanup,
    }),
    [verge?.auto_close_connection, enableConnectionCleanup],
  );

  // 切换节点：先等核心与 profile 同步完成，再刷新代理列表，避免过早刷新拿到旧 now 导致界面「选不上」
  const changeProxy = useCallback(
    async (
      groupName: string,
      proxyName: string,
      previousProxy?: string,
      skipConfigSave: boolean = false,
    ) => {
      debugLog(`[ProxySelection] 代理切换: ${groupName} -> ${proxyName}`);
      console.log("[ProxySelection] 代理切换:", groupName, "->", proxyName);
      // 标记手动选择节点，在此后 10 秒内不发送 fallback 切换通知
      markManualProxySelectionStarted();

      const doPatchCurrent = async () => {
        if (!current || skipConfigSave) return;
        const selected = current.selected ? [...current.selected] : [];
        const index = selected.findIndex((item) => item.name === groupName);
        if (index < 0) {
          selected.push({ name: groupName, now: proxyName });
        } else {
          selected[index] = { name: groupName, now: proxyName };
        }
        await patchCurrent({ selected });
      };

      // 先完成核心切换与 profile 写入，再延迟刷新代理列表，等核心写好 group.now 后再拉取，避免 UI 不更新选中/图钉
      const delayMs = 400;
      const delayMs2 = 900;
      const delayMs3 = 1800;
      Promise.all([
        selectNodeForGroup(groupName, proxyName),
        doPatchCurrent(),
        syncTrayProxySelection(),
      ])
        .then(() => {
          debugLog(
            `[ProxySelection] 代理和状态同步完成: ${groupName} -> ${proxyName}`,
          );
          const runRefresh = (label: string) => {
            debugLog(`[ProxySelection] ${label} 刷新代理列表`);
            if (label === "首次") {
              console.log("[ProxySelection] 触发刷新代理列表，用于更新选中与图钉");
            }
            onSuccess?.();
          };
          setTimeout(() => runRefresh("首次"), delayMs);
          setTimeout(() => runRefresh("二次"), delayMs2);
          setTimeout(() => runRefresh("三次(兜底)"), delayMs3);
        })
        .catch((err) => {
          console.warn("[ProxySelection] 后台同步失败:", err);
          setTimeout(() => onSuccess?.(), delayMs);
        });

      // 3. 后台清理连接（异步，不阻塞）
      if (
        config.enableConnectionCleanup &&
        config.autoCloseConnection &&
        previousProxy
      ) {
        setTimeout(() => cleanupConnections(previousProxy), 0);
      }
    },
    [current, patchCurrent, config, onSuccess, onError],
  );

  const handleSelectChange = useCallback(
    (
      groupName: string,
      previousProxy?: string,
      skipConfigSave: boolean = false,
    ) =>
      (event: { target: { value: string } }) => {
        const newProxy = event.target.value;
        changeProxy(groupName, newProxy, previousProxy, skipConfigSave);
      },
    [changeProxy],
  );

  const handleProxyGroupChange = useCallback(
    (group: { name: string; now?: string }, proxy: { name: string }) => {
      changeProxy(group.name, proxy.name, group.now);
    },
    [changeProxy],
  );

  return {
    changeProxy,
    handleSelectChange,
    handleProxyGroupChange,
  };
};
