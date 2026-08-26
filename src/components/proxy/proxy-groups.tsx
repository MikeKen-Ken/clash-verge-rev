import { ExpandMoreRounded } from "@mui/icons-material";
import {
  Alert,
  Box,
  Chip,
  IconButton,
  Menu,
  MenuItem,
  Snackbar,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type VirtuosoHandle } from "react-virtuoso";
import { healthcheckProxyProvider } from "tauri-plugin-mihomo-api";

import { selectNodeForGroup } from "@/services/proxy-select-node";

import { BaseEmpty } from "@/components/base";
import { markManualDelayCheckStarted } from "@/hooks/use-fallback-switch-notify";
import { useProfiles } from "@/hooks/use-profiles";
import { useProxySelection } from "@/hooks/use-proxy-selection";
import { useVerge } from "@/hooks/use-verge";
import { useAppData } from "@/providers/app-data-context";
import {
  applyManualConnectivityProxyOrder,
  clearProxyGroupManualSelection,
  updateProxyChainConfigInRuntime,
} from "@/services/cmds";
import delayManager, {
  getGroupDelayTimeout,
  type DelayUpdate,
} from "@/services/delay";
import {
  clearDelayCheckManualOverrides,
  hasDelayCheckManualOverride,
  markDelayCheckManualOverride,
  snapshotDelayCheckManualOverrides,
} from "@/services/delay-check-manual-override";
import { hideNotice, showNotice, updateNotice } from "@/services/notice-service";
import { buildConnectivityScoreContext, hydrateConnectivityStatsFromDisk } from "@/services/proxy-connectivity-stats";
import {
  applyLiveConnectivityOrderForGroups,
  createDelayTestEarlyPicker,
  isAutoSelectGroupType,
  orderedMemberNamesByConnectivity,
  switchGroupsAfterDelayTest,
} from "@/services/proxy-live-connectivity-order";
import { compareProxyNamesByConnectivity } from "@/services/proxy-region-sort";
import { closeConnectionsExcludingDirect } from "@/utils/close-connections";
import { debugLog } from "@/utils/debug";

import { ScrollTopButton } from "../layout/scroll-top-button";

import { ProxyChain } from "./proxy-chain";
import {
  buildGroupNowMap,
  resolveLeafProxyName,
  resolvePrimaryGroupName,
} from "./resolve-leaf-proxy";
import {
  DEFAULT_HOVER_DELAY,
  ProxyGroupNavigator,
} from "./proxy-group-navigator";
import { ProxyVirtuosoList } from "./proxy-virtuoso-list";
import { useRenderList } from "./use-render-list";

interface Props {
  mode: string;
  isChainMode?: boolean;
  chainConfigData?: string | null;
  regionFilter?: string;
  hideUnavailableNodes?: boolean;
  onRegisterCheckAll?: ((runner: (() => void) | null) => void) | null;
  onActiveSelectionChange?: (
    selection: {
      groupName: string;
      proxyName: string;
      isManualSelection?: boolean;
      group?: { timeout?: number; selectedTimeout?: number } | null;
    } | null,
  ) => void;
}

interface ProxyChainItem {
  id: string;
  name: string;
  type?: string;
  delay?: number;
}

const SKIP_DELAY_CHECK_GROUPS = new Set(["Direct", "Final"]);

const formatGroupNameWithConnectTimes = (group: {
  name: string;
  connectTimes?: number;
  maxConnectTimes?: number;
}) => {
  if (typeof group.maxConnectTimes === "number" && group.maxConnectTimes > 0) {
    return `${group.name} (${group.connectTimes ?? 0}/${group.maxConnectTimes})`;
  }
  return group.name;
};

