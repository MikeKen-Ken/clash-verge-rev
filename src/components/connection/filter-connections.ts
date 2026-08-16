type OrderFunc = (list: IConnectionsItem[]) => IConnectionsItem[];

export const CONNECTION_ORDER_OPTIONS = [
  {
    id: "default",
    labelKey: "connections.components.order.default",
    fn: (list: IConnectionsItem[]) =>
      list.sort(
        (a, b) =>
          new Date(b.start || "0").getTime()! -
          new Date(a.start || "0").getTime()!,
      ),
  },
  {
    id: "uploadSpeed",
    labelKey: "connections.components.order.uploadSpeed",
    fn: (list: IConnectionsItem[]) =>
      list.sort((a, b) => b.curUpload! - a.curUpload!),
  },
  {
    id: "downloadSpeed",
    labelKey: "connections.components.order.downloadSpeed",
    fn: (list: IConnectionsItem[]) =>
      list.sort((a, b) => b.curDownload! - a.curDownload!),
  },
] as const;

export type ConnectionOrderKey = (typeof CONNECTION_ORDER_OPTIONS)[number]["id"];

const orderFunctionMap = CONNECTION_ORDER_OPTIONS.reduce<
  Record<ConnectionOrderKey, OrderFunc>
>(
  (acc, option) => {
    acc[option.id] = option.fn;
    return acc;
  },
  {} as Record<ConnectionOrderKey, OrderFunc>,
);

/** 按域名合并已关闭连接，合并下载量、上传量 */
export const mergeClosedConnectionsByHost = (
  list: IConnectionsItem[],
): IConnectionsItem[] => {
  const byHost = new Map<string, IConnectionsItem[]>();
  for (const conn of list) {
    const key =
      conn.metadata?.host ||
      conn.metadata?.remoteDestination ||
      conn.metadata?.destinationIP ||
      conn.id;
    if (!byHost.has(key)) byHost.set(key, []);
    byHost.get(key)!.push(conn);
  }
  return Array.from(byHost.entries()).map(([hostKey, group]) => {
    const first = group[0]!;
    const upload = group.reduce((s, c) => s + (c.upload ?? 0), 0);
    const download = group.reduce((s, c) => s + (c.download ?? 0), 0);
    const latest = group.reduce(
      (latestItem, c) =>
        new Date(c.start || "0").getTime() >
        new Date(latestItem.start || "0").getTime()
          ? c
          : latestItem,
      first,
    );
    return {
      ...latest,
      id: `merged-${hostKey}-${first.id}`,
      upload,
      download,
      curUpload: 0,
      curDownload: 0,
    } as IConnectionsItem;
  });
};

export interface FilterConnectionsInput {
  connections:
    | {
        activeConnections?: IConnectionsItem[];
        closedConnections?: IConnectionsItem[];
      }
    | undefined;
  connectionsType: "active" | "closed";
  blockedLanIpSet: Set<string>;
  match: (input: string) => boolean;
  orderKey: ConnectionOrderKey;
  mergeByDomain: boolean;
  isTableLayout: boolean;
  hasSearchQuery: boolean;
}

/** 表格默认路径直接复用快照数组，避免每秒 filter/clone/sort */
export const filterConnectionsForDisplay = ({
  connections,
  connectionsType,
  blockedLanIpSet,
  match,
  orderKey,
  mergeByDomain,
  isTableLayout,
  hasSearchQuery,
}: FilterConnectionsInput): IConnectionsItem[] => {
  const orderFunc = orderFunctionMap[orderKey];
  const conns =
    connectionsType === "active"
      ? (connections?.activeConnections ?? [])
      : (connections?.closedConnections ?? []);
  const visibleConns =
    connectionsType === "active" && blockedLanIpSet.size > 0
      ? conns.filter(
          (conn) => !blockedLanIpSet.has(conn.metadata?.sourceIP || ""),
        )
      : conns;

  if (
    isTableLayout &&
    !hasSearchQuery &&
    !(connectionsType === "closed" && mergeByDomain)
  ) {
    return visibleConns;
  }

  let matchConns = hasSearchQuery
    ? visibleConns.filter((conn) => {
        const { host, destinationIP, process } = conn.metadata;
        return (
          match(host || "") ||
          match(destinationIP || "") ||
          match(process || "")
        );
      })
    : visibleConns;

  if (!isTableLayout && orderFunc) matchConns = orderFunc([...matchConns]);

  if (connectionsType === "closed" && mergeByDomain && matchConns.length > 0) {
    matchConns = mergeClosedConnectionsByHost(matchConns);
    if (!isTableLayout && orderFunc) matchConns = orderFunc(matchConns);
  }

  return matchConns;
};
