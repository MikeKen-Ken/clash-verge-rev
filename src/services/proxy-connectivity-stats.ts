/** 节点测速联通统计（localStorage 持久化，最多保留 30 天，惩罚有效延迟 + 指数衰减） */
import { scheduleConnectivityPersistenceSync } from "@/services/proxy-connectivity-sync";

const STORAGE_KEY = "proxy.connectivityStats";
const STORE_VERSION = 2;

/** 原始按天数据最多保留天数（超过则物理删除） */
export const CONNECTIVITY_RETENTION_DAYS = 30;
/** 指数衰减半衰期（天）：age 天前的数据权重 = 0.5 ^ (age / halfLife) */
export const CONNECTIVITY_DECAY_HALF_LIFE_DAYS = 3;
/** 平滑平均有效延迟的虚拟样本数 k */
export const CONNECTIVITY_PRIOR_VIRTUAL_SAMPLES = 20;
/** 全局无实测时的默认先验延迟（ms） */
export const CONNECTIVITY_FALLBACK_DELAY_MS = 400;
/** 排序分参考延迟（ms）：avg = D0 时 score = 0.5 */
export const CONNECTIVITY_SCORE_REFERENCE_DELAY_MS = 400;
/** 测速 timeout 无效时的失败惩罚延迟（ms） */
export const CONNECTIVITY_DEFAULT_PENALTY_DELAY_MS = 5000;

const RETENTION_DAYS = CONNECTIVITY_RETENTION_DAYS;
const MS_PER_DAY = 86_400_000;

interface DayCounts {
  s: number;
  f: number;
  ds?: number;
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

/** 加权后的测速统计（s=成功次数，f=失败次数，delaySum=有效延迟总和） */
export interface ProxyConnectivityStats {
  success: number;
  failure: number;
  delaySum: number;
}

export interface ConnectivityScoreContext {
  priorDelayMs: number;
  scoreFor: (proxyName: string) => number;
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

function dayAgeInDays(dayKey: string, now: Date): number {
  const parts = dayKey.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return Number.POSITIVE_INFINITY;
  }
  const [y, m, d] = parts;
  const dayStart = new Date(y, m - 1, d);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((todayStart.getTime() - dayStart.getTime()) / MS_PER_DAY);
}

/** weight = 0.5 ^ (ageDays / halfLife) */
export function connectivityDecayWeight(
  ageDays: number,
  halfLifeDays = CONNECTIVITY_DECAY_HALF_LIFE_DAYS,
): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0;
  if (ageDays >= RETENTION_DAYS) return 0;
  if (halfLifeDays <= 0) return ageDays === 0 ? 1 : 0;
  return 0.5 ** (ageDays / halfLifeDays);
}

function sumWeightedDays(
  days: Record<string, DayCounts>,
  now: Date,
): ProxyConnectivityStats {
  let success = 0;
  let failure = 0;
  let delaySum = 0;
  for (const [day, counts] of Object.entries(days)) {
    const weight = connectivityDecayWeight(dayAgeInDays(day, now));
    if (weight <= 0) continue;
    success += (counts.s ?? 0) * weight;
    failure += (counts.f ?? 0) * weight;
    delaySum += (counts.ds ?? 0) * weight;
  }
  return { success, failure, delaySum };
}

function weightedTrialCount(stats: ProxyConnectivityStats): number {
  return stats.success + stats.failure;
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
  if (!proxyName) return { success: 0, failure: 0, delaySum: 0 };
  const store = loadStore();
  const entry = store[proxyName];
  if (!entry?.days) return { success: 0, failure: 0, delaySum: 0 };
  const now = new Date();
  pruneDays(entry.days, now);
  if (Object.keys(entry.days).length === 0) {
    const next = { ...store };
    delete next[proxyName];
    persistStore(next);
    return { success: 0, failure: 0, delaySum: 0 };
  }
  return sumWeightedDays(entry.days, now);
}

export function getConnectivitySuccessCount(proxyName: string): number {
  return getConnectivityStats(proxyName).success;
}

