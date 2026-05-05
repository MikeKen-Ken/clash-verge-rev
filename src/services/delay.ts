import { delayProxyByName, ProxyDelay } from "tauri-plugin-mihomo-api";

import { debugLog } from "@/utils/debug";

const hashKey = (name: string, group: string) => `${group ?? ""}::${name}`;

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

const CACHE_TTL = 30 * 60 * 1000;
const DELAY_CHECK_CONCURRENCY_STORAGE_KEY = "health_check_concurrency";
export const DELAY_CHECK_CONCURRENCY_PRESETS = [30, 50, 100, 150, 200] as const;
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
  private cache = new Map<string, DelayUpdate>();
  private urlMap = new Map<string, string>();

  // 每个节点的监听
  private listenerMap = new Map<string, (update: DelayUpdate) => void>();

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

  setGlobalListener(listener: () => void) {
    this.globalListener = listener;
  }

  removeGlobalListener() {
    this.globalListener = null;
  }

  setUrl(group: string, url: string) {
    debugLog(`[DelayManager] 设置测试URL，组: ${group}, URL: ${url}`);
    this.urlMap.set(group, url);
  }

  getUrl(group: string) {
    const url = this.urlMap.get(group);
    debugLog(
      `[DelayManager] 获取测试URL，组: ${group}, URL: ${url || "未设置"}`,
    );
    // 如果未设置URL，返回默认URL
    return url || "https://cp.cloudflare.com/generate_204";
  }

  setListener(
    name: string,
    group: string,
    listener: (update: DelayUpdate) => void,
  ) {
    const key = hashKey(name, group);
    this.listenerMap.set(key, listener);
  }

  removeListener(name: string, group: string) {
    const key = hashKey(name, group);
    this.listenerMap.delete(key);
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
    const key = hashKey(name, group);
    debugLog(
      `[DelayManager] 设置延迟，代理: ${name}, 组: ${group}, 延迟: ${delay}`,
    );
    const update: DelayUpdate = {
      delay,
      elapsed: meta?.elapsed,
      updatedAt: Date.now(),
    };

    this.cache.set(key, update);

    const queue = this.pendingItemUpdates.get(key);
    if (queue) {
      queue.push(update);
    } else {
      this.pendingItemUpdates.set(key, [update]);
    }
    this.scheduleItemFlush();
    if (!meta?.silentGlobal) {
      this.scheduleGlobalFlush();
    }

    return update;
  }

  getDelayUpdate(name: string, group: string) {
    const key = hashKey(name, group);
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.updatedAt > CACHE_TTL) {
      this.cache.delete(key);
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
    options?: {
      /** 为 true 时仅更新该节点延迟，不触发全量 refreshProxy */
      silentGlobal?: boolean;
    },
  ): Promise<DelayUpdate> {
    debugLog(
      `[DelayManager] 开始测试延迟，代理: ${name}, 组: ${group}, 超时: ${timeout}ms`,
    );

    const silent = options?.silentGlobal ?? false;
    // 先将状态设置为测试中（与安卓端一致：每次测速请求核心，不在前端跨组复用缓存）
    this.setDelay(name, group, -2, { silentGlobal: silent });

    let delay = -1;
    let elapsed = 0;

    const startTime = Date.now();

    try {
      const url = this.getUrl(group);
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

    return this.setDelay(name, group, delay, { elapsed, silentGlobal: silent });
  }

  async checkListDelay(
    nameList: string[],
    group: string,
    timeout: number,
    /** 显式并发上限；省略时使用代理页「Health check concurrency」所选值 */
    concurrency?: number,
  ) {
    const names = nameList.filter(Boolean);
    const requested = concurrency ?? delayCheckConcurrency;
    const actualConcurrency = Math.min(requested, delayCheckConcurrency, names.length);
    debugLog(
      `[DelayManager] 批量测试开始 组:${group} 数量:${names.length} 并发:${actualConcurrency} timeout:${timeout}ms`,
    );
    const startTime = Date.now();

    // 设置正在延迟测试中
    names.forEach((name) => this.setDelay(name, group, -2));

    let index = 0;
    const listener = this.groupListenerMap.get(group);

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

        await this.checkDelay(currName, group, timeout);
        const nodeElapsed = Date.now() - nodeStart;
        debugLog(
          `[DelayManager] 单节点API 代理:${currName} 耗时:${nodeElapsed}ms`,
        );
        if (listener) {
          this.queueGroupNotification(group);
        }
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

export default new DelayManager();
