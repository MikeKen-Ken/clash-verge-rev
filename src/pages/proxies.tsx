import RefreshRounded from "@mui/icons-material/RefreshRounded";
import NetworkCheckRounded from "@mui/icons-material/NetworkCheckRounded";
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
import { resetConnectionTrafficSession } from "@/hooks/use-connection-data";
import { useClash } from "@/hooks/use-clash";
import { useNetworkInterfaces } from "@/hooks/use-network";
import { useVerge } from "@/hooks/use-verge";
import { useAppData } from "@/providers/app-data-context";
import { patchClashMode } from "@/services/cmds";
import {
  DELAY_CHECK_CONCURRENCY_PRESETS,
  getDelayCheckConcurrency,
  setDelayCheckConcurrency,
} from "@/services/delay";
import { useSystemState } from "@/hooks/use-system-state";
import { showNotice } from "@/services/notice-service";
import { ProviderButton } from "@/components/proxy/provider-button";
import { ProviderButton as RuleProviderButton } from "@/components/rule/provider-button";
import { ProxyGroups } from "@/components/proxy/proxy-groups";
import { closeLanConnections } from "@/utils/close-connections";

const MODES = ["rule", "global", "direct"] as const;
type Mode = (typeof MODES)[number];
const MODE_SET = new Set<string>(MODES);
const isMode = (value: unknown): value is Mode =>
  typeof value === "string" && MODE_SET.has(value);

const AUTO_REFRESH_INTERVALS = [5, 10, 30, 60] as const;
const STORAGE_KEY_AUTO_REFRESH = "proxies_auto_refresh";
const STORAGE_KEY_AUTO_REFRESH_INTERVAL = "proxies_auto_refresh_interval";

const DEFAULT_HEALTH_TIMEOUT_MS = 250;
const DEFAULT_HEALTH_SELECTED_TIMEOUT_MS = 3000;
const DEFAULT_HEALTH_FAILURE_RESET_MS = 5000;

/** 健康检测相关下拉预设（ms） */
const HEALTH_CHECK_PRESETS = [250, 300, 500, 1000, 3000, 5000] as const;

const STORAGE_KEY_UI_MODE = "proxies_ui_mode";
const LAN_ENDPOINT_OFFSET_X = -2;
const WIFI_INTERFACE_NAME_RE = /wi-?fi|wlan|wireless/i;