function collectWeightedStatsFromStore(
  store: Record<string, ProxyConnectivityEntry>,
  now = new Date(),
): {
  global: ProxyConnectivityStats;
  byProxy: Record<string, ProxyConnectivityStats>;
} {
  const global = { success: 0, failure: 0, delaySum: 0 };
  const byProxy: Record<string, ProxyConnectivityStats> = {};

  for (const [name, entry] of Object.entries(store)) {
    if (!entry?.days) continue;
    const weighted = sumWeightedDays(entry.days, now);
    if (weighted.success <= 0 && weighted.failure <= 0) continue;
    byProxy[name] = weighted;
    global.success += weighted.success;
    global.failure += weighted.failure;
    global.delaySum += weighted.delaySum;
  }

  return { global, byProxy };
}

/** 全局加权平均有效延迟，无数据时用默认 400ms */
export function computePriorEffectiveDelayMs(
  global: ProxyConnectivityStats = { success: 0, failure: 0, delaySum: 0 },
): number {
  const trials = weightedTrialCount(global);
  if (trials <= 0) return CONNECTIVITY_FALLBACK_DELAY_MS;
  const avg = global.delaySum / trials;
  if (!Number.isFinite(avg) || avg < 0) return CONNECTIVITY_FALLBACK_DELAY_MS;
  return avg;
}

/** avg = (Wds + k × priorDelay) / (Wn + k) */
export function computeSmoothedEffectiveAvgDelay(
  stats: ProxyConnectivityStats,
  priorDelayMs: number,
): number {
  const k = CONNECTIVITY_PRIOR_VIRTUAL_SAMPLES;
  const trials = weightedTrialCount(stats);
  const prior =
    Number.isFinite(priorDelayMs) && priorDelayMs > 0
      ? priorDelayMs
      : CONNECTIVITY_FALLBACK_DELAY_MS;
  return (stats.delaySum + k * prior) / (trials + k);
}

/** score = 1 / (1 + avg / D0)，越高越靠前 */
export function computeConnectivityScoreFromAvgDelay(avgDelayMs: number): number {
  if (!Number.isFinite(avgDelayMs) || avgDelayMs < 0) {
    return 1 / (1 + CONNECTIVITY_FALLBACK_DELAY_MS / CONNECTIVITY_SCORE_REFERENCE_DELAY_MS);
  }
  return 1 / (1 + avgDelayMs / CONNECTIVITY_SCORE_REFERENCE_DELAY_MS);
}

export function computePenalizedDelayConnectivityScore(
  stats: ProxyConnectivityStats,
  priorDelayMs: number,
): number {
  const avg = computeSmoothedEffectiveAvgDelay(stats, priorDelayMs);
  return computeConnectivityScoreFromAvgDelay(avg);
}

/** 一次性构建排序上下文，避免批量排序时重复扫描 store */
export function buildConnectivityScoreContext(): ConnectivityScoreContext {
  const { global, byProxy } = collectWeightedStatsFromStore(loadStore());
  const priorDelayMs = computePriorEffectiveDelayMs(global);

  return {
    priorDelayMs,
    scoreFor: (proxyName: string) => {
      const stats = byProxy[proxyName] ?? {
        success: 0,
        failure: 0,
        delaySum: 0,
      };
      return computePenalizedDelayConnectivityScore(stats, priorDelayMs);
    },
  };
}

export function getConnectivityBayesianScore(proxyName: string): number {
  return buildConnectivityScoreContext().scoreFor(proxyName);
}

/** 根据测速 delay 累加（成功=真实 delay，失败=timeout 惩罚延迟） */
export function recordDelayTestResult(
  proxyName: string,
  delay: number,
  timeout: number,
): void {
  if (!proxyName || proxyName === "DIRECT" || proxyName === "REJECT") return;
  if (delay === -2 || delay === -1) return;

  const effectiveTimeout =
    Number.isFinite(timeout) && timeout > 0
      ? timeout
      : CONNECTIVITY_DEFAULT_PENALTY_DELAY_MS;
  const isSuccess = delay > 0 && delay <= effectiveTimeout;

  const now = new Date();
  const day = formatDayKey(now);
  const store = { ...loadStore() };
  const entry = store[proxyName] ?? { days: {} };
  if (!entry.days) entry.days = {};
  const prev = entry.days[day] ?? { s: 0, f: 0, ds: 0 };
  entry.days[day] = isSuccess
    ? {
        s: prev.s + 1,
        f: prev.f,
        ds: (prev.ds ?? 0) + delay,
      }
    : {
        s: prev.s,
        f: prev.f + 1,
        ds: (prev.ds ?? 0) + effectiveTimeout,
      };
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
