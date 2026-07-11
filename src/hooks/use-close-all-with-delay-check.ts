import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { delayGroup, healthcheckProxyProvider } from "tauri-plugin-mihomo-api";

import { selectNodeForGroup } from "@/services/proxy-select-node";
import { useTranslation } from "react-i18next";
import { useAppData } from "@/providers/app-data-context";
import delayManager, {
  DEFAULT_GROUP_TIMEOUT_MS,
  type DelayUpdate,
} from "@/services/delay";
import { hideNotice, showNotice, updateNotice } from "@/services/notice-service";
import { debugLog } from "@/utils/debug";
import { closeConnectionsExcludingDirect } from "@/utils/close-connections";
import { markCloseConnectionsStarted } from "@/hooks/use-fallback-switch-notify";

const SKIP_DELAY_CHECK_GROUPS = new Set(["Direct", "Final"]);

/**
 * Hook to handle close all connections with delay checks
 * Listens to the hotkey event and triggers delay checks for all groups before closing connections
 */
export const useCloseAllWithDelayCheck = () => {
  const { proxies: proxiesData } = useAppData();
  const { t } = useTranslation();
  const delayCheckingNoticeIdRef = useRef<number | null>(null);

  const handleCloseAllWithDelayCheck = useCallback(async () => {
    // 标记关闭连接开始，在此后 10 秒内禁用 fallback 切换通知
    markCloseConnectionsStarted();

    delayCheckingNoticeIdRef.current = showNotice.info(
      `${t("proxies.page.tooltips.delayCheck")}进行中...`,
      0,
    );
    const pingDelayCheckNotice = (detailZh: string) => {
      const nid = delayCheckingNoticeIdRef.current;
      if (nid == null) return;
      updateNotice(
        nid,
        `${t("proxies.page.tooltips.delayCheck")}进行中\n${detailZh}`,
        0,
      );
    };

    try {
      if (!proxiesData?.groups) {
        pingDelayCheckNotice("无代理组数据，直接关闭非 DIRECT 连接…");
        debugLog("[CloseAll] No proxy groups available, closing connections directly (excluding DIRECT)");
        await closeConnectionsExcludingDirect();
        showNotice.success(
          `${t("proxies.page.tooltips.delayCheck")} ${t("tests.statuses.test.completed")}，连接清理将在后台继续`,
        );
        return;
      }

      debugLog(`[CloseAll] Starting delay checks for ${proxiesData.groups.length} groups`);

      const groups = proxiesData.groups;
      const bulkReuseMap = new Map<string, DelayUpdate>();

      // 收集所有 provider
      const allProviders = new Set<string>();
      groups.forEach((group: IProxyGroupItem) => {
        if (SKIP_DELAY_CHECK_GROUPS.has(group.name)) return;
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
        pingDelayCheckNotice(
          `正在对 ${allProviders.size} 个订阅提供者执行健康检查（与组内叶子测速并行准备）…`,
        );
        await Promise.allSettled(
          [...allProviders].map((provider) => healthcheckProxyProvider(provider)),
        );
        pingDelayCheckNotice("订阅提供者健康检查已完成，开始按组测速…");
      }

      let plannedGroupCount = 0;
      for (const g of groups as IProxyGroupItem[]) {
        if (SKIP_DELAY_CHECK_GROUPS.has(g.name)) continue;
        if (!g.all || g.all.length === 0) continue;
        const groupProxyNames = g.all
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
        if (groupProxyNames.length > 0) plannedGroupCount += 1;
      }
      pingDelayCheckNotice(
        plannedGroupCount > 0
          ? `准备：共 ${plannedGroupCount} 个代理组将顺序测速`
          : "当前无可测速的叶子节点分组",
      );

      let groupPhase = 0;
      // 顺序测速；同一会话内同一出站名复用首轮结果（含嵌套组被多个父 selector 引用）
      for (const group of groups as IProxyGroupItem[]) {
        if (SKIP_DELAY_CHECK_GROUPS.has(group.name)) {
          debugLog(`[CloseAll] Skip delay check group: ${group.name}`);
          continue;
        }
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

        groupPhase += 1;
        const phaseLabel =
          plannedGroupCount > 0
            ? `第 ${groupPhase}/${plannedGroupCount} 组`
            : `组「${group.name}」`;

        const url = delayManager.getUrl(group.name);
        const timeout = group?.timeout ?? DEFAULT_GROUP_TIMEOUT_MS;
        const testableProxyNames = groupProxyNames.filter(
          (n) => n && n !== "DIRECT" && n !== "REJECT",
        );
        const missingBulkReuse = delayManager.listNamesMissingBulkReuse(
          testableProxyNames,
          bulkReuseMap,
        );
        debugLog(
          `[CloseAll] Checking delays for group ${group.name}, ${groupProxyNames.length} proxies, 未命中同会话缓存: ${missingBulkReuse.length}/${testableProxyNames.length}`,
        );

        pingDelayCheckNotice(
          `${phaseLabel}：正在测速「${group.name}」（组级 URLTest，${groupProxyNames.length} 个叶子，超时 ${timeout}ms）`,
        );

        try {
          if (testableProxyNames.length > 0 && missingBulkReuse.length === 0) {
            delayManager.applyBulkReuseHitsForGroup(
              group.name,
              testableProxyNames,
              bulkReuseMap,
            );
            debugLog(
              `[CloseAll] 分组 ${group.name} 可测叶子全部命中同会话缓存，跳过组级/单节点测速`,
            );
          } else if (
            testableProxyNames.length > 0 &&
            missingBulkReuse.length === testableProxyNames.length
          ) {
            delayManager.markGroupDelayTesting(group.name, groupProxyNames);
            try {
              const dm = await delayGroup(group.name, url, timeout);
              delayManager.applyGroupUrlTestDelays(group.name, groupProxyNames, dm, {
                bulkReuseMap,
                timeout,
              });
              debugLog(
                `[CloseAll] delayGroup 完成 ${group.name}，返回 ${Object.keys(dm || {}).length} 条延迟`,
              );
            } catch (error: unknown) {
              console.warn(
                `[CloseAll] 组级 delayGroup 失败，回退逐节点测速: ${group.name}`,
                error,
              );
              pingDelayCheckNotice(
                `${phaseLabel}：组级测速不可用，已改用逐节点测速…`,
              );
              await delayManager.checkListDelay(
                groupProxyNames,
                group.name,
                timeout,
                {
                  bulkReuseMap,
                  fullBulkMaxConcurrency: true,
                },
              );
            }
          } else if (testableProxyNames.length > 0) {
            pingDelayCheckNotice(
              `${phaseLabel}：部分叶子复用他组同会话结果，对其余节点逐节点测速（${missingBulkReuse.length}/${testableProxyNames.length}）…`,
            );
            await delayManager.checkListDelay(
              groupProxyNames,
              group.name,
              timeout,
              {
                bulkReuseMap,
                fullBulkMaxConcurrency: true,
              },
            );
          }
          debugLog(`[CloseAll] Completed delay check for group ${group.name}`);
        } catch (error) {
          console.error(`[CloseAll] Delay check error for group ${group.name}:`, error);
        }
      }
      debugLog("[CloseAll] All delay checks completed, closing connections (excluding DIRECT)");

      const switchable = groups.filter(
        (g: IProxyGroupItem) =>
          !SKIP_DELAY_CHECK_GROUPS.has(g.name) &&
          g.all &&
          g.all.length > 0 &&
          ["URLTest", "Fallback"].includes(g.type),
      );
      if (switchable.length > 0) {
        pingDelayCheckNotice(
          `组内测速已完成，正在对 ${switchable.length} 个 url-test / fallback 组评估自动切换…`,
        );
      }

      // 自动切换到每个组第一个连接成功的节点（只处理 URLTest 和 Fallback，不处理 Selector）
      let switchPhase = 0;
      for (const group of groups) {
        if (SKIP_DELAY_CHECK_GROUPS.has(group.name)) continue;
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
              switchPhase += 1;
              pingDelayCheckNotice(
                `url-test/fallback 切换 ${switchPhase}：「${group.name}」${currentProxy ?? "（无）"} → ${firstSuccessProxy}`,
              );
              debugLog(
                `[CloseAll] Auto-switching group ${group.name}: ${currentProxy || "none"} -> ${firstSuccessProxy}`,
              );
              await selectNodeForGroup(group.name, firstSuccessProxy, {
                reason: "connections-close-all-auto",
              });
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

      pingDelayCheckNotice("正在关闭非 DIRECT 的活跃连接…");
      // Close all connections except those using DIRECT
      await closeConnectionsExcludingDirect();

      pingDelayCheckNotice("连接清理完成，正在发送完成事件…");
      // 发送完成通知
      try {
        await invoke("notify_close_all_completed");
        debugLog("[CloseAll] Notification sent successfully");
      } catch (error) {
        console.error("[CloseAll] Failed to send notification:", error);
      }
      showNotice.success(
        `${t("proxies.page.tooltips.delayCheck")} ${t("tests.statuses.test.completed")}，连接清理将在后台继续`,
      );
    } catch (error) {
      console.error("[CloseAll] Error during close all connections:", error);
      const nid = delayCheckingNoticeIdRef.current;
      if (nid != null) {
        updateNotice(
          nid,
          `${t("proxies.page.tooltips.delayCheck")}出错\n${error instanceof Error ? error.message : String(error)}`,
          0,
        );
      }
    } finally {
      const noticeId = delayCheckingNoticeIdRef.current;
      if (noticeId != null) {
        delayCheckingNoticeIdRef.current = null;
        hideNotice(noticeId);
      }
    }
    // 注意：不需要重置关闭连接状态，因为使用基于时间的冷却期（10秒）
  }, [proxiesData, t]);

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
