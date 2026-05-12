import { selectNodeForGroup as selectNodeForGroupRaw } from "tauri-plugin-mihomo-api";

/** 控制台与排查用；取值保持简短稳定 */
export type SelectNodeForGroupCallReason =
  | "proxy-ui-manual"
  | "proxy-ui-delay-bulk-auto"
  | "connections-close-all-auto"
  | "proxy-chain";

export interface SelectNodeForGroupOptions {
  reason?: SelectNodeForGroupCallReason;
}

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
  options?: SelectNodeForGroupOptions,
): Promise<void> {
  const rid = makeRequestId();
  const reason: SelectNodeForGroupCallReason =
    options?.reason ?? "proxy-ui-manual";
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
    调用原因: reason,
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
      调用原因: reason,
      组: groupName,
      节点: proxyName,
      耗时_ms: ms,
      耗时_ms_高精度: Number(elapsed.toFixed(2)),
    });
    if (ms >= 2000) {
      const bulkHint =
        reason === "proxy-ui-delay-bulk-auto"
          ? " 当前为「全部测速」后自动切节点：若刚跑完组级/逐节点测速，内核队列未清空时出现数秒延迟较常见。"
          : "";
      console.warn(
        `[核心切换-前端] invoke 偏慢，常见原因：内核正忙（批量测速/healthcheck/规则集更新）、🔀 等策略组内部重算、或首次连 API 套接字较慢。可对照同一时间点的应用日志中 \`[核心切换]\`（Rust）以区分 IPC 与 HTTP。${bulkHint}`,
        {
          rid,
          调用原因: reason,
          组: groupName,
          节点: proxyName,
          耗时_ms: ms,
        },
      );
    }
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    console.log("[核心切换-前端] invoke 失败", {
      rid,
      调用原因: reason,
      组: groupName,
      节点: proxyName,
      耗时_ms: ms,
      err,
    });
    throw err;
  }
}
