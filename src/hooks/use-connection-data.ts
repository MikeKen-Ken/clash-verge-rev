import { useEffect } from "react";
import { mutate } from "swr";
import { MihomoWebSocket } from "tauri-plugin-mihomo-api";

import {
  getClosedConnectionsFromStorage,
  getConnectionSnapshot,
  setClosedConnectionsInStorage,
  setConnectionSnapshot,
} from "@/utils/closed-connections-storage";

import { registerProcessPath } from "./use-process-icon";
import { useMihomoWsSubscription } from "./use-mihomo-ws-subscription";

const DEFAULT_CLOSED_RETENTION_HOURS = 8;

/** 持久化保留时长（小时）：仅超过此时长或手动清除时才会从列表移除 */
const PERSIST_RETENTION_HOURS = 24;

export const initConnData: ConnectionMonitorData = {
  uploadTotal: 0,
  downloadTotal: 0,
  activeConnections: [],
  closedConnections: [],
};

export interface ConnectionMonitorData {
  uploadTotal: number;
  downloadTotal: number;
  activeConnections: IConnectionsItem[];
  closedConnections: IConnectionsItem[];
}

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

  // 持久化与内存中均按 24 小时保留；展示时由连接页按用户设置（1/3/8/24h）再过滤
  const closedConnections = filterClosedConnectionsByRetention(
    [...(previous.closedConnections ?? []), ...newlyClosed],
    PERSIST_RETENTION_HOURS,
  );
  void setClosedConnectionsInStorage(closedConnections);

  return {
    uploadTotal: payload.uploadTotal ?? 0,
    downloadTotal: payload.downloadTotal ?? 0,
    activeConnections,
    closedConnections,
  };
};

export const useConnectionData = () => {
  const { response, refresh, subscriptionCacheKey } =
    useMihomoWsSubscription<ConnectionMonitorData>({
      storageKey: "mihomo_connection_date",
      buildSubscriptKey: (date) => `getClashConnection-${date}`,
      fallbackData: initConnData,
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
            next(null, (old = initConnData) =>
              mergeConnectionSnapshot(parsed, old),
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
          mutate(subscriptionCacheKey, snapshot, { revalidate: false });
          return;
        }
        return getClosedConnectionsFromStorage();
      })
      .then((raw) => {
        if (!raw || !Array.isArray(raw)) return;
        const closed = filterClosedConnectionsByRetention(
          raw,
          PERSIST_RETENTION_HOURS,
        );
        if (closed.length === 0) return;
        mutate(
          subscriptionCacheKey,
          (prev: ConnectionMonitorData | undefined) => {
            const current = prev ?? initConnData;
            if ((current.closedConnections?.length ?? 0) > 0) return current;
            return { ...current, closedConnections: closed };
          },
          { revalidate: false },
        );
      })
      .catch(() => {});
  }, [subscriptionCacheKey]);

  // 有连接数据时持久化完整快照，供重新进入连接页时恢复
  useEffect(() => {
    const data = response.data;
    if (data && (data.activeConnections?.length > 0 || data.closedConnections?.length > 0)) {
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
    mutate(subscriptionCacheKey, next);
    void setClosedConnectionsInStorage([]);
    setConnectionSnapshot(next);
  };

  return {
    response,
    refreshGetClashConnection: refresh,
    clearClosedConnections,
  };
};
