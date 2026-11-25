import type { ReactNode } from "react";
import { useLocation } from "react-router";

import { useLogData } from "@/hooks/use-log-data";
import { useVisibility } from "@/hooks/use-visibility";

import { LogDataContext } from "./log-data-context";

/**
 * 在主导航布局内常驻挂载日志 WebSocket，避免离开「日志」页后订阅被销毁导致漏记。
 * 非日志页或窗口不可见时仅在内存中缓冲，切回 /logs 时再批量刷入 UI。
 */
export const LogDataProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const { pathname } = useLocation();
  const visible = useVisibility();
  const isActive = visible && pathname === "/logs";
  const value = useLogData(isActive);
  return <LogDataContext value={value}>{children}</LogDataContext>;
};
