import { useLocalStorage } from "foxact/use-local-storage";

/** 已关闭连接保留条数可选值 */
export const CLOSED_CONNECTIONS_LIMITS = [1000, 5000, 10000, 20000] as const;
export type ClosedConnectionsLimit = (typeof CLOSED_CONNECTIONS_LIMITS)[number];

export const DEFAULT_CLOSED_CONNECTIONS_LIMIT: ClosedConnectionsLimit = 5000;

const defaultConnectionSetting: IConnectionSetting = {
  layout: "table",
  closedConnectionsLimit: DEFAULT_CLOSED_CONNECTIONS_LIMIT,
  connectionsView: "connections",
};

const isValidLimit = (n: unknown): n is ClosedConnectionsLimit =>
  typeof n === "number" &&
  (CLOSED_CONNECTIONS_LIMITS as readonly number[]).includes(n);

/** 旧「小时保留」→ 条数上限 */
const hoursToLimit = (hours: number): ClosedConnectionsLimit => {
  const map: Record<number, ClosedConnectionsLimit> = {
    1: 1000,
    3: 5000,
    8: 10000,
    24: 20000,
  };
  return map[hours] ?? DEFAULT_CLOSED_CONNECTIONS_LIMIT;
};

/** 迁移旧设置：retentionHours / 旧 limit 数值 → 新 closedConnectionsLimit */
const migrateSetting = (raw: unknown): IConnectionSetting => {
  const o = raw as Record<string, unknown> | undefined;
  if (!o) return defaultConnectionSetting;

  let limit: ClosedConnectionsLimit | undefined;
  if (isValidLimit(o.closedConnectionsLimit)) {
    limit = o.closedConnectionsLimit;
  } else if (typeof o.closedConnectionsRetentionHours === "number") {
    limit = hoursToLimit(o.closedConnectionsRetentionHours);
  } else if (typeof o.closedConnectionsLimit === "number") {
    // 历史 500/1000/3000/5000 映射到最接近的新档位
    const legacy = o.closedConnectionsLimit;
    if (legacy <= 1000) limit = 1000;
    else if (legacy <= 5000) limit = 5000;
    else if (legacy <= 10000) limit = 10000;
    else limit = 20000;
  }

  const {
    closedConnectionsRetentionHours: _hours,
    ...rest
  } = o as IConnectionSetting & { closedConnectionsRetentionHours?: number };

  return {
    ...defaultConnectionSetting,
    ...rest,
    closedConnectionsLimit: limit ?? DEFAULT_CLOSED_CONNECTIONS_LIMIT,
    connectionsView:
      (o.connectionsView as IConnectionSetting["connectionsView"]) ??
      "connections",
  };
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
