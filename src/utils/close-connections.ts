import { closeConnection, getConnections } from "tauri-plugin-mihomo-api";

import { isLanSourceIp } from "@/features/lan-devices/model";
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

/**
 * 根据 sourceIP 批量关闭连接
 * @returns 返回关闭的连接数量
 */
export async function closeConnectionsBySourceIp(sourceIp: string): Promise<number> {
  try {
    const { connections } = await getConnections();
    if (!connections || connections.length === 0) {
      debugLog("[CloseConnectionsBySourceIp] No connections found");
      return 0;
    }

    const connectionsToClose = connections.filter(
      (conn) => conn.metadata?.sourceIP === sourceIp,
    );

    if (connectionsToClose.length === 0) {
      debugLog(`[CloseConnectionsBySourceIp] No connections for ${sourceIp}`);
      return 0;
    }

    const closePromises = connectionsToClose.map((conn) =>
      closeConnection(conn.id).catch((error) => {
        console.error(
          `[CloseConnectionsBySourceIp] Failed to close connection ${conn.id}:`,
          error,
        );
        return null;
      }),
    );
    const results = await Promise.allSettled(closePromises);
    return results.filter(
      (result) => result.status === "fulfilled" && result.value !== null,
    ).length;
  } catch (error) {
    console.error("[CloseConnectionsBySourceIp] Error closing connections:", error);
    throw error;
  }
}

/**
 * 关闭全部局域网来源连接
 * @returns 返回关闭的连接数量
 */
export async function closeLanConnections(): Promise<number> {
  try {
    const { connections } = await getConnections();
    if (!connections || connections.length === 0) {
      debugLog("[CloseLanConnections] No connections found");
      return 0;
    }

    const connectionsToClose = connections.filter((conn) =>
      isLanSourceIp(conn.metadata?.sourceIP),
    );
    if (connectionsToClose.length === 0) {
      debugLog("[CloseLanConnections] No LAN connections to close");
      return 0;
    }

    const closePromises = connectionsToClose.map((conn) =>
      closeConnection(conn.id).catch((error) => {
        console.error(`[CloseLanConnections] Failed to close connection ${conn.id}:`, error);
        return null;
      }),
    );
    const results = await Promise.allSettled(closePromises);
    return results.filter(
      (result) => result.status === "fulfilled" && result.value !== null,
    ).length;
  } catch (error) {
    console.error("[CloseLanConnections] Error closing LAN connections:", error);
    throw error;
  }
}
