import { useEffect, useRef, useState } from "react";
import { mutate } from "swr";
import { MihomoWebSocket } from "tauri-plugin-mihomo-api";

import {
  getClosedConnectionsFromStorage,
  getConnectionSnapshot,
  setClosedConnectionsInStorage,
  setConnectionSnapshot,
} from "@/utils/closed-connections-storage";
import {
  compactRejectClosed,
  upsertRejectClosed,
} from "@/utils/reject-closed-dedupe";

import { registerProcessPath } from "./use-process-icon";
import { useMihomoWsSubscription } from "./use-mihomo-ws-subscription";
import { useVerge } from "./use-verge";
import {
  DEFAULT_CLOSED_CONNECTIONS_LIMIT,
  type ClosedConnectionsLimit,
  useConnectionSetting,
} from "./use-connection-setting";

const EMPTY_SNAPSHOT_GRACE_MS = 1200;

/** 当前生效的已关闭条数上限（由设置同步，供 WS merge 路径使用） */
let activeClosedConnectionsLimit: number = DEFAULT_CLOSED_CONNECTIONS_LIMIT;

export const setActiveClosedConnectionsLimit = (limit: number) => {
  activeClosedConnectionsLimit = limit;
};

export const getActiveClosedConnectionsLimit = () =>
  activeClosedConnectionsLimit;

let currentSessionStartMs = Date.now();
let globalTrafficBaseline: {
  uploadTotal: number;
  downloadTotal: number;
} | null = null;
const sessionListeners = new Set<(sessionStartMs: number) => void>();

export const resetConnectionTrafficSession = () => {
  const nextSessionStartMs = Date.now();
  currentSessionStartMs = nextSessionStartMs;
  globalTrafficBaseline = null;
  sessionListeners.forEach((listener) => listener(nextSessionStartMs));
};

export const initConnData: ConnectionMonitorData = {
  uploadTotal: 0,
  downloadTotal: 0,
  activeConnections: [],
  closedConnections: [],
};
// 跨页面保留最近一次稳定连接数据，避免路由切回时先闪回空状态。
let latestStableConnData: ConnectionMonitorData = initConnData;

export interface ConnectionMonitorData {
  uploadTotal: number;
  downloadTotal: number;
  activeConnections: IConnectionsItem[];
  closedConnections: IConnectionsItem[];
}

export type { NonDirectSessionTraffic } from "@/utils/non-direct-session-traffic";
export { computeNonDirectSessionTraffic } from "@/utils/non-direct-session-traffic";

/** 按 id 去重，保留较新的 closedAt */
const dedupeClosedConnectionsById = (
  items: IConnectionsItem[],
): IConnectionsItem[] => {
  const map = new Map<string, IConnectionsItem>();
  for (const item of items) {
    const closedAt = item.closedAt ?? new Date(item.start || 0).getTime();
    const existing = map.get(item.id);
    const existingClosedAt =
      existing?.closedAt ?? new Date(existing?.start || 0).getTime();
    if (!existing || closedAt >= existingClosedAt) {
      map.set(item.id, { ...item, closedAt });
    }
  }
  return Array.from(map.values());
};

const normalizeRecentClosedFromPayload = (
  payload: IConnections,
  activeIds: Set<string>,
  knownClosedIds: Set<string>,
): IConnectionsItem[] => {
  const seen = new Set<string>();
  return (payload.recentClosed ?? [])
    .filter((conn) => {
      if (!conn.id || activeIds.has(conn.id) || knownClosedIds.has(conn.id)) {
        return false;
      }
      if (seen.has(conn.id)) return false;
      seen.add(conn.id);
      return true;
    })
    .map(
      (conn) =>
        ({
          ...conn,
          closedAt: conn.closedAt ?? Date.now(),
        }) as IConnectionsItem,
    );
};

/** 超出条数上限时只保留 closedAt 最新的 max 条 */
export const trimClosedConnectionsByMaxCount = (
  closedConnections: IConnectionsItem[],
  max: number = DEFAULT_CLOSED_CONNECTIONS_LIMIT,
): IConnectionsItem[] => {
  if (closedConnections.length <= max) return closedConnections;
  return [...closedConnections]
    .sort((a, b) => {
      const aAt = a.closedAt ?? new Date(a.start || 0).getTime();
      const bAt = b.closedAt ?? new Date(b.start || 0).getTime();
      return bAt - aAt;
    })
    .slice(0, max);
};

