import { selectNodeForGroup as selectNodeForGroupRaw } from "tauri-plugin-mihomo-api";

function makeRequestId(): string {
  try {
    const u = crypto.randomUUID?.();
    if (u) return u.slice(0, 8);
  } catch {
    /* ignore */
  }
  return String(Date.now()).slice(-8);
}

/**
 * 调用核心切换代理组选中节点（PUT /proxies/{group}）。
 * 耗时主要来自 mihomo 处理该请求（与测速、规则匹配等争用同一把内核锁时常达数秒）；Tauri IPC 通常只占毫秒级。
 * 日志：浏览器控制台 `[核心切换-前端]`；Rust 侧见 `src-tauri/src/feat/profile.rs` 与 tauri-plugin-mihomo 中 `[核心切换]`。
 */
export async function selectNodeForGroup(
  groupName: string,
  proxyName: string,
): Promise<void> {
  const rid = makeRequestId();
  const t0 = performance.now();
  const envHint =
    typeof document !== "undefined"
      ? {
        visibilityState: document.visibilityState,
        hidden: document.hidden,
      }
      : {};
  console.log("[核心切换-前端] invoke 开始", {
    rid,
    组: groupName,
    节点: proxyName,
    ts: Date.now(),
    ...envHint,
  });
  try {
    await selectNodeForGroupRaw(groupName, proxyName);
    const elapsed = performance.now() - t0;
    const ms = Math.round(elapsed);
    console.log("[核心切换-前端] invoke 结束", {
      rid,
      组: groupName,
      节点: proxyName,
      耗时_ms: ms,
      耗时_ms_高精度: Number(elapsed.toFixed(2)),
    });
    if (ms >= 2000) {
      console.warn("[核心切换-前端] invoke 偏慢，常见原因：内核正忙（批量测速/healthcheck/规则集更新）、🔀 等策略组内部重算、或首次连 API 套接字较慢。可对照同一时间点的应用日志中 `[核心切换]`（Rust）以区分 IPC 与 HTTP。", {
        rid,
        组: groupName,
        节点: proxyName,
        耗时_ms: ms,
      });
    }
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    console.log("[核心切换-前端] invoke 失败", {
      rid,
      组: groupName,
      节点: proxyName,
      耗时_ms: ms,
      err,
    });
    throw err;
  }
}