export const ProxyGroups = (props: Props) => {
  const { t } = useTranslation();
  const {
    mode,
    isChainMode = false,
    chainConfigData,
    regionFilter,
    hideUnavailableNodes = false,
    onRegisterCheckAll,
    onActiveSelectionChange,
  } = props;
  const [proxyChain, setProxyChain] = useState<ProxyChainItem[]>(() => {
    try {
      const saved = localStorage.getItem("proxy-chain-items");
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {
      // ignore
    }
    return [];
  });
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

  useEffect(() => {
    if (proxyChain.length > 0) {
      localStorage.setItem("proxy-chain-items", JSON.stringify(proxyChain));
    } else {
      localStorage.removeItem("proxy-chain-items");
    }
  }, [proxyChain]);
  const [ruleMenuAnchor, setRuleMenuAnchor] = useState<null | HTMLElement>(
    null,
  );
  const [duplicateWarning, setDuplicateWarning] = useState<{
    open: boolean;
    message: string;
  }>({ open: false, message: "" });
  const [delayCheckBusyWarning, setDelayCheckBusyWarning] = useState<{
    open: boolean;
    message: string;
  }>({ open: false, message: "" });
  const isDelayCheckingRef = useRef(false);
  const delayCheckingNoticeIdRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      const noticeId = delayCheckingNoticeIdRef.current;
      if (noticeId != null) {
        delayCheckingNoticeIdRef.current = null;
        hideNotice(noticeId);
      }
    };
  }, []);

  const { verge } = useVerge();
  const { proxies: proxiesData } = useAppData();
  const { current, patchCurrent, mutateProfiles } = useProfiles();
  const groups = proxiesData?.groups;

  // 使用核心返回的 group.now 标记每个组当前使用的节点
  const selectedByGroup = useMemo((): Map<string, string> => {
    const g = groups;
    if (!g?.length) return new Map<string, string>();
    const map = new Map<string, string>(
      g
        .filter(
          (x: { name?: string; now?: string }) =>
            x.name != null && x.now != null,
        )
        .map(
          (x: { name: string; now: string }) =>
            [x.name, x.now] as [string, string],
        ),
    );
    return map;
  }, [groups, current?.selected]);

  // 用 ref 存最新 map，保证传给 Virtuoso 的回调引用稳定，减少子组件重渲染
  const selectedByGroupRef = useRef<Map<string, string>>(new Map());
  selectedByGroupRef.current = selectedByGroup;

  // 自动清理：删除 profile.selected 里核心不存在的组（旧配置遗留的记录）
  const lastCleanupRef = useRef<string>("");
  useEffect(() => {
    if (!current?.selected?.length || !groups?.length) return;

    const validGroupNames = new Set(
      (groups as any[]).map((g: any) => g.name).filter(Boolean)
    );
    const invalidGroups = (current.selected ?? [])
      .map((s: any) => s.name)
      .filter((name: string) => !validGroupNames.has(name));

    if (invalidGroups.length > 0) {
      const cleanupKey = invalidGroups.sort().join(",");
      // 避免重复清理同一批记录
      if (lastCleanupRef.current === cleanupKey) return;
      lastCleanupRef.current = cleanupKey;

      const validSelected = (current.selected ?? []).filter(
        (s: any) => validGroupNames.has(s.name)
      );
      // 异步清理，不阻塞渲染
      patchCurrent({ selected: validSelected })
        .then(() => {
          mutateProfiles();
        })
        .catch((err) => {
          console.warn("[Cleanup] Failed to remove expired records", err);
        });
    }
  }, [groups, current?.selected, patchCurrent, mutateProfiles]);

  const getSelectedForGroup = useCallback(
    (groupName: string): string | undefined =>
      selectedByGroupRef.current.get(groupName),
    [],
  );

  // 解析 group.now 得到最终节点名；用于组头显示「当前节点」文案（子分组时会解析为「子分组名 (实际节点)」）
  const getDisplayNowForGroup = useCallback(
    (
      group: { name: string; now?: string | null },
      _useNameAsLabel?: boolean,
    ): string => {
      if (group.now == null || group.now === "")
        return group.name ?? "";
      const map = selectedByGroupRef.current;
      let current: string = group.now;
      while (map.has(current)) {
        const next = map.get(current)!;
        if (next === current) break;
        current = next;
      }
      if (!current) return group.name ?? "";
      const label = _useNameAsLabel ? group.name : (group.now ?? group.name);
      if (current === label) return label;
      return `${label} (${current})`;
    },
    [],
  );

  // Selector / URLTest / Fallback 组且 profile 的 current.selected 与 core 当前 now 一致时显示「手动选择」
  const getManualSelectionForGroup = useCallback(
    (groupName: string): string | undefined => {
      const group = groups?.find(
        (g: { name: string; type: string }) => g.name === groupName,
      );
      const typeLower = group?.type?.toLowerCase();
      const entry = (current?.selected ?? []).find((s) => s.name === groupName);
      const profileNow = entry?.now;
      const coreNow = selectedByGroupRef.current.get(groupName);

      if (
        !group ||
        !["selector", "url-test", "fallback"].includes(typeLower ?? "")
      )
        return undefined;
      if (profileNow == null) return undefined;
      return coreNow === profileNow ? profileNow : undefined;
    },
    [groups, current?.selected],
  );

  const availableGroups = useMemo(() => {
    if (!groups) return [];
    // 在链式代理模式下，仅显示支持选择节点的 Selector 代理组
    return isChainMode
      ? groups.filter((g: any) => g.type === "Selector")
      : groups;
  }, [groups, isChainMode]);

  const defaultRuleGroup = useMemo(() => {
    if (availableGroups.length === 0) return null;
    if (isChainMode && mode === "rule") {
      return availableGroups[0].name;
    }
    if (mode === "rule") {
      return resolvePrimaryGroupName(availableGroups);
    }
    return null;
  }, [availableGroups, isChainMode, mode]);

  const activeSelectedGroup = useMemo(
    () => selectedGroup ?? defaultRuleGroup,
    [selectedGroup, defaultRuleGroup],
  );

  const { renderList, onProxies, onHeadState } = useRenderList(
    mode,
    isChainMode,
    activeSelectedGroup,
    regionFilter,
    hideUnavailableNodes,
  );

  const getGroupHeadState = useCallback(
    (groupName: string) => {
      const headItem = renderList.find(
        (item) => item.type === 1 && item.group?.name === groupName,
      );
      return headItem?.headState;
    },
    [renderList],
  );

  // 统代理选择
  const { handleProxyGroupChange } = useProxySelection({
    onSuccess: () => {
      onProxies();
    },
    onError: (error) => {
      console.error("Failed to switch proxy", error);
      onProxies();
    },
    onRefreshSelectedNodeOnly: (groupName, proxyName) => {
      const group = groups?.find((g: { name?: string }) => g.name === groupName);
      const timeout = getGroupDelayTimeout(group ?? null, true) || 5000;
      void delayManager.checkDelay(proxyName, groupName, timeout, {
        silentGlobal: true,
      });
    },
  });

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollPositionRef = useRef<Record<string, number>>({});
  const [showScrollTop, setShowScrollTop] = useState(false);
  const scrollerRef = useRef<Element | null>(null);

  // 从 localStorage 恢复滚动位置
  useEffect(() => {
    if (renderList.length === 0) return;

    let restoreTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      const savedPositions = localStorage.getItem("proxy-scroll-positions");
      if (savedPositions) {
        const positions = JSON.parse(savedPositions);
        scrollPositionRef.current = positions;
        const savedPosition = positions[mode];

        if (savedPosition !== undefined) {
          restoreTimer = setTimeout(() => {
            virtuosoRef.current?.scrollTo({
              top: savedPosition,
              behavior: "auto",
            });
          }, 100);
        }
      }
    } catch (e) {
      console.error("Error restoring scroll position:", e);
    }

    return () => {
      if (restoreTimer) {
        clearTimeout(restoreTimer);
      }
    };
  }, [mode, renderList.length]);

  // 改为使用节流函数保存滚动位置
  const saveScrollPosition = useCallback(
    (scrollTop: number) => {
      try {
        scrollPositionRef.current[mode] = scrollTop;
        localStorage.setItem(
          "proxy-scroll-positions",
          JSON.stringify(scrollPositionRef.current),
        );
      } catch (e) {
        console.error("Error saving scroll position:", e);
      }
    },
    [mode],
  );

  // 使用改进的滚动处理
  const handleScroll = useMemo(
    () =>
      throttle((event: Event) => {
        const target = event.target as HTMLElement | null;
        const scrollTop = target?.scrollTop ?? 0;
        setShowScrollTop(scrollTop > 100);
        // 使用稳定的节流来保存位置，而不是setTimeout
        saveScrollPosition(scrollTop);
      }, 500), // 增加到500ms以确保平滑滚动
    [saveScrollPosition],
  );

  const scrollToTop = useCallback(() => {
    virtuosoRef.current?.scrollTo?.({
      top: 0,
      behavior: "smooth",
    });
    saveScrollPosition(0);
  }, [saveScrollPosition]);

  // 关闭重复节点警告
  const handleCloseDuplicateWarning = useCallback(() => {
    setDuplicateWarning({ open: false, message: "" });
  }, []);

  const handleCloseDelayCheckBusyWarning = useCallback(() => {
    setDelayCheckBusyWarning({ open: false, message: "" });
  }, []);

  const currentGroup = useMemo(() => {
    if (!activeSelectedGroup) return null;
    return (
      availableGroups.find(
        (group: any) => group.name === activeSelectedGroup,
      ) ?? null
    );
  }, [activeSelectedGroup, availableGroups]);

  useEffect(() => {
    if (!onActiveSelectionChange) return;

    if (mode === "direct" || mode === "offline") {
      onActiveSelectionChange(null);
      return;
    }

    const groupNowMap = buildGroupNowMap(groups as Array<{ name?: string; now?: string | null }>);
    const targetGroupName =
      mode === "global"
        ? "GLOBAL"
        : activeSelectedGroup ?? defaultRuleGroup ?? null;

    if (!targetGroupName) {
      onActiveSelectionChange(null);
      return;
    }

    const groupRecord = groups?.find(
      (g: { name: string }) => g.name === targetGroupName,
    );
    const rawNow = groupRecord?.now;
    if (!rawNow) {
      onActiveSelectionChange(null);
      return;
    }

    const proxyName = resolveLeafProxyName(rawNow, groupNowMap);
    if (!proxyName || proxyName === "DIRECT" || proxyName === "REJECT") {
      onActiveSelectionChange(null);
      return;
    }

    onActiveSelectionChange({
      groupName: targetGroupName,
      proxyName,
      isManualSelection: getManualSelectionForGroup(targetGroupName) != null,
      group: groupRecord ?? null,
    });
  }, [
    onActiveSelectionChange,
    mode,
    groups,
    activeSelectedGroup,
    defaultRuleGroup,
    getManualSelectionForGroup,
  ]);

  // 处理代理组选择菜单
  const handleGroupMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setRuleMenuAnchor(event.currentTarget);
  };

  const handleGroupMenuClose = () => {
    setRuleMenuAnchor(null);
  };

  const handleGroupSelect = (groupName: string) => {
    setSelectedGroup(groupName);
    handleGroupMenuClose();

    if (isChainMode && mode === "rule") {
      updateProxyChainConfigInRuntime(null);
      localStorage.removeItem("proxy-chain-group");
      localStorage.removeItem("proxy-chain-exit-node");
      localStorage.removeItem("proxy-chain-items");
      setProxyChain([]);
    }
  };

  const handleChangeProxy = useCallback(
    (
      group: IProxyGroupItem,
      proxy: IProxyItem,
      options?: { isManualSelection?: boolean },
    ) => {
      if (isChainMode) {
        // 使用函数式更新来避免状态延迟问题
        setProxyChain((prev) => {
          // 检查是否已经存在相同名称的代理，防止重复添加
          if (prev.some((item) => item.name === proxy.name)) {
            const warningMessage = t("proxies.page.chain.duplicateNode");
            setDuplicateWarning({
              open: true,
              message: warningMessage,
            });
            return prev; // 返回原来的状态，不做任何更改
          }

          // 安全获取延迟数据，如果没有延迟数据则设为 undefined
          const delay =
            proxy.history && proxy.history.length > 0
              ? proxy.history[proxy.history.length - 1].delay
              : undefined;

          const chainItem: ProxyChainItem = {
            id: `${proxy.name}_${Date.now()}`,
            name: proxy.name,
            type: proxy.type,
            delay: delay,
          };

          return [...prev, chainItem];
        });
        return;
      }

      const groupTypeLower = group.type?.toLowerCase();
      if (
        !groupTypeLower ||
        !["selector", "url-test", "fallback"].includes(groupTypeLower)
      ) {
        return;
      }

      if (isDelayCheckingRef.current) {
        markDelayCheckManualOverride(group.name, proxy.name);
      }

      handleProxyGroupChange(group, proxy, options);
    },
    [handleProxyGroupChange, isChainMode, t],
  );

  const proxyList = (
    <ProxyVirtuosoList
      virtuosoRef={virtuosoRef}
      scrollerRef={scrollerRef}
      renderList={renderList}
      indent={mode === "rule" || mode === "script"}
      isChainMode={isChainMode}
      initialScrollTop={scrollPositionRef.current[mode]}
      onScroll={handleScroll as EventListener}
      onHeadState={onHeadState}
      onChangeProxy={handleChangeProxy}
      getSelectedForGroup={getSelectedForGroup}
      getDisplayNowForGroup={getDisplayNowForGroup}
      getManualSelectionForGroup={getManualSelectionForGroup}
    />
  );

  // 测全部延迟：按组顺序测试；同一会话内同一出站名复用首轮测速（含嵌套组出现在多个父 selector）
  const handleCheckAll = useCallback(async (_groupName: string) => {
    if (isDelayCheckingRef.current) {
      setDelayCheckBusyWarning({
        open: true,
        message: `${t("proxies.page.tooltips.delayCheck")} in progress; please try again later`,
      });
      return;
    }
    isDelayCheckingRef.current = true;
    clearDelayCheckManualOverrides();
    debugLog(`[ProxyGroups] Starting delay tests for all groups`);
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
    markManualDelayCheckStarted();
    delayManager.beginBulkDelaySession();

    // 测速前清空所有组的手动选择
    if (current) {
      const allGroupNames = new Set(
        availableGroups.map((g: IProxyGroupItem) => g.name),
      );
      const next = (current.selected ?? []).filter((s) => {
        const name = s.name;
        if (!name) return true;
        return !allGroupNames.has(name);
      });
      if (next.length !== (current.selected ?? []).length) {
        patchCurrent({ selected: next }).catch(() => { });
      }
    }

    const allProviders = new Set<string>();
    const bulkReuseMap = new Map<string, DelayUpdate>();
    const keepPinned = new Set<string>();

    try {
      let plannedGroupCount = 0;
      for (const g of availableGroups as IProxyGroupItem[]) {
        if (SKIP_DELAY_CHECK_GROUPS.has(g.name)) continue;
        const plist: IProxyItem[] = (g as any).all ?? [];
        const n = plist
          .filter((p) => !p.provider)
          .map((p) => p.name)
          .filter(Boolean).length;
        if (n > 0) plannedGroupCount += 1;
      }
      pingDelayCheckNotice(
        plannedGroupCount > 0
          ? `Preparing: testing ${plannedGroupCount} proxy groups in sequence`
          : "Preparing: no proxy groups with testable leaf nodes",
      );

      await hydrateConnectivityStatsFromDisk();
      const scoreContext = buildConnectivityScoreContext();
      const liveOrderGroups = (availableGroups as IProxyGroupItem[])
        .filter(
          (g) =>
            !SKIP_DELAY_CHECK_GROUPS.has(g.name) &&
            isAutoSelectGroupType(g.type),
        )
        .map((g) => ({
          name: g.name,
          type: g.type,
          members: ((g as { all?: IProxyItem[] }).all ?? [])
            .filter((p) => !p.provider)
            .map((p) => p.name)
            .filter(
              (n): n is string =>
                Boolean(n) && n !== "DIRECT" && n !== "REJECT",
            ),
        }));
      await applyLiveConnectivityOrderForGroups(liveOrderGroups);
      await Promise.allSettled(
        liveOrderGroups.map((g) => clearProxyGroupManualSelection(g.name)),
      );

      let groupPhase = 0;
      const orderTargets: Array<{
        name: string;
        type?: string;
        members: string[];
      }> = [];
      const firstSuccessByGroup = new Map<string, string>();
      for (const group of availableGroups as IProxyGroupItem[]) {
        const groupName = group.name;
        if (SKIP_DELAY_CHECK_GROUPS.has(groupName)) {
          debugLog(`[ProxyGroups] Skipping delay test for group: ${groupName}`);
          continue;
        }
        const timeout = getGroupDelayTimeout(group, false);
        const proxies: IProxyItem[] = (group as any).all ?? [];

        proxies.forEach((p) => {
          if (p.provider) allProviders.add(p.provider);
        });

        const names = proxies
          .filter((p) => !p.provider)
          .map((p) => p.name)
          .filter(Boolean);

        if (names.length === 0) continue;

        groupPhase += 1;
        const phaseLabel =
          plannedGroupCount > 0
            ? `Group ${groupPhase}/${plannedGroupCount}`
            : `Group "${groupName}"`;

        const testableNames = names.filter(
          (n): n is string => Boolean(n) && n !== "DIRECT" && n !== "REJECT",
        );
        const missingBulkReuse = delayManager.listNamesMissingBulkReuse(
          testableNames,
          bulkReuseMap,
        );
        debugLog(
          `[ProxyGroups] 测试分组: ${groupName}, 节点数: ${names.length}, 可测叶子: ${testableNames.length}, 未命中同会话缓存: ${missingBulkReuse.length}, timeout: ${timeout}ms`,
        );

        pingDelayCheckNotice(
          `${phaseLabel}: testing "${groupName}" (${names.length} leaf nodes, timeout ${timeout}ms)`,
        );

        const orderedNames = orderedMemberNamesByConnectivity(
          testableNames,
          scoreContext,
        );
        const earlyPicker =
          isAutoSelectGroupType(group.type) &&
          !hasDelayCheckManualOverride(groupName)
            ? createDelayTestEarlyPicker({
                groupName,
                orderedNames,
                timeoutMs: timeout,
                isCancelled: () => hasDelayCheckManualOverride(groupName),
              })
            : null;
        const feedEarlyPick = (proxyName: string) => {
          const delay = delayManager.getDelayUpdate(proxyName, groupName)
            ?.delay;
          if (typeof delay === "number") {
            earlyPicker?.onResult(proxyName, delay);
          }
        };

        // 同会话复用（与旧 checkListDelay 路径一致）：嵌套组多父 selector 共用出站名时，后续组可跳过已测叶子。
        // 全部命中缓存 → 只写 UI；否则统一走节点级 checkListDelay（与 Android healthCheckWithTimeout 一致）。
        if (testableNames.length > 0 && missingBulkReuse.length === 0) {
          delayManager.applyBulkReuseHitsForGroup(
            groupName,
            testableNames,
            bulkReuseMap,
          );
          orderedNames.forEach(feedEarlyPick);
          debugLog(
            `[ProxyGroups] 分组 ${groupName} 可测叶子全部命中同会话缓存，跳过节点级测速`,
          );
        } else if (testableNames.length > 0) {
          if (missingBulkReuse.length < testableNames.length) {
            pingDelayCheckNotice(
              `${phaseLabel}: reusing results for some nodes; testing the rest (${missingBulkReuse.length}/${testableNames.length})...`,
            );
            delayManager.applyBulkReuseHitsForGroup(
              groupName,
              testableNames,
              bulkReuseMap,
            );
            orderedNames.forEach(feedEarlyPick);
          }
          delayManager.markGroupDelayTesting(groupName, names);
          await delayManager.checkListDelay(orderedNames, groupName, timeout, {
            bulkReuseMap,
            onNodeSettled: (proxyName, delay) =>
              earlyPicker?.onResult(proxyName, delay),
          });
        }

        const successCandidates = names
          .map((proxyName, index) => {
            const delayUpdate = delayManager.getDelayUpdate(proxyName, groupName);
            const delay = delayUpdate?.delay;
            return { proxyName, index, delay };
          })
          .filter(
            ({ proxyName, delay }) =>
              proxyName !== "DIRECT" &&
              proxyName !== "REJECT" &&
              typeof delay === "number" &&
              delay > 0 &&
              delay <= timeout,
          );

        const postTestScoreContext = buildConnectivityScoreContext();
        successCandidates.sort((a, b) =>
          compareProxyNamesByConnectivity(
            a.proxyName,
            b.proxyName,
            a.index,
            b.index,
            postTestScoreContext,
          ),
        );

        if (isAutoSelectGroupType(group.type)) {
          orderTargets.push({
            name: groupName,
            type: group.type,
            members: names.filter(
              (n) => n && n !== "DIRECT" && n !== "REJECT",
            ),
          });
        }

        // fallback/url-test：测速后按积分重排运行时列表再清钉，不能 PUT 后立刻清钉
        // （清钉会让 Fallback 回到配置文件原序的第一个可用节点）。
        const firstSuccessProxy = successCandidates[0]?.proxyName;
        if (firstSuccessProxy && !hasDelayCheckManualOverride(groupName)) {
          if (isAutoSelectGroupType(group.type)) {
            firstSuccessByGroup.set(groupName, firstSuccessProxy);
            pingDelayCheckNotice(
              `${phaseLabel}: testing complete; applying score order for "${groupName}" → ${firstSuccessProxy}`,
            );
          } else {
            pingDelayCheckNotice(
              `${phaseLabel}: testing complete; asking the core to switch "${groupName}" → ${firstSuccessProxy}`,
            );
            await selectNodeForGroup(groupName, firstSuccessProxy, {
              reason: "proxy-ui-delay-bulk-auto",
            }).catch((err) => {
              console.warn(
                `[ProxyGroups] 自动选择首个成功节点失败: ${groupName} -> ${firstSuccessProxy}`,
                err,
              );
            });
          }
        } else if (hasDelayCheckManualOverride(groupName)) {
          pingDelayCheckNotice(
            `${phaseLabel}: manual selection detected; skipping automatic switch for "${groupName}"`,
          );
          debugLog(
            `[ProxyGroups] 分组 ${groupName} 测速期间用户已手动选择，跳过自动切换`,
          );
        } else {
          pingDelayCheckNotice(
            `${phaseLabel}: no successful test result for "${groupName}"; skipping switch`,
          );
          debugLog(
            `[ProxyGroups] 分组 ${groupName} 未找到测速成功节点，保留核心当前选择`,
          );
        }
      }
      const manualDuringCheck = snapshotDelayCheckManualOverrides();
      const extraUnpinNames = availableGroups
        .filter((g: IProxyGroupItem) => {
          const type = g.type?.toLowerCase();
          return (
            !SKIP_DELAY_CHECK_GROUPS.has(g.name) &&
            !manualDuringCheck.has(g.name) &&
            (type === "selector" ||
              type === "url-test" ||
              type === "urltest" ||
              type === "fallback")
          );
        })
        .map((g: IProxyGroupItem) => g.name);
      pingDelayCheckNotice("Applying connectivity score order to live groups...");
      const pinned = await switchGroupsAfterDelayTest({
        groups: orderTargets,
        firstSuccessByGroup,
        manualOverrides: manualDuringCheck,
        extraUnpinNames,
        selectReason: "proxy-ui-delay-bulk-auto",
      });
      pinned.forEach((name) => keepPinned.add(name));
      // 只把联通顺序写入 runtime YAML，不要整包 reload_config：
      // 测速后重载会重建出站（延迟全变成超时）并重置 DNS/TUN，流量会一直失败直到重启。
      await applyManualConnectivityProxyOrder();
      debugLog(`[ProxyGroups] Delay tests for all groups completed`);
      pingDelayCheckNotice("Testing and switching complete; refreshing proxy data...");
    } catch (error) {
      console.error(`[ProxyGroups] Delay tests for all groups failed`, error);
      const nid = delayCheckingNoticeIdRef.current;
      if (nid != null) {
        updateNotice(
          nid,
          `${t("proxies.page.tooltips.delayCheck")} failed\n${error instanceof Error ? error.message : String(error)}`,
          0,
        );
      }
    } finally {
      delayManager.endBulkDelaySession();
      try {
        // 处理 provider 健康检查（fire and forget）
        if (allProviders.size) {
          debugLog(`[ProxyGroups] Found providers, count: ${allProviders.size}`);
          Promise.allSettled(
            [...allProviders].map((p) => healthcheckProxyProvider(p)),
          ).then(() => {
            debugLog(`[ProxyGroups] Provider health checks completed`);
            onProxies();
          });
        }

        // 测速后清空各组手动选择记录；测速期间用户手动选过的组保留
        const manualDuringCheck = snapshotDelayCheckManualOverrides();
        const unpinGroups = availableGroups.filter((g: IProxyGroupItem) => {
          const type = g.type?.toLowerCase();
          return (
            !SKIP_DELAY_CHECK_GROUPS.has(g.name) &&
            !manualDuringCheck.has(g.name) &&
            !keepPinned.has(g.name) &&
            (type === "selector" ||
              type === "url-test" ||
              type === "urltest" ||
              type === "fallback")
          );
        });
        await Promise.allSettled(
          unpinGroups.map((g: IProxyGroupItem) =>
            clearProxyGroupManualSelection(g.name),
          ),
        );
        if (current) {
          const allGroupNames = new Set(
            availableGroups.map((g: IProxyGroupItem) => g.name),
          );
          const next = (current.selected ?? []).filter((s) => {
            const name = s.name;
            if (!name) return true;
            return (
              !allGroupNames.has(name) || manualDuringCheck.has(name)
            );
          });
          if (next.length !== (current.selected ?? []).length) {
            patchCurrent({ selected: next })
              .then(() => mutateProfiles())
              .catch(() => { });
          }
        }

        // 关闭连接可能较慢，不应阻塞测速完成后的 UI 刷新与通知收尾
        void closeConnectionsExcludingDirect()
          .then(() => {
            onProxies();
          })
          .catch((error) => {
            console.error("[ProxyGroups] Failed to close non-DIRECT connections", error);
          });
        onProxies();
        showNotice.success(
          `${t("proxies.page.tooltips.delayCheck")} ${t("tests.statuses.test.completed")}; connection cleanup will continue in the background`,
        );
      } finally {
        const noticeId = delayCheckingNoticeIdRef.current;
        if (noticeId != null) {
          delayCheckingNoticeIdRef.current = null;
          hideNotice(noticeId);
        }
        isDelayCheckingRef.current = false;
        clearDelayCheckManualOverrides();
      }
    }
  }, [
    availableGroups,
    current,
    getGroupHeadState,
    mutateProfiles,
    onHeadState,
    onProxies,
    patchCurrent,
    t,
  ]);

  useEffect(() => {
    if (!onRegisterCheckAll) return;
    onRegisterCheckAll(() => {
      void handleCheckAll("");
    });
    return () => {
      onRegisterCheckAll(null);
    };
  }, [handleCheckAll, onRegisterCheckAll]);

  // 定位到指定的代理组
  const handleGroupLocationByName = useCallback(
    (groupName: string) => {
      const index = renderList.findIndex(
        (item) => item.type === 0 && item.group?.name === groupName,
      );

      if (index >= 0) {
        virtuosoRef.current?.scrollToIndex?.({
          index,
          align: "start",
          behavior: "smooth",
        });
      }
    },
    [renderList],
  );

  const proxyGroupNames = useMemo(() => {
    const names = renderList
      .filter((item) => item.type === 0 && item.group?.name)
      .map((item) => item.group!.name);
    return Array.from(new Set(names));
  }, [renderList]);

  // 直连/全局模式不切换组：仍显示与规则模式相同的代理组，仅后端改 rules/dns
  if (isChainMode) {
    // 获取所有代理组
    const proxyGroups = proxiesData?.groups || [];

    return (
      <>
        <Box sx={{ display: "flex", height: "100%", minHeight: 0, gap: 2 }}>
          <Box
            sx={{
              flex: 1,
              position: "relative",
              minHeight: 0,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* 代理规则标题和代理组按钮栏 */}
            {mode === "rule" && proxyGroups.length > 0 && (
              <Box sx={{ borderBottom: "1px solid", borderColor: "divider" }}>
                {/* 代理规则标题 */}
                <Box
                  sx={{
                    px: 2,
                    py: 1.5,
                    borderBottom: "1px solid",
                    borderColor: "divider",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                    <Typography
                      variant="h6"
                      sx={{ fontWeight: 600, fontSize: "16px" }}
                    >
                      {t("proxies.page.rules.title")}
                    </Typography>
                    {currentGroup && (
                      <Box
                        sx={{ display: "flex", alignItems: "center", gap: 1 }}
                      >
                        <Chip
                          size="small"
                          label={`${formatGroupNameWithConnectTimes(currentGroup)} (${currentGroup.type})`}
                          variant="outlined"
                          sx={{
                            fontSize: "12px",
                            maxWidth: "200px",
                            "& .MuiChip-label": {
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            },
                          }}
                        />
                      </Box>
                    )}
                  </Box>

                  {availableGroups.length > 0 && (
                    <IconButton
                      size="small"
                      onClick={handleGroupMenuOpen}
                      sx={{
                        border: "1px solid",
                        borderColor: "divider",
                        borderRadius: "4px",
                        padding: "4px 8px",
                      }}
                    >
                      <Typography
                        variant="body2"
                        sx={{ mr: 0.5, fontSize: "12px" }}
                      >
                        {t("proxies.page.rules.select")}
                      </Typography>
                      <ExpandMoreRounded fontSize="small" />
                    </IconButton>
                  )}
                </Box>
              </Box>
            )}

            <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
              {proxyList}
            </Box>
            <ScrollTopButton show={showScrollTop} onClick={scrollToTop} />
          </Box>

          <Box sx={{ width: "400px", minWidth: "300px" }}>
            <ProxyChain
              proxyChain={proxyChain}
              onUpdateChain={setProxyChain}
              chainConfigData={chainConfigData}
              mode={mode}
              selectedGroup={activeSelectedGroup}
            />
          </Box>
        </Box>

        <Snackbar
          open={duplicateWarning.open}
          autoHideDuration={3000}
          onClose={handleCloseDuplicateWarning}
          anchorOrigin={{ vertical: "top", horizontal: "center" }}
        >
          <Alert
            onClose={handleCloseDuplicateWarning}
            severity="warning"
            variant="filled"
          >
            {duplicateWarning.message}
          </Alert>
        </Snackbar>
        <Snackbar
          open={delayCheckBusyWarning.open}
          autoHideDuration={2500}
          onClose={handleCloseDelayCheckBusyWarning}
          anchorOrigin={{ vertical: "top", horizontal: "center" }}
        >
          <Alert
            onClose={handleCloseDelayCheckBusyWarning}
            severity="error"
            variant="filled"
          >
            {delayCheckBusyWarning.message}
          </Alert>
        </Snackbar>

        {/* 代理组选择菜单 */}
        <Menu
          anchorEl={ruleMenuAnchor}
          open={Boolean(ruleMenuAnchor)}
          onClose={handleGroupMenuClose}
          slotProps={{
            paper: {
              sx: {
                maxHeight: 300,
                minWidth: 200,
              },
            },
          }}
        >
          {availableGroups.map((group: any) => (
            <MenuItem
              key={group.name}
              onClick={() => handleGroupSelect(group.name)}
              selected={activeSelectedGroup === group.name}
              sx={{
                fontSize: "14px",
                py: 1,
              }}
            >
              <Box
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                }}
              >
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {formatGroupNameWithConnectTimes(group)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {group.type} · {group.all.length} 节点
                </Typography>
              </Box>
            </MenuItem>
          ))}
          {availableGroups.length === 0 && (
            <MenuItem disabled>
              <Typography variant="body2" color="text.secondary">
            No proxy groups available
              </Typography>
            </MenuItem>
          )}
        </Menu>
      </>
    );
  }

  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* 代理组导航栏 */}
      {mode === "rule" && (
        <ProxyGroupNavigator
          proxyGroupNames={proxyGroupNames}
          onGroupLocation={handleGroupLocationByName}
          enableHoverJump={verge?.enable_hover_jump_navigator ?? true}
          hoverDelay={verge?.hover_jump_navigator_delay ?? DEFAULT_HOVER_DELAY}
        />
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {proxyList}
      </div>
      <ScrollTopButton show={showScrollTop} onClick={scrollToTop} />
      <Snackbar
        open={delayCheckBusyWarning.open}
        autoHideDuration={2500}
        onClose={handleCloseDelayCheckBusyWarning}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
      >
        <Alert
          onClose={handleCloseDelayCheckBusyWarning}
          severity="error"
          variant="filled"
        >
          {delayCheckBusyWarning.message}
        </Alert>
      </Snackbar>
    </div>
  );
};

// 替换简单防抖函数为更优的节流函数
function throttle<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let previous = 0;

  return function (...args: Parameters<T>) {
    const now = Date.now();
    const remaining = wait - (now - previous);

    if (remaining <= 0 || remaining > wait) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      previous = now;
      func(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        previous = Date.now();
        timer = null;
        func(...args);
      }, remaining);
    }
  };
}
