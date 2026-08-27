import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { healthcheckProxyProvider } from "tauri-plugin-mihomo-api";

import { markCloseConnectionsStarted } from "@/hooks/use-fallback-switch-notify";
import { useAppData } from "@/providers/app-data-context";
import delayManager, {
  DEFAULT_GROUP_TIMEOUT_MS,
  type DelayUpdate,
} from "@/services/delay";
import {
  beginDelayCheckManualOverrideTracking,
  hasDelayCheckManualOverride,
} from "@/services/delay-check-manual-override";
import {
  hideNotice,
  showNotice,
  updateNotice,
} from "@/services/notice-service";
import {
  buildConnectivityScoreContext,
  hydrateConnectivityStatsFromDisk,
} from "@/services/proxy-connectivity-stats";
import {
  applyStartupLiveConnectivityOrder,
  createDelayTestEarlyPicker,
  isAutoSelectGroupType,
  memberNamesFromGroupAll,
  orderedMemberNamesByConnectivity,
  stopDelayTestEarlyPickers,
  switchGroupsAfterDelayTest,
  type DelayTestEarlyPicker,
} from "@/services/proxy-live-connectivity-order";
import { compareProxyNamesByConnectivity } from "@/services/proxy-region-sort";
import { closeConnectionsExcludingDirect } from "@/utils/close-connections";
import { debugLog } from "@/utils/debug";

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
    const endManualOverrideTracking = beginDelayCheckManualOverrideTracking();

    delayCheckingNoticeIdRef.current = showNotice.info(
      `${t("proxies.page.tooltips.delayCheck")} in progress...`,
      0,
    );
    const pingDelayCheckNotice = (detail: string) => {
      const nid = delayCheckingNoticeIdRef.current;
      if (nid == null) return;
      updateNotice(
        nid,
        `${t("proxies.page.tooltips.delayCheck")} in progress\n${detail}`,
        0,
      );
    };

    try {
      if (!proxiesData?.groups) {
        pingDelayCheckNotice(
          "No proxy group data; closing non-DIRECT connections...",
        );
        debugLog(
          "[CloseAll] No proxy groups available, closing connections directly (excluding DIRECT)",
        );
        await closeConnectionsExcludingDirect();
        showNotice.success(
          `${t("proxies.page.tooltips.delayCheck")} ${t("tests.statuses.test.completed")}; connection cleanup will continue in the background`,
        );
        return;
      }

      debugLog(
        `[CloseAll] Starting delay checks for ${proxiesData.groups.length} groups`,
      );

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
        debugLog(
          `[CloseAll] Checking delays for ${allProviders.size} providers`,
        );
        pingDelayCheckNotice(
          `Running health checks for ${allProviders.size} providers (preparing leaf-node tests in parallel)...`,
        );
        await Promise.allSettled(
          [...allProviders].map((provider) =>
            healthcheckProxyProvider(provider),
          ),
        );
        pingDelayCheckNotice(
          "Provider health checks complete; starting group tests...",
        );
      }

      let plannedGroupCount = 0;
      for (const g of groups as IProxyGroupItem[]) {
        if (SKIP_DELAY_CHECK_GROUPS.has(g.name)) continue;
        if (!g.all || g.all.length === 0) continue;
        const groupProxyNames = g.all
          .map((proxy: IProxyItem | string) =>
            typeof proxy === "string" ? proxy : proxy.name,
          )
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
          ? `Preparing: testing ${plannedGroupCount} proxy groups in sequence`
          : "No proxy groups with testable leaf nodes",
      );

      await hydrateConnectivityStatsFromDisk();
      const scoreContext = buildConnectivityScoreContext();
      const liveOrderGroups = (groups as IProxyGroupItem[])
        .filter(
          (g) =>
            !SKIP_DELAY_CHECK_GROUPS.has(g.name) &&
            isAutoSelectGroupType(g.type),
        )
        .map((g) => ({
          name: g.name,
          type: g.type,
          members: memberNamesFromGroupAll(g.all),
        }));
      await applyStartupLiveConnectivityOrder(liveOrderGroups, {
        has: hasDelayCheckManualOverride,
      });

      let groupPhase = 0;
      delayManager.beginBulkDelaySession();
      const earlyPickers: DelayTestEarlyPicker[] = [];
      try {
        // 顺序测速；同一会话内同一出站名复用首轮结果（含嵌套组被多个父 selector 引用）
        for (const group of groups as IProxyGroupItem[]) {
          if (SKIP_DELAY_CHECK_GROUPS.has(group.name)) {
            debugLog(`[CloseAll] Skip delay check group: ${group.name}`);
            continue;
          }
          if (!group.all || group.all.length === 0) continue;

          const groupProxyNames = group.all
            .map((proxy: IProxyItem | string) =>
              typeof proxy === "string" ? proxy : proxy.name,
            )
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
              ? `Group ${groupPhase}/${plannedGroupCount}`
              : `Group "${group.name}"`;

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
            `${phaseLabel}: testing "${group.name}" (${groupProxyNames.length} leaf nodes, timeout ${timeout}ms)`,
          );

          const orderedNames = orderedMemberNamesByConnectivity(
            testableProxyNames,
            scoreContext,
          );
          const earlyPicker =
            isAutoSelectGroupType(group.type) &&
            !hasDelayCheckManualOverride(group.name)
              ? createDelayTestEarlyPicker({
                  groupName: group.name,
                  orderedNames,
                  timeoutMs: timeout,
                  isCancelled: () => hasDelayCheckManualOverride(group.name),
                })
              : null;
          if (earlyPicker) earlyPickers.push(earlyPicker);
          const feedEarlyPick = (proxyName: string) => {
            const delay = delayManager.getDelayUpdate(
              proxyName,
              group.name,
            )?.delay;
            if (typeof delay === "number") {
              earlyPicker?.onResult(proxyName, delay);
            }
          };

          try {
            if (
              testableProxyNames.length > 0 &&
              missingBulkReuse.length === 0
            ) {
              delayManager.applyBulkReuseHitsForGroup(
                group.name,
                testableProxyNames,
                bulkReuseMap,
              );
              orderedNames.forEach(feedEarlyPick);
              debugLog(
                `[CloseAll] 分组 ${group.name} 可测叶子全部命中同会话缓存，跳过节点级测速`,
              );
            } else if (testableProxyNames.length > 0) {
              if (missingBulkReuse.length < testableProxyNames.length) {
                pingDelayCheckNotice(
                  `${phaseLabel}: reusing results for some nodes; testing the rest (${missingBulkReuse.length}/${testableProxyNames.length})...`,
                );
                delayManager.applyBulkReuseHitsForGroup(
                  group.name,
                  testableProxyNames,
                  bulkReuseMap,
                );
                orderedNames.forEach(feedEarlyPick);
              }
              delayManager.markGroupDelayTesting(group.name, groupProxyNames);
              await delayManager.checkListDelay(
                orderedNames,
                group.name,
                timeout,
                {
                  bulkReuseMap,
                  onNodeSettled: (proxyName, delay) =>
                    earlyPicker?.onResult(proxyName, delay),
                },
              );
              debugLog(
                `[CloseAll] 节点级测速完成 ${group.name}，共 ${groupProxyNames.length} 个叶子`,
              );
            }
            await earlyPicker?.flush();
            debugLog(
              `[CloseAll] Completed delay check for group ${group.name}`,
            );
          } catch (error) {
            console.error(
              `[CloseAll] Delay check error for group ${group.name}:`,
              error,
            );
          }
        }
      } finally {
        delayManager.endBulkDelaySession();
        await stopDelayTestEarlyPickers(earlyPickers);
      }
      debugLog(
        "[CloseAll] All delay checks completed, closing connections (excluding DIRECT)",
      );

      const switchable = groups.filter(
        (g: IProxyGroupItem) =>
          !SKIP_DELAY_CHECK_GROUPS.has(g.name) &&
          g.all &&
          g.all.length > 0 &&
          isAutoSelectGroupType(g.type),
      );
      if (switchable.length > 0) {
        pingDelayCheckNotice(
          `Group tests complete; applying score order for ${switchable.length} url-test/fallback groups...`,
        );
      }

      const scoreContextAfterTest = buildConnectivityScoreContext();
      const orderTargets: Array<{
        name: string;
        type?: string;
        members: string[];
      }> = [];
      const firstSuccessByGroup = new Map<string, string>();
      for (const group of switchable) {
        const timeout = group?.timeout ?? DEFAULT_GROUP_TIMEOUT_MS;
        const members = memberNamesFromGroupAll(group.all);
        orderTargets.push({
          name: group.name,
          type: group.type,
          members,
        });

        const successCandidates = members
          .map((proxyName, index) => {
            const delayUpdate = delayManager.getDelayUpdate(
              proxyName,
              group.name,
            );
            return { proxyName, index, delay: delayUpdate?.delay };
          })
          .filter(({ delay }) => {
            if (typeof delay !== "number") return false;
            const delayText = delayManager.formatDelay(delay, timeout);
            return (
              delayText !== "T" &&
              delayText !== "E" &&
              delayText !== "-" &&
              delayText !== "testing" &&
              delay > 0 &&
              delay < timeout &&
              delay <= 1e5
            );
          });
        successCandidates.sort((a, b) =>
          compareProxyNamesByConnectivity(
            a.proxyName,
            b.proxyName,
            a.index,
            b.index,
            scoreContextAfterTest,
          ),
        );
        const firstSuccessProxy = successCandidates[0]?.proxyName;
        if (firstSuccessProxy) {
          firstSuccessByGroup.set(group.name, firstSuccessProxy);
          debugLog(
            `[CloseAll] Score-first success proxy for ${group.name}: ${firstSuccessProxy}`,
          );
        }
      }

      await switchGroupsAfterDelayTest({
        groups: orderTargets,
        firstSuccessByGroup,
        manualOverrides: { has: hasDelayCheckManualOverride },
        extraUnpinNames: switchable.map((g: IProxyGroupItem) => g.name),
        selectReason: "connections-close-all-auto",
      });

      pingDelayCheckNotice("Closing active non-DIRECT connections...");
      // Close all connections except those using DIRECT
      await closeConnectionsExcludingDirect();

      pingDelayCheckNotice(
        "Connection cleanup complete; sending completion event...",
      );
      // 发送完成通知
      try {
        await invoke("notify_close_all_completed");
        debugLog("[CloseAll] Notification sent successfully");
      } catch (error) {
        console.error("[CloseAll] Failed to send notification:", error);
      }
      showNotice.success(
        `${t("proxies.page.tooltips.delayCheck")} ${t("tests.statuses.test.completed")}; connection cleanup will continue in the background`,
      );
    } catch (error) {
      console.error("[CloseAll] Error during close all connections:", error);
      const nid = delayCheckingNoticeIdRef.current;
      if (nid != null) {
        updateNotice(
          nid,
          `${t("proxies.page.tooltips.delayCheck")} failed\n${error instanceof Error ? error.message : String(error)}`,
          0,
        );
      }
    } finally {
      endManualOverrideTracking();
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
        debugLog(
          "[CloseAll] Listener registered for close all connections event",
        );
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
