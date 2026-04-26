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
  isLanSourceIp,
} from "@/features/lan-devices/model";
import {
  addBlockedLanSourceIp,
  normalizeBlockedLanSourceIps,
} from "@/features/lan-devices/state";
import parseTraffic from "@/utils/parse-traffic";
import {
  closeConnectionsBySourceIp,
  closeConnectionsExcludingDirect,
} from "@/utils/close-connections";

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
  const [connectionsView, setConnectionsView] = useState<"connections" | "devices">(
    "connections",
  );
  const [mergeByDomain, setMergeByDomain] = useState(false);
  const [blockedLanIps, setBlockedLanIps] = useState<string[]>([]);
  const { clash, patchClash } = useClash();

  const {
    response: { data: connections },
    clearClosedConnections,
    sessionStartMs,
  } = useConnectionData();

  const [setting, setSetting] = useConnectionSetting();

  const isTableLayout = setting.layout === "table";

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
    for (const c of [...active, ...closed]) {
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
        ? conns.filter((conn) => !blockedLanIps.includes(conn.metadata?.sourceIP || ""))
        : conns;
    let matchConns = visibleConns.filter((conn) => {
      const { host, destinationIP, process } = conn.metadata;
      return (
        match(host || "") || match(destinationIP || "") || match(process || "")
      );
    });

    if (orderFunc) matchConns = orderFunc(matchConns ?? []);

    if (connectionsType === "closed" && mergeByDomain && matchConns.length > 0) {
      matchConns = mergeClosedConnectionsByHost(matchConns);
      if (orderFunc) matchConns = orderFunc(matchConns);
    }

    return [matchConns];
  }, [connections, connectionsType, match, curOrderOpt, mergeByDomain, setting?.closedConnectionsRetentionHours, blockedLanIps]);

  const lanDeviceItems = useMemo(() => {
    if (connectionsType !== "active") return [];
    const active = connections?.activeConnections ?? [];
    const visible = active.filter(
      (conn) => !blockedLanIps.includes(conn.metadata?.sourceIP || ""),
    );
    return buildLanDeviceItems(visible);
  }, [connections?.activeConnections, connectionsType, blockedLanIps]);

  const onCloseAll = useLockFn(closeAllConnections);
  const onCloseExcludingDirect = useLockFn(closeConnectionsExcludingDirect);
  const onDisableDevice = useLockFn(async (sourceIp: string) => {
    await closeConnectionsBySourceIp(sourceIp);
    const next = addBlockedLanSourceIp(blockedLanIps, sourceIp);
    await patchClash({
      "clash-for-android": {
        "lan-blocked-devices": next,
      },
    } as Partial<IConfigData>);
    setBlockedLanIps(next);
    showNotice.success("已禁用该设备");
  });

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
  const hasDeviceData = lanDeviceItems.length > 0;

  useEffect(() => {
    const fromConfig =
      clash?.["clash-for-android"]?.["lan-blocked-devices"] ?? [];
    setBlockedLanIps(normalizeBlockedLanSourceIps(fromConfig));
  }, [clash]);

  useEffect(() => {
    const active = connections?.activeConnections ?? [];
    if (active.length === 0 || blockedLanIps.length === 0) return;
    const targets = Array.from(
      new Set(
        active
          .map((conn) => conn.metadata?.sourceIP || "")
          .filter((ip) => ip && blockedLanIps.includes(ip) && isLanSourceIp(ip)),
      ),
    );
    if (targets.length === 0) return;
    void Promise.allSettled(targets.map((ip) => closeConnectionsBySourceIp(ip)));
  }, [connections?.activeConnections, blockedLanIps]);

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
              setConnectionsView("connections");
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
              setConnectionsView((prev) =>
                prev === "connections" ? "devices" : "connections",
              )
            }
          >
            设备视图 {lanDeviceItems.length}
          </Button>
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
                  ↓ {parseTraffic(device.download)} / ↑ {parseTraffic(device.upload)}
                </Typography>
                <Box sx={{ pt: 0.5 }}>
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