const mergeConnectionSnapshot = (
  payload: IConnections,
  previous: ConnectionMonitorData = initConnData,
): ConnectionMonitorData => {
  const nextConnections = payload.connections ?? [];
  const previousActive = previous.activeConnections ?? [];
  const nextById = new Map(nextConnections.map((conn) => [conn.id, conn]));
  const now = Date.now();

  // Register process name to path mappings for log icon display
  nextConnections.forEach((conn) => {
    const { process, processPath } = conn.metadata;
    if (process && processPath) {
      registerProcessPath(process, processPath);
    }
  });
  const newIds = new Set(nextConnections.map((conn) => conn.id));

  // Keep surviving connections in their previous relative order to reduce row reshuffle,
  // but constrain the array to the incoming snapshot length.
  const carried = previousActive
    .map((prev) => {
      const next = nextById.get(prev.id);
      if (!next) return null;

      nextById.delete(prev.id);
      return {
        ...next,
        curUpload: next.upload - prev.upload,
        curDownload: next.download - prev.download,
      } as IConnectionsItem;
    })
    .filter(Boolean) as IConnectionsItem[];

  const newcomers = nextConnections
    .filter((conn) => nextById.has(conn.id))
    .map((conn) => ({
      ...conn,
      curUpload: 0,
      curDownload: 0,
    }));

  const activeConnections = [...carried, ...newcomers];

  const newlyClosed = previousActive
    .filter((conn) => !newIds.has(conn.id))
    .map((conn) => ({ ...conn, closedAt: now } as IConnectionsItem));

  const previousClosed = previous.closedConnections ?? [];
  const knownClosedIds = new Set(previousClosed.map((conn) => conn.id));
  const fromRecentClosed = normalizeRecentClosedFromPayload(
    payload,
    newIds,
    knownClosedIds,
  );

  let closedAcc: IConnectionsItem[] = [...previousClosed];
  for (const conn of newlyClosed) {
    closedAcc = upsertRejectClosed(closedAcc, conn);
  }
  for (const conn of fromRecentClosed) {
    closedAcc = upsertRejectClosed(closedAcc, conn);
  }

  // 仅按条数上限裁剪（无时间限制）；上限由用户设置同步到 activeClosedConnectionsLimit
  const closedConnections = trimClosedConnectionsByMaxCount(
    dedupeClosedConnectionsById(closedAcc),
    activeClosedConnectionsLimit,
  );
  // 仅当最终列表内容变化时才调度写盘（写盘侧另有节流）
  const closedChanged =
    closedConnections.length !== previousClosed.length ||
    closedConnections.some(
      (conn, index) =>
        previousClosed[index]?.id !== conn.id ||
        previousClosed[index]?.closedAt !== conn.closedAt,
    );
  if (closedChanged) {
    void setClosedConnectionsInStorage(closedConnections);
  }

  return {
    uploadTotal: payload.uploadTotal ?? 0,
    downloadTotal: payload.downloadTotal ?? 0,
    activeConnections,
    closedConnections,
  };
};

