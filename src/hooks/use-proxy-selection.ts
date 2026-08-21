import { useCallback } from "react";
import { selectNodeForGroup } from "@/services/proxy-select-node";

import { markManualProxySelectionStarted } from "@/hooks/use-fallback-switch-notify";
import { useProfiles } from "@/hooks/use-profiles";
import {
  clearProxyGroupManualSelection,
  syncTrayProxySelection,
} from "@/services/cmds";
import { closeConnectionsForProxyGroup } from "@/utils/close-connections";
import { debugLog } from "@/utils/debug";

interface ProxySelectionOptions {
  onSuccess?: () => void;
  onError?: (error: any) => void;
  /** 仅刷新当前选中节点的延迟（不触发全量 refreshProxy）；轮询 1～10s 时若提供则调用此项 */
  onRefreshSelectedNodeOnly?: (groupName: string, proxyName: string) => void | Promise<void>;
}

const supportsClearManualSelection = (groupType?: string) => {
  const type = groupType?.toLowerCase();
  return (
    type === "selector" ||
    type === "url-test" ||
    type === "urltest" ||
    type === "fallback"
  );
};

// 代理选择 Hook
export const useProxySelection = (options: ProxySelectionOptions = {}) => {
  const { current, patchCurrent } = useProfiles();

  const { onSuccess, onRefreshSelectedNodeOnly } = options;

  const clearManualSelection = useCallback(
    async (groupName: string, skipConfigSave: boolean = false) => {
      debugLog(`[ProxySelection] Clearing manual selection: ${groupName}`);
      await clearProxyGroupManualSelection(groupName);

      if (!skipConfigSave && current) {
        const selected = (current.selected ?? []).filter(
          (item) => item.name !== groupName,
        );
        await patchCurrent({ selected });
      }

      await syncTrayProxySelection().catch((err) => {
      console.warn("[ProxySelection] clear syncTray failed (non-critical)", err);
      });
      onSuccess?.();
      setTimeout(() => onSuccess?.(), 450);
      setTimeout(() => onSuccess?.(), 1000);
    },
    [current, onSuccess, patchCurrent],
  );

  // 切换节点：先等核心与 profile 同步完成，再刷新代理列表，避免过早刷新拿到旧 now 导致界面「选不上」
  const changeProxy = useCallback(
    async (
      groupName: string,
      proxyName: string,
      skipConfigSave: boolean = false,
    ) => {
      debugLog(`[ProxySelection] Proxy switch: ${groupName} -> ${proxyName}`);

      // 标记手动选择节点，在此后 10 秒内不发送 fallback 切换通知
      markManualProxySelectionStarted();

      const doPatchCurrent = async () => {
        if (!current || skipConfigSave) {
          return;
        }
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

      const tParallel0 = performance.now();
      /** 各子 Promise 完成时相对 tParallel0 的毫秒数，用于区分「卡在核心 invoke」还是 profile/托盘 */
      const parallelDoneAt: {
        selectNode?: number;
        patchCurrent?: number;
        syncTray?: number;
      } = {};

      Promise.all([
        selectNodeForGroup(groupName, proxyName, {
          reason: "proxy-ui-manual",
        }).then((result) => {
          parallelDoneAt.selectNode = Math.round(
            performance.now() - tParallel0,
          );
          setTimeout(() => onSuccess?.(), 50);
          return result;
        }).catch((err) => {
          console.error("=== [CoreSwitch] selectNodeForGroup call failed ===", {
            组名: groupName,
            节点名: proxyName,
            错误: err,
            "错误信息": err?.message || String(err),
            "错误堆栈": err?.stack,
            调用失败: true,
            时间戳: Date.now(),
          });
          throw err;
        }),
        doPatchCurrent()
          .then(() => {
            parallelDoneAt.patchCurrent = Math.round(
              performance.now() - tParallel0,
            );
          })
          .catch((err) => {
          console.error("[ProxySelection] doPatchCurrent failed", err);
            throw err;
          }),
        syncTrayProxySelection()
          .then(() => {
            parallelDoneAt.syncTray = Math.round(
              performance.now() - tParallel0,
            );
          })
          .catch((err) => {
            parallelDoneAt.syncTray = Math.round(
              performance.now() - tParallel0,
            );
          console.warn("[ProxySelection] syncTray failed (non-critical)", err);
          }),
      ])
        .then(() => {
          const totalParallelMs = Math.round(
            performance.now() - tParallel0,
          );
          console.log("[CoreSwitch-Frontend] Parallel phase completed (profile write and tray sync included)", {
            组: groupName,
            节点: proxyName,
            各子项完成距起点_ms: { ...parallelDoneAt },
            Promise_all总耗时_ms: totalParallelMs,
          });

          debugLog(
            `[ProxySelection] 代理和状态同步完成: ${groupName} -> ${proxyName}`,
          );

          void closeConnectionsForProxyGroup(groupName).then((n) => {
            if (n > 0) {
              debugLog(`[ProxySelection] Closed ${n} connections through group ${groupName}`);
            }
          });

          const runRefresh = (label: string, delay: number) => {
              debugLog(`[ProxySelection] ${label} refreshed proxy list`);
            onSuccess?.();
          };
          // 仅刷新当前选中节点延迟（不触发全量 refreshProxy），若未提供则走全量刷新
          const runRefreshSelectedNodeOnly = (label: string, t: number) => {
              debugLog(`[ProxySelection] ${label} refreshed selected-node delay only`);
            if (onRefreshSelectedNodeOnly) {
              void onRefreshSelectedNodeOnly(groupName, proxyName);
            } else {
              onSuccess?.();
            }
          };
          setTimeout(() => runRefresh("首次", delayMs), delayMs);
          setTimeout(() => runRefresh("二次", delayMs2), delayMs2);
          setTimeout(() => runRefresh("三次(兜底)", delayMs3), delayMs3);

          // 选择后 3.5s 时查询一次：若提供 onRefreshSelectedNodeOnly 则只刷新当前节点延迟，否则全量刷新
          setTimeout(
            () => runRefreshSelectedNodeOnly("轮询(3.5s)", 3500),
            3500,
          );

        })
        .catch((err) => {
          console.error("=== [ProxySelection] Backend synchronization failed ===", {
            错误: err,
            组名: groupName,
            目标节点: proxyName,
          });
          setTimeout(() => onSuccess?.(), delayMs);
        });
    },
    [current, patchCurrent, onSuccess, onRefreshSelectedNodeOnly],
  );

  const handleSelectChange = useCallback(
    (groupName: string, skipConfigSave: boolean = false) =>
      (event: { target: { value: string } }) => {
        const newProxy = event.target.value;
        changeProxy(groupName, newProxy, skipConfigSave);
      },
    [changeProxy],
  );

  const handleProxyGroupChange = useCallback(
    (
      group: { name: string; now?: string; type?: string },
      proxy: { name: string },
      options?: { isManualSelection?: boolean; skipConfigSave?: boolean },
    ) => {
      if (
        options?.isManualSelection &&
        proxy.name === group.now &&
        supportsClearManualSelection(group.type)
      ) {
        void clearManualSelection(group.name, options?.skipConfigSave ?? false);
        return;
      }
      changeProxy(group.name, proxy.name);
    },
    [changeProxy, clearManualSelection],
  );

  return {
    changeProxy,
    handleSelectChange,
    handleProxyGroupChange,
  };
};
