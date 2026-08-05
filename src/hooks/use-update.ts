import useSWR, { SWRConfiguration } from "swr";

import {
  checkForkUpdate,
  type ForkUpdateInfo,
} from "@/services/fork-update";

export type UpdateInfo = ForkUpdateInfo;

/**
 * 仅手动触发检查更新。
 * 默认不自动请求；调用 checkUpdate() 时才会拉取清单。
 */
export const useUpdate = (
  _enabled: boolean = false,
  options?: SWRConfiguration,
) => {
  const {
    data: updateInfo,
    mutate: checkUpdate,
    isValidating,
  } = useSWR("checkForkUpdate", checkForkUpdate, {
    errorRetryCount: 1,
    revalidateOnMount: false,
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    refreshInterval: 0,
    ...options,
  });

  return {
    updateInfo,
    checkUpdate,
    loading: isValidating,
  };
};
