import { listen } from "@tauri-apps/api/event";
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import useSWR from "swr";
import {
  delayGroup,
  getBaseConfig,
  getRuleProviders,
  getRules,
} from "tauri-plugin-mihomo-api";

import {
  markManualDelayCheckStarted,
  markManualProxySelectionStarted,
} from "@/hooks/use-fallback-switch-notify";
import { useVerge } from "@/hooks/use-verge";
import {
  calcuProxies,
  calcuProxyProviders,
  getAppUptime,
  getRunningMode,
  getSystemProxy,
} from "@/services/cmds";
import { SWR_DEFAULTS, SWR_MIHOMO } from "@/services/config";
import delayManager from "@/services/delay";

import { AppDataContext, AppDataContextType } from "./app-data-context";

// 全局数据提供者组件
export const AppDataProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const { verge } = useVerge();

  const { data: proxiesData, mutate: refreshProxy } = useSWR(
    "getProxies",
    calcuProxies,
    SWR_MIHOMO,
  );

  const { data: clashConfig, mutate: refreshClashConfig } = useSWR(
    "getClashConfig",
    getBaseConfig,
    SWR_MIHOMO,
  );

  const { data: proxyProviders, mutate: refreshProxyProviders } = useSWR(
    "getProxyProviders",
    calcuProxyProviders,
    SWR_MIHOMO,
  );

  const { data: ruleProviders, mutate: refreshRuleProviders } = useSWR(
    "getRuleProviders",
    getRuleProviders,
    SWR_MIHOMO,
  );

  const { data: rulesData, mutate: refreshRules } = useSWR(
    "getRules",
    getRules,
    SWR_MIHOMO,
  );

  const hasTriggeredStartupFallback = useRef(false);
  /** 启动轮询时记录的 url-test/fallback 各组初始 now，用于判断核心是否已更新 */
  const initialNowByGroupRef = useRef<Map<string, string> | null>(null);
  const pollingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingCountRef = useRef(0);

  const POLL_INTERVAL_MS = 1500;
  const POLL_MAX_COUNT = 16;

  // 启动时触发 url-test/fallback 组的测速，然后轮询代理数据直到各组的 now 已更新或达到最大次数
  useEffect(() => {
    if (!proxiesData?.groups?.length || hasTriggeredStartupFallback.current) {
      return;
    }
    const groups = proxiesData.groups as IProxyGroupItem[];
    const urlTestOrFallback = groups.filter(
      (g) => g.type === "url-test" || g.type === "fallback",
    );
    if (urlTestOrFallback.length === 0) return;

    hasTriggeredStartupFallback.current = true;
    initialNowByGroupRef.current = new Map(
      urlTestOrFallback.map((g) => [g.name, g.now ?? ""]),
    );
    pollingCountRef.current = 0;

    // 标记测速，在此后 10 秒内不发送 fallback 切换通知
    markManualDelayCheckStarted();

    const scheduleNextPoll = () => {
      pollingTimerRef.current = setTimeout(() => {
        pollingTimerRef.current = null;
        pollingCountRef.current += 1;
        refreshProxy().catch(() => {});
        if (pollingCountRef.current < POLL_MAX_COUNT) {
          scheduleNextPoll();
        }
      }, POLL_INTERVAL_MS);
    };

    const run = async () => {
      await Promise.allSettled(
        urlTestOrFallback.map((g) => {
          const url = delayManager.getUrl(g.name);
          const timeout = g.timeout ?? 5000;
          return delayGroup(g.name, url, timeout);
        }),
      );
      await refreshProxy();
      pollingCountRef.current += 1;
      scheduleNextPoll();
    };
    void run();

    return () => {
      if (pollingTimerRef.current != null) {
        clearTimeout(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };
  }, [proxiesData, refreshProxy]);

  // 每次代理数据更新后检查：若所有 url-test/fallback 的 now 已相对初始值变化，或已达最大轮询次数，则停止轮询
  useEffect(() => {
    const initial = initialNowByGroupRef.current;
    if (initial == null || !proxiesData?.groups?.length) return;

    const groups = proxiesData.groups as IProxyGroupItem[];
    const urlTestOrFallback = groups.filter(
      (g) => g.type === "url-test" || g.type === "fallback",
    );
    const allUpdated = urlTestOrFallback.every(
      (g) => (g.now ?? "") !== initial.get(g.name),
    );
    const overLimit = pollingCountRef.current >= POLL_MAX_COUNT;

    if (allUpdated || overLimit) {
      initialNowByGroupRef.current = null;
      if (pollingTimerRef.current != null) {
        clearTimeout(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    }
  }, [proxiesData]);

  useEffect(() => {
    let lastProfileId: string | null = null;
    let lastUpdateTime = 0;
    const refreshThrottle = 800;

    let isUnmounted = false;
    const scheduledTimeouts = new Set<number>();
    const cleanupFns: Array<() => void> = [];

    const registerCleanup = (fn: () => void) => {
      if (isUnmounted) {
        try {
          fn();
        } catch (error) {
          console.error("[DataProvider] Immediate cleanup failed:", error);
        }
      } else {
        cleanupFns.push(fn);
      }
    };

    const addWindowListener = (eventName: string, handler: EventListener) => {
      // eslint-disable-next-line @eslint-react/web-api/no-leaked-event-listener
      window.addEventListener(eventName, handler);
      return () => window.removeEventListener(eventName, handler);
    };

    const scheduleTimeout = (
      callback: () => void | Promise<void>,
      delay: number,
    ) => {
      if (isUnmounted) return -1;

      const timeoutId = window.setTimeout(() => {
        scheduledTimeouts.delete(timeoutId);
        if (!isUnmounted) {
          void callback();
        }
      }, delay);

      scheduledTimeouts.add(timeoutId);
      return timeoutId;
    };

    const clearAllTimeouts = () => {
      scheduledTimeouts.forEach((timeoutId) => clearTimeout(timeoutId));
      scheduledTimeouts.clear();
    };

    const handleProfileChanged = (event: { payload: string }) => {
      const newProfileId = event.payload;
      const now = Date.now();

      if (
        lastProfileId === newProfileId &&
        now - lastUpdateTime < refreshThrottle
      ) {
        return;
      }

      lastProfileId = newProfileId;
      lastUpdateTime = now;
      hasTriggeredStartupFallback.current = false;

      scheduleTimeout(() => {
        refreshRules().catch((error) =>
          console.warn("[DataProvider] Rules refresh failed:", error),
        );
        refreshRuleProviders().catch((error) =>
          console.warn("[DataProvider] Rule providers refresh failed:", error),
        );
      }, 200);
    };

    const handleRefreshClash = () => {
      const now = Date.now();
      if (now - lastUpdateTime <= refreshThrottle) return;

      lastUpdateTime = now;
      // 配置重载后需要重新触发 url-test/fallback 组的测速，以更新当前节点
      hasTriggeredStartupFallback.current = false;
      scheduleTimeout(async () => {
        await Promise.all([
          refreshProxy().catch((error) =>
            console.error("[DataProvider] Proxy refresh failed:", error),
          ),
          refreshClashConfig().catch((error) =>
            console.error("[DataProvider] Clash config refresh failed:", error),
          ),
        ]);
      }, 200);
    };

    const handleRefreshProxy = () => {
      const now = Date.now();
      if (now - lastUpdateTime <= refreshThrottle) return;

      lastUpdateTime = now;
      // 该事件由托盘切换节点成功时发出，标记为手动选择以抑制 fallback 切换通知
      markManualProxySelectionStarted();
      scheduleTimeout(() => {
        refreshProxy().catch((error) =>
          console.warn("[DataProvider] Proxy refresh failed:", error),
        );
      }, 200);
    };

    const initializeListeners = async () => {
      try {
        const unlistenProfile = await listen<string>(
          "profile-changed",
          handleProfileChanged,
        );
        registerCleanup(unlistenProfile);
      } catch (error) {
        console.error("[AppDataProvider] 监听 Profile 事件失败:", error);
      }

      try {
        const unlistenClash = await listen(
          "verge://refresh-clash-config",
          handleRefreshClash,
        );
        const unlistenProxy = await listen(
          "verge://refresh-proxy-config",
          handleRefreshProxy,
        );

        registerCleanup(() => {
          unlistenClash();
          unlistenProxy();
        });
      } catch (error) {
        console.warn("[AppDataProvider] 设置 Tauri 事件监听器失败:", error);

        const fallbackHandlers: Array<[string, EventListener]> = [
          ["verge://refresh-clash-config", handleRefreshClash],
          ["verge://refresh-proxy-config", handleRefreshProxy],
        ];

        fallbackHandlers.forEach(([eventName, handler]) => {
          registerCleanup(addWindowListener(eventName, handler));
        });
      }
    };

    void initializeListeners();

    return () => {
      isUnmounted = true;
      clearAllTimeouts();

      const errors: Error[] = [];
      cleanupFns.splice(0).forEach((fn) => {
        try {
          fn();
        } catch (error) {
          errors.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });

      if (errors.length > 0) {
        console.error(
          `[DataProvider] ${errors.length} errors during cleanup:`,
          errors,
        );
      }
    };
  }, [refreshProxy, refreshClashConfig, refreshRules, refreshRuleProviders]);

  const { data: sysproxy, mutate: refreshSysproxy } = useSWR(
    "getSystemProxy",
    getSystemProxy,
    SWR_DEFAULTS,
  );

  const { data: runningMode } = useSWR(
    "getRunningMode",
    getRunningMode,
    SWR_DEFAULTS,
  );

  const { data: uptimeData } = useSWR("appUptime", getAppUptime, {
    ...SWR_DEFAULTS,
    refreshInterval: 3000,
    errorRetryCount: 1,
  });

  // 提供统一的刷新方法
  const refreshAll = useCallback(async () => {
    await Promise.all([
      refreshProxy(),
      refreshClashConfig(),
      refreshRules(),
      refreshSysproxy(),
      refreshProxyProviders(),
      refreshRuleProviders(),
    ]);
  }, [
    refreshProxy,
    refreshClashConfig,
    refreshRules,
    refreshSysproxy,
    refreshProxyProviders,
    refreshRuleProviders,
  ]);

  // 聚合所有数据
  const value = useMemo(() => {
    // 计算系统代理地址
    const calculateSystemProxyAddress = () => {
      if (!verge || !clashConfig) return "-";

      const isPacMode = verge.proxy_auto_config ?? false;

      if (isPacMode) {
        // PAC模式：显示我们期望设置的代理地址
        const proxyHost = verge.proxy_host || "127.0.0.1";
        const proxyPort =
          verge.verge_mixed_port || clashConfig.mixedPort || 7897;
        return `${proxyHost}:${proxyPort}`;
      } else {
        // HTTP代理模式：优先使用系统地址，但如果格式不正确则使用期望地址
        const systemServer = sysproxy?.server;
        if (
          systemServer &&
          systemServer !== "-" &&
          !systemServer.startsWith(":")
        ) {
          return systemServer;
        } else {
          // 系统地址无效，返回期望的代理地址
          const proxyHost = verge.proxy_host || "127.0.0.1";
          const proxyPort =
            verge.verge_mixed_port || clashConfig.mixedPort || 7897;
          return `${proxyHost}:${proxyPort}`;
        }
      }
    };

    return {
      // 数据
      proxies: proxiesData,
      clashConfig,
      rules: rulesData?.rules || [],
      sysproxy,
      runningMode,
      uptime: uptimeData || 0,

      // 提供者数据
      proxyProviders: proxyProviders || {},
      ruleProviders: ruleProviders?.providers || {},

      systemProxyAddress: calculateSystemProxyAddress(),

      // 刷新方法
      refreshProxy,
      refreshClashConfig,
      refreshRules,
      refreshSysproxy,
      refreshProxyProviders,
      refreshRuleProviders,
      refreshAll,
    } as AppDataContextType;
  }, [
    proxiesData,
    clashConfig,
    rulesData,
    sysproxy,
    runningMode,
    uptimeData,
    proxyProviders,
    ruleProviders,
    verge,
    refreshProxy,
    refreshClashConfig,
    refreshRules,
    refreshSysproxy,
    refreshProxyProviders,
    refreshRuleProviders,
    refreshAll,
  ]);

  return <AppDataContext value={value}>{children}</AppDataContext>;
};
