import {
  ArrowDropDown,
  DeleteForeverRounded,
  MergeTypeRounded,
  TableChartRounded,
  TableRowsRounded,
} from "@mui/icons-material";
import {
  Box,
  Button,
  ButtonGroup,
  IconButton,
  Menu,
  MenuItem,
  Typography,
} from "@mui/material";
import { useLockFn } from "ahooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";
import { closeAllConnections } from "tauri-plugin-mihomo-api";

import {
  BaseEmpty,
  BasePage,
  BaseSearchBox,
  BaseStyledSelect,
} from "@/components/base";
import {
  ConnectionDetail,
  ConnectionDetailRef,
} from "@/components/connection/connection-detail";
import { ConnectionItem } from "@/components/connection/connection-item";
import { ConnectionTable } from "@/components/connection/connection-table";
import {
  filterClosedConnectionsByRetention,
  useConnectionData,
} from "@/hooks/use-connection-data";
import {
  CLOSED_CONNECTIONS_RETENTION_HOURS,
  useConnectionSetting,
} from "@/hooks/use-connection-setting";
import { useClash } from "@/hooks/use-clash";
import { showNotice } from "@/services/notice-service";
import {
  buildLanDeviceItems,
  extractLocalInterfaceIps,
  isLanSourceIp,
  isRemoteLanClientConnection,
} from "@/features/lan-devices/model";
import {
  addBlockedLanSourceIp,
  normalizeBlockedLanSourceIps,
} from "@/features/lan-devices/state";
import { useNetworkInterfaces } from "@/hooks/use-network";
import parseTraffic from "@/utils/parse-traffic";
import {
  closeConnectionsBySourceIp,
  closeConnectionsExcludingDirect,
} from "@/utils/close-connections";
import { patchRuntimeConfig } from "@/services/cmds";

type OrderFunc = (list: IConnectionsItem[]) => IConnectionsItem[];