const ProxyPage = () => {
  const { t } = useTranslation();

  const { clashConfig, refreshClashConfig, refreshProxy } = useAppData();
  const { verge, patchVerge, mutateVerge } = useVerge();
  const { clash, patchClash, mutateClash } = useClash();
  const { networkInterfaces } = useNetworkInterfaces();
  const { isTunModeAvailable } = useSystemState();

  const modeList = useMemo(() => MODES, []);

  // 前端自己记录当前模式，用于按钮选中状态，不依赖核心返回的 mode（核心在直连/全局时固定为 rule）
  const [uiMode, setUiMode] = useState<Mode>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_UI_MODE);
      if (stored && isMode(stored)) return stored as Mode;
    } catch {
      // ignore
    }
    return "rule";
  });

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
  const checkAllDelayRunnerRef = useRef<(() => void) | null>(null);
  const [healthCheckConcurrency, setHealthCheckConcurrencyState] =
    useState<number>(() => getDelayCheckConcurrency());

  const onChangeMode = useLockFn(async (mode: Mode) => {
    if (mode !== uiMode && verge?.auto_close_connection) {
      closeAllConnections();
    }
    setUiMode(mode);
    try {
      localStorage.setItem(STORAGE_KEY_UI_MODE, mode);
    } catch {
      // ignore
    }
    // 切换规则/全局/直连后 1 分钟内不发送 fallback 切换通知（与 TUN/系统代理一致）
    markProxyModeChanged();
    await patchClashMode(mode);
    refreshClashConfig();
  });

  // 后端 mode 非法时只修正后端，不改变前端按钮状态（uiMode 仅由用户点击维护）
  useEffect(() => {
    const raw = clashConfig?.mode?.toLowerCase();
    if (raw && !isMode(raw)) {
      patchClashMode("rule").then(() => refreshClashConfig());
    }
  }, [clashConfig?.mode, refreshClashConfig]);

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
      refreshProxy().catch(() => { });
    }, autoRefreshInterval * 1000);
    return () => {
      if (autoRefreshTimerRef.current) {
        clearInterval(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };
  }, [autoRefresh, autoRefreshInterval, refreshProxy]);

  const { enable_tun_mode } = verge ?? {};
  const allowLan = clash?.["allow-lan"] ?? false;
  const proxyAdsBlockEnabled = clash?.["proxy-ads-block"] ?? true;
  const mixedPort = clash?.["mixed-port"];
  const httpPort = clash?.port;
  const socksPort = clash?.["socks-port"];

  const lanIpv4List = useMemo(() => {
    const ipv4Set = new Set<string>();
    networkInterfaces.forEach((iface) => {
      iface.addr.forEach((addr) => {
        const ip = addr.V4?.ip;
        if (!ip) return;
        if (ip === "127.0.0.1" || ip.startsWith("169.254.")) return;
        ipv4Set.add(ip);
      });
    });
    return Array.from(ipv4Set);
  }, [networkInterfaces]);

  const preferredLanIpv4 = useMemo(() => {
    const orderedInterfaces = [...networkInterfaces].sort((a, b) => {
      const aWifi = WIFI_INTERFACE_NAME_RE.test(a.name);
      const bWifi = WIFI_INTERFACE_NAME_RE.test(b.name);
      if (aWifi !== bWifi) return aWifi ? -1 : 1;
      return 0;
    });

    for (const iface of orderedInterfaces) {
      for (const addr of iface.addr) {
        const ip = addr.V4?.ip;
        if (!ip) continue;
        if (ip === "127.0.0.1" || ip.startsWith("169.254.")) continue;
        return ip;
      }
    }
    return undefined;
  }, [networkInterfaces]);

  const lanEndpointItems = useMemo(() => {
    if (!allowLan || lanIpv4List.length === 0) return [] as string[];
    const ports: number[] = [];
    if (mixedPort) ports.push(mixedPort);
    if (verge?.verge_http_enabled && httpPort) ports.push(httpPort);
    if (verge?.verge_socks_enabled && socksPort) ports.push(socksPort);
    const uniquePorts = Array.from(new Set(ports));
    return lanIpv4List.flatMap((ip) => uniquePorts.map((port) => `${ip}:${port}`));
  }, [
    allowLan,
    lanIpv4List,
    mixedPort,
    httpPort,
    socksPort,
    verge?.verge_http_enabled,
    verge?.verge_socks_enabled,
  ]);

  const handleCopyLanEndpoint = useLockFn(async (endpoint: string) => {
    try {
      await navigator.clipboard.writeText(endpoint);
      showNotice.success("shared.feedback.notifications.common.copySuccess");
    } catch (err) {
      showNotice.error("settings.sections.externalController.messages.copyFailed", err);
    }
  });

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
    resetConnectionTrafficSession();
    mutateVerge({ ...verge, enable_tun_mode: value }, false);
    await patchVerge({ enable_tun_mode: value });
  });

  /** 只接受预设值或 undefined，避免写入异常大数或字符串 */
  const clampHealthValue = (
    raw: string,
  ): number | undefined => {
    if (raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return undefined;
    return (HEALTH_CHECK_PRESETS as readonly number[]).includes(n)
      ? n
      : undefined;
  };

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
                  {!isTunModeAvailable && (
                    <>
                      {" "}
                      <Box
                        component="span"
                        sx={{ color: "error.main", fontSize: "inherit" }}
                      >
                        {t(
                          "settings.sections.proxyControl.fields.tunModeRequiresAdmin",
                        )}
                      </Box>
                    </>
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
                    const patchPayload: Partial<IConfigData> = { "allow-lan": v };
                    if (v && preferredLanIpv4) {
                      patchPayload["bind-address"] = preferredLanIpv4;
                    }
                    mutateClash(
                      (prev) =>
                        prev != null
                          ? {
                            ...prev,
                            "allow-lan": v,
                            ...(v && preferredLanIpv4
                              ? { "bind-address": preferredLanIpv4 }
                              : {}),
                          }
                          : prev,
                      false,
                    );
                    await patchClash(patchPayload);
                    if (!v) {
                      const closedCount = await closeLanConnections();
                      if (closedCount > 0) {
                        showNotice.success(`已断开局域网连接（${closedCount}）`);
                      }
                    }
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
            {allowLan &&
              (lanEndpointItems.length > 0 ? (
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 0.75,
                    ml: LAN_ENDPOINT_OFFSET_X,
                  }}
                >
                  {lanEndpointItems.map((endpoint) => (
                    <Button
                      key={endpoint}
                      size="small"
                      variant="outlined"
                      sx={{ minWidth: "auto", px: 1, py: 0.25 }}
                      onClick={() => {
                        void handleCopyLanEndpoint(endpoint);
                      }}
                    >
                      {endpoint}
                    </Button>
                  ))}
                </Box>
              ) : (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ ml: LAN_ENDPOINT_OFFSET_X }}
                >
                  N/A
                </Typography>
              ))}
            <FormControlLabel
              control={
                <GuardState
                  value={proxyAdsBlockEnabled}
                  valueProps="checked"
                  onFormat={(_, checked) => checked}
                  onChange={(checked) => {
                    mutateClash(
                      (prev) =>
                        prev != null
                          ? { ...prev, "proxy-ads-block": checked }
                          : prev,
                      false,
                    );
                  }}
                  onGuard={async (checked) => {
                    await patchClash({ "proxy-ads-block": checked });
                  }}
                >
                  <Switch size="small" />
                </GuardState>
              }
              label={
                <Typography variant="body2" sx={{ whiteSpace: "nowrap" }}>
                  {t("proxies.page.labels.blockAds")}
                </Typography>
              }
            />
            <Tooltip title={t("proxies.page.labels.healthCheckTimeout")}>
              <FormControl size="small" sx={{ minWidth: 88 }}>
                <Select
                  value={
                    verge?.health_check_timeout != null &&
                      (HEALTH_CHECK_PRESETS as readonly number[]).includes(
                        verge.health_check_timeout,
                      )
                      ? String(verge.health_check_timeout)
                      : ""
                  }
                  displayEmpty
                  onChange={(e) => {
                    const v = clampHealthValue(
                      typeof e.target.value === "string"
                        ? e.target.value
                        : String(e.target.value),
                    );
                    mutateVerge(
                      { ...verge, health_check_timeout: v },
                      false,
                    );
                    void patchVerge({ health_check_timeout: v });
                  }}
                  sx={{ height: 32 }}
                  renderValue={(v) =>
                    v === "" ? "—" : `${v} ms`
                  }
                >
                  <MenuItem value="">
                    <em>—</em>
                  </MenuItem>
                  {HEALTH_CHECK_PRESETS.map((n) => (
                    <MenuItem key={n} value={String(n)}>
                      {n} ms
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Tooltip>
            <Tooltip title={t("proxies.page.labels.healthCheckSelectedTimeout")}>
              <FormControl size="small" sx={{ minWidth: 88 }}>
                <Select
                  value={
                    verge?.health_check_selected_timeout != null &&
                      (HEALTH_CHECK_PRESETS as readonly number[]).includes(
                        verge.health_check_selected_timeout,
                      )
                      ? String(verge.health_check_selected_timeout)
                      : ""
                  }
                  displayEmpty
                  onChange={(e) => {
                    const v = clampHealthValue(
                      typeof e.target.value === "string"
                        ? e.target.value
                        : String(e.target.value),
                    );
                    mutateVerge(
                      { ...verge, health_check_selected_timeout: v },
                      false,
                    );
                    void patchVerge({ health_check_selected_timeout: v });
                  }}
                  sx={{ height: 32 }}
                  renderValue={(v) =>
                    v === "" ? "—" : `${v} ms`
                  }
                >
                  <MenuItem value="">
                    <em>—</em>
                  </MenuItem>
                  {HEALTH_CHECK_PRESETS.map((n) => (
                    <MenuItem key={n} value={String(n)}>
                      {n} ms
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Tooltip>
            <Tooltip
              title={t(
                "proxies.page.labels.healthCheckFailureResetInterval",
              )}
            >
              <FormControl size="small" sx={{ minWidth: 88 }}>
                <Select
                  value={
                    verge?.health_check_failure_reset_interval != null &&
                      (HEALTH_CHECK_PRESETS as readonly number[]).includes(
                        verge.health_check_failure_reset_interval,
                      )
                      ? String(verge.health_check_failure_reset_interval)
                      : ""
                  }
                  displayEmpty
                  onChange={(e) => {
                    const v = clampHealthValue(
                      typeof e.target.value === "string"
                        ? e.target.value
                        : String(e.target.value),
                    );
                    mutateVerge(
                      { ...verge, health_check_failure_reset_interval: v },
                      false,
                    );
                    void patchVerge({
                      health_check_failure_reset_interval: v,
                    });
                  }}
                  sx={{ height: 32 }}
                  renderValue={(v) =>
                    v === "" ? "—" : `${v} ms`
                  }
                >
                  <MenuItem value="">
                    <em>—</em>
                  </MenuItem>
                  {HEALTH_CHECK_PRESETS.map((n) => (
                    <MenuItem key={n} value={String(n)}>
                      {n} ms
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Tooltip>
            <Tooltip title="Health check concurrency">
              <FormControl size="small" sx={{ minWidth: 88 }}>
                <Select
                  value={healthCheckConcurrency}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    setDelayCheckConcurrency(value);
                    setHealthCheckConcurrencyState(getDelayCheckConcurrency());
                  }}
                  sx={{ height: 32 }}
                >
                  {DELAY_CHECK_CONCURRENCY_PRESETS.map((n) => (
                    <MenuItem key={n} value={n}>
                      {n}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Tooltip>
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
            <Tooltip title={t("proxies.page.tooltips.delayCheck")}>
              <IconButton
                size="small"
                onClick={() => {
                  checkAllDelayRunnerRef.current?.();
                }}
                aria-label={t("proxies.page.tooltips.delayCheck")}
              >
                <NetworkCheckRounded fontSize="small" />
              </IconButton>
            </Tooltip>
            <RuleProviderButton />
            <ProviderButton />
            <ButtonGroup size="small">
              {modeList.map((mode) => (
                <Button
                  key={mode}
                  variant={mode === uiMode ? "contained" : "outlined"}
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
        mode={uiMode}
        isChainMode={false}
        chainConfigData={null}
        onRegisterCheckAll={(runner) => {
          checkAllDelayRunnerRef.current = runner;
        }}
      />
    </BasePage>
  );
};

export default ProxyPage;
