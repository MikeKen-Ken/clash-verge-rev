import {
  PlayCircleOutlineRounded,
  PauseCircleOutlineRounded,
  SwapVertRounded,
  FileDownloadOutlined,
} from "@mui/icons-material";
import { Box, Button, IconButton, MenuItem } from "@mui/material";
import { save } from "@tauri-apps/plugin-dialog";
import { useLockFn } from "ahooks";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";

import {
  BaseEmpty,
  BasePage,
  BaseSearchBox,
  BaseStyledSelect,
  type SearchState,
} from "@/components/base";
import LogItem from "@/components/log/log-item";
import { useClash } from "@/hooks/use-clash";
import { useClashLog } from "@/hooks/use-clash-log";
import { useLogDataContext } from "@/providers/log-data-context";
import { exportTextFile, patchRuntimeConfig } from "@/services/cmds";
import { showNotice } from "@/services/notice-service";
import { debugLog } from "@/utils/debug";

const KERNEL_LOG_LEVELS = [
  "debug",
  "info",
  "warning",
  "error",
  "silent",
] as const;

const toUiLogLevel = (level?: string) => (level === "warn" ? "warning" : level);

const toKernelLogLevel = (level: string) =>
  level === "warning" ? "warn" : level;

function formatLogExportLines(items: ILogItem[]): string {
  return items
    .map((row) => {
      const proc = row.processName ? ` [${row.processName}]` : "";
      return `[${row.time ?? "-"}] [${row.type}]${proc} ${row.payload}`;
    })
    .join("\n");
}

