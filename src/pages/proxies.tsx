import { ExpandMoreRounded } from "@mui/icons-material";
import {
  Box,
  Button,
  ButtonGroup,
  FormControlLabel,
  IconButton,
  Menu,
  MenuItem,
  Switch,
  Typography,
} from "@mui/material";
import { useLockFn } from "ahooks";
import { useEffect, useMemo, useState } from "react";
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
import { ProxyGroups } from "@/components/proxy/proxy-groups";

const MODES = ["rule", "global", "direct"] as const;
type Mode = (typeof MODES)[number];
const MODE_SET = new Set<string>(MODES);
const isMode = (value: unknown): value is Mode =>
  typeof value === "string" && MODE_SET.has(value);

const ProxyPage = () => {
  const { t } = useTranslation();

  const { clashConfig, refreshClashConfig, proxies: proxiesData } =
    useAppData();
  const { verge, patchVerge, mutateVerge } = useVerge();
  const { clash, patchClash, mutateClash } = useClash();
  const { isTunModeAvailable } = useSystemState();

  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [ruleGroupAnchor, setRuleGroupAnchor] = useState<null | HTMLElement>(
    null,
  );

  const modeList = useMemo(() => MODES, []);

  const normalizedMode = clashConfig?.mode?.toLowerCase();
  const curMode = isMode(normalizedMode) ? normalizedMode : undefined;

  const groups = proxiesData?.groups ?? [];
  const availableGroups = useMemo(
    () => (Array.isArray(groups) ? groups : []),
    [groups],
  );

  useEffect(() => {
    if (curMode === "rule" && availableGroups.length > 0 && !selectedGroup) {
      setSelectedGroup(availableGroups[0].name);
    }
    if (curMode !== "rule") {
      setSelectedGroup(null);
    }
  }, [curMode, availableGroups, selectedGroup]);

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

  const handleRuleGroupSelect = (name: string) => {
    setSelectedGroup(name);
    setRuleGroupAnchor(null);
  };

  const currentGroupLabel =
    curMode === "rule" && selectedGroup
      ? availableGroups.find((g: any) => g.name === selectedGroup)?.name ??
        selectedGroup
      : null;

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
                    mutateClash({ ...clash, "allow-lan": v }, false);
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

          {curMode === "rule" && availableGroups.length > 0 && (
            <>
              <IconButton
                size="small"
                onClick={(e) => setRuleGroupAnchor(e.currentTarget)}
                sx={{
                  border: "1px solid",
                  borderColor: "divider",
                  borderRadius: 1,
                  py: 0.5,
                  px: 1,
                }}
              >
                <Typography variant="body2" sx={{ mr: 0.5, fontSize: "12px" }}>
                  {t("proxies.page.rules.title")}:{" "}
                  {currentGroupLabel ?? t("proxies.page.rules.select")}
                </Typography>
                <ExpandMoreRounded fontSize="small" />
              </IconButton>
              <Menu
                anchorEl={ruleGroupAnchor}
                open={Boolean(ruleGroupAnchor)}
                onClose={() => setRuleGroupAnchor(null)}
                slotProps={{
                  paper: {
                    sx: { maxHeight: 300, minWidth: 200 },
                  },
                }}
              >
                {availableGroups.map((group: any) => (
                  <MenuItem
                    key={group.name}
                    onClick={() => handleRuleGroupSelect(group.name)}
                    selected={selectedGroup === group.name}
                  >
                    <Box
                      sx={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                      }}
                    >
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {group.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {group.type} · {group.all?.length ?? 0}{" "}
                        {t("proxies.page.labels.proxyCount")}
                      </Typography>
                    </Box>
                  </MenuItem>
                ))}
              </Menu>
            </>
          )}

          <Box display="flex" alignItems="center" gap={1} sx={{ ml: "auto" }}>
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
        selectedGroup={curMode === "rule" ? selectedGroup : null}
        onSelectedGroupChange={setSelectedGroup}
      />
    </BasePage>
  );
};

export default ProxyPage;
