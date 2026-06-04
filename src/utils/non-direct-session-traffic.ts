/** 当前会话内、经代理转发（非 DIRECT）的累计上下行字节数 */
export interface NonDirectSessionTraffic {
  download: number;
  upload: number;
}

/**
 * 仅统计非直连（未走 DIRECT）、且在当前会话（sessionStartMs）之后建立的连接流量。
 * 切换 TUN 或重置会话后从 0 重新累计。
 */
type ConnectionTrafficInput = {
  activeConnections?: IConnectionsItem[];
  closedConnections?: IConnectionsItem[];
};

export const computeNonDirectSessionTraffic = (
  connections: ConnectionTrafficInput | undefined,
  sessionStartMs: number,
): NonDirectSessionTraffic => {
  const active = connections?.activeConnections ?? [];
  const closed = connections?.closedConnections ?? [];
  let download = 0;
  let upload = 0;
  for (const c of active) {
    if (c.chains?.includes?.("DIRECT")) continue;
    const connStartMs = new Date(c.start || 0).getTime();
    if (connStartMs < sessionStartMs) continue;
    download += c.download ?? 0;
    upload += c.upload ?? 0;
  }
  for (const c of closed) {
    if (c.chains?.includes?.("DIRECT")) continue;
    const connStartMs = new Date(c.start || 0).getTime();
    if (connStartMs < sessionStartMs) continue;
    download += c.download ?? 0;
    upload += c.upload ?? 0;
  }
  return { download, upload };
};
