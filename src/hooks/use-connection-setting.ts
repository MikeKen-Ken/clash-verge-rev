import { useLocalStorage } from "foxact/use-local-storage";

/** 已关闭连接保存数量可选值 */
export const CLOSED_CONNECTIONS_LIMIT_OPTIONS = [
  500, 1000, 3000, 5000,
] as const;

const defaultConnectionSetting: IConnectionSetting = {
  layout: "table",
  closedConnectionsLimit: 500,
};

export const useConnectionSetting = () =>
  useLocalStorage<IConnectionSetting>(
    "connections-setting",
    defaultConnectionSetting,
    {
      serializer: JSON.stringify,
      deserializer: JSON.parse,
    },
  );
