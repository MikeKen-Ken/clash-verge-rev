import { useCallback } from "react";
import { selectNodeForGroup } from "@/services/proxy-select-node";

import { markManualProxySelectionStarted } from "@/hooks/use-fallback-switch-notify";
import { useProfiles } from "@/hooks/use-profiles";
import { syncTrayProxySelection } from "@/services/cmds";
import { closeConnectionsForProxyGroup } from "@/utils/close-connections";
import { debugLog } from "@/utils/debug";

interface ProxySelectionOptions {
  onSuccess?: () => void;
  onError?: (error: any) => void;
  /** 仅刷新当前选中节点的延迟（不触发全量 refreshProxy）；轮询 1～10s 时若提供则调用此项 */
  onRefreshSelectedNodeOnly?: (groupName: string, proxyName: string) => void | Promise<void>;
}

// 代理选择 Hook
export const useProxySelection = (options: ProxySelectionOptions = {}) => {
  const { current, patchCurrent } = useProfiles();

  const { onSuccess, onRefreshSelectedNodeOnly } = options;

  // 切换节点：先等核心与 profile 同步完成，再刷新代理列表，避免过早刷新拿到旧 now 导致界面「选不上」
  const changeProxy = useCallback(
    async (
      groupName: string,
      proxyName: string,
      skipConfigSave: boolean = false,
    ) => {
      debugLog(`[ProxySelection] 代理切换: ${groupName} -> ${proxyName}`);

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
        selectNodeForGroup(groupName, proxyName).then((result) => {
          parallelDoneAt.selectNode = Math.round(
            performance.now() - tParallel0,
          );
          setTimeout(() => onSuccess?.(), 50);
          return result;
        }).catch((err) => {
          console.error("=== [核心切换] selectNodeForGroup 调用失败 ===", {
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
            console.error("[ProxySelection] doPatchCurrent 失败", err);
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
            console.warn("[ProxySelection] syncTray 失败（非关键）", err);
          }),
      ])
        .then(() => {
          const totalParallelMs = Math.round(
            performance.now() - tParallel0,
          );
          console.log("[核心切换-前端] 并行阶段完成（含 profile 写入与托盘同步）", {
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
              debugLog(`[ProxySelection] 已关闭 ${n} 条经过组 ${groupName} 的连接`);
            }
          });

          const runRefresh = (label: string, delay: number) => {
            debugLog(`[ProxySelection] ${label} 刷新代理列表`);
            onSuccess?.();
          };
          // 仅刷新当前选中节点延迟（不触发全量 refreshProxy），若未提供则走全量刷新
          const runRefreshSelectedNodeOnly = (label: string, t: number) => {
            debugLog(`[ProxySelection] ${label} 仅刷新选中节点延迟`);
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
          console.error("=== [ProxySelection] 后端同步失败 ===", {
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
    (group: { name: string; now?: string }, proxy: { name: string }) => {
      changeProxy(group.name, proxy.name);
    },
    [changeProxy],
  );

  return {
    changeProxy,
    handleSelectChange,
    handleProxyGroupChange,
  };
};