const ORDER_OPTIONS = [
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
const DEFAULT_LAN_SILENT_THRESHOLD_SECONDS = 60;

type OrderKey = (typeof ORDER_OPTIONS)[number]["id"];

const orderFunctionMap = ORDER_OPTIONS.reduce<Record<OrderKey, OrderFunc>>(
  (acc, option) => {
    acc[option.id] = option.fn;
    return acc;
  },
  {} as Record<OrderKey, OrderFunc>,
);

/** 按域名合并已关闭连接，合并下载量、上传量 */
const mergeClosedConnectionsByHost = (
  list: IConnectionsItem[],
): IConnectionsItem[] => {
  const byHost = new Map<string, IConnectionsItem[]>();
  for (const conn of list) {
    const key = conn.metadata?.host || conn.metadata?.remoteDestination || conn.metadata?.destinationIP || conn.id;
    if (!byHost.has(key)) byHost.set(key, []);
    byHost.get(key)!.push(conn);
  }
  return Array.from(byHost.entries()).map(([hostKey, group]) => {
    const first = group[0]!;
    const upload = group.reduce((s, c) => s + (c.upload ?? 0), 0);
    const download = group.reduce((s, c) => s + (c.download ?? 0), 0);
    const latest = group.reduce(
      (latest, c) =>
        new Date(c.start || "0").getTime() > new Date(latest.start || "0").getTime()
          ? c
          : latest,
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

const ConnectionsPage = () => {
  const { t } = useTranslation();
  const [match, setMatch] = useState<(input: string) => boolean>(
    () => () => true,
  );
  const [curOrderOpt, setCurOrderOpt] = useState<OrderKey>("default");
  const [connectionsType, setConnectionsType] = useState<"active" | "closed">(
    "active",
  );
  const [mergeByDomain, setMergeByDomain] = useState(false);
  const [blockedLanIps, setBlockedLanIps] = useState<string[]>([]);
  const [lanMaxDevices, setLanMaxDevices] = useState<number>(0);
  const [lanSilentThresholdSeconds, setLanSilentThresholdSeconds] = useState<number>(
    DEFAULT_LAN_SILENT_THRESHOLD_SECONDS,
  );
  const lastActiveAtByIpRef = useRef<Map<string, number>>(new Map());
  const blockedLanIpsRef = useRef<string[]>([]);
  const lanSettingsRef = useRef({
    lanMaxDevices: 0,
    lanSilentThresholdSeconds: DEFAULT_LAN_SILENT_THRESHOLD_SECONDS,
  });
  const lanSettingsPersistPendingRef = useRef(false);
  const lanSettingsPersistRunningRef = useRef(false);
  const closingBlockedIpsRef = useRef<Set<string>>(new Set());
  const blockedCloseLastRunAtRef = useRef<Map<string, number>>(new Map());
  const { clash } = useClash();
  const { networkInterfaces } = useNetworkInterfaces();

  const {
    response: { data: connections },
    clearClosedConnections,
    sessionStartMs,
  } = useConnectionData();

  const [setting, setSetting] = useConnectionSetting();
  const connectionsView = setting?.connectionsView ?? "connections";

  const isTableLayout = setting.layout === "table";
  const blockedLanIpSet = useMemo(() => new Set(blockedLanIps), [blockedLanIps]);
  const localInterfaceIps = useMemo(
    () => extractLocalInterfaceIps(networkInterfaces),
    [networkInterfaces],
  );

  const [isColumnManagerOpen, setIsColumnManagerOpen] = useState(false);

  /**
   * 仅统计非直连（未走 DIRECT）、且在当前会话（sessionStartMs）之后建立的连接流量。
   * 排除 sessionStartMs 之前的连接，使得重启软件或切换 TUN 模式后流量从 0 重新计算。
   */
  const nonDirectTraffic = useMemo(() => {
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
      // Skip connections that were established before the current session started
      // (e.g. restored from IndexedDB cache from a previous run or pre-TUN-toggle session).
      const connStartMs = new Date(c.start || 0).getTime();
      if (connStartMs < sessionStartMs) continue;
      download += c.download ?? 0;
      upload += c.upload ?? 0;
    }
    return { download, upload };
  }, [connections?.activeConnections, connections?.closedConnections, sessionStartMs]);

  const [filterConn] = useMemo(() => {
    const orderFunc = orderFunctionMap[curOrderOpt];
    const closedRaw = connections?.closedConnections ?? [];
    const closedForDisplay = filterClosedConnectionsByRetention(
      closedRaw,
      setting?.closedConnectionsRetentionHours ?? 8,
    );
    const conns =
      connectionsType === "active"
        ? (connections?.activeConnections ?? [])
        : closedForDisplay;
    const visibleConns =
      connectionsType === "active"
        ? conns.filter((conn) => !blockedLanIpSet.has(conn.metadata?.sourceIP || ""))
        : conns;
    let matchConns = visibleConns.filter((conn) => {
      const { host, destinationIP, process } = conn.metadata;
      return (
        match(host || "") || match(destinationIP || "") || match(process || "")
      );
    });

    // 避免原地排序修改引用，减少高频推送时的重排与闪动
    if (orderFunc) matchConns = orderFunc([...matchConns]);

    if (connectionsType === "closed" && mergeByDomain && matchConns.length > 0) {
      matchConns = mergeClosedConnectionsByHost(matchConns);
      if (orderFunc) matchConns = orderFunc(matchConns);
    }

    return [matchConns];
  }, [connections, connectionsType, match, curOrderOpt, mergeByDomain, setting?.closedConnectionsRetentionHours, blockedLanIpSet]);

  const activeLanConnections = useMemo(() => {
    const active = connections?.activeConnections ?? [];
    return active.filter(
      (conn) =>
        !blockedLanIpSet.has(conn.metadata?.sourceIP || "") &&
        isRemoteLanClientConnection(conn, localInterfaceIps),
    );
  }, [connections?.activeConnections, blockedLanIpSet, localInterfaceIps]);
  const silentDeviceItems = useMemo(() => {
    if (connectionsType !== "active") return [];
    const byIp = new Map<string, IConnectionsItem[]>();
    activeLanConnections.forEach((conn) => {
      const sourceIp = conn.metadata?.sourceIP || "";
      if (!sourceIp) return;
      if (!byIp.has(sourceIp)) byIp.set(sourceIp, []);
      byIp.get(sourceIp)!.push(conn);
    });
    const now = Date.now();
    const result: { ip: string; lastUsed: number }[] = [];
    byIp.forEach((list, ip) => {
      const hasTraffic = list.some(
        (conn) => (conn.curUpload ?? 0) > 0 || (conn.curDownload ?? 0) > 0,
      );
      const latestStart = list.reduce(
        (latest, conn) => Math.max(latest, new Date(conn.start || 0).getTime()),
        0,
      );
      if (hasTraffic) {
        lastActiveAtByIpRef.current.set(ip, now);
        return;
      }
      const lastActiveAt = lastActiveAtByIpRef.current.get(ip) ?? latestStart;
      if (lastActiveAt > 0 && now - lastActiveAt >= lanSilentThresholdSeconds * 1000) {
        result.push({ ip, lastUsed: lastActiveAt });
      }
    });
    return result.sort((a, b) => b.lastUsed - a.lastUsed);
  }, [activeLanConnections, connectionsType, lanSilentThresholdSeconds]);
  const silentIpSet = useMemo(
    () => new Set(silentDeviceItems.map((item) => item.ip)),
    [silentDeviceItems],
  );
  const activeLanDeviceCount = useMemo(
    () =>
      new Set(
        activeLanConnections
          .map((conn) => conn.metadata?.sourceIP || "")
          .filter((ip) => ip.length > 0),
      ).size,
    [activeLanConnections],
  );
  const lanDeviceItems = useMemo(() => {
    if (connectionsType !== "active") return [];
    const nonSilent = activeLanConnections.filter(
      (conn) => !silentIpSet.has(conn.metadata?.sourceIP || ""),
    );
    return buildLanDeviceItems(nonSilent);
  }, [activeLanConnections, connectionsType, silentIpSet]);
  const blockedLastUsedMap = useMemo(() => {
    const map = new Map<string, number>();
    const all = [
      ...(connections?.activeConnections ?? []),
      ...(connections?.closedConnections ?? []),
    ];
    all.forEach((conn) => {
      const sourceIp = conn.metadata?.sourceIP || "";
      if (!sourceIp || !blockedLanIpSet.has(sourceIp)) return;
      const startMs = new Date(conn.start || 0).getTime();
      if (!Number.isFinite(startMs)) return;
      map.set(sourceIp, Math.max(map.get(sourceIp) ?? 0, startMs));
    });
    return map;
  }, [
    connections?.activeConnections,
    connections?.closedConnections,
    blockedLanIpSet,
  ]);
  const disconnectedDeviceItems = useMemo(() => {
    const active = connections?.activeConnections ?? [];
    const closed = connections?.closedConnections ?? [];
    const activeIpSet = new Set(
      active
        .filter((conn) => isRemoteLanClientConnection(conn, localInterfaceIps))
        .map((conn) => conn.metadata?.sourceIP || "")
        .filter((ip) => ip.length > 0),
    );
    const closedLastUsed = new Map<string, number>();
    closed.forEach((conn) => {
      const ip = conn.metadata?.sourceIP || "";
      if (!ip) return;
      if (!isRemoteLanClientConnection(conn, localInterfaceIps)) return;
      if (blockedLanIpSet.has(ip)) return;
      if (activeIpSet.has(ip)) return;
      const startMs = new Date(conn.start || 0).getTime();
      if (!Number.isFinite(startMs)) return;
      closedLastUsed.set(ip, Math.max(closedLastUsed.get(ip) ?? 0, startMs));
    });
    const disconnected = Array.from(closedLastUsed.entries()).map(([ip, lastUsed]) => ({
      ip,
      lastUsed,
      status: "disconnected" as const,
    }));
    const silent = silentDeviceItems.map((item) => ({
      ip: item.ip,
      lastUsed: item.lastUsed,
      status: "silent" as const,
    }));
    return [...silent, ...disconnected].sort((a, b) => b.lastUsed - a.lastUsed);
  }, [
    connections?.activeConnections,
    connections?.closedConnections,
    blockedLanIpSet,
    silentDeviceItems,
    localInterfaceIps,
  ]);

  const onCloseAll = useLockFn(closeAllConnections);
  const onCloseExcludingDirect = useLockFn(closeConnectionsExcludingDirect);
  const onDisableDevice = useLockFn(async (sourceIp: string) => {
    await closeConnectionsBySourceIp(sourceIp);
    const next = addBlockedLanSourceIp(blockedLanIps, sourceIp);
    await patchRuntimeConfig({
      "clash-for-android": {
        "lan-blocked-devices": next,
      },
    } as Partial<IConfigData>);
    setBlockedLanIps(next);
    showNotice.success("已禁用该设备");
  });
  const onDisconnectDevice = useLockFn(async (sourceIp: string) => {
    const closedCount = await closeConnectionsBySourceIp(sourceIp);
    if (closedCount > 0) {
      showNotice.success(`已断开设备连接（${closedCount}）`);
      return;
    }
    showNotice.success("该设备当前无可断开的连接");
  });
  const onEnableDevice = useLockFn(async (sourceIp: string) => {
    const next = normalizeBlockedLanSourceIps(
      blockedLanIps.filter((ip) => ip !== sourceIp),
    );
    await patchRuntimeConfig({
      "clash-for-android": {
        "lan-blocked-devices": next,
      },
    } as Partial<IConfigData>);
    setBlockedLanIps(next);
    showNotice.success("已从禁用列表移除");
  });
  const flushLanSettingsPersist = useCallback(async () => {
    if (lanSettingsPersistRunningRef.current) return;
    lanSettingsPersistRunningRef.current = true;
    try {
      while (lanSettingsPersistPendingRef.current) {
        lanSettingsPersistPendingRef.current = false;
        const current = lanSettingsRef.current;
        await patchRuntimeConfig({
          "clash-for-android": {
            "lan-max-devices": current.lanMaxDevices,
            "lan-over-limit-action": "reject",
            "lan-silent-threshold-seconds": current.lanSilentThresholdSeconds,
          },
        } as Partial<IConfigData>);
      }
    } finally {
      lanSettingsPersistRunningRef.current = false;
    }
  }, []);
  const queueLanSettingsPersist = useCallback(() => {
    lanSettingsPersistPendingRef.current = true;
    void flushLanSettingsPersist();
  }, [flushLanSettingsPersist]);
  const onLanMaxDevicesChange = useCallback((value: number) => {
    const normalized = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    lanSettingsRef.current = {
      ...lanSettingsRef.current,
      lanMaxDevices: normalized,
    };
    setLanMaxDevices(normalized);
    queueLanSettingsPersist();
    showNotice.success("设备数量限制已生效");
  }, [queueLanSettingsPersist]);
  const onLanSilentThresholdChange = useCallback((value: number) => {
    const normalized = Number.isFinite(value)
      ? Math.max(5, Math.min(3600, Math.floor(value)))
      : DEFAULT_LAN_SILENT_THRESHOLD_SECONDS;
    lanSettingsRef.current = {
      ...lanSettingsRef.current,
      lanSilentThresholdSeconds: normalized,
    };
    setLanSilentThresholdSeconds(normalized);
    queueLanSettingsPersist();
    showNotice.success("静默阈值已生效");
  }, [queueLanSettingsPersist]);

  const [closeMenuAnchor, setCloseMenuAnchor] = useState<null | HTMLElement>(null);
  const isCloseMenuOpen = Boolean(closeMenuAnchor);

  const detailRef = useRef<ConnectionDetailRef>(null!);

  const handleSearch = useCallback((match: (content: string) => boolean) => {
    setMatch(() => match);
  }, []);

  const handleCloseMenuClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    setCloseMenuAnchor(event.currentTarget);
  }, []);

  const handleCloseMenuClose = useCallback(() => {
    setCloseMenuAnchor(null);
  }, []);

  const handleCloseAll = useCallback(() => {
    onCloseAll();
    handleCloseMenuClose();
  }, [onCloseAll, handleCloseMenuClose]);

  const handleCloseExcludingDirect = useCallback(() => {
    onCloseExcludingDirect();
    handleCloseMenuClose();
  }, [onCloseExcludingDirect, handleCloseMenuClose]);

  const hasTableData = filterConn.length > 0;
  const hasDeviceData =
    lanDeviceItems.length > 0 ||
    blockedLanIps.length > 0 ||
    disconnectedDeviceItems.length > 0;

  useEffect(() => {
    const fromConfig =
      clash?.["clash-for-android"]?.["lan-blocked-devices"] ?? [];
    const nextLanMaxDevices = Math.max(
      0,
      clash?.["clash-for-android"]?.["lan-max-devices"] ?? 0,
    );
    const nextLanSilentThresholdSeconds = Math.max(
      5,
      clash?.["clash-for-android"]?.["lan-silent-threshold-seconds"] ??
      DEFAULT_LAN_SILENT_THRESHOLD_SECONDS,
    );
    const nextBlocked = normalizeBlockedLanSourceIps(fromConfig);
    const prevBlocked = blockedLanIpsRef.current;
    const blockedChanged =
      nextBlocked.length !== prevBlocked.length ||
      nextBlocked.some((ip, index) => ip !== prevBlocked[index]);
    if (blockedChanged) {
      blockedLanIpsRef.current = nextBlocked;
      setBlockedLanIps(nextBlocked);
    }
    setLanMaxDevices((prev) => (prev === nextLanMaxDevices ? prev : nextLanMaxDevices));
    setLanSilentThresholdSeconds((prev) =>
      prev === nextLanSilentThresholdSeconds ? prev : nextLanSilentThresholdSeconds,
    );
    lanSettingsRef.current = {
      lanMaxDevices: nextLanMaxDevices,
      lanSilentThresholdSeconds: nextLanSilentThresholdSeconds,
    };
  }, [clash]);

  useEffect(() => {
    const localInterfaceIps = extractLocalInterfaceIps(networkInterfaces);
    const active = connections?.activeConnections ?? [];
    if (active.length === 0 || blockedLanIps.length === 0) return;
    const targets = Array.from(
      new Set(
        active
          .filter((conn) => isRemoteLanClientConnection(conn, localInterfaceIps))
          .map((conn) => conn.metadata?.sourceIP || "")
          .filter((ip) => ip && blockedLanIpSet.has(ip) && isLanSourceIp(ip)),
      ),
    );
    if (targets.length === 0) return;
    const now = Date.now();
    const runnableTargets = targets.filter((ip) => {
      if (closingBlockedIpsRef.current.has(ip)) return false;
      const lastRunAt = blockedCloseLastRunAtRef.current.get(ip) ?? 0;
      // 同一设备短时间内不重复执行关闭，避免高频 ws 更新触发风暴调用
      return now - lastRunAt >= 2000;
    });
    if (runnableTargets.length === 0) return;
    runnableTargets.forEach((ip) => {
      closingBlockedIpsRef.current.add(ip);
      blockedCloseLastRunAtRef.current.set(ip, now);
    });
    void Promise.allSettled(
      runnableTargets.map(async (ip) => {
        try {
          await closeConnectionsBySourceIp(ip);
        } finally {
          closingBlockedIpsRef.current.delete(ip);
        }
      }),
    );
  }, [connections?.activeConnections, blockedLanIpSet, localInterfaceIps]);

  return (
    <BasePage
      full
      title={
        <span style={{ whiteSpace: "nowrap" }}>
          {t("connections.page.title")}
        </span>
      }
      contentStyle={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        borderRadius: "8px",
        minHeight: 0,
      }}
      header={
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          {connectionsType === "closed" && (
            <Button
              size="small"
              variant="outlined"
              color="primary"
              startIcon={<DeleteForeverRounded />}
              onClick={() => clearClosedConnections()}
            >
              {t("shared.actions.clear")}
            </Button>
          )}
          <Box sx={{ mx: 1 }}>
            {t("shared.labels.downloaded")}:{" "}
            {parseTraffic(nonDirectTraffic.download)}
          </Box>
          <Box sx={{ mx: 1 }}>
            {t("shared.labels.uploaded")}:{" "}
            {parseTraffic(nonDirectTraffic.upload)}
          </Box>
          <IconButton
            color="inherit"
            size="small"
            onClick={() =>
              setSetting((o) =>
                o?.layout !== "table"
                  ? { ...o, layout: "table" }
                  : { ...o, layout: "list" },
              )
            }
          >
            {isTableLayout ? (
              <TableRowsRounded titleAccess={t("shared.actions.listView")} />
            ) : (
              <TableChartRounded titleAccess={t("shared.actions.tableView")} />
            )}
          </IconButton>
          <ButtonGroup size="small" variant="contained">
            <Button onClick={handleCloseExcludingDirect}>
              <span style={{ whiteSpace: "nowrap" }}>
                关闭非DIRECT连接
              </span>
            </Button>
            <Button
              size="small"
              aria-controls={isCloseMenuOpen ? "close-menu" : undefined}
              aria-expanded={isCloseMenuOpen ? "true" : undefined}
              aria-haspopup="true"
              onClick={handleCloseMenuClick}
            >
              <ArrowDropDown />
            </Button>
          </ButtonGroup>
          <Menu
            id="close-menu"
            anchorEl={closeMenuAnchor}
            open={isCloseMenuOpen}
            onClose={handleCloseMenuClose}
            MenuListProps={{
              "aria-labelledby": "close-button",
            }}
          >
            <MenuItem onClick={handleCloseExcludingDirect}>
              关闭非DIRECT连接
            </MenuItem>
            <MenuItem onClick={handleCloseAll}>
              {t("shared.actions.closeAll")}
            </MenuItem>
          </Menu>
        </Box>
      }
    >
      <Box
        sx={{
          pt: 1,
          mb: 0.5,
          mx: "10px",
          minHeight: "36px",
          display: "flex",
          alignItems: "center",
          gap: 1,
          userSelect: "text",
          position: "sticky",
          top: 0,
          zIndex: 2,
        }}
      >
        <ButtonGroup sx={{ mr: 1, flexBasis: "content" }}>
          <Button
            size="small"
            variant={connectionsType === "active" ? "contained" : "outlined"}
            onClick={() => setConnectionsType("active")}
          >
            {t("connections.components.actions.active")}{" "}
            {connections?.activeConnections.length}
          </Button>
          <Button
            size="small"
            variant={connectionsType === "closed" ? "contained" : "outlined"}
            onClick={() => {
              setConnectionsType("closed");
              setSetting((o) => ({
                ...(o ?? {
                  layout: "table",
                  closedConnectionsRetentionHours: 8,
                  connectionsView: "connections",
                }),
                connectionsView: "connections",
              }));
            }}
          >
            {t("connections.components.actions.closed")}{" "}
            {connections?.closedConnections.length}
          </Button>
        </ButtonGroup>
        {connectionsType === "active" && (
          <Button
            size="small"
            variant={connectionsView === "devices" ? "contained" : "outlined"}
            onClick={() =>
              setSetting((o) => {
                const base: IConnectionSetting = o ?? {
                  layout: "table",
                  closedConnectionsRetentionHours: 8,
                  connectionsView: "connections",
                };
                return {
                  ...base,
                  connectionsView:
                    (base.connectionsView ?? "connections") === "connections"
                      ? "devices"
                      : "connections",
                };
              })
            }
          >
            设备视图 {activeLanDeviceCount}
          </Button>
        )}
        {connectionsType === "active" && connectionsView === "devices" && (
          <>
            <BaseStyledSelect
              value={String(lanMaxDevices)}
              onChange={(e) => onLanMaxDevicesChange(Number(e.target.value))}
              sx={{ minWidth: 110 }}
              title="最大设备数（0=无限制）"
            >
              {[0, 1, 2, 3, 4, 5, 8, 10, 15, 20].map((value) => (
                <MenuItem key={value} value={String(value)}>
                  <span style={{ fontSize: 14 }}>设备上限: {value}</span>
                </MenuItem>
              ))}
            </BaseStyledSelect>
            <BaseStyledSelect
              value={String(lanSilentThresholdSeconds)}
              onChange={(e) => onLanSilentThresholdChange(Number(e.target.value))}
              sx={{ minWidth: 170 }}
              title="静默判定阈值（秒）"
            >
              {[15, 30, 45, 60, 90, 120, 180, 300, 600].map((value) => (
                <MenuItem key={value} value={String(value)}>
                  <span style={{ fontSize: 14 }}>静默阈值：{value} 秒</span>
                </MenuItem>
              ))}
            </BaseStyledSelect>
          </>
        )}
        {!isTableLayout && (
          <BaseStyledSelect
            value={curOrderOpt}
            onChange={(e) => setCurOrderOpt(e.target.value as OrderKey)}
          >
            {ORDER_OPTIONS.map((option) => (
              <MenuItem key={option.id} value={option.id}>
                <span style={{ fontSize: 14 }}>{t(option.labelKey)}</span>
              </MenuItem>
            ))}
          </BaseStyledSelect>
        )}
        {connectionsType === "closed" && (
          <>
            <BaseStyledSelect
              value={String(setting?.closedConnectionsRetentionHours ?? 8)}
              onChange={(e) =>
                setSetting((o) => {
                  const base: IConnectionSetting = o ?? {
                    layout: "table",
                    closedConnectionsRetentionHours: 8,
                  };
                  return {
                    ...base,
                    closedConnectionsRetentionHours: Number(e.target.value) as IConnectionSetting["closedConnectionsRetentionHours"],
                  };
                })
              }
              sx={{ minWidth: 100 }}
              title={t("connections.components.closedRetention")}
            >
              {CLOSED_CONNECTIONS_RETENTION_HOURS.map((h) => (
                <MenuItem key={h} value={String(h)}>
                  <span style={{ fontSize: 14 }}>
                    {t(`connections.components.retentionHours${h}`)}
                  </span>
                </MenuItem>
              ))}
            </BaseStyledSelect>
            <Button
              size="small"
              variant={mergeByDomain ? "contained" : "outlined"}
              onClick={() => setMergeByDomain((v) => !v)}
              startIcon={<MergeTypeRounded />}
            >
              {mergeByDomain
                ? t("connections.components.actions.cancelMergeByDomain")
                : t("connections.components.actions.mergeByDomain")}
            </Button>
          </>
        )}
        <Box
          sx={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            "& > *": {
              flex: 1,
            },
          }}
        >
          <BaseSearchBox onSearch={handleSearch} />
        </Box>
      </Box>

      {connectionsType === "active" && connectionsView === "devices" ? (
        !hasDeviceData ? (
          <BaseEmpty />
        ) : (
          <Box
            sx={{
              px: 1.5,
              pb: 1.5,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 1,
              overflowY: "auto",
            }}
          >
            {lanDeviceItems.map((device) => (
              <Box
                key={device.sourceIp}
                sx={{
                  border: "1px solid",
                  borderColor: "divider",
                  borderRadius: 1,
                  p: 1.25,
                  display: "flex",
                  flexDirection: "column",
                  gap: 0.5,
                }}
              >
                <Typography variant="body2" fontWeight={700}>
                  {device.sourceIp}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  连接数: {device.connectionCount}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  开始时间: {dayjs(device.latestStart).format("YYYY-MM-DD HH:mm:ss")}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  ↓ {parseTraffic(device.download)} / ↑ {parseTraffic(device.upload)}
                </Typography>
                <Box sx={{ pt: 0.5, display: "flex", gap: 0.75, flexWrap: "wrap" }}>
                  <Button
                    size="small"
                    color="info"
                    variant="outlined"
                    onClick={() => onDisconnectDevice(device.sourceIp)}
                  >
                    断开设备
                  </Button>
                  <Button
                    size="small"
                    color="warning"
                    variant="outlined"
                    onClick={() => onDisableDevice(device.sourceIp)}
                  >
                    禁用设备
                  </Button>
                </Box>
              </Box>
            ))}
            {blockedLanIps.map((ip) => (
              <Box
                key={`blocked-${ip}`}
                sx={{
                  border: "1px dashed",
                  borderColor: "warning.main",
                  borderRadius: 1,
                  p: 1.25,
                  display: "flex",
                  flexDirection: "column",
                  gap: 0.5,
                }}
              >
                <Typography variant="body2" fontWeight={700}>
                  {ip}
                </Typography>
                <Typography variant="caption" color="warning.main">
                  已禁用
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  最后使用: {(() => {
                    const ts = blockedLastUsedMap.get(ip) ?? 0;
                    return ts > 0
                      ? dayjs(ts).format("YYYY-MM-DD HH:mm:ss")
                      : "暂无记录";
                  })()}
                </Typography>
                <Box sx={{ pt: 0.5 }}>
                  <Button
                    size="small"
                    color="info"
                    variant="outlined"
                    onClick={() => onEnableDevice(ip)}
                  >
                    移除禁用
                  </Button>
                </Box>
              </Box>
            ))}
            {disconnectedDeviceItems.map((item) => (
              <Box
                key={`disconnected-${item.ip}`}
                sx={{
                  border: "1px dashed",
                  borderColor: "text.disabled",
                  borderRadius: 1,
                  p: 1.25,
                  display: "flex",
                  flexDirection: "column",
                  gap: 0.5,
                }}
              >
                <Typography variant="body2" fontWeight={700}>
                  {item.ip}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {item.status === "silent" ? "静默（连接仍存在）" : "已断开"}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  最后使用: {dayjs(item.lastUsed).format("YYYY-MM-DD HH:mm:ss")}
                </Typography>
              </Box>
            ))}
          </Box>
        )
      ) : !hasTableData ? (
        <BaseEmpty />
      ) : isTableLayout ? (
        <ConnectionTable
          connections={filterConn}
          onShowDetail={(detail) =>
            detailRef.current?.open(detail, connectionsType === "closed")
          }
          columnManagerOpen={isTableLayout && isColumnManagerOpen}
          onOpenColumnManager={() => setIsColumnManagerOpen(true)}
          onCloseColumnManager={() => setIsColumnManagerOpen(false)}
        />
      ) : (
        <Virtuoso
          style={{
            flex: 1,
            borderRadius: "8px",
            WebkitOverflowScrolling: "touch",
            overscrollBehavior: "contain",
          }}
          data={filterConn}
          itemContent={(_, item) => (
            <ConnectionItem
              value={item}
              closed={connectionsType === "closed"}
              onShowDetail={() =>
                detailRef.current?.open(item, connectionsType === "closed")
              }
            />
          )}
        />
      )}
      <ConnectionDetail ref={detailRef} />
    </BasePage>
  );
};

export default ConnectionsPage;
