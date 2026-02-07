import { useRef } from "react";
import { mutate } from "swr";
import { MihomoWebSocket } from "tauri-plugin-mihomo-api";

import { useConnectionSetting } from "./use-connection-setting";
import { registerProcessPath } from "./use-process-icon";
import { useMihomoWsSubscription } from "./use-mihomo-ws-subscription";

const DEFAULT_CLOSED_RETENTION_HOURS = 8;

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

/** 按保留时间（小时）过滤已关闭连接：只保留关闭时间在 retentionHours 内的 */
const filterClosedConnectionsByRetention = (
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
  retentionHours: number = DEFAULT_CLOSED_RETENTION_HOURS,
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

  const closedConnections = filterClosedConnectionsByRetention(
    [...(previous.closedConnections ?? []), ...newlyClosed],
    retentionHours,
  );

  return {
    uploadTotal: payload.uploadTotal ?? 0,
    downloadTotal: payload.downloadTotal ?? 0,
    activeConnections,
    closedConnections,
  };
};

export const useConnectionData = () => {
  const [setting] = useConnectionSetting();
  const retentionHours = setting?.closedConnectionsRetentionHours ?? DEFAULT_CLOSED_RETENTION_HOURS;
  const retentionHoursRef = useRef(retentionHours);
  retentionHoursRef.current = retentionHours;

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
              mergeConnectionSnapshot(
                parsed,
                old,
                retentionHoursRef.current ?? DEFAULT_CLOSED_RETENTION_HOURS,
              ),
            );
          } catch (error) {
            next(error);
          }
        },
      }),
    });

  const clearClosedConnections = () => {
    if (!subscriptionCacheKey) return;
    mutate(subscriptionCacheKey, {
      uploadTotal: response.data?.uploadTotal ?? 0,
      downloadTotal: response.data?.downloadTotal ?? 0,
      activeConnections: response.data?.activeConnections ?? [],
      closedConnections: [],
    });
  };

  return {
    response,
    refreshGetClashConnection: refresh,
    clearClosedConnections,
  };
};
