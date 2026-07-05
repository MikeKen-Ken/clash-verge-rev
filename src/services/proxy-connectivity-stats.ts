/** 节点测速联通次数统计（localStorage 持久化，仅保留最近 3 天） */
import { scheduleConnectivityPersistenceSync } from "@/services/proxy-connectivity-sync";

const STORAGE_KEY = "proxy.connectivityStats";
const RETENTION_DAYS = 3;
const STORE_VERSION = 2;

interface DayCounts {
  s: number;
  f: number;
}

interface ProxyConnectivityEntry {
  days: Record<string, DayCounts>;
}

interface StatsFileV2 {
  v: number;
  data: Record<string, ProxyConnectivityEntry>;
}

/** @deprecated v1 flat entry */
interface LegacyProxyConnectivityStats {
  success: number;
  failure: number;
}

export interface ProxyConnectivityStats {
  success: number;
  failure: number;
}

let cachedStore: Record<string, ProxyConnectivityEntry> | null = null;

function formatDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function cutoffDayKey(now: Date): string {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (RETENTION_DAYS - 1));
  return formatDayKey(cutoff);
}

function pruneDays(days: Record<string, DayCounts>, now: Date): void {
  const cutoff = cutoffDayKey(now);
  for (const key of Object.keys(days)) {
    if (key < cutoff) {
      delete days[key];
    }
  }
}

function sumEntry(entry: ProxyConnectivityEntry | undefined): ProxyConnectivityStats {
  if (!entry?.days) return { success: 0, failure: 0 };
  let success = 0;
  let failure = 0;
  for (const counts of Object.values(entry.days)) {
    success += counts.s ?? 0;
    failure += counts.f ?? 0;
  }
  return { success, failure };
}

function migrateLegacyStore(
  legacy: Record<string, LegacyProxyConnectivityStats>,
): Record<string, ProxyConnectivityEntry> {
  const today = formatDayKey(new Date());
  const next: Record<string, ProxyConnectivityEntry> = {};
  for (const [name, entry] of Object.entries(legacy)) {
    const success = Math.max(0, entry?.success ?? 0);
    const failure = Math.max(0, entry?.failure ?? 0);
    if (success === 0 && failure === 0) continue;
    next[name] = { days: { [today]: { s: success, f: failure } } };
  }
  return next;
}

function loadStore(): Record<string, ProxyConnectivityEntry> {
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
    const maybeV2 = parsed as StatsFileV2;
    if (maybeV2.v === STORE_VERSION && maybeV2.data && typeof maybeV2.data === "object") {
      cachedStore = maybeV2.data;
      return cachedStore;
    }
    cachedStore = migrateLegacyStore(parsed as Record<string, LegacyProxyConnectivityStats>);
    persistStore(cachedStore);
    return cachedStore;
  } catch {
    cachedStore = {};
    return cachedStore;
  }
}

function persistStore(store: Record<string, ProxyConnectivityEntry>) {
  cachedStore = store;
  if (typeof window === "undefined") return;
  try {
    const payload: StatsFileV2 = { v: STORE_VERSION, data: store };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    scheduleConnectivityPersistenceSync();
  } catch {
    // ignore localStorage failure
  }
}

export function getConnectivityStats(proxyName: string): ProxyConnectivityStats {
  if (!proxyName) return { success: 0, failure: 0 };
  const store = loadStore();
  const entry = store[proxyName];
  if (!entry?.days) return { success: 0, failure: 0 };
  const now = new Date();
  pruneDays(entry.days, now);
  if (Object.keys(entry.days).length === 0) {
    const next = { ...store };
    delete next[proxyName];
    persistStore(next);
    return { success: 0, failure: 0 };
  }
  return sumEntry(entry);
}

export function getConnectivitySuccessCount(proxyName: string): number {
  return getConnectivityStats(proxyName).success;
}

/** 根据测速 delay 判定成功/失败并累加（0 < delay <= timeout 为成功） */
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

  const now = new Date();
  const day = formatDayKey(now);
  const store = { ...loadStore() };
  const entry = store[proxyName] ?? { days: {} };
  if (!entry.days) entry.days = {};
  const prev = entry.days[day] ?? { s: 0, f: 0 };
  entry.days[day] = isSuccess
    ? { s: prev.s + 1, f: prev.f }
    : { s: prev.s, f: prev.f + 1 };
  pruneDays(entry.days, now);
  if (Object.keys(entry.days).length === 0) {
    delete store[proxyName];
  } else {
    store[proxyName] = entry;
  }
  persistStore(store);
}

/** 批量写入组级 URLTest 结果（启动测速、delayGroup 等场景） */
export function recordGroupDelayResults(
  memberNames: string[],
  delays: Record<string, number>,
  timeout: number,
): void {
  for (const name of memberNames) {
    if (!name || name === "DIRECT" || name === "REJECT") continue;
    const raw = delays[name];
    const value =
      raw != null && Number.isFinite(raw) && raw > 0 ? raw : 0;
    recordDelayTestResult(name, value, timeout);
  }
}

/** 一键清空全部节点的测速联通统计 */
export function clearConnectivityStats(): void {
  cachedStore = {};
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
    scheduleConnectivityPersistenceSync();
  } catch {
    // ignore localStorage failure
  }
}
