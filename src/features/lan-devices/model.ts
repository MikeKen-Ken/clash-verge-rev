export interface LanDeviceItem {
  sourceIp: string;
  connections: IConnectionsItem[];
  connectionCount: number;
  upload: number;
  download: number;
  latestStart: number;
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
    .map(([sourceIp, list]) => ({
      sourceIp,
      connections: list,
      connectionCount: list.length,
      upload: list.reduce((sum, conn) => sum + (conn.upload ?? 0), 0),
      download: list.reduce((sum, conn) => sum + (conn.download ?? 0), 0),
      latestStart: list.reduce(
        (latest, conn) => Math.max(latest, new Date(conn.start || 0).getTime()),
        0,
      ),
    }))
    .sort((a, b) => b.connectionCount - a.connectionCount || b.latestStart - a.latestStart);
};
