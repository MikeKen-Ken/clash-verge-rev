import useSWR, { SWRConfiguration } from "swr";

import {
  checkForkUpdate,
  type ForkUpdateInfo,
} from "@/services/fork-update";

export type UpdateInfo = ForkUpdateInfo;

/**
 * 仅手动触发检查更新。
 * 默认不自动请求；调用 checkUpdate() 时才会拉取清单。
 *
 * checkUpdate 直接调用 checkForkUpdate，避免 SWR mutate 在异常/空缓存时
 * 返回 undefined 被调用方误判为「已是最新」。
 */
export const useUpdate = (
  _enabled: boolean = false,
  options?: SWRConfiguration,
) => {
  const {
    data: updateInfo,
    mutate,
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

  const checkUpdate = async (): Promise<UpdateInfo | null> => {
    const result = await checkForkUpdate();
    // 同步缓存；不触发二次请求
    await mutate(result, { revalidate: false, populateCache: true });
    return result;
  };

  return {
    updateInfo,
    checkUpdate,
    loading: isValidating,
  };
};