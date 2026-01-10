import { closeConnection, getConnections } from "tauri-plugin-mihomo-api";
import { debugLog } from "./debug";

/**
 * 关闭所有连接，但排除包含 DIRECT 的连接
 * @returns 返回关闭的连接数量
 */
export async function closeConnectionsExcludingDirect(): Promise<number> {
  try {
    const { connections } = await getConnections();
    if (!connections || connections.length === 0) {
      debugLog("[CloseConnections] No connections found");
      return 0;
    }

    // 过滤出所有不包含 DIRECT 的连接
    const connectionsToClose = connections.filter((conn) => {
      // 检查 chains 数组中是否包含 "DIRECT"
      return !conn.chains.includes("DIRECT");
    });

    if (connectionsToClose.length === 0) {
      debugLog("[CloseConnections] No connections to close (all are DIRECT)");
      return 0;
    }

    debugLog(
      `[CloseConnections] Closing ${connectionsToClose.length} connections (excluding DIRECT)`,
    );

    // 并行关闭所有符合条件的连接
    const closePromises = connectionsToClose.map((conn) =>
      closeConnection(conn.id).catch((error) => {
        console.error(`[CloseConnections] Failed to close connection ${conn.id}:`, error);
        return null;
      }),
    );

    const results = await Promise.allSettled(closePromises);
    const successCount = results.filter(
      (result) => result.status === "fulfilled" && result.value !== null,
    ).length;

    debugLog(
      `[CloseConnections] Successfully closed ${successCount}/${connectionsToClose.length} connections`,
    );

    return successCount;
  } catch (error) {
    console.error("[CloseConnections] Error closing connections:", error);
    throw error;
  }
}
