import { useCallback } from "react";

import { reinstallService, restartCore, stopCore } from "@/services/cmds";
import { showNotice } from "@/services/notice-service";

import { useSystemState } from "./use-system-state";

const executeWithErrorHandling = async (
  operation: () => Promise<void>,
  loadingMessage: string,
  successMessage?: string,
) => {
  try {
    showNotice.info(loadingMessage);
    await operation();
    if (successMessage) {
      showNotice.success(successMessage);
    }
  } catch (err) {
    showNotice.error(err);
    throw err;
  }
};

export const useServiceReinstaller = () => {
  const { mutateSystemState } = useSystemState();

  const reinstallServiceAndRestartCore = useCallback(async () => {
    try {
      await executeWithErrorHandling(
        () => stopCore(),
        "正在停止核心...",
      );
      await executeWithErrorHandling(
        () => reinstallService(),
        "正在重新安装服务...",
        "已成功重新安装服务",
      );
    } catch (ignore) {
    } finally {
      await executeWithErrorHandling(
        () => restartCore(),
        "settings.statuses.clash.restarting",
        "settings.feedback.notifications.clash.restartSuccess",
      );
      await mutateSystemState();
    }
  }, [mutateSystemState]);

  return { reinstallServiceAndRestartCore };
};
