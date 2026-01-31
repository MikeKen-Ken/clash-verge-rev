import { useLockFn } from "ahooks";
import { useCallback, useMemo } from "react";
import {
  closeConnection,
  getConnections,
  selectNodeForGroup,
} from "tauri-plugin-mihomo-api";

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

  // 切换节点（参考安卓端：先调 core 再更 UI，profile 保存并行或延后以提升响应）
  const changeProxy = useLockFn(
    async (
      groupName: string,
      proxyName: string,
      previousProxy?: string,
      skipConfigSave: boolean = false,
    ) => {
      debugLog(`[ProxySelection] 代理切换: ${groupName} -> ${proxyName}`);

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

      try {
        // 参考安卓端：core 切换与 profile 保存并行，再托盘同步并刷新 UI，缩短等待
        await Promise.all([
          selectNodeForGroup(groupName, proxyName),
          doPatchCurrent(),
        ]);
        await syncTrayProxySelection();
        debugLog(
          `[ProxySelection] 代理和状态同步完成: ${groupName} -> ${proxyName}`,
        );
        onSuccess?.();

        if (
          config.enableConnectionCleanup &&
          config.autoCloseConnection &&
          previousProxy
        ) {
          setTimeout(() => cleanupConnections(previousProxy), 0);
        }
      } catch (error) {
        console.error(
          `[ProxySelection] 代理切换失败: ${groupName} -> ${proxyName}`,
          error,
        );

        try {
          await selectNodeForGroup(groupName, proxyName);
          await syncTrayProxySelection();
          onSuccess?.();
          void doPatchCurrent().catch((e) => {
            console.warn("[ProxySelection] profile 保存失败", e);
          });
          debugLog(
            `[ProxySelection] 代理切换回退成功: ${groupName} -> ${proxyName}`,
          );
        } catch (fallbackError) {
          console.error(
            `[ProxySelection] 代理切换回退也失败: ${groupName} -> ${proxyName}`,
            fallbackError,
          );
          onError?.(fallbackError);
        }
      }
    },
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
