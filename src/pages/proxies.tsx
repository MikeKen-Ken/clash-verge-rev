import ArrowDownwardRounded from "@mui/icons-material/ArrowDownwardRounded";
import ArrowUpwardRounded from "@mui/icons-material/ArrowUpwardRounded";
import BuildRounded from "@mui/icons-material/BuildRounded";
import DeleteForeverRounded from "@mui/icons-material/DeleteForeverRounded";
import DeleteSweepRounded from "@mui/icons-material/DeleteSweepRounded";
import DnsRounded from "@mui/icons-material/DnsRounded";
import NetworkCheckRounded from "@mui/icons-material/NetworkCheckRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import ReplayRounded from "@mui/icons-material/ReplayRounded";
import {
  alpha,
  Box,
  Button,
  ButtonGroup,
  FormControl,
  FormControlLabel,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Select,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import { useLockFn } from "ahooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import {
  closeAllConnections,
  flushDNS,
  flushFakeIp,
} from "tauri-plugin-mihomo-api";

import { BasePage } from "@/components/base";
import { GuardState } from "@/components/setting/mods/guard-state";
import { markProxyModeChanged } from "@/hooks/use-fallback-switch-notify";
import {
  computeNonDirectSessionTraffic,
  resetConnectionTrafficSession,
  useConnectionData,
} from "@/hooks/use-connection-data";
import { useClash } from "@/hooks/use-clash";
import { useNetworkInterfaces } from "@/hooks/use-network";
import { useServiceInstaller } from "@/hooks/use-service-installer";
import { useServiceReinstaller } from "@/hooks/use-service-reinstaller";
import { useServiceUninstaller } from "@/hooks/use-service-uninstaller";
import { useSystemState } from "@/hooks/use-system-state";
import { useUpdate } from "@/hooks/use-update";
import { useVerge } from "@/hooks/use-verge";
import { useAppData } from "@/providers/app-data-context";
import {
  openSystemNetworkProxySettings,
  openWindowsFirewallAllowedAppsSettings,
  patchClashMode,
  patchRuntimeConfig,
} from "@/services/cmds";
import {
  DELAY_CHECK_CONCURRENCY_PRESETS,
  getDelayCheckConcurrency,
  setDelayCheckConcurrency,
} from "@/services/delay";
import { showNotice } from "@/services/notice-service";
import {
  listAvailableRegionsFromProxyGroups,
  REGION_FLAG_LABELS,
} from "@/services/proxy-region-sort";
import { ConnectivityStatsDialog } from "@/components/proxy/connectivity-stats-dialog";
import { ProviderButton } from "@/components/proxy/provider-button";
import { ProviderButton as RuleProviderButton } from "@/components/rule/provider-button";
import { ProxyGroups } from "@/components/proxy/proxy-groups";
import { ProxyPageIpInfo } from "@/components/proxy/proxy-page-ip-info";
import { ProxySiteTestButtons } from "@/components/proxy/proxy-site-test-buttons";
import type { ProxySiteTestSelection } from "@/components/proxy/proxy-site-test-buttons";
import { closeLanConnections } from "@/utils/close-connections";
import getSystem from "@/utils/get-system";
import parseTraffic from "@/utils/parse-traffic";

const MODES = ["rule", "global", "direct", "offline"] as const;
type Mode = (typeof MODES)[number];
const MODE_SET = new Set<string>(MODES);
const isMode = (value: unknown): value is Mode =>
  typeof value === "string" && MODE_SET.has(value);

const DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS = 5;

const DEFAULT_HEALTH_TIMEOUT_MS = 250;

/** 健康检测相关下拉预设（ms） */
const HEALTH_CHECK_PRESETS = [250, 300, 500, 1000, 3000, 5000] as const;

const STORAGE_KEY_UI_MODE = "proxies_ui_mode";
const WIFI_INTERFACE_NAME_RE = /wi-?fi|wlan|wireless/i;
const ETHERNET_INTERFACE_NAME_RE = /ethernet|eth|en\d/i;
const VIRTUAL_INTERFACE_NAME_RE =
  /vpn|tun|tap|tailscale|wireguard|wg|v2ray|utun|ppp|loopback|virtual|vmware|hyper-v|vbox|docker|zerotier/i;

