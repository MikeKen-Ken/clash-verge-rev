import DeleteOutlineRounded from "@mui/icons-material/DeleteOutlineRounded";
import DeleteSweepRounded from "@mui/icons-material/DeleteSweepRounded";
import SyncRounded from "@mui/icons-material/SyncRounded";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  FormControl,
  InputLabel,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Select,
  Tooltip,
  Typography,
  alpha,
} from "@mui/material";
import { useLockFn } from "ahooks";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useTranslation } from "react-i18next";

import { useVerge } from "@/hooks/use-verge";
import { useAppData } from "@/providers/app-data-context";
import { showNotice } from "@/services/notice-service";
import {
  clearConnectivityStats,
  clearConnectivityStatsForProxy,
  hydrateConnectivityStatsFromDisk,
  listConnectivityScoreRows,
  type ConnectivityScoreRow,
} from "@/services/proxy-connectivity-stats";
import {
  isConnectivityWebdavConfigured,
  isConnectivityWebdavHttps,
  mergeConnectivityStatsNow,
} from "@/services/proxy-connectivity-webdav-sync";

/** 策略组类型：列表只展示叶子出站 */
const PROXY_GROUP_TYPES = new Set([
  "Selector",
  "URLTest",
  "Fallback",
  "LoadBalance",
  "Relay",
  "Smart",
]);

const EXCLUDED_NAMES = new Set([
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "PASS",
  "COMPATIBLE",
]);
const CONNECTIVITY_SYNC_INTERVAL_OPTIONS = [1, 6, 12, 24, 48, 168];

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return n >= 10 ? n.toFixed(0) : n.toFixed(1);
}

function formatRowSecondary(row: ConnectivityScoreRow): string {
  if (!row.hasStats) return "No statistics";
  const delay = Number.isFinite(row.effectiveAvgDelayMs)
    ? `${Math.round(row.effectiveAvgDelayMs)}ms`
    : "—";
  return `Score ${row.score.toFixed(3)} · Success ${formatCount(row.weightedSuccess)} · Failure ${formatCount(row.weightedFailure)} · Effective delay ${delay}`;
}

export type ConnectivityStatsDialogProps = {
  open: boolean;
  onClose: () => void;
};

