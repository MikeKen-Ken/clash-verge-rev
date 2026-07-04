/** 节点测速联通次数统计（localStorage 持久化） */
const STORAGE_KEY = "proxy.connectivityStats";

export interface ProxyConnectivityStats {
  success: number;
  failure: number;
}

type StatsStore = Record<string, ProxyConnectivityStats>;

let cachedStore: StatsStore | null = null;

function loadStore(): StatsStore {
  if (cachedStore) return cachedStore;
  if (typeof window === "undefined") {
    cachedStore = {};
    return cachedStore;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cachedStore = {};
      return cachedStore;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      cachedStore = {};
      return cachedStore;
    }
    cachedStore = parsed as StatsStore;
    return cachedStore;
  } catch {
    cachedStore = {};
    return cachedStore;
  }
}

function persistStore(store: StatsStore) {
  cachedStore = store;
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore localStorage failure
  }
}

function normalizeEntry(entry: ProxyConnectivityStats | undefined): ProxyConnectivityStats {
  return {
    success: Math.max(0, entry?.success ?? 0),
    failure: Math.max(0, entry?.failure ?? 0),
  };
}

export function getConnectivityStats(proxyName: string): ProxyConnectivityStats {
  if (!proxyName) return { success: 0, failure: 0 };
  const store = loadStore();
  return normalizeEntry(store[proxyName]);
}

export function getConnectivitySuccessCount(proxyName: string): number {
  return getConnectivityStats(proxyName).success;
}

/** 根据测速 delay 判定成功/失败并累加（与 UI 成功判定一致：0 < delay <= timeout） */
export function recordDelayTestResult(
  proxyName: string,
  delay: number,
  timeout: number,
): void {
  if (!proxyName || proxyName === "DIRECT" || proxyName === "REJECT") return;
  if (delay === -2 || delay === -1) return;

  const effectiveTimeout =
    Number.isFinite(timeout) && timeout > 0 ? timeout : 5000;
  const isSuccess = delay > 0 && delay <= effectiveTimeout;

  const store = { ...loadStore() };
  const prev = normalizeEntry(store[proxyName]);
  store[proxyName] = isSuccess
    ? { success: prev.success + 1, failure: prev.failure }
    : { success: prev.success, failure: prev.failure + 1 };
  persistStore(store);
}
