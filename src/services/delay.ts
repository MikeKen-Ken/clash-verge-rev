import { delayProxyByName, ProxyDelay } from "tauri-plugin-mihomo-api";

import { hydrateConnectivityStatsFromDisk } from "@/services/proxy-connectivity-stats";
import { debugLog } from "@/utils/debug";

/** 默认测速 URL（与 Android `tunnel/connectivity.go` 中空 testURL 一致） */
export const DEFAULT_DELAY_TEST_URL =
  "https://www.gstatic.com/generate_204";

/** @deprecated 请使用 DEFAULT_DELAY_TEST_URL */
export const ANDROID_HEALTH_CHECK_FALLBACK_URL = DEFAULT_DELAY_TEST_URL;

/** 组件订阅键：仍按「组 + 出站名」区分单元格，避免同名节点在不同列表的监听器互相覆盖 */
const listenerSubscriptionKey = (group: string, name: string) =>
  `${String(group ?? "")}\u0000${name}`;

/** 配置里未指定时的默认超时（与 core GroupBase 一致） */
export const DEFAULT_GROUP_TIMEOUT_MS = 5000;

/** 由设置页/代理页快捷设置写入的全局默认（verge health_check_*），组未配置时使用 */
let defaultHealthCheckOverrides: {
  timeout?: number;
  selectedTimeout?: number;
} = {};

/**
 * 设置健康检测默认超时（来自 verge 快捷设置），组配置未指定时使用。
 */
export function setDefaultHealthCheck(overrides: {
  timeout?: number;
  selectedTimeout?: number;
}) {
  defaultHealthCheckOverrides = overrides ?? {};
}

/**
 * 从代理组配置取测速超时：仅当该节点为「手动选择」时用 selected-timeout，否则用 timeout。
 * 组未配置时使用 verge 快捷设置（setDefaultHealthCheck）或 DEFAULT_GROUP_TIMEOUT_MS。
 */
export function getGroupDelayTimeout(
  group: { timeout?: number; selectedTimeout?: number } | null | undefined,
  isManualSelection: boolean,
): number {
  if (isManualSelection) {
    const fromGroup = group?.selectedTimeout;
    if (fromGroup != null && fromGroup > 0) return fromGroup;
    const fromVerge = defaultHealthCheckOverrides.selectedTimeout;
    if (fromVerge != null && fromVerge > 0) return fromVerge;
    return DEFAULT_GROUP_TIMEOUT_MS;
  }
  const fromGroup = group?.timeout;
  if (fromGroup != null && fromGroup > 0) return fromGroup;
  const fromVerge = defaultHealthCheckOverrides.timeout;
  if (fromVerge != null && fromVerge > 0) return fromVerge;
  return group ? DEFAULT_GROUP_TIMEOUT_MS : DEFAULT_GROUP_TIMEOUT_MS;
}

export interface DelayUpdate {
  delay: number;
  elapsed?: number;
  updatedAt: number;
}

/** 批量测速会话内跨父组复用：与核心「同一出站名共享一条延迟」一致。仅用出站名作键：
 * 嵌套 selector（如 🔀）出现在多个父组时，若键含父组 URL/timeout 会误杀复用。 */
function bulkDelayReuseKey(name: string): string {
  return name;
}

export interface CheckDelayOptions {
  silentGlobal?: boolean;
  bulkReuseMap?: Map<string, DelayUpdate>;
}

export interface CheckListDelayOptions {
  concurrency?: number;
  bulkReuseMap?: Map<string, DelayUpdate>;
  /**
   * 为 true 时：并行数取 {@link DELAY_CHECK_FULL_BULK_MAX_CONCURRENCY} 与节点数，
   * 不受代理页「测速数量步长」限制（用于测全部、全局大批量、关连接多组测速等）。
   */
  fullBulkMaxConcurrency?: boolean;
}