export const ConnectivityStatsDialog = ({
  open,
  onClose,
}: ConnectivityStatsDialogProps) => {
  const { t } = useTranslation();
  const { proxies, refreshProxy } = useAppData();
  const { verge, patchVerge } = useVerge();
  const [rows, setRows] = useState<ConnectivityScoreRow[]>([]);
  const [clearing, setClearing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const configuredSyncInterval = verge?.connectivity_sync_interval_hours ?? 24;
  const syncIntervalHours = CONNECTIVITY_SYNC_INTERVAL_OPTIONS.includes(
    configuredSyncInterval,
  )
    ? configuredSyncInterval
    : 24;

  const leafProxyNames = useMemo(() => {
    const records = (proxies?.records ?? {}) as Record<
      string,
      { type?: string; name?: string }
    >;
    return Object.keys(records).filter((name) => {
      if (!name || EXCLUDED_NAMES.has(name)) return false;
      const type = records[name]?.type ?? "";
      return !PROXY_GROUP_TYPES.has(type);
    });
  }, [proxies?.records]);

  const reloadRows = useCallback(async () => {
    await hydrateConnectivityStatsFromDisk();
    setRows(listConnectivityScoreRows(leafProxyNames));
  }, [leafProxyNames]);

  useEffect(() => {
    if (open) {
      void reloadRows();
    }
  }, [open, reloadRows]);

  const handleClearOne = useLockFn(async (name: string) => {
    // 先拉最新盘数据再删，避免只清掉内存里过期副本
    await hydrateConnectivityStatsFromDisk();
    await clearConnectivityStatsForProxy(name);
    await reloadRows();
    showNotice.success(`Cleared connectivity statistics for "${name}"`);
    await refreshProxy();
  });

  const handleClearAll = useLockFn(async () => {
    if (clearing) return;
    const ok = window.confirm(
      "Clear connectivity statistics for all nodes? This action cannot be undone.",
    );
    if (!ok) return;
    setClearing(true);
    try {
      await clearConnectivityStats();
      await reloadRows();
      showNotice.success("Cleared connectivity statistics for all nodes");
      await refreshProxy();
    } finally {
      setClearing(false);
    }
  });

  const handleMerge = useLockFn(async () => {
    if (!isConnectivityWebdavConfigured(verge)) {
      showNotice.error(t("proxies.page.connectivityStats.webdavRequired"));
      return;
    }
    if (!isConnectivityWebdavHttps(verge)) {
      showNotice.error(t("proxies.page.connectivityStats.httpsRequired"));
      return;
    }
    setSyncing(true);
    try {
      const result = await mergeConnectivityStatsNow();
      await reloadRows();
      await refreshProxy();
      showNotice.success(
        t("proxies.page.connectivityStats.mergeSucceeded", {
          count: result.deviceCount,
        }),
      );
    } catch (error) {
      showNotice.error(
        t("proxies.page.connectivityStats.mergeFailed"),
        error,
      );
    } finally {
      setSyncing(false);
    }
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Box
          display="flex"
          justifyContent="space-between"
          alignItems="center"
          gap={1}
        >
          <Typography variant="h6">Node Connectivity Statistics</Typography>
          <Button
            variant="contained"
            size="small"
            color="error"
            disabled={clearing || rows.every((r) => !r.hasStats)}
            startIcon={<DeleteSweepRounded fontSize="small" />}
            onClick={() => {
              void handleClearAll();
            }}
          >
            Clear All
          </Button>
        </Box>
      </DialogTitle>

      <DialogContent>
        <Box
          display="flex"
          alignItems="center"
          gap={1.5}
          flexWrap="wrap"
          sx={{ mb: 2 }}
        >
          <Button
            variant="contained"
            size="small"
            disabled={syncing}
            startIcon={<SyncRounded fontSize="small" />}
            onClick={() => void handleMerge()}
          >
            {syncing
              ? t("proxies.page.connectivityStats.merging")
              : t("proxies.page.connectivityStats.mergeNow")}
          </Button>
          <FormControl size="small" sx={{ minWidth: 190 }}>
            <InputLabel id="connectivity-sync-interval-label">
              {t("proxies.page.connectivityStats.intervalLabel")}
            </InputLabel>
            <Select
              labelId="connectivity-sync-interval-label"
              label={t("proxies.page.connectivityStats.intervalLabel")}
              value={syncIntervalHours}
              onChange={(event) => {
                void patchVerge({
                  connectivity_sync_interval_hours: Number(event.target.value),
                }).catch((error) => {
                  showNotice.error(
                    t("proxies.page.connectivityStats.intervalSaveFailed"),
                    error,
                  );
                });
              }}
            >
              {CONNECTIVITY_SYNC_INTERVAL_OPTIONS.map((hours) => (
                <MenuItem key={hours} value={hours}>
                  {hours === 168
                    ? t("proxies.page.connectivityStats.interval7Days")
                    : hours === 1
                      ? t("proxies.page.connectivityStats.intervalHour")
                      : t("proxies.page.connectivityStats.intervalHours", {
                          hours,
                        })}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
        <List sx={{ py: 0, minHeight: 250 }}>
          {rows.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
              No proxy nodes
            </Typography>
          ) : (
            rows.map((row) => (
              <ListItem
                key={row.name}
                sx={[
                  {
                    mb: "8px",
                    borderRadius: 2,
                    pr: 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                  },
                  ({ palette: { mode, primary } }) => {
                    const bgcolor =
                      mode === "light" ? "transparent" : "#24252f";
                    return {
                      backgroundColor: bgcolor,
                      "&:hover": {
                        backgroundColor: alpha(primary.main, 0.08),
                      },
                    };
                  },
                ]}
                secondaryAction={
                  <Tooltip
                    title={
                      row.hasStats ? "Clear node statistics" : "No statistics"
                    }
                  >
                    <span>
                      <IconButton
                        edge="end"
                        size="small"
                        color="error"
                        disabled={!row.hasStats}
                        aria-label={`Clear ${row.name}`}
                        onClick={() => {
                          void handleClearOne(row.name);
                        }}
                      >
                        <DeleteOutlineRounded fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                }
              >
                <ListItemText
                  primary={
                    <Typography
                      variant="subtitle1"
                      component="div"
                      noWrap
                      title={row.name}
                    >
                      {row.name}
                    </Typography>
                  }
                  secondary={formatRowSecondary(row)}
                  sx={{ pr: 6 }}
                />
              </ListItem>
            ))
          )}
        </List>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} variant="outlined">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
};
