import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

// 缓存上限：依赖连接活跃度，按经验值给出，避免长时间运行后无界增长。
// 图标缓存内容（base64）较大，上限相对小一些；路径映射条目轻量，可放宽。
const MAX_ICON_CACHE_ENTRIES = 512;
const MAX_PROCESS_PATH_CACHE_ENTRIES = 1024;

/**
 * 以 LRU 语义写入 Map：
 * - 已存在则删除后重新插入（移到末尾）；
 * - 超出上限时删除最旧条目（Map 迭代器按插入顺序）。
 */
const lruSet = <V>(
  map: Map<string, V>,
  key: string,
  value: V,
  max: number,
) => {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > max) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    map.delete(oldestKey);
  }
};

/** 以 LRU 语义读取（命中后将该项重新插入到末尾） */
const lruGet = <V>(map: Map<string, V>, key: string): V | undefined => {
  if (!map.has(key)) {
    return undefined;
  }
  const value = map.get(key) as V;
  map.delete(key);
  map.set(key, value);
  return value;
};

// 全局图标缓存，避免重复请求 (key: processPath)
const iconCache = new Map<string, string | null>();
// 进程名图标缓存 (key: processName)
const iconByNameCache = new Map<string, string | null>();
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
    // 使用进程名（不区分大小写）作为 key，并以 LRU 限制总条目数
    lruSet(
      processNameToPathCache,
      processName.toLowerCase(),
      processPath,
      MAX_PROCESS_PATH_CACHE_ENTRIES,
    );
  }
};

/**
 * Get process path by process name
 */
export const getProcessPathByName = (processName: string): string | undefined => {
  if (!processName) return undefined;
  return lruGet(processNameToPathCache, processName.toLowerCase());
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
        lruSet(iconCache, processPath, icon, MAX_ICON_CACHE_ENTRIES);
        pendingRequests.delete(processPath);
        return icon;
      })
      .catch((err) => {
        console.warn(`Failed to get icon for ${processPath}:`, err);
        lruSet(iconCache, processPath, null, MAX_ICON_CACHE_ENTRIES);
        pendingRequests.delete(processPath);
        return null;
      });

    pendingRequests.set(processPath, request);
    return request;
  }, []);

  return { getIcon };
};

const cachedIcon = (
  cache: Map<string, string | null>,
  key: string | undefined,
): string | null => {
  if (!key || !cache.has(key)) return null;
  return cache.get(key) ?? null;
};

/**
 * 列表行会被复用。图标必须跟着当前 key 走，不能停在这一行第一次取到的图上。
 */
const useTrackedIcon = (
  cache: Map<string, string | null>,
  cacheKey: string | undefined,
  requestKey: string | undefined,
  load: () => Promise<string | null>,
) => {
  const [icon, setIcon] = useState<string | null>(() => cachedIcon(cache, cacheKey));
  const [seenKey, setSeenKey] = useState(cacheKey);

  if (seenKey !== cacheKey) {
    setSeenKey(cacheKey);
    setIcon(cachedIcon(cache, cacheKey));
  }

  useEffect(() => {
    if (!cacheKey || !requestKey) return;
    if (cache.has(cacheKey)) {
      setIcon(cache.get(cacheKey) ?? null);
      return;
    }

    let cancelled = false;
    const apply = (result: string | null) => {
      lruSet(cache, cacheKey, result, MAX_ICON_CACHE_ENTRIES);
      pendingRequests.delete(requestKey);
      if (!cancelled) setIcon(result);
      return result;
    };

    const existing = pendingRequests.get(requestKey);
    if (existing) {
      void existing.then((result) => {
        if (!cancelled) setIcon(result);
      });
    } else {
      const request = load()
        .then(apply)
        .catch((err) => {
          console.warn(`Failed to get icon for ${cacheKey}:`, err);
          return apply(null);
        });
      pendingRequests.set(requestKey, request);
    }

    return () => {
      cancelled = true;
    };
  }, [cache, cacheKey, load, requestKey]);

  return icon;
};

/**
 * Synchronous hook to get cached process icon.
 * Returns null if not cached, triggers fetch in background.
 */
export const useProcessIconSync = (processPath: string | undefined) => {
  const load = useCallback(
    () => invoke<string | null>("get_process_icon", { processPath }),
    [processPath],
  );
  return useTrackedIcon(iconCache, processPath, processPath, load);
};

/**
 * Synchronous hook to get cached process icon by process name.
 * Uses a known executable path when connection data has already provided one.
 */
export const useProcessIconByNameSync = (processName: string | undefined) => {
  const key = processName?.toLowerCase();
  const load = useCallback(() => {
    const knownPath = key ? processNameToPathCache.get(key) : undefined;
    return knownPath
      ? invoke<string | null>("get_process_icon", { processPath: knownPath })
      : invoke<string | null>("get_process_icon_by_name", { processName });
  }, [key, processName]);
  return useTrackedIcon(
    iconByNameCache,
    key,
    key ? `name:${key}` : undefined,
    load,
  );
};

/**
 * Clear the icon cache
 */
export const clearProcessIconCache = () => {
  iconCache.clear();
  iconByNameCache.clear();
};