const CACHE_TTL = 30 * 60 * 1000;
/** 延迟缓存条数上限：超出时按 updatedAt 淘汰最旧项（订阅节点数通常远小于此） */
const CACHE_MAX_SIZE = 4096;
/** 非超容量时，主动扫 TTL 的最小间隔，避免每次 setDelay 全表扫描 */
const CACHE_PRUNE_INTERVAL_MS = 60_000;
const DELAY_CHECK_CONCURRENCY_STORAGE_KEY = "health_check_concurrency";
export const DELAY_CHECK_CONCURRENCY_PRESETS = [30, 50, 100, 150, 200] as const;

/** 全量/大批量测速时与代理页「测速数量步长」解耦的并行上限（与预设档位最大值一致） */
export const DELAY_CHECK_FULL_BULK_MAX_CONCURRENCY = Math.max(
  ...DELAY_CHECK_CONCURRENCY_PRESETS,
);

const DEFAULT_DELAY_CHECK_CONCURRENCY = 30;

const LEGACY_DELAY_CHECK_CONCURRENCY = new Set([10, 20, 40]);

function resolveInitialDelayCheckConcurrency(): number {
  if (typeof window === "undefined") return DEFAULT_DELAY_CHECK_CONCURRENCY;
  try {
    const raw = localStorage.getItem(DELAY_CHECK_CONCURRENCY_STORAGE_KEY);
    const parsed = Number(raw);
    if ((DELAY_CHECK_CONCURRENCY_PRESETS as readonly number[]).includes(parsed)) {
      return parsed;
    }
    if (LEGACY_DELAY_CHECK_CONCURRENCY.has(parsed)) {
      return 30;
    }
    return DEFAULT_DELAY_CHECK_CONCURRENCY;
  } catch {
    return DEFAULT_DELAY_CHECK_CONCURRENCY;
  }
}

let delayCheckConcurrency = resolveInitialDelayCheckConcurrency();

export function getDelayCheckConcurrency(): number {
  return delayCheckConcurrency;
}

export function setDelayCheckConcurrency(value: number) {
  const normalized = (DELAY_CHECK_CONCURRENCY_PRESETS as readonly number[]).includes(value)
    ? value
    : DEFAULT_DELAY_CHECK_CONCURRENCY;
  delayCheckConcurrency = normalized;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(
        DELAY_CHECK_CONCURRENCY_STORAGE_KEY,
        String(normalized),
      );
    } catch {
      // ignore localStorage failure
    }
  }
}

class DelayManager {
  /** 延迟按出站名一条（对齐 mihomo 核心单登记表）；组参数仅用于测速 URL 与订阅 UI */
  private cache = new Map<string, DelayUpdate>();
  private urlMap = new Map<string, string>();
  private lastCachePruneAt = 0;

  /** 来自 /proxies 快照，用于解析出站本体 test-url（对齐原生 Provider HealthCheckURL 语义） */
  private topoRecords: Record<string, IProxyItem> | undefined;
  private topoGroups: IProxyGroupItem[] | undefined;

  /** 出站名 → 订阅该节点的 listenerSubscriptionKey（多父组可多条） */
  private listenerKeysByName = new Map<string, Set<string>>();

  // 每个节点的监听
  private listenerMap = new Map<string, (update: DelayUpdate) => void>();

  /** 合并触发各组延迟排序刷新，避免多父组下仅当前组 reorder */
  private groupListenerBumpTimerId: number | undefined = undefined;
  private readonly GROUP_LISTENER_BUMP_MS = 120;

  // 每个分组的监听
  private groupListenerMap = new Map<string, () => void>();

  /** 任意延迟更新时触发一次（防抖），用于 UI 自动刷新以显示最新延迟 */
  private globalListener: (() => void) | null = null;
  private globalFlushScheduled = false;
  private readonly GLOBAL_DEBOUNCE_MS = 300;

  private pendingItemUpdates = new Map<string, DelayUpdate[]>();
  private pendingGroupUpdates = new Set<string>();
  private itemFlushScheduled = false;
  private groupFlushScheduled = false;

