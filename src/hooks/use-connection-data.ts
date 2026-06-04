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

const DEFAULT_CLOSED_RETENTION_HOURS = 8;
const EMPTY_SNAPSHOT_GRACE_MS = 1200;

/** 持久化保留时长（小时）：仅超过此时长或手动清除时才会从列表移除 */
const PERSIST_RETENTION_HOURS = 24;
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

/** 按保留时间（小时）过滤已关闭连接：只保留关闭时间在 retentionHours 内的（供展示与持久化使用） */
export const filterClosedConnectionsByRetention = (
  closedConnections: IConnectionsItem[],
  retentionHours: number = DEFAULT_CLOSED_RETENTION_HOURS,
): IConnectionsItem[] => {
  const now = Date.now();
  const maxAgeMs = retentionHours * 3600 * 1000;
  return closedConnections.filter((conn) => {
    const closedAt = conn.closedAt ?? new Date(conn.start || 0).getTime();
    return now - closedAt <= maxAgeMs;
  });
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

  // 持久化与内存中均按 24 小时保留；展示时由连接页按用户设置（1/3/8/24h）再过滤
  const closedConnections = filterClosedConnectionsByRetention(
    dedupeClosedConnectionsById(closedAcc),
    PERSIST_RETENTION_HOURS,
  );
  const closedChanged =
    newlyClosed.length > 0 ||
    fromRecentClosed.length > 0 ||
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
          latestStableConnData = snapshot;
          mutate(subscriptionCacheKey, snapshot, { revalidate: false });
          return;
        }
        return getClosedConnectionsFromStorage();
      })
      .then((raw) => {
        if (!raw || !Array.isArray(raw)) return;
        const closed = filterClosedConnectionsByRetention(
          compactRejectClosed(raw),
          PERSIST_RETENTION_HOURS,
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

  // 有连接数据时持久化完整快照，供重新进入连接页时恢复
  useEffect(() => {
    const data = response.data;
    if (data && (data.activeConnections?.length > 0 || data.closedConnections?.length > 0)) {
      latestStableConnData = data;
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
    void setClosedConnectionsInStorage([]);
    setConnectionSnapshot(next);
  };

  return {
    response,
    refreshGetClashConnection: refresh,
    clearClosedConnections,
    /** Timestamp (ms) marking the start of the current traffic session. Resets when TUN is toggled. */
    sessionStartMs,
  };
};
