/** 节点测速联通统计（localStorage 持久化，最多保留 30 天，惩罚有效延迟 + 指数衰减）
 * 记账以桌面内核 URLTest 写入的 proxy-connectivity-stats.json 为准；前端负责 hydrate 与清空。
 */
import { invoke } from "@tauri-apps/api/core";

import {
  publishConnectivityReset,
  runConnectivityPersistenceTransaction,
  scheduleConnectivityPersistenceSync,
} from "@/services/proxy-connectivity-sync";

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

function pruneEmptyProxyEntries(
  store: Record<string, ProxyConnectivityEntry>,
  now = new Date(),
): { store: Record<string, ProxyConnectivityEntry>; changed: boolean } {
  let changed = false;
  const next: Record<string, ProxyConnectivityEntry> = {};
  for (const [name, entry] of Object.entries(store)) {
    if (!entry?.days) {
      changed = true;
      continue;
    }
    const days = { ...entry.days };
    pruneDays(days, now);
    if (Object.keys(days).length === 0) {
      changed = true;
      continue;
    }
    if (Object.keys(days).length !== Object.keys(entry.days).length) {
      changed = true;
      next[name] = { days };
    } else {
      next[name] = entry;
    }
  }
  return { store: next, changed };
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
    const loaded =
      maybeV2.v === STORE_VERSION &&
      maybeV2.data &&
      typeof maybeV2.data === "object"
        ? maybeV2.data
        : migrateLegacyStore(
            parsed as Record<string, LegacyProxyConnectivityStats>,
          );
    const { store, changed } = pruneEmptyProxyEntries(loaded);
    cachedStore = store;
    if (changed || maybeV2.v !== STORE_VERSION) {
      persistStore(cachedStore);
    }
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

/**
 * 从数据目录拉取内核写入的联通统计，覆盖 localStorage 缓存。
 * 若磁盘尚无数据而 localStorage 仍有旧账，先把 LS 推到磁盘，避免升级后丢历史。
 */
export async function hydrateConnectivityStatsFromDisk(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const raw = await invoke<string>("read_connectivity_stats_file");
    const diskStoreRaw = parseStatsPayload(raw);
    const { store: diskStore, changed } = pruneEmptyProxyEntries(diskStoreRaw);
    const diskHasData = Object.keys(diskStore).length > 0;

    if (!diskHasData) {
      const existing = loadStore();
      if (Object.keys(existing).length > 0) {
        persistStore(existing);
        return;
      }
    }

    cachedStore = diskStore;
    const payload: StatsFileV2 = { v: STORE_VERSION, data: diskStore };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    // 磁盘上若仍有过期空条目，写回裁剪后的结果，与内核 prune 行为对齐
    if (changed) {
      scheduleConnectivityPersistenceSync();
    }
  } catch {
    // ignore hydrate failure
  }
}

function parseStatsPayload(
  raw: string | null | undefined,
): Record<string, ProxyConnectivityEntry> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const maybeV2 = parsed as StatsFileV2;
    if (
      maybeV2.v === STORE_VERSION &&
      maybeV2.data &&
      typeof maybeV2.data === "object"
    ) {
      return maybeV2.data;
    }
    return migrateLegacyStore(
      parsed as Record<string, LegacyProxyConnectivityStats>,
    );
  } catch {
    return {};
  }
}

export function getConnectivityStats(
  proxyName: string,
): ProxyConnectivityStats {
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
export function computeConnectivityScoreFromAvgDelay(
  avgDelayMs: number,
): number {
  if (!Number.isFinite(avgDelayMs) || avgDelayMs < 0) {
    return (
      1 /
      (1 +
        CONNECTIVITY_FALLBACK_DELAY_MS / CONNECTIVITY_SCORE_REFERENCE_DELAY_MS)
    );
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

/** 根据测速 delay 累加（成功=真实 delay，失败=timeout 惩罚延迟）
 * @deprecated 桌面记账改由内核 URLTest 写入磁盘；保留空实现以免旧调用报错。
 */
export function recordDelayTestResult(
  _proxyName: string,
  _delay: number,
  _timeout: number,
): void {
  void hydrateConnectivityStatsFromDisk();
}

/** 批量写入组级 URLTest 结果（启动测速、delayGroup 等场景）
 * @deprecated 同 recordDelayTestResult，改为 hydrate 磁盘统计。
 */
export function recordGroupDelayResults(
  _memberNames: string[],
  _delays: Record<string, number>,
  _timeout: number,
): void {
  void hydrateConnectivityStatsFromDisk();
}

/** 一键清空全部节点的测速联通统计（写盘完成后再返回，避免随后 hydrate 读到旧数据） */
export async function clearConnectivityStats(): Promise<void> {
  if (typeof window === "undefined") return;
  await runConnectivityPersistenceTransaction(async () => {
    await publishConnectivityReset();
    cachedStore = {};
    try {
      const payload: StatsFileV2 = { v: STORE_VERSION, data: {} };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // The native reset is authoritative even if the UI cache cannot persist.
    }
  });
}

/** 清空单个节点的测速联通统计（写盘完成后再返回） */
export async function clearConnectivityStatsForProxy(
  proxyName: string,
): Promise<void> {
  if (!proxyName) return;
  const store = { ...loadStore() };
  if (!(proxyName in store)) return;
  if (typeof window === "undefined") return;
  await runConnectivityPersistenceTransaction(async () => {
    await publishConnectivityReset(proxyName);
    delete store[proxyName];
    cachedStore = store;
    try {
      const payload: StatsFileV2 = { v: STORE_VERSION, data: store };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // The native reset is authoritative even if the UI cache cannot persist.
    }
  });
}

/** 面板列表行：分数 + 加权成功/失败 + 平滑有效延迟 */
export interface ConnectivityScoreRow {
  name: string;
  score: number;
  weightedSuccess: number;
  weightedFailure: number;
  effectiveAvgDelayMs: number;
  hasStats: boolean;
}

/**
 * 按联通分降序列出节点（同分保序）。
 * hasStats=false 时仍给出先验平滑分数，有效延迟供展示用。
 */
export function listConnectivityScoreRows(
  proxyNames: string[],
): ConnectivityScoreRow[] {
  if (proxyNames.length === 0) return [];

  const { global, byProxy } = collectWeightedStatsFromStore(loadStore());
  const priorDelayMs = computePriorEffectiveDelayMs(global);

  const keyed = proxyNames.map((name, index) => {
    const stats = byProxy[name] ?? { success: 0, failure: 0, delaySum: 0 };
    const hasStats = stats.success > 0 || stats.failure > 0;
    return {
      index,
      row: {
        name,
        score: computePenalizedDelayConnectivityScore(stats, priorDelayMs),
        weightedSuccess: stats.success,
        weightedFailure: stats.failure,
        effectiveAvgDelayMs: computeSmoothedEffectiveAvgDelay(
          stats,
          priorDelayMs,
        ),
        hasStats,
      } satisfies ConnectivityScoreRow,
    };
  });

  keyed.sort((a, b) => {
    if (a.row.score !== b.row.score) return b.row.score - a.row.score;
    return a.index - b.index;
  });

  return keyed.map((k) => k.row);
}
