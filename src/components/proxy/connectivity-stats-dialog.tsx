import DeleteOutlineRounded from "@mui/icons-material/DeleteOutlineRounded";
import DeleteSweepRounded from "@mui/icons-material/DeleteSweepRounded";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Tooltip,
  Typography,
  alpha,
} from "@mui/material";
import { useLockFn } from "ahooks";
import { useEffect, useMemo, useState } from "react";

import { useAppData } from "@/providers/app-data-context";
import { showNotice } from "@/services/notice-service";
import {
  clearConnectivityStats,
  clearConnectivityStatsForProxy,
  listConnectivityScoreRows,
  type ConnectivityScoreRow,
} from "@/services/proxy-connectivity-stats";

/** 策略组类型：列表只展示叶子出站 */
const PROXY_GROUP_TYPES = new Set([
  "Selector",
  "URLTest",
  "Fallback",
  "LoadBalance",
  "Relay",
  "Smart",
]);

const EXCLUDED_NAMES = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return n >= 10 ? n.toFixed(0) : n.toFixed(1);
}

function formatRowSecondary(row: ConnectivityScoreRow): string {
  if (!row.hasStats) return "无统计";
  const delay = Number.isFinite(row.effectiveAvgDelayMs)
    ? `${Math.round(row.effectiveAvgDelayMs)}ms`
    : "—";
  return `分数 ${row.score.toFixed(3)} · 成功 ${formatCount(row.weightedSuccess)} · 失败 ${formatCount(row.weightedFailure)} · 有效延迟 ${delay}`;
}

export type ConnectivityStatsDialogProps = {
  open: boolean;
  onClose: () => void;
};

export const ConnectivityStatsDialog = ({
  open,
  onClose,
}: ConnectivityStatsDialogProps) => {
  const { proxies, refreshProxy } = useAppData();
  const [rows, setRows] = useState<ConnectivityScoreRow[]>([]);
  const [clearing, setClearing] = useState(false);

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

  const reloadRows = () => {
    setRows(listConnectivityScoreRows(leafProxyNames));
  };

  useEffect(() => {
    if (open) {
      reloadRows();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅打开时 / 节点名变化时刷新
  }, [open, leafProxyNames]);

  const handleClearOne = useLockFn(async (name: string) => {
    clearConnectivityStatsForProxy(name);
    reloadRows();
    showNotice.success(`已清空「${name}」的测速统计`);
    await refreshProxy();
  });

  const handleClearAll = useLockFn(async () => {
    if (clearing) return;
    const ok = window.confirm(
      "确定清空所有节点的测速成功/失败统计吗？此操作不可恢复。",
    );
    if (!ok) return;
    setClearing(true);
    try {
      clearConnectivityStats();
      reloadRows();
      showNotice.success("已清空节点测速统计");
      await refreshProxy();
    } finally {
      setClearing(false);
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
          <Typography variant="h6">节点测速统计</Typography>
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
            一键清空
          </Button>
        </Box>
      </DialogTitle>

      <DialogContent>
        <List sx={{ py: 0, minHeight: 250 }}>
          {rows.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
              暂无代理节点
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
                      mode === "light" ? "#ffffff" : "#24252f";
                    return {
                      backgroundColor: bgcolor,
                      "&:hover": {
                        backgroundColor: alpha(primary.main, 0.08),
                      },
                    };
                  },
                ]}
                secondaryAction={
                  <Tooltip title={row.hasStats ? "清空该节点统计" : "无统计"}>
                    <span>
                      <IconButton
                        edge="end"
                        size="small"
                        color="error"
                        disabled={!row.hasStats}
                        aria-label={`清空 ${row.name}`}
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
          关闭
        </Button>
      </DialogActions>
    </Dialog>
  );
};
