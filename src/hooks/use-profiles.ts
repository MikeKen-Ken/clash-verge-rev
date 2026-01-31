import useSWR, { mutate } from "swr";
import { selectNodeForGroup } from "tauri-plugin-mihomo-api";

import {
  getProfiles,
  patchProfile,
  patchProfilesConfig,
} from "@/services/cmds";
import { calcuProxies } from "@/services/cmds";
import { debugLog } from "@/utils/debug";

export const useProfiles = () => {
  const {
    data: profiles,
    mutate: mutateProfiles,
    error,
    isValidating,
  } = useSWR("getProfiles", getProfiles, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 500, // 减少去重时间，提高响应性
    errorRetryCount: 3,
    errorRetryInterval: 1000,
    refreshInterval: 0, // 完全由手动控制
    onError: (error) => {
      console.error("[useProfiles] SWR错误:", error);
    },
    onSuccess: (data) => {
      debugLog(
        "[useProfiles] 配置数据更新成功，配置数量:",
        data?.items?.length || 0,
      );
    },
  });

  const patchProfiles = async (
    value: Partial<IProfilesConfig>,
    signal?: AbortSignal,
  ) => {
    try {
      if (signal?.aborted) {
        throw new DOMException("Operation was aborted", "AbortError");
      }
      const success = await patchProfilesConfig(value);

      if (signal?.aborted) {
        throw new DOMException("Operation was aborted", "AbortError");
      }

      await mutateProfiles();

      return success;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }

      await mutateProfiles();
      throw error;
    }
  };

  const patchCurrent = async (value: Partial<IProfileItem>) => {
    if (profiles?.current) {
      await patchProfile(profiles.current, value);
      if (!value.selected) {
        mutateProfiles();
      }
    }
  };

  // 重新打开代理时清空手动选择，界面不显示「当前节点」；仅当用户手动选择后才显示
  const activateSelected = async () => {
    try {
      debugLog("[ActivateSelected] 清空该 profile 的手动选择（重新打开代理）");

      const profileData = await getProfiles();
      if (!profileData?.current) {
        debugLog("[ActivateSelected] 无当前 profile，跳过");
        return;
      }

      await patchProfile(profileData.current, { selected: [] });
      debugLog("[ActivateSelected] 已清空 selected");
      mutateProfiles();
      setTimeout(() => {
        mutate("getProxies", calcuProxies());
      }, 100);
    } catch (error: any) {
      console.error("[ActivateSelected] 清空选择失败:", error.message);
    }
  };

  return {
    profiles,
    current: profiles?.items?.find((p) => p && p.uid === profiles.current),
    activateSelected,
    patchProfiles,
    patchCurrent,
    mutateProfiles,
    // 新增故障检测状态
    isLoading: isValidating,
    error,
    isStale: !profiles && !error && !isValidating, // 检测是否处于异常状态
  };
};