const IS_WINDOWS = getSystem() === "windows";

const ProxyPage = () => {
  const { t } = useTranslation();

  /** fork 专属：离线模式文案（硬编码简体中文） */
  const getModeLabel = (mode: Mode) =>
    mode === "offline" ? "离线" : t(`proxies.page.modes.${mode}`);

  const location = useLocation();

  const { clashConfig, refreshClashConfig, refreshProxy, proxies: proxiesData } =
    useAppData();
  const { verge, patchVerge, mutateVerge } = useVerge();
  const { clash, mutateClash } = useClash();
  const { networkInterfaces } = useNetworkInterfaces();
  const { isServiceOk, isTunModeAvailable, mutateSystemState } =
    useSystemState();
  const { installServiceAndRestartCore } = useServiceInstaller();
  const { reinstallServiceAndRestartCore } = useServiceReinstaller();
  const { uninstallServiceAndRestartCore } = useServiceUninstaller();
  const {
    response: { data: connections },
    sessionStartMs,
  } = useConnectionData();

  const nonDirectTraffic = useMemo(
    () => computeNonDirectSessionTraffic(connections, sessionStartMs),
    [connections, sessionStartMs],
  );

  const [downloadText, downloadUnit] = useMemo(
    () => parseTraffic(nonDirectTraffic.download),
    [nonDirectTraffic.download],
  );
  const [uploadText, uploadUnit] = useMemo(
    () => parseTraffic(nonDirectTraffic.upload),
    [nonDirectTraffic.upload],
  );

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

  const autoRefreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const checkAllDelayRunnerRef = useRef<(() => void) | null>(null);
  const [healthCheckConcurrency, setHealthCheckConcurrencyState] =
    useState<number>(() => getDelayCheckConcurrency());
  const [siteTestSelection, setSiteTestSelection] =
    useState<ProxySiteTestSelection | null>(null);
  const [regionFilter, setRegionFilter] = useState("");
  const [connectivityStatsOpen, setConnectivityStatsOpen] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [serviceMenuAnchor, setServiceMenuAnchor] =
    useState<null | HTMLElement>(null);

  const availableRegions = useMemo(
    () => listAvailableRegionsFromProxyGroups(proxiesData?.groups ?? []),
    [proxiesData?.groups],
  );

  useEffect(() => {
    if (!regionFilter) return;
    if (!availableRegions.some((item) => item.flag === regionFilter)) {
      setRegionFilter("");
    }
  }, [availableRegions, regionFilter]);

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

  // 默认开启自动刷新，并固定 5 秒刷新一次（不再支持动态配置）
  useEffect(() => {
    autoRefreshTimerRef.current = setInterval(() => {
      refreshProxy().catch(() => { });
    }, DEFAULT_AUTO_REFRESH_INTERVAL_SECONDS * 1000);
    return () => {
      if (autoRefreshTimerRef.current) {
        clearInterval(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };
  }, [refreshProxy]);

  const { enable_tun_mode } = verge ?? {};
  const allowLan = clash?.["allow-lan"] ?? false;
  const strictRoute = clash?.tun?.["strict-route"] ?? true;
  const proxyAdsBlockEnabled = clash?.["proxy-ads-block"] ?? true;
  const mixedPort = clash?.["mixed-port"];
  const httpPort = clash?.port;
  const socksPort = clash?.["socks-port"];

  const preferredLanIpv4 = useMemo(() => {
    const scoreInterface = (name: string) => {
      const lowered = name.toLowerCase();
      if (VIRTUAL_INTERFACE_NAME_RE.test(lowered)) return 100;
      if (WIFI_INTERFACE_NAME_RE.test(lowered)) return 0;
      if (ETHERNET_INTERFACE_NAME_RE.test(lowered)) return 1;
      return 10;
    };

    const orderedInterfaces = [...networkInterfaces].sort((a, b) => {
      const scoreDiff = scoreInterface(a.name) - scoreInterface(b.name);
      if (scoreDiff !== 0) return scoreDiff;
      return a.name.localeCompare(b.name);
    });

    for (const iface of orderedInterfaces) {
      if (VIRTUAL_INTERFACE_NAME_RE.test(iface.name.toLowerCase())) continue;
      for (const addr of iface.addr) {
        const ip = addr.V4?.ip;
        if (!ip) continue;
        if (ip === "127.0.0.1" || ip.startsWith("169.254.")) continue;
        return ip;
      }
    }
    return undefined;
  }, [networkInterfaces]);

  /** 局域网对外可连端口，供本机 IP 区在 allow-lan 开启时展示 */
  const lanListenPorts = useMemo(() => {
    const ports: number[] = [];
    if (mixedPort) ports.push(mixedPort);
    if (verge?.verge_http_enabled && httpPort) ports.push(httpPort);
    if (verge?.verge_socks_enabled && socksPort) ports.push(socksPort);
    return Array.from(new Set(ports));
  }, [
    mixedPort,
    httpPort,
    socksPort,
    verge?.verge_http_enabled,
    verge?.verge_socks_enabled,
  ]);

  const handleRefreshProxy = useLockFn(async () => {
    await refreshProxy();
  });

  // 每次切回/打开该页面时，立即刷新一次，避免进入界面未及时更新数据
  useEffect(() => {
    if (location.pathname !== "/proxies") return;
    void handleRefreshProxy();
  }, [location.pathname, handleRefreshProxy]);

  const handleFlushFakeIp = useLockFn(async () => {
    // flushFakeIp：整表清空 Fake-IP，并清 DNS 应答缓存；flushDNS：再清 DNS 并重置 DoH/DoT 连接
    await closeAllConnections();
    await flushFakeIp();
    await flushDNS();
    showNotice.success(t("proxies.page.tooltips.flushFakeIp"));
  });

  const { checkUpdate: triggerCheckUpdate } = useUpdate(false);

  const handleCheckUpdate = useLockFn(async () => {
    setCheckingUpdate(true);
    try {
      const info = await triggerCheckUpdate();
      localStorage.setItem("last_check_update", Date.now().toString());
      if (!info?.available) {
        showNotice.success(
          "settings.components.verge.advanced.notifications.latestVersion",
        );
        return;
      }
      showNotice.info("shared.feedback.notifications.updateAvailable", 2000);
      await info.downloadAndInstall();
    } catch (err) {
      showNotice.error(err);
    } finally {
      setCheckingUpdate(false);
    }
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

  const closeServiceMenu = () => setServiceMenuAnchor(null);

  const onInstallService = useLockFn(async () => {
    closeServiceMenu();
    try {
      await installServiceAndRestartCore();
      await mutateSystemState();
    } catch (err) {
      showNotice.error(err);
    }
  });

  const onReinstallService = useLockFn(async () => {
    closeServiceMenu();
    try {
      await reinstallServiceAndRestartCore();
      await mutateSystemState();
    } catch (err) {
      showNotice.error(err);
    }
  });

  const onUninstallService = useLockFn(async () => {
    closeServiceMenu();
    try {
      if (verge?.enable_tun_mode) {
        await handleTunToggle(false);
      }
      await uninstallServiceAndRestartCore();
      await mutateSystemState();
    } catch (err) {
      showNotice.error(err);
    }
  });

  /** 只接受指定预设值或 undefined，避免写入异常大数或字符串 */
  const clampHealthValueByPresets = (
    raw: string,
    presets: readonly number[],
  ): number | undefined => {
    if (raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return undefined;
    return presets.includes(n) ? n : undefined;
  };

  return (
    <BasePage
      full
      contentStyle={{ height: "101.5%" }}
      title={t("proxies.page.title.default")}
      header={
        <Box display="flex" alignItems="center" gap={2} flexWrap="wrap">
          <Box display="flex" alignItems="center" gap={0.25}>
            <FormControlLabel
              sx={{ mr: 0 }}
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
            <Tooltip title="服务管理">
              <IconButton
                size="small"
                aria-label="服务管理"
                aria-controls={
                  serviceMenuAnchor ? "proxy-service-menu" : undefined
                }
                aria-haspopup="true"
                aria-expanded={serviceMenuAnchor ? "true" : undefined}
                onClick={(e) => setServiceMenuAnchor(e.currentTarget)}
              >
                <BuildRounded fontSize="small" />
              </IconButton>
            </Tooltip>
            <Menu
              id="proxy-service-menu"
              anchorEl={serviceMenuAnchor}
              open={Boolean(serviceMenuAnchor)}
              onClose={closeServiceMenu}
              anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
              transformOrigin={{ vertical: "top", horizontal: "left" }}
            >
              {!isServiceOk && (
                <MenuItem onClick={() => void onInstallService()}>
                  <ListItemIcon>
                    <BuildRounded fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>安装服务</ListItemText>
                </MenuItem>
              )}
              <MenuItem onClick={() => void onReinstallService()}>
                <ListItemIcon>
                  <ReplayRounded fontSize="small" />
                </ListItemIcon>
                <ListItemText>重新安装服务</ListItemText>
              </MenuItem>
              <MenuItem
                disabled={!isServiceOk}
                onClick={() => void onUninstallService()}
              >
                <ListItemIcon>
                  <DeleteForeverRounded fontSize="small" />
                </ListItemIcon>
                <ListItemText>卸载服务</ListItemText>
              </MenuItem>
            </Menu>
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
                    await patchRuntimeConfig(patchPayload);
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
            <FormControlLabel
              control={
                <GuardState
                  value={strictRoute}
                  valueProps="checked"
                  onFormat={(_, v) => v}
                  onGuard={async (v) => {
                    const currentTun = clash?.tun;
                    if (!currentTun) return;
                    mutateClash(
                      (prev) =>
                        prev != null
                          ? {
                            ...prev,
                            tun: {
                              ...(prev.tun ?? {}),
                              "strict-route": v,
                            },
                          }
                          : prev,
                      false,
                    );
                    await patchRuntimeConfig({
                      tun: {
                        ...currentTun,
                        "strict-route": v,
                      },
                    });
                  }}
                >
                  <Switch size="small" />
                </GuardState>
              }
              label={
                <Typography variant="body2" sx={{ whiteSpace: "nowrap" }}>
                  {t("settings.modals.tun.fields.strictRoute")}
                </Typography>
              }
            />
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
                    await patchRuntimeConfig({ "proxy-ads-block": checked });
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
            <Tooltip title="按节点地区筛选（不含 Selector 组）">
              <FormControl size="small" sx={{ minWidth: 120 }}>
                <Select
                  value={regionFilter}
                  displayEmpty
                  onChange={(e) => {
                    setRegionFilter(String(e.target.value));
                  }}
                  sx={{ height: 32 }}
                  renderValue={(value) => {
                    if (!value) return "地区筛选";
                    const label = REGION_FLAG_LABELS[value];
                    return label ? `${value} ${label}` : value;
                  }}
                >
                  <MenuItem value="">
                    <em>全部地区</em>
                  </MenuItem>
                  {availableRegions.map(({ flag, label }) => (
                    <MenuItem key={flag} value={flag}>
                      {flag} {label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Tooltip>
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
                    const v = clampHealthValueByPresets(
                      typeof e.target.value === "string"
                        ? e.target.value
                        : String(e.target.value),
                      HEALTH_CHECK_PRESETS,
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
            <Tooltip title="测速数量步长">
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
          <Box
            display="flex"
            alignItems="center"
            gap={1}
            flexWrap="wrap"
            sx={{ ml: "auto" }}
          >
            {IS_WINDOWS && (
              <>
                <Tooltip title="打开 Windows 防火墙设置（允许应用通过防火墙）">
                  <Button
                    size="small"
                    variant="outlined"
                    sx={{
                      minWidth: "auto",
                      px: 1,
                      py: 0.25,
                      whiteSpace: "nowrap",
                    }}
                    onClick={() => {
                      void openWindowsFirewallAllowedAppsSettings();
                    }}
                  >
                    防火墙
                  </Button>
                </Tooltip>
                <Tooltip title="打开 Windows 系统代理设置（手动配置 HTTP 代理等）">
                  <Button
                    size="small"
                    variant="outlined"
                    sx={{
                      minWidth: "auto",
                      px: 1,
                      py: 0.25,
                      whiteSpace: "nowrap",
                    }}
                    onClick={() => {
                      void openSystemNetworkProxySettings();
                    }}
                  >
                    系统代理
                  </Button>
                </Tooltip>
              </>
            )}
            <Tooltip title="节点测速统计">
              <IconButton
                size="small"
                aria-label="节点测速统计"
                onClick={() => {
                  setConnectivityStatsOpen(true);
                }}
              >
                <DeleteSweepRounded fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="刷新 UI">
              <IconButton
                size="small"
                onClick={handleRefreshProxy}
                aria-label="刷新 UI"
              >
                <RefreshRounded fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={t("proxies.page.tooltips.flushFakeIp")}>
              <IconButton
                size="small"
                onClick={handleFlushFakeIp}
                aria-label={t("proxies.page.tooltips.flushFakeIp")}
              >
                <DnsRounded fontSize="small" />
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
                  {getModeLabel(mode)}
                </Button>
              ))}
            </ButtonGroup>
            <Tooltip title={t("proxies.page.tooltips.tunnelTraffic")}>
              <Box
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 0.25,
                  ml: 0.5,
                  px: 1,
                  py: 0.5,
                  borderRadius: 1,
                  bgcolor: (theme) => alpha(theme.palette.divider, 0.08),
                  border: (theme) =>
                    `1px solid ${alpha(theme.palette.divider, 0.2)}`,
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 0.5,
                    minWidth: 0,
                  }}
                >
                  <ArrowDownwardRounded
                    sx={{ fontSize: 16, color: "primary.main", flexShrink: 0 }}
                  />
                  <Typography
                    variant="body2"
                    color="text.primary"
                    sx={{
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {downloadText} {downloadUnit}
                  </Typography>
                </Box>
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 0.5,
                    minWidth: 0,
                  }}
                >
                  <ArrowUpwardRounded
                    sx={{
                      fontSize: 16,
                      color: "secondary.main",
                      flexShrink: 0,
                    }}
                  />
                  <Typography
                    variant="body2"
                    color="text.primary"
                    sx={{
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {uploadText} {uploadUnit}
                  </Typography>
                </Box>
              </Box>
            </Tooltip>
            <ProxySiteTestButtons mode={uiMode} selection={siteTestSelection} />
            <ProxyPageIpInfo
              localIp={preferredLanIpv4}
              allowLan={allowLan}
              ports={lanListenPorts}
            />
            <Tooltip title="检查更新">
              <span>
                <IconButton
                  size="small"
                  color="inherit"
                  aria-label="检查更新"
                  disabled={checkingUpdate}
                  onClick={() => {
                    void handleCheckUpdate();
                  }}
                  sx={{
                    animation: checkingUpdate
                      ? "spin 1s linear infinite"
                      : "none",
                    "@keyframes spin": {
                      "0%": { transform: "rotate(0deg)" },
                      "100%": { transform: "rotate(360deg)" },
                    },
                  }}
                >
                  <RefreshRounded fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        </Box>
      }
    >
      <ProxyGroups
        mode={uiMode}
        isChainMode={false}
        chainConfigData={null}
        regionFilter={regionFilter || undefined}
        onRegisterCheckAll={(runner) => {
          checkAllDelayRunnerRef.current = runner;
        }}
        onActiveSelectionChange={setSiteTestSelection}
      />
      <ConnectivityStatsDialog
        open={connectivityStatsOpen}
        onClose={() => setConnectivityStatsOpen(false)}
      />
    </BasePage>
  );
};

export default ProxyPage;
