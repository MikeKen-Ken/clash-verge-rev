import type { ReactNode } from "react";

import { useLogData } from "@/hooks/use-log-data";

import { LogDataContext } from "./log-data-context";

/**
 * 在主导航布局内常驻挂载日志 WebSocket，避免离开「日志」页后订阅被销毁导致漏记。
 */
export const LogDataProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const value = useLogData();
  return <LogDataContext value={value}>{children}</LogDataContext>;
};
