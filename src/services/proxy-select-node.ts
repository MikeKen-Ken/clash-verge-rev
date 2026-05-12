import { selectNodeForGroup as selectNodeForGroupRaw } from "tauri-plugin-mihomo-api";

/**
 * 调用核心切换代理组选中节点（PUT /proxies/{group}）。
 * 耗时主要来自 mihomo 处理该请求（与测速、规则匹配等争用同一把内核锁时常达数秒）；Tauri IPC 通常只占毫秒级。
 * 日志：浏览器控制台 `[核心切换-前端]`；Rust 侧见 tauri-plugin-mihomo `mihomo.rs` 中 `[核心切换]`。
 */
export async function selectNodeForGroup(
  groupName: string,
  proxyName: string,
): Promise<void> {
  const t0 = performance.now();
  console.log("[核心切换-前端] invoke 开始", {
    组: groupName,
    节点: proxyName,
    ts: Date.now(),
  });
  try {
    await selectNodeForGroupRaw(groupName, proxyName);
    const ms = Math.round(performance.now() - t0);
    console.log("[核心切换-前端] invoke 结束", {
      组: groupName,
      节点: proxyName,
      耗时_ms: ms,
    });
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    console.log("[核心切换-前端] invoke 失败", {
      组: groupName,
      节点: proxyName,
      耗时_ms: ms,
      err,
    });
    throw err;
  }
}