const LogPage = () => {
  const { t } = useTranslation();
  const { clash } = useClash();
  const [clashLog, setClashLog] = useClashLog();
  const enableLog = clashLog.enable;
  const logState = clashLog.logFilter;
  const kernelLogLevel = toUiLogLevel(clashLog.logLevel) ??
    toUiLogLevel(clash?.["log-level"]) ??
    "info";
  const logOrder = clashLog.logOrder ?? "asc";
  const isDescending = logOrder === "desc";

  const [match, setMatch] = useState(() => (_: string) => true);
  const [searchState, setSearchState] = useState<SearchState>();
  const {
    response: { data: logData, error: logSubscriptionError },
    refreshGetClashLog,
  } = useLogDataContext();

  const filterLogs = useMemo(() => {
    if (!logData || logData.length === 0) {
      return [];
    }

    // Server-side filtering handles level filtering via query parameters
    // We only need to apply search filtering here
    return logData.filter((data) => {
      // 构建完整的搜索文本，包含时间、类型和内容
      const searchText =
        `${data.time || ""} ${data.type} ${data.payload}`.toLowerCase();

      const matchesSearch = match(searchText);

      const rawType = String(data.type ?? "").toLowerCase();
      const state = String(logState);
      const matchesLevel =
        logState === "all" ||
        (state === "warn" && rawType.includes("warn")) ||
        (state === "err" && rawType.includes("err")) ||
        (state !== "all" && state !== "warn" && state !== "err"
          ? rawType.includes(state)
          : false);

      return matchesLevel && matchesSearch;
    });
  }, [logData, logState, match]);

  useEffect(() => {
    debugLog("[日志页] 状态", {
      原始条数: logData?.length ?? 0,
      过滤后条数: filterLogs.length,
      采集开启: enableLog,
      订阅错误: logSubscriptionError,
    });
  }, [logData, filterLogs.length, enableLog, logSubscriptionError]);

  const filteredLogs = useMemo(
    () => (isDescending ? [...filterLogs].reverse() : filterLogs),
    [filterLogs, isDescending],
  );

  const handleExportLogs = useLockFn(async () => {
    const raw = logData ?? [];
    if (raw.length === 0) {
      showNotice.info("There are no logs to export");
      return;
    }
    const defaultPath = `clash-verge-logs-${dayjs().format("YYYY-MM-DD_HH-mm-ss")}.txt`;
    const savePath = await save({
      title: "Export logs",
      defaultPath,
    });
    if (!savePath || Array.isArray(savePath)) {
      return;
    }
    try {
      await exportTextFile(savePath, formatLogExportLines(raw));
      showNotice.success("Logs exported");
    } catch (error) {
      console.error(error);
      showNotice.error(
        error instanceof Error ? `Export failed: ${error.message}` : "Export failed",
      );
    }
  });

  const handleLogFilterChange = (newLevel: string) => {
    setClashLog((pre: any) => ({ ...pre, logFilter: newLevel }));
  };

  const handleKernelLogLevelChange = async (newLevel: string) => {
    setClashLog((pre: any) => ({ ...pre, logLevel: newLevel }));
    await patchRuntimeConfig({ "log-level": toKernelLogLevel(newLevel) });
  };

  const handleToggleLog = async () => {
    setClashLog((pre: any) => ({ ...pre, enable: !enableLog }));
  };

  const handleToggleOrder = () => {
    setClashLog((pre: any) => ({
      ...pre,
      logOrder: pre.logOrder === "desc" ? "asc" : "desc",
    }));
  };

  return (
    <BasePage
      full
      title={t("logs.page.title")}
      contentStyle={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
      }}
      header={
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <IconButton
            title={t(
              enableLog ? "shared.actions.pause" : "shared.actions.resume",
            )}
            aria-label={t(
              enableLog ? "shared.actions.pause" : "shared.actions.resume",
            )}
            size="small"
            color="inherit"
            onClick={handleToggleLog}
          >
            {enableLog ? (
              <PauseCircleOutlineRounded />
            ) : (
              <PlayCircleOutlineRounded />
            )}
          </IconButton>
          <IconButton
            title={t(
              isDescending
                ? "logs.actions.showAscending"
                : "logs.actions.showDescending",
            )}
            aria-label={t(
              isDescending
                ? "logs.actions.showAscending"
                : "logs.actions.showDescending",
            )}
            size="small"
            color="inherit"
            onClick={handleToggleOrder}
          >
            <SwapVertRounded
              sx={{
                transform: isDescending ? "scaleY(-1)" : "none",
                transition: "transform 0.2s ease",
              }}
            />
          </IconButton>

          <Button
            size="small"
            variant="outlined"
            startIcon={<FileDownloadOutlined />}
            onClick={() => {
              void handleExportLogs();
            }}
          >
            Export logs
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => {
              refreshGetClashLog(true);
            }}
          >
            {t("shared.actions.clear")}
          </Button>
        </Box>
      }
    >
      <Box
        sx={{
          pt: 1,
          mb: 0.5,
          mx: "10px",
          height: "39px",
          display: "flex",
          alignItems: "center",
          gap: 1,
        }}
      >
        <BaseStyledSelect
          value={kernelLogLevel}
          onChange={(e) => handleKernelLogLevelChange(e.target.value as string)}
          sx={{ minWidth: 100 }}
        >
          {KERNEL_LOG_LEVELS.map((level) => (
            <MenuItem key={level} value={level}>
              {t(`settings.sections.clash.form.options.logLevel.${level}`)}
            </MenuItem>
          ))}
        </BaseStyledSelect>
        <BaseStyledSelect
          value={logState}
          onChange={(e) => handleLogFilterChange(e.target.value as LogFilter)}
        >
          <MenuItem value="all">{t("shared.filters.logLevels.all")}</MenuItem>
          <MenuItem value="debug">
            {t("shared.filters.logLevels.debug")}
          </MenuItem>
          <MenuItem value="info">{t("shared.filters.logLevels.info")}</MenuItem>
          <MenuItem value="warn">{t("shared.filters.logLevels.warn")}</MenuItem>
          <MenuItem value="err">{t("shared.filters.logLevels.error")}</MenuItem>
        </BaseStyledSelect>
        <BaseSearchBox
          onSearch={(matcher, state) => {
            setMatch(() => matcher);
            setSearchState(state);
          }}
        />
      </Box>

      {filteredLogs.length > 0 ? (
        <Virtuoso
          initialTopMostItemIndex={
            isDescending ? 0 : Math.max(0, filteredLogs.length - 1)
          }
          data={filteredLogs}
          style={{
            flex: 1,
          }}
          itemContent={(index, item) => (
            <LogItem value={item} searchState={searchState} />
          )}
          followOutput={isDescending ? false : "smooth"}
        />
      ) : (
        <BaseEmpty />
      )}
    </BasePage>
  );
};

export default LogPage;
