import {
  DirectionsRounded,
  LanguageRounded,
  MultipleStopRounded,
  WifiOffRounded,
} from "@mui/icons-material";
import { Box, Paper, Stack, Typography } from "@mui/material";
import { useLockFn } from "ahooks";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { closeAllConnections } from "tauri-plugin-mihomo-api";

import { useVerge } from "@/hooks/use-verge";
import { useAppData } from "@/providers/app-data-context";
import { patchClashMode } from "@/services/cmds";

const CLASH_MODES = ["rule", "global", "direct", "offline"] as const;
type ClashMode = (typeof CLASH_MODES)[number];

const STORAGE_KEY_UI_MODE = "proxies_ui_mode";

const isClashMode = (mode: string): mode is ClashMode =>
  (CLASH_MODES as readonly string[]).includes(mode);

const MODE_META: Record<
  ClashMode,
  { label: string; description: string }
> = {
  rule: {
    label: "home.components.clashMode.labels.rule",
    description: "home.components.clashMode.descriptions.rule",
  },
  global: {
    label: "home.components.clashMode.labels.global",
    description: "home.components.clashMode.descriptions.global",
  },
  direct: {
    label: "home.components.clashMode.labels.direct",
    description: "home.components.clashMode.descriptions.direct",
  },
  offline: {
    label: "离线",
    description: "拒绝全部流量，等同断网。",
  },
};

export const ClashModeCard = () => {
  const { t } = useTranslation();
  const { verge } = useVerge();
  const { refreshClashConfig } = useAppData();

  const modeList = CLASH_MODES;

  // 与代理页一致：前端记录 UI 模式，不依赖核心返回的 mode（直连/全局/离线时核心固定为 rule）
  const [uiMode, setUiMode] = useState<ClashMode>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_UI_MODE);
      if (stored && isClashMode(stored)) return stored;
    } catch {
      // ignore
    }
    return "rule";
  });

  const modeDescription = useMemo(() => {
    const meta = MODE_META[uiMode];
    if (uiMode === "offline") return meta.description;
    return t(meta.description);
  }, [uiMode, t]);

  const modeIcons = useMemo(
    () => ({
      rule: <MultipleStopRounded fontSize="small" />,
      global: <LanguageRounded fontSize="small" />,
      direct: <DirectionsRounded fontSize="small" />,
      offline: <WifiOffRounded fontSize="small" />,
    }),
    [],
  );

  const getModeLabel = (mode: ClashMode) => {
    const meta = MODE_META[mode];
    return mode === "offline" ? meta.label : t(meta.label);
  };

  const onChangeMode = useLockFn(async (mode: ClashMode) => {
    if (mode === uiMode) return;
    if (verge?.auto_close_connection) {
      closeAllConnections();
    }

    try {
      setUiMode(mode);
      try {
        localStorage.setItem(STORAGE_KEY_UI_MODE, mode);
      } catch {
        // ignore
      }
      await patchClashMode(mode);
      refreshClashConfig();
    } catch (error) {
      console.error("Failed to change mode:", error);
    }
  });

  const buttonStyles = (mode: ClashMode) => ({
    cursor: "pointer",
    px: 2,
    py: 1.2,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
    bgcolor: mode === uiMode ? "primary.main" : "background.paper",
    color: mode === uiMode ? "primary.contrastText" : "text.primary",
    borderRadius: 1.5,
    transition: "all 0.2s ease-in-out",
    position: "relative",
    overflow: "visible",
    "&:hover": {
      transform: "translateY(-1px)",
      boxShadow: 1,
    },
    "&:active": {
      transform: "translateY(1px)",
    },
    "&::after":
      mode === uiMode
        ? {
            content: '""',
            position: "absolute",
            bottom: -16,
            left: "50%",
            width: 2,
            height: 16,
            bgcolor: "primary.main",
            transform: "translateX(-50%)",
          }
        : {},
  });

  const descriptionStyles = {
    width: "95%",
    textAlign: "center",
    color: "text.secondary",
    p: 0.8,
    borderRadius: 1,
    borderColor: "primary.main",
    borderWidth: 1,
    borderStyle: "solid",
    backgroundColor: "background.paper",
    wordBreak: "break-word",
    hyphens: "auto",
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", width: "100%" }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          display: "flex",
          justifyContent: "center",
          py: 1,
          position: "relative",
          zIndex: 2,
        }}
      >
        {modeList.map((mode) => (
          <Paper
            key={mode}
            elevation={mode === uiMode ? 2 : 0}
            onClick={() => onChangeMode(mode)}
            sx={buttonStyles(mode)}
          >
            {modeIcons[mode]}
            <Typography
              variant="body2"
              sx={{
                textTransform: "capitalize",
                fontWeight: mode === uiMode ? 600 : 400,
              }}
            >
              {getModeLabel(mode)}
            </Typography>
          </Paper>
        ))}
      </Stack>

      <Box
        sx={{
          width: "100%",
          my: 1,
          position: "relative",
          display: "flex",
          justifyContent: "center",
          overflow: "visible",
        }}
      >
        <Typography variant="caption" component="div" sx={descriptionStyles}>
          {modeDescription}
        </Typography>
      </Box>
    </Box>
  );
};
