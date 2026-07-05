/** 节点测速联通统计（localStorage 持久化，最多保留 30 天，指数衰减加权） */
import { scheduleConnectivityPersistenceSync } from "@/services/proxy-connectivity-sync";

const STORAGE_KEY = "proxy.connectivityStats";
const STORE_VERSION = 2;

/** 原始按天数据最多保留天数（超过则物理删除） */
export const CONNECTIVITY_RETENTION_DAYS = 30;
/** 指数衰减半衰期（天）：age 天前的数据权重 = 0.5 ^ (age / halfLife) */
export const CONNECTIVITY_DECAY_HALF_LIFE_DAYS = 3;
/** 贝叶斯先验虚拟样本数 k：越大对小样本越保守 */
export const CONNECTIVITY_PRIOR_VIRTUAL_SAMPLES = 20;
/** 全局尚无实测数据时的默认成功率先验 */
export const CONNECTIVITY_FALLBACK_PRIOR_RATE = 0.75;
/** 速度分参考延迟（ms）：avgDelay = D0 时 speedScore = 0.5 */
export const CONNECTIVITY_SPEED_REFERENCE_DELAY_MS = 400;
/** 无成功测速记录时的中性速度分 */
export const CONNECTIVITY_NEUTRAL_SPEED_SCORE = 0.5;

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

export interface ProxyConnectivityStats {
  success: number;
  failure: number;
  delaySum: number;
}

export interface ConnectivityBayesianPrior {
  alpha: number;
  beta: number;
}

export interface ConnectivityScoreContext {
  prior: ConnectivityBayesianPrior;
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

/** 方案 B：weight = 0.5 ^ (ageDays / halfLife) */
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

export function computeConnectivityBayesianPrior(
  totals: ProxyConnectivityStats = { success: 0, failure: 0, delaySum: 0 },
): ConnectivityBayesianPrior {
  const k = CONNECTIVITY_PRIOR_VIRTUAL_SAMPLES;
  const total = totals.success + totals.failure;
  const rate =
    total > 0
      ? totals.success / total
      : CONNECTIVITY_FALLBACK_PRIOR_RATE;
  return { alpha: rate * k, beta: (1 - rate) * k };
}

export function computeBayesianConnectivityScore(
  success: number,
  failure: number,
  prior: ConnectivityBayesianPrior,
): number {
  const denom = success + failure + prior.alpha + prior.beta;
  if (denom <= 0) return CONNECTIVITY_FALLBACK_PRIOR_RATE;
  return (success + prior.alpha) / denom;
}

/** 路线 1：成功测速的加权平均延迟 → 速度分 */
export function computeConnectivitySpeedScore(
  weightedSuccess: number,
  weightedDelaySum: number,
): number {
  if (weightedSuccess <= 0) {
    return CONNECTIVITY_NEUTRAL_SPEED_SCORE;
  }
  const avgDelay = weightedDelaySum / weightedSuccess;
  if (!Number.isFinite(avgDelay) || avgDelay < 0) {
    return CONNECTIVITY_NEUTRAL_SPEED_SCORE;
  }
  return 1 / (1 + avgDelay / CONNECTIVITY_SPEED_REFERENCE_DELAY_MS);
}

/** 综合分 = 可靠分 × 速度分 */
export function computeCompositeConnectivityScore(
  stats: ProxyConnectivityStats,
  prior: ConnectivityBayesianPrior,
): number {
  const reliability = computeBayesianConnectivityScore(
    stats.success,
    stats.failure,
    prior,
  );
  const speed = computeConnectivitySpeedScore(stats.success, stats.delaySum);
  return reliability * speed;
}

/** 一次性构建排序上下文，避免批量排序时重复扫描 store */
export function buildConnectivityScoreContext(): ConnectivityScoreContext {
  const { global, byProxy } = collectWeightedStatsFromStore(loadStore());
  const prior = computeConnectivityBayesianPrior(global);

  return {
    prior,
    scoreFor: (proxyName: string) => {
      const stats = byProxy[proxyName] ?? {
        success: 0,
        failure: 0,
        delaySum: 0,
      };
      return computeCompositeConnectivityScore(stats, prior);
    },
  };
}

export function getConnectivityBayesianScore(proxyName: string): number {
  return buildConnectivityScoreContext().scoreFor(proxyName);
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
  const prev = entry.days[day] ?? { s: 0, f: 0, ds: 0 };
  entry.days[day] = isSuccess
    ? {
        s: prev.s + 1,
        f: prev.f,
        ds: (prev.ds ?? 0) + delay,
      }
    : { s: prev.s, f: prev.f + 1, ds: prev.ds ?? 0 };
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
