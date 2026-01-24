import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef, useState } from "react";

// 全局图标缓存，避免重复请求
const iconCache = new Map<string, string | null>();
// 正在请求中的 Promise 缓存，避免重复请求
const pendingRequests = new Map<string, Promise<string | null>>();
// 进程名到进程路径的映射缓存
const processNameToPathCache = new Map<string, string>();

/**
 * Register a process name to path mapping
 * Called when connection data is received
 */
export const registerProcessPath = (processName: string, processPath: string) => {
  if (processName && processPath) {
    // 使用进程名（不区分大小写）作为 key
    processNameToPathCache.set(processName.toLowerCase(), processPath);
  }
};

/**
 * Get process path by process name
 */
export const getProcessPathByName = (processName: string): string | undefined => {
  if (!processName) return undefined;
  return processNameToPathCache.get(processName.toLowerCase());
};

/**
 * Hook to get process icon from executable path
 * Uses caching to avoid repeated requests
 */
export const useProcessIcon = () => {
  const [, forceUpdate] = useState({});

  const getIcon = useCallback(async (processPath: string | undefined): Promise<string | null> => {
    if (!processPath) return null;

    // 检查缓存
    if (iconCache.has(processPath)) {
      return iconCache.get(processPath) ?? null;
    }

    // 检查是否已有请求在进行中
    if (pendingRequests.has(processPath)) {
      return pendingRequests.get(processPath)!;
    }

    // 创建新请求
    const request = invoke<string | null>("get_process_icon", { processPath })
      .then((icon) => {
        iconCache.set(processPath, icon);
        pendingRequests.delete(processPath);
        return icon;
      })
      .catch((err) => {
        console.warn(`Failed to get icon for ${processPath}:`, err);
        iconCache.set(processPath, null);
        pendingRequests.delete(processPath);
        return null;
      });

    pendingRequests.set(processPath, request);
    return request;
  }, []);

  return { getIcon };
};

/**
 * Synchronous hook to get cached process icon
 * Returns null if not cached, triggers fetch in background
 */
export const useProcessIconSync = (processPath: string | undefined) => {
  const [icon, setIcon] = useState<string | null>(() => {
    if (!processPath) return null;
    return iconCache.get(processPath) ?? null;
  });
  const fetchedRef = useRef(false);

  // 如果没有缓存，异步获取
  if (processPath && !iconCache.has(processPath) && !fetchedRef.current) {
    fetchedRef.current = true;

    // 检查是否已有请求在进行中
    if (!pendingRequests.has(processPath)) {
      const request = invoke<string | null>("get_process_icon", { processPath })
        .then((result) => {
          iconCache.set(processPath, result);
          pendingRequests.delete(processPath);
          setIcon(result);
          return result;
        })
        .catch((err) => {
          console.warn(`Failed to get icon for ${processPath}:`, err);
          iconCache.set(processPath, null);
          pendingRequests.delete(processPath);
          return null;
        });

      pendingRequests.set(processPath, request);
    } else {
      // 等待已有请求完成
      pendingRequests.get(processPath)!.then((result) => {
        setIcon(result);
      });
    }
  }

  return icon;
};

/**
 * Clear the icon cache
 */
export const clearProcessIconCache = () => {
  iconCache.clear();
};
