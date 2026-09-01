import useSWR from "swr";

import { getRunningMode, isAdmin, isServiceAvailable } from "@/services/cmds";

export interface SystemState {
  runningMode: "Sidecar" | "Service";
  isAdminMode: boolean;
  isServiceOk: boolean;
}

const defaultSystemState = {
  runningMode: "Sidecar",
  isAdminMode: false,
  isServiceOk: false,
} as SystemState;

/**
 * 自定义 hook 用于获取系统运行状态
 * 包括运行模式、管理员状态、系统服务是否可用
 */
export function useSystemState() {
  const {
    data: systemState,
    mutate: mutateSystemState,
    isLoading,
  } = useSWR(
    "getSystemState",
    async () => {
      const [runningMode, isAdminMode, isServiceOk] = await Promise.all([
        getRunningMode(),
        isAdmin(),
        isServiceAvailable(),
      ]);
      return { runningMode, isAdminMode, isServiceOk } as SystemState;
    },
    {
      suspense: true,
      refreshInterval: 30000,
      fallback: defaultSystemState,
    },
  );

  const isSidecarMode = systemState.runningMode === "Sidecar";
  const isServiceMode = systemState.runningMode === "Service";
  const isTunModeAvailable = systemState.isAdminMode || systemState.isServiceOk;

  return {
    runningMode: systemState.runningMode,
    isAdminMode: systemState.isAdminMode,
    isServiceOk: systemState.isServiceOk,
    isSidecarMode,
    isServiceMode,
    isTunModeAvailable,
    mutateSystemState,
    isLoading,
  };
}
