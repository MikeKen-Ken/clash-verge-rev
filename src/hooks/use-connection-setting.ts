import { useLocalStorage } from "foxact/use-local-storage";

/** 已关闭连接保留时间（小时）可选值 */
export const CLOSED_CONNECTIONS_RETENTION_HOURS = [1, 3, 8, 24] as const;

const defaultConnectionSetting: IConnectionSetting = {
  layout: "table",
  closedConnectionsRetentionHours: 8,
};

/** 迁移旧设置：原 closedConnectionsLimit 转为 retentionHours（可选） */
const migrateSetting = (raw: unknown): IConnectionSetting => {
  const o = raw as IConnectionSetting | undefined;
  if (!o) return defaultConnectionSetting;
  if ("closedConnectionsLimit" in o && o.closedConnectionsLimit != null) {
    const { closedConnectionsLimit, ...rest } = o;
    const map: Record<number, 1 | 3 | 8 | 24> = {
      500: 1, 1000: 3, 3000: 8, 5000: 24,
    };
    return {
      ...rest,
      closedConnectionsRetentionHours: map[closedConnectionsLimit as number] ?? 8,
    };
  }
  return o;
};

export const useConnectionSetting = () =>
  useLocalStorage<IConnectionSetting>(
    "connections-setting",
    defaultConnectionSetting,
    {
      serializer: JSON.stringify,
      deserializer: (v: string) => migrateSetting(JSON.parse(v)),
    },
  );
