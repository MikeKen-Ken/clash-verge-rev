import RefreshRounded from "@mui/icons-material/RefreshRounded";
import {
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  FormControl,
  FormControlLabel,
  IconButton,
  MenuItem,
  Select,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import { useLockFn } from "ahooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { closeAllConnections } from "tauri-plugin-mihomo-api";

import { BasePage } from "@/components/base";
import { GuardState } from "@/components/setting/mods/guard-state";
import { markProxyModeChanged } from "@/hooks/use-fallback-switch-notify";
import { useClash } from "@/hooks/use-clash";
import { useVerge } from "@/hooks/use-verge";
import { useAppData } from "@/providers/app-data-context";
import { patchClashMode } from "@/services/cmds";
import { useSystemState } from "@/hooks/use-system-state";
import { showNotice } from "@/services/notice-service";
import { ProviderButton } from "@/components/proxy/provider-button";
import { ProviderButton as RuleProviderButton } from "@/components/rule/provider-button";
import { ProxyGroups } from "@/components/proxy/proxy-groups";

const MODES = ["rule", "global", "direct"] as const;
type Mode = (typeof MODES)[number];
const MODE_SET = new Set<string>(MODES);
const isMode = (value: unknown): value is Mode =>
  typeof value === "string" && MODE_SET.has(value);

const AUTO_REFRESH_INTERVALS = [5, 10, 30, 60] as const;
const STORAGE_KEY_AUTO_REFRESH = "proxies_auto_refresh";
const STORAGE_KEY_AUTO_REFRESH_INTERVAL = "proxies_auto_refresh_interval";

const ProxyPage = () => {
  const { t } = useTranslation();

  const { clashConfig, refreshClashConfig, refreshProxy } = useAppData();
  const { verge, patchVerge, mutateVerge } = useVerge();
  const { clash, patchClash, mutateClash } = useClash();
  const { isTunModeAvailable } = useSystemState();

  const modeList = useMemo(() => MODES, []);

  const normalizedMode = clashConfig?.mode?.toLowerCase();
  const curMode = isMode(normalizedMode) ? normalizedMode : undefined;

  const onChangeMode = useLockFn(async (mode: Mode) => {
    if (mode !== curMode && verge?.auto_close_connection) {
      closeAllConnections();
    }
    await patchClashMode(mode);
    refreshClashConfig();
  });

  useEffect(() => {
    if (normalizedMode && !isMode(normalizedMode)) {
      onChangeMode("rule");
    }
  }, [normalizedMode, onChangeMode]);

  const { enable_tun_mode } = verge ?? {};
  const allowLan = clash?.["allow-lan"] ?? false;

  const [autoRefresh, setAutoRefresh] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_AUTO_REFRESH) === "1";
    } catch {
      return false;
    }
  });
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number>(() => {
    try {
      const v = parseInt(
        localStorage.getItem(STORAGE_KEY_AUTO_REFRESH_INTERVAL) ?? "10",
        10,
      );
      return (
        (AUTO_REFRESH_INTERVALS as readonly number[]).includes(v) ? v : 10
      );
    } catch {
      return 10;
    }
  });
  const autoRefreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_AUTO_REFRESH, autoRefresh ? "1" : "0");
      localStorage.setItem(
        STORAGE_KEY_AUTO_REFRESH_INTERVAL,
        String(autoRefreshInterval),
      );
    } catch {
      // ignore
    }
  }, [autoRefresh, autoRefreshInterval]);

  useEffect(() => {
    if (!autoRefresh) {
      if (autoRefreshTimerRef.current) {
        clearInterval(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
      return;
    }
    autoRefreshTimerRef.current = setInterval(() => {
      refreshProxy().catch(() => {});
    }, autoRefreshInterval * 1000);
    return () => {
      if (autoRefreshTimerRef.current) {
        clearInterval(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };
  }, [autoRefresh, autoRefreshInterval, refreshProxy]);

  const handleRefreshProxy = useLockFn(async () => {
    await refreshProxy();
  });

  const handleTunToggle = useLockFn(async (value: boolean) => {
    if (!isTunModeAvailable) {
      showNotice.error(
        t("settings.sections.proxyControl.tooltips.tunUnavailable"),
      );
      return;
    }
    if (value) markProxyModeChanged();
    mutateVerge({ ...verge, enable_tun_mode: value }, false);
    await patchVerge({ enable_tun_mode: value });
  });

  return (
    <BasePage
      full
      contentStyle={{ height: "101.5%" }}
      title={t("proxies.page.title.default")}
      header={
        <Box display="flex" alignItems="center" gap={2} flexWrap="wrap">
          <Box display="flex" alignItems="center" gap={1}>
            <FormControlLabel
              control={
                <GuardState
                  value={enable_tun_mode ?? false}
                  valueProps="checked"
                  onFormat={(_, v) => v}
                  onGuard={handleTunToggle}
                >
                  <Switch size="small" disabled={!isTunModeAvailable} />
                </GuardState>
              }
              label={
                <Typography variant="body2" sx={{ whiteSpace: "nowrap" }}>
                  {t("settings.sections.system.toggles.tunMode")}
                  {!isTunModeAvailable &&
                    " " +
                      t(
                        "settings.sections.proxyControl.fields.tunModeRequiresAdmin",
                      )}
                </Typography>
              }
            />
            <FormControlLabel
              control={
                <GuardState
                  value={allowLan}
                  valueProps="checked"
                  onFormat={(_, v) => v}
                  onGuard={async (v) => {
                    mutateClash(
                      (prev) =>
                        prev != null ? { ...prev, "allow-lan": v } : prev,
                      false,
                    );
                    await patchClash({ "allow-lan": v });
                  }}
                >
                  <Switch size="small" />
                </GuardState>
              }
              label={
                <Typography variant="body2" sx={{ whiteSpace: "nowrap" }}>
                  {t("settings.sections.clash.form.fields.allowLan")}
                </Typography>
              }
            />
          </Box>

          <Box display="flex" alignItems="center" gap={1} sx={{ ml: "auto" }}>
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={autoRefresh}
                  onChange={(_, checked) => setAutoRefresh(checked)}
                />
              }
              label={
                <Typography variant="body2" sx={{ whiteSpace: "nowrap" }}>
                  {t("proxies.page.labels.autoRefresh")}
                </Typography>
              }
            />
            <FormControl size="small" sx={{ minWidth: 64 }} disabled={!autoRefresh}>
              <Select
                value={autoRefreshInterval}
                onChange={(e) =>
                  setAutoRefreshInterval(Number(e.target.value))
                }
                displayEmpty
                sx={{ height: 32 }}
              >
                {AUTO_REFRESH_INTERVALS.map((s) => (
                  <MenuItem key={s} value={s}>
                    {s} s
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Tooltip title={t("shared.actions.refresh")}>
              <IconButton
                size="small"
                onClick={handleRefreshProxy}
                aria-label={t("shared.actions.refresh")}
              >
                <RefreshRounded fontSize="small" />
              </IconButton>
            </Tooltip>
            <RuleProviderButton />
            <ProviderButton />
            <ButtonGroup size="small">
              {modeList.map((mode) => (
                <Button
                  key={mode}
                  variant={mode === curMode ? "contained" : "outlined"}
                  onClick={() => onChangeMode(mode)}
                  sx={{ textTransform: "capitalize" }}
                >
                  {t(`proxies.page.modes.${mode}`)}
                </Button>
              ))}
            </ButtonGroup>
          </Box>
        </Box>
      }
    >
      <ProxyGroups
        mode={curMode ?? "rule"}
        isChainMode={false}
        chainConfigData={null}
      />
    </BasePage>
  );
};

export default ProxyPage;