export const useConnectionData = () => {
  const { verge } = useVerge();
  const tunEnabled = verge?.enable_tun_mode ?? false;
  const [setting] = useConnectionSetting();
  const closedLimit: ClosedConnectionsLimit =
    setting?.closedConnectionsLimit ?? DEFAULT_CLOSED_CONNECTIONS_LIMIT;

  /**
   * sessionStartMs marks the beginning of the "current traffic session".
   * Kept at module scope so route switches won't reset it.
   * Resets whenever TUN mode is toggled.
   * Used by consumers (e.g. the connections page) to exclude per-connection
   * upload/download values that accumulated before this point.
   */
  const [sessionStartMs, setSessionStartMs] = useState(currentSessionStartMs);
  const prevTunEnabledRef = useRef(tunEnabled);
  const emptySnapshotStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    sessionListeners.add(setSessionStartMs);
    return () => {
      sessionListeners.delete(setSessionStartMs);
    };
  }, []);

  useEffect(() => {
    setActiveClosedConnectionsLimit(closedLimit);
  }, [closedLimit]);

  useEffect(() => {
    if (prevTunEnabledRef.current !== tunEnabled) {
      prevTunEnabledRef.current = tunEnabled;
      resetConnectionTrafficSession();
    }
  }, [tunEnabled]);

  /**
   * traffic baseline: the raw core cumulative totals at the moment
   * this session started. Subtracted from live totals so that the home-page
   * upload/download stats also start from 0 each session.
   * Resets on TUN toggle (via sessionStartMs dependency).
   */
  const normalizeTotals = (data: ConnectionMonitorData): ConnectionMonitorData => {
    const baseline = globalTrafficBaseline;
    if (!baseline) {
      globalTrafficBaseline = {
        uploadTotal: data.uploadTotal,
        downloadTotal: data.downloadTotal,
      };
      return { ...data, uploadTotal: 0, downloadTotal: 0 };
    }
    return {
      ...data,
      uploadTotal: Math.max(0, data.uploadTotal - baseline.uploadTotal),
      downloadTotal: Math.max(0, data.downloadTotal - baseline.downloadTotal),
    };
  };

  const { response, refresh, subscriptionCacheKey } =
    useMihomoWsSubscription<ConnectionMonitorData>({
      storageKey: "mihomo_connection_date",
      buildSubscriptKey: (date) => `getClashConnection-${date}`,
      fallbackData: latestStableConnData,
      connect: () => MihomoWebSocket.connect_connections(),
      setupHandlers: ({ next, scheduleReconnect }) => ({
        handleMessage: (data) => {
          if (data.startsWith("Websocket error")) {
            next(data);
            void scheduleReconnect();
            return;
          }

          try {
            const parsed = JSON.parse(data) as IConnections;
            const nextConnections = parsed.connections ?? [];
            next(null, (old = initConnData) => {
              // 部分环境下重连后会短暂收到空 connections 快照，容易导致连接页闪空。
              // 这里给一个短暂宽限期，连续空快照超过阈值才认定为真实空列表。
              if (nextConnections.length === 0 && (old.activeConnections?.length ?? 0) > 0) {
                const now = Date.now();
                if (emptySnapshotStartedAtRef.current == null) {
                  emptySnapshotStartedAtRef.current = now;
                  return old;
                }
                if (now - emptySnapshotStartedAtRef.current < EMPTY_SNAPSHOT_GRACE_MS) {
                  return old;
                }
              } else {
                emptySnapshotStartedAtRef.current = null;
              }

              return normalizeTotals(mergeConnectionSnapshot(parsed, old));
            },
            );
          } catch (error) {
            next(error);
          }
        },
      }),
    });

  // 重新进入连接页时从 IndexedDB 恢复上次快照（活跃+已关闭），避免列表空白；若无快照则仅恢复已关闭列表
  useEffect(() => {
    if (!subscriptionCacheKey) return;
    getConnectionSnapshot()
      .then((snapshot) => {
        if (snapshot && (snapshot.activeConnections?.length > 0 || snapshot.closedConnections?.length > 0)) {
          const closed = trimClosedConnectionsByMaxCount(
            compactRejectClosed(snapshot.closedConnections ?? []),
            activeClosedConnectionsLimit,
          );
          const next = { ...snapshot, closedConnections: closed };
          latestStableConnData = next;
          mutate(subscriptionCacheKey, next, { revalidate: false });
          return;
        }
        return getClosedConnectionsFromStorage();
      })
      .then((raw) => {
        if (!raw || !Array.isArray(raw)) return;
        const closed = trimClosedConnectionsByMaxCount(
          compactRejectClosed(raw),
          activeClosedConnectionsLimit,
        );
        if (closed.length === 0) return;
        mutate(
          subscriptionCacheKey,
          (prev: ConnectionMonitorData | undefined) => {
            const current = prev ?? initConnData;
            if ((current.closedConnections?.length ?? 0) > 0) return current;
            const next = { ...current, closedConnections: closed };
            latestStableConnData = next;
            return next;
          },
          { revalidate: false },
        );
      })
      .catch(() => { });
  }, [subscriptionCacheKey]);

  // 用户调低条数上限时，立即裁剪内存与落盘
  useEffect(() => {
    if (!subscriptionCacheKey) return;
    mutate(
      subscriptionCacheKey,
      (prev: ConnectionMonitorData | undefined) => {
        const current = prev ?? latestStableConnData;
        const closed = trimClosedConnectionsByMaxCount(
          current.closedConnections ?? [],
          closedLimit,
        );
        if (closed.length === (current.closedConnections?.length ?? 0)) {
          return current;
        }
        const next = { ...current, closedConnections: closed };
        latestStableConnData = next;
        void setClosedConnectionsInStorage(closed);
        setConnectionSnapshot(next);
        return next;
      },
      { revalidate: false },
    );
  }, [closedLimit, subscriptionCacheKey]);

  // 有连接数据时调度完整快照落盘（IndexedDB 侧节流，避免每秒写入数十 MB）
  useEffect(() => {
    const data = response.data;
    if (!data) return;
    latestStableConnData = data;
    if (
      data.activeConnections?.length > 0 ||
      data.closedConnections?.length > 0
    ) {
      setConnectionSnapshot(data);
    }
  }, [response.data]);

  const clearClosedConnections = () => {
    if (!subscriptionCacheKey) return;
    const next = {
      uploadTotal: response.data?.uploadTotal ?? 0,
      downloadTotal: response.data?.downloadTotal ?? 0,
      activeConnections: response.data?.activeConnections ?? [],
      closedConnections: [],
    };
    latestStableConnData = next;
    mutate(subscriptionCacheKey, next);
    void setClosedConnectionsInStorage([], { immediate: true });
    setConnectionSnapshot(next, { immediate: true });
  };

  return {
    response,
    refreshGetClashConnection: refresh,
    clearClosedConnections,
    /** Timestamp (ms) marking the start of the current traffic session. Resets when TUN is toggled. */
    sessionStartMs,
  };
};