  private scheduleItemFlush() {
    if (this.itemFlushScheduled) return;
    this.itemFlushScheduled = true;

    const run = () => {
      this.itemFlushScheduled = false;
      const updates = this.pendingItemUpdates;
      this.pendingItemUpdates = new Map();

      updates.forEach((queue, key) => {
        const listener = this.listenerMap.get(key);
        if (!listener) return;

        queue.forEach((update) => {
          try {
            listener(update);
          } catch (error) {
            console.error(
              `[DelayManager] 通知节点延迟监听器失败: ${key}`,
              error,
            );
          }
        });
      });
    };

    if (typeof window !== "undefined") {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(run);
        return;
      }
      if (typeof window.setTimeout === "function") {
        window.setTimeout(run, 0);
        return;
      }
    }

    Promise.resolve().then(run);
  }

  private scheduleGroupFlush() {
    if (this.groupFlushScheduled) return;
    this.groupFlushScheduled = true;

    const run = () => {
      this.groupFlushScheduled = false;
      const groups = this.pendingGroupUpdates;
      this.pendingGroupUpdates = new Set();

      groups.forEach((group) => {
        const listener = this.groupListenerMap.get(group);
        if (!listener) return;
        try {
          listener();
        } catch (error) {
          console.error(
            `[DelayManager] 通知分组延迟监听器失败: ${group}`,
            error,
          );
        }
      });
    };

    if (typeof window !== "undefined") {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(run);
        return;
      }
      if (typeof window.setTimeout === "function") {
        window.setTimeout(run, 0);
        return;
      }
    }

    Promise.resolve().then(run);
  }

  private queueGroupNotification(group: string) {
    this.pendingGroupUpdates.add(group);
    this.scheduleGroupFlush();
  }

  private scheduleGlobalFlush() {
    if (this.globalFlushScheduled || !this.globalListener) return;
    this.globalFlushScheduled = true;
    const run = () => {
      this.globalFlushScheduled = false;
      try {
        this.globalListener?.();
      } catch (error) {
        console.error("[DelayManager] 全局延迟刷新回调失败", error);
      }
    };
    if (typeof window !== "undefined" && window.setTimeout) {
      window.setTimeout(run, this.GLOBAL_DEBOUNCE_MS);
    } else {
      Promise.resolve().then(() => run());
    }
  }

  /** 防抖通知所有已注册 groupListener 的组（延迟排序等），与「出站名全局缓存」配套 */
  private scheduleNotifyAllGroupListeners() {
    if (this.groupListenerBumpTimerId !== undefined) return;
    const run = () => {
      this.groupListenerBumpTimerId = undefined;
      for (const g of this.groupListenerMap.keys()) {
        this.pendingGroupUpdates.add(g);
      }
      this.scheduleGroupFlush();
    };
    if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
      this.groupListenerBumpTimerId = window.setTimeout(
        run,
        this.GROUP_LISTENER_BUMP_MS,
      );
    } else {
      Promise.resolve().then(run);
    }
  }

  setGlobalListener(listener: () => void) {
    this.globalListener = listener;
  }

  removeGlobalListener() {
    this.globalListener = null;
  }

  /**
   * 同步代理列表快照（须在拉取 proxies 后调用）。用于按出站名解析 test-url，
   * 避免嵌套 selector 沿用父列表表头的 URL。
   */
  syncProxyTopo(
    records: Record<string, IProxyItem> | undefined,
    groups: IProxyGroupItem[] | undefined,
  ) {
    this.topoRecords = records;
    this.topoGroups = groups;
    // 组测速 URL 仅保留当前拓扑中仍存在的组，避免换订阅后 urlMap 只增不减
    if (groups) {
      const alive = new Set(groups.map((g) => g.name));
      for (const key of this.urlMap.keys()) {
        if (!alive.has(key)) {
          this.urlMap.delete(key);
        }
      }
    }
    this.maybePruneDelayCache(true);
  }

  /** 删除过期项；若仍超上限则按 updatedAt 淘汰最旧条目 */
  private pruneDelayCache(now = Date.now()) {
    for (const [name, entry] of this.cache) {
      if (now - entry.updatedAt > CACHE_TTL) {
        this.cache.delete(name);
      }
    }
    if (this.cache.size <= CACHE_MAX_SIZE) return;

    const ranked = Array.from(this.cache.entries()).sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt,
    );
    const removeCount = ranked.length - CACHE_MAX_SIZE;
    for (let i = 0; i < removeCount; i++) {
      this.cache.delete(ranked[i][0]);
    }
  }

  private maybePruneDelayCache(force = false) {
    const now = Date.now();
    const overCapacity = this.cache.size > CACHE_MAX_SIZE;
    if (
      !force &&
      !overCapacity &&
      now - this.lastCachePruneAt < CACHE_PRUNE_INTERVAL_MS
    ) {
      return;
    }
    this.lastCachePruneAt = now;
    this.pruneDelayCache(now);
  }

  setUrl(group: string, url: string) {
    debugLog(`[DelayManager] 设置测试URL，组: ${group}, URL: ${url}`);
    this.urlMap.set(group, url);
  }

  getUrl(group: string) {
    const ui = this.urlMap.get(group)?.trim();
    if (ui) {
      debugLog(`[DelayManager] 获取测试URL（UI），组: ${group}, URL: ${ui}`);
      return ui;
    }
    const fromTopo = this.topoGroups
      ?.find((g) => g.name === group)
      ?.testUrl?.trim();
    if (fromTopo) {
      debugLog(
        `[DelayManager] 获取测试URL（配置/核心），组: ${group}, URL: ${fromTopo}`,
      );
      return fromTopo;
    }
    debugLog(
      `[DelayManager] 获取默认测试URL（默认测速），组: ${group}, URL: ${DEFAULT_DELAY_TEST_URL}`,
    );
    return DEFAULT_DELAY_TEST_URL;
  }

  /**
   * 单节点测速：`records[name]` / 出站本身为 selector 时在 `groups` 中取 test-url；
   * 再用当前列表上下文组的有效 URL（与安卓组内对每个 proxy.URLTest 的 URL 链一致）。
   */
  getTestUrlForOutbound(outboundName: string, contextGroup: string): string {
    const recUrl = this.topoRecords?.[outboundName]?.testUrl?.trim();
    if (recUrl) {
      debugLog(
        `[DelayManager] 出站 ${outboundName} 使用 records.testUrl: ${recUrl}`,
      );
      return recUrl;
    }
    const asGroupUrl = this.topoGroups
      ?.find((g) => g.name === outboundName)
      ?.testUrl?.trim();
    if (asGroupUrl) {
      debugLog(
        `[DelayManager] 出站 ${outboundName} 使用 policy-group.testUrl: ${asGroupUrl}`,
      );
      return asGroupUrl;
    }
    return this.getUrl(contextGroup);
  }

  setListener(
    name: string,
    group: string,
    listener: (update: DelayUpdate) => void,
  ) {
    const key = listenerSubscriptionKey(group, name);
    this.listenerMap.set(key, listener);
    let subscribers = this.listenerKeysByName.get(name);
    if (!subscribers) {
      subscribers = new Set<string>();
      this.listenerKeysByName.set(name, subscribers);
    }
    subscribers.add(key);
  }

  removeListener(name: string, group: string) {
    const key = listenerSubscriptionKey(group, name);
    this.listenerMap.delete(key);
    const subscribers = this.listenerKeysByName.get(name);
    if (subscribers) {
      subscribers.delete(key);
      if (subscribers.size === 0) {
        this.listenerKeysByName.delete(name);
      }
    }
  }

  setGroupListener(group: string, listener: () => void) {
    this.groupListenerMap.set(group, listener);
  }

  removeGroupListener(group: string) {
    this.groupListenerMap.delete(group);
  }

  setDelay(
    name: string,
    group: string,
    delay: number,
    meta?: { elapsed?: number; /** 为 true 时不触发全量刷新，仅通知该节点的监听器 */ silentGlobal?: boolean },
  ): DelayUpdate {
    debugLog(
      `[DelayManager] 设置延迟（按出站名共享），代理: ${name}, 上下文组: ${group}, 延迟: ${delay}`,
    );
    const update: DelayUpdate = {
      delay,
      elapsed: meta?.elapsed,
      updatedAt: Date.now(),
    };

    this.cache.set(name, update);
    this.maybePruneDelayCache();

    const subscribers = this.listenerKeysByName.get(name);
    if (subscribers) {
      for (const lk of subscribers) {
        const queue = this.pendingItemUpdates.get(lk);
        if (queue) {
          queue.push(update);
        } else {
          this.pendingItemUpdates.set(lk, [update]);
        }
      }
      this.scheduleItemFlush();
    }

    if (!meta?.silentGlobal) {
      this.scheduleGlobalFlush();
      this.scheduleNotifyAllGroupListeners();
    }

    return update;
  }

  /** `group` 仅为兼容；读缓存与安卓/核心一致，仅按出站名 */
  getDelayUpdate(name: string, _group?: string) {
    const entry = this.cache.get(name);
    if (!entry) return undefined;

    if (Date.now() - entry.updatedAt > CACHE_TTL) {
      this.cache.delete(name);
      return undefined;
    }

    return { ...entry };
  }

  getDelay(name: string, group: string) {
    const update = this.getDelayUpdate(name, group);
    return update ? update.delay : -1;
  }

  /// 暂时修复provider的节点延迟排序的问题
  getDelayFix(proxy: IProxyItem, group: string) {
    if (!proxy.provider) {
      const update = this.getDelayUpdate(proxy.name, group);
      if (update && (update.delay >= 0 || update.delay === -2)) {
        return update.delay;
      }
    }

    // 添加 history 属性的安全检查
    if (proxy.history && proxy.history.length > 0) {
      // 0ms以error显示
      return proxy.history[proxy.history.length - 1].delay || 1e6;
    }
    return -1;
  }

  /// 批量获取一组节点的 getDelayFix 结果，用于过滤/排序时减少重复查 cache
  getDelaysForGroupFix(groupName: string, proxies: IProxyItem[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const proxy of proxies) {
      map.set(proxy.name, this.getDelayFix(proxy, groupName));
    }
    return map;
  }

  async checkDelay(
    name: string,
    group: string,
    timeout: number,
    options?: CheckDelayOptions,
  ): Promise<DelayUpdate> {
    debugLog(
      `[DelayManager] 开始测试延迟，代理: ${name}, 组: ${group}, 超时: ${timeout}ms`,
    );

    const silent = options?.silentGlobal ?? false;
    const url = this.getTestUrlForOutbound(name, group);
    const reuseMap = options?.bulkReuseMap;
    const reuseKey =
      reuseMap ? bulkDelayReuseKey(name) : undefined;

    if (reuseMap != null && reuseKey !== undefined) {
      const cached = reuseMap.get(reuseKey);
      if (cached !== undefined && cached.delay !== -2) {
        debugLog(
          `[DelayManager] 复用同会话测速结果 代理:${name} 组:${group} delay:${cached.delay}`,
        );
        return this.setDelay(name, group, cached.delay, {
          elapsed: cached.elapsed,
          silentGlobal: silent,
        });
      }
    }

    // 先将状态设置为测试中
    this.setDelay(name, group, -2, { silentGlobal: silent });

    let delay = -1;
    let elapsed = 0;

    const startTime = Date.now();

    try {
      debugLog(`[DelayManager] 调用API测试延迟，代理: ${name}, URL: ${url}`);

      // 设置超时处理, delay = 0 为超时
      const timeoutPromise = new Promise<ProxyDelay>((resolve) => {
        setTimeout(() => resolve({ delay: 0 }), timeout);
      });

      // 使用Promise.race来实现超时控制
      const result = await Promise.race([
        delayProxyByName(name, url, timeout),
        timeoutPromise,
      ]);

      const elapsedTime = Date.now() - startTime;

      delay = result.delay;
      elapsed = elapsedTime;
      debugLog(
        `[DelayManager] API返回 代理:${name} 组:${group} 延迟:${delay}ms 耗时:${elapsedTime}ms timeout:${timeout}ms`,
      );
    } catch (error) {
      console.error(`[DelayManager] 延迟测试出错，代理: ${name}`, error);
      delay = 1e6; // error
      elapsed = Date.now() - startTime;
    }

    const update = this.setDelay(name, group, delay, {
      elapsed,
      silentGlobal: silent,
    });
    // 联通统计由内核 Proxy.URLTest 写入磁盘；前端只刷新缓存，避免与安卓双通道不一致/双记
    if (update.delay !== -2) {
      void hydrateConnectivityStatsFromDisk();
    }
    if (reuseMap != null && reuseKey !== undefined && update.delay !== -2) {
      reuseMap.set(reuseKey, { ...update });
    }
    return update;
  }

  async checkListDelay(
    nameList: string[],
    group: string,
    timeout: number,
    maybeOptions?: number | CheckListDelayOptions,
  ) {
    const options: CheckListDelayOptions =
      typeof maybeOptions === "number"
        ? { concurrency: maybeOptions }
        : maybeOptions ?? {};
    const concurrency = options.concurrency;
    const bulkReuseMap = options.bulkReuseMap;
    const fullBulkMaxConcurrency = options.fullBulkMaxConcurrency === true;

    const names = nameList.filter(Boolean);
    const actualConcurrency = fullBulkMaxConcurrency
      ? Math.min(DELAY_CHECK_FULL_BULK_MAX_CONCURRENCY, names.length)
      : Math.min(
        concurrency ?? delayCheckConcurrency,
        delayCheckConcurrency,
        names.length,
      );
    debugLog(
      `[DelayManager] 批量测试开始 组:${group} 数量:${names.length} 并发:${actualConcurrency} fullBulk:${fullBulkMaxConcurrency} timeout:${timeout}ms`,
    );
    const startTime = Date.now();

    // 设置正在延迟测试中
    names.forEach((name) => this.setDelay(name, group, -2));

    let index = 0;

    const help = async (): Promise<void> => {
      const currName = names[index++];
      if (!currName) return;

      const nodeStart = Date.now();
      try {
        this.setDelay(currName, group, -2);

        if (index > 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.random() * 200),
          );
        }

        await this.checkDelay(currName, group, timeout, {
          bulkReuseMap,
        });
        const nodeElapsed = Date.now() - nodeStart;
        debugLog(
          `[DelayManager] 单节点API 代理:${currName} 耗时:${nodeElapsed}ms`,
        );
      } catch (error) {
        console.error(
          `[DelayManager] 批量测试单个代理出错，代理: ${currName}`,
          error,
        );
        this.setDelay(currName, group, 1e6);
      }

      return help();
    };

    const promiseList: Promise<void>[] = [];
    for (let i = 0; i < actualConcurrency; i++) {
      promiseList.push(help());
    }

    await Promise.all(promiseList);
    const totalTime = Date.now() - startTime;
    debugLog(
      `[DelayManager] 批量测试完成 组:${group} 总耗时:${totalTime}ms 节点:${names.length}`,
    );
  }

  /**
   * 批量静默写入后触发一次全局与分组监听刷新（避免每条 setDelay 触发全量防抖风暴）。
   */
  flushAfterBulkSilentWrites() {
    this.scheduleGlobalFlush();
    this.scheduleNotifyAllGroupListeners();
  }

  /** 组级测速开始前将成员标为测试中（-2） */
  markGroupDelayTesting(groupName: string, memberNames: string[]) {
    for (const name of memberNames) {
      if (!name || name === "DIRECT" || name === "REJECT") continue;
      this.setDelay(name, groupName, -2, { silentGlobal: true });
    }
    this.flushAfterBulkSilentWrites();
  }

  /**
   * 将内核组级 URLTest（`GET /group/{name}/delay`，与 Android `healthCheckWithTimeout` 同源）的
   * 结果写入 UI 缓存。未出现在 `delays` 中的成员视为测速失败或超时，按 delay 0 处理。
   */
  applyGroupUrlTestDelays(
    groupName: string,
    memberNames: string[],
    delays: Record<string, number>,
    opts?: { bulkReuseMap?: Map<string, DelayUpdate>; timeout?: number },
  ) {
    for (const name of memberNames) {
      if (!name || name === "DIRECT" || name === "REJECT") continue;
      const raw = delays[name];
      const value =
        raw != null && Number.isFinite(raw) && raw > 0 ? raw : 0;
      const update = this.setDelay(name, groupName, value, {
        silentGlobal: true,
      });
      opts?.bulkReuseMap?.set(name, { ...update });
    }
    // 组级 URLTest 已由内核记账；此处只同步磁盘统计到前端缓存
    void hydrateConnectivityStatsFromDisk();
    this.flushAfterBulkSilentWrites();
  }

  /**
   * 无有效 bulk 缓存的出站名（不含 DIRECT/REJECT）。
   * 用于「全部测速」等会话：后续组可跳过已在同会话 `bulkReuseMap` 中的叶子。
   */
  listNamesMissingBulkReuse(
    memberNames: string[],
    reuseMap: Map<string, DelayUpdate>,
  ): string[] {
    const out: string[] = [];
    for (const name of memberNames) {
      if (!name || name === "DIRECT" || name === "REJECT") continue;
      const c = reuseMap.get(name);
      if (c === undefined || c.delay === -2) {
        out.push(name);
      }
    }
    return out;
  }

  /**
   * 将同会话 bulk 缓存中已有的延迟写入当前组上下文（不发起测速）。
   */
  applyBulkReuseHitsForGroup(
    groupName: string,
    memberNames: string[],
    reuseMap: Map<string, DelayUpdate>,
  ) {
    for (const name of memberNames) {
      if (!name || name === "DIRECT" || name === "REJECT") continue;
      const c = reuseMap.get(name);
      if (c === undefined || c.delay === -2) continue;
      this.setDelay(name, groupName, c.delay, {
        elapsed: c.elapsed,
        silentGlobal: true,
      });
      debugLog(
        `[DelayManager] 复用同会话测速结果 代理:${name} 组:${groupName} delay:${c.delay}`,
      );
    }
    this.flushAfterBulkSilentWrites();
  }

  formatDelay(delay: number, timeout = DEFAULT_GROUP_TIMEOUT_MS) {
    if (delay === -1) return "-";
    if (delay === -2) return "testing";
    if (delay === 0 || (delay >= timeout && delay <= 1e5)) return "T";
    if (delay > 1e5) return "E";
    return `${delay}`;
  }

  formatDelayColor(delay: number, timeout = DEFAULT_GROUP_TIMEOUT_MS) {
    if (delay < 0) return "";
    // T (timeout) 或 E (error) 显示为红色
    if (delay === 0 || (delay >= timeout && delay <= 1e5)) return "error.main";
    if (delay > 1e5) return "error.main";
    // 所有成功的节点（不是 T 或 E）都显示为浅绿色
    return "success.main";
  }
}

/** 经指定出站节点访问自定义 URL 的延迟（不走 Clash 规则路径，强制使用该节点） */
export async function checkProxyDelayForUrl(
  proxyName: string,
  url: string,
  timeout: number,
): Promise<number> {
  try {
    const timeoutPromise = new Promise<ProxyDelay>((resolve) => {
      setTimeout(() => resolve({ delay: 0 }), timeout);
    });
    const result = await Promise.race([
      delayProxyByName(proxyName, url, timeout),
      timeoutPromise,
    ]);
    return result.delay;
  } catch {
    return 1e6;
  }
}

export default new DelayManager();
