export interface LanDeviceItem {
  sourceIp: string;
  connections: IConnectionsItem[];
  connectionCount: number;
  upload: number;
  download: number;
  latestStart: number;
  latestHost: string;
}

export const isLanSourceIp = (ip: string | undefined): boolean => {
  if (!ip) return false;
  const normalized = ip.trim().toLowerCase();
  // Exclude loopback / unspecified / multicast
  if (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized.startsWith("ff")
  ) {
    return false;
  }

  // IPv6: ULA(fc00::/7) and link-local(fe80::/10)
  if (normalized.includes(":")) {
    return (
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }

  // IPv4 private ranges; exclude IPv4 link-local
  if (normalized.startsWith("169.254.")) return false;
  if (normalized.startsWith("192.168.") || normalized.startsWith("10.")) return true;
  const second = Number(normalized.split(".")[1] || "-1");
  return normalized.startsWith("172.") && second >= 16 && second <= 31;
};

export const buildLanDeviceItems = (
  connections: IConnectionsItem[],
): LanDeviceItem[] => {
  const byIp = new Map<string, IConnectionsItem[]>();
  connections.forEach((conn) => {
    const sourceIp = conn.metadata?.sourceIP;
    if (!isLanSourceIp(sourceIp)) return;
    if (!byIp.has(sourceIp!)) byIp.set(sourceIp!, []);
    byIp.get(sourceIp!)!.push(conn);
  });

  return Array.from(byIp.entries())
    .map(([sourceIp, list]) => {
      const latestConnection = list.reduce<IConnectionsItem | null>((latest, conn) => {
        if (!latest) return conn;
        return new Date(conn.start || 0).getTime() > new Date(latest.start || 0).getTime()
          ? conn
          : latest;
      }, null);
      const latestHost = latestConnection
        ? latestConnection.metadata?.host
          ? `${latestConnection.metadata.host}:${latestConnection.metadata.destinationPort}`
          : `${latestConnection.metadata?.remoteDestination || latestConnection.metadata?.destinationIP || ""}:${latestConnection.metadata.destinationPort}`
        : "";
      return {
        sourceIp,
        connections: list,
        connectionCount: list.length,
        upload: list.reduce((sum, conn) => sum + (conn.upload ?? 0), 0),
        download: list.reduce((sum, conn) => sum + (conn.download ?? 0), 0),
        latestStart: list.reduce(
          (latest, conn) => Math.max(latest, new Date(conn.start || 0).getTime()),
          0,
        ),
        latestHost,
      };
    })
    .sort((a, b) => b.connectionCount - a.connectionCount || b.latestStart - a.latestStart);
};

export const extractLocalInterfaceIps = (
  networkInterfaces: INetworkInterface[] | undefined,
): Set<string> => {
  const localIps = new Set<string>();
  (networkInterfaces ?? []).forEach((iface) => {
    iface.addr?.forEach((addr) => {
      const v4 = addr.V4?.ip?.trim();
      const v6 = addr.V6?.ip?.trim();
      if (v4) localIps.add(v4);
      if (v6) localIps.add(v6.toLowerCase());
    });
  });
  return localIps;
};

/**
 * 设备视图只统计“远端局域网客户端”的连接，排除本机进程和本机网卡 IP。
 * 这样可以避免将 adb 等本机发起的局域网连接误识别为 LAN 设备接入。
 */
export const isRemoteLanClientConnection = (
  conn: IConnectionsItem,
  localInterfaceIps: Set<string>,
): boolean => {
  const sourceIp = (conn.metadata?.sourceIP || "").trim();
  if (!isLanSourceIp(sourceIp)) return false;
  if (localInterfaceIps.has(sourceIp) || localInterfaceIps.has(sourceIp.toLowerCase())) {
    return false;
  }
  const processName = (conn.metadata?.process || "").trim();
  const processPath = (conn.metadata?.processPath || "").trim();
  if (processName || processPath) return false;
  return true;
};
