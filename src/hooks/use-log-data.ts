import dayjs from "dayjs";
import { useEffect, useRef } from "react";
import { mutate } from "swr";
import { MihomoWebSocket, type LogLevel } from "tauri-plugin-mihomo-api";

import { getClashLogs } from "@/services/cmds";

import { useClashLog } from "./use-clash-log";
import { useMihomoWsSubscription } from "./use-mihomo-ws-subscription";

/**
 * Extract process name from log payload.
 * Process name only appears as IP:port(processName), e.g. 198.18.0.1:52631(BaiduNetdisk.exe)
 * Must not match RuleSet(name) or other (...) that are not after :port.
 */
function extractProcessName(payload: string): string | undefined {
  if (!payload) return undefined;

  // Only match (processName) when preceded by :port so we don't match RuleSet(proxy) etc.
  const afterPort = /:\d+\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = afterPort.exec(payload)) !== null) {
    const inner = m[1];
    if (/\.exe$/i.test(inner)) return inner;
    if (/\.app$/i.test(inner)) return inner;
    if (
      inner.length > 2 &&
      /^[a-zA-Z0-9_.-]+$/.test(inner) &&
      !/^\d+$/.test(inner)
    ) {
      return inner;
    }
  }
  return undefined;
}

export const MAX_LOG_NUM = 3000;
const FLUSH_DELAY_MS = 50;
type LogType = ILogItem["type"];

const DEFAULT_LOG_TYPES: LogType[] = ["debug", "info", "warning", "error"];
const LOG_LEVEL_FILTERS: Record<LogLevel, LogType[]> = {
  debug: DEFAULT_LOG_TYPES,
  info: ["info", "warning", "error"],
  warning: ["warning", "error"],
  error: ["error"],
  silent: [],
};

const clampLogs = (logs: ILogItem[]): ILogItem[] =>
  logs.length > MAX_LOG_NUM ? logs.slice(-MAX_LOG_NUM) : logs;

const filterLogsByLevel = (
  logs: ILogItem[],
  allowedTypes: LogType[],
): ILogItem[] => {
  if (allowedTypes.length === 0) return [];
  if (allowedTypes.length === DEFAULT_LOG_TYPES.length) return logs;
  return logs.filter((log) => allowedTypes.includes(log.type));
};

const appendLogs = (
  current: ILogItem[] | undefined,
  incoming: ILogItem[],
): ILogItem[] => clampLogs([...(current ?? []), ...incoming]);

function logItemKey(item: ILogItem): string {
  return `${item.time ?? ""}\0${item.type}\0${item.payload}`;
}

/**
 * 合并文件快照与当前列表：避免 WebSocket 重连后 getClashLogs 返回空数组时把已有缓存清空。
 * 快照中已存在于 current 的条目跳过；其余按快照顺序前置。
 */
function mergeSnapshotIntoCurrent(
  current: ILogItem[] | undefined,
  snapshot: ILogItem[],
): ILogItem[] {
  const cur = Array.isArray(current) ? [...current] : [];
  if (snapshot.length === 0) {
    return cur;
  }
  if (cur.length === 0) {
    return snapshot;
  }
  const curKeys = new Set(cur.map(logItemKey));
  const prefix: ILogItem[] = [];
  for (const item of snapshot) {
    const k = logItemKey(item);
    if (!curKeys.has(k)) {
      curKeys.add(k);
      prefix.push(item);
    }
  }
  return clampLogs([...prefix, ...cur]);
}

export const useLogData = () => {
  const [clashLog] = useClashLog();
  const enableLog = clashLog.enable;
  const logLevel = clashLog.logLevel;
  const allowedTypes = LOG_LEVEL_FILTERS[logLevel] ?? DEFAULT_LOG_TYPES;

  const { response, refresh, subscriptionCacheKey } = useMihomoWsSubscription<
    ILogItem[]
  >({
    storageKey: "mihomo_logs_date",
    buildSubscriptKey: (date) => (enableLog ? `getClashLog-${date}` : null),
    fallbackData: [],
    keepPreviousData: true,
    connect: () => MihomoWebSocket.connect_logs(logLevel),
    setupHandlers: ({ next, scheduleReconnect, isMounted }) => {
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const buffer: ILogItem[] = [];

      const clearFlushTimer = () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
      };

      const flush = () => {
        if (!buffer.length || !isMounted()) {
          flushTimer = null;
          return;
        }
        const pendingLogs = buffer.splice(0, buffer.length);
        next(null, (current) => appendLogs(current, pendingLogs));
        flushTimer = null;
      };

      return {
        handleMessage: (data) => {
          if (data.startsWith("Websocket error")) {
            next(data);
            void scheduleReconnect();
            return;
          }

          try {
            const parsed = JSON.parse(data) as ILogItem;
            if (
              allowedTypes.length > 0 &&
              !allowedTypes.includes(parsed.type)
            ) {
              return;
            }
            parsed.time = dayjs().format("MM-DD HH:mm:ss");
            // Extract process name from payload if not already present
            if (!parsed.processName && parsed.payload) {
              parsed.processName = extractProcessName(parsed.payload);
            }
            buffer.push(parsed);
            if (!flushTimer) {
              flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
            }
          } catch (error) {
            next(error);
          }
        },
        async onConnected() {
          const logs = await getClashLogs();
          if (isMounted()) {
            const snapshot = clampLogs(filterLogsByLevel(logs, allowedTypes));
            next(null, (prev) => mergeSnapshotIntoCurrent(prev, snapshot));
          }
        },
        cleanup: clearFlushTimer,
      };
    },
  });

  const previousLogLevelRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!logLevel) {
      previousLogLevelRef.current = logLevel ?? undefined;
      return;
    }

    if (previousLogLevelRef.current === logLevel) {
      return;
    }

    previousLogLevelRef.current = logLevel;
    refresh();
  }, [logLevel, refresh]);

  const refreshGetClashLog = (clear = false) => {
    if (clear) {
      if (subscriptionCacheKey) {
        mutate(subscriptionCacheKey, []);
      }
    } else {
      refresh();
    }
  };

  return { response, refreshGetClashLog };
};
