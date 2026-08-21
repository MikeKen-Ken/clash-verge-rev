import { alpha, Box, Tooltip, Typography } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { useLockFn } from "ahooks";

import { showNotice } from "@/services/notice-service";

interface Props {
  localIp?: string;
  /** 局域网连接已开启时高亮，并展示可复制的 ip:port */
  allowLan?: boolean;
  /** 对外监听端口（mixed / http / socks 等） */
  ports?: number[];
}

const buildEndpoints = (localIp: string | undefined, ports: number[]): string[] => {
  if (!localIp || ports.length === 0) return [];
  return ports.map((port) => `${localIp}:${port}`);
};

export const ProxyPageIpInfo = ({
  localIp,
  allowLan = false,
  ports = [],
}: Props) => {
  const endpoints = allowLan ? buildEndpoints(localIp, ports) : [];
  const displayText =
    endpoints.length > 0 ? endpoints.join("  ") : (localIp ?? "—");
  const canCopy = endpoints.length > 0 || Boolean(localIp);
  const copyValue = endpoints[0] ?? localIp;

  const handleCopy = useLockFn(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showNotice.success("shared.feedback.notifications.common.copySuccess");
    } catch (err) {
      showNotice.error(
        "settings.sections.externalController.messages.copyFailed",
        err,
      );
    }
  });

  const cardSx = {
    ml: 0.5,
    px: 1,
    py: 0.5,
    borderRadius: 1,
    minWidth: 160,
    transition: "background-color 0.2s ease, border-color 0.2s ease",
    bgcolor: (theme: Theme) =>
      allowLan
        ? alpha(theme.palette.primary.main, 0.12)
        : alpha(theme.palette.divider, 0.08),
    border: (theme: Theme) =>
      `1px solid ${
        allowLan
          ? alpha(theme.palette.primary.main, 0.45)
          : alpha(theme.palette.divider, 0.2)
      }`,
  };

  const tooltipTitle = !canCopy
    ? "Local IP"
    : allowLan && endpoints.length > 0
      ? "Click to copy LAN address"
      : "Click to copy local IP";

  return (
    <Box sx={cardSx}>
      <Tooltip title={tooltipTitle}>
        <Box
          role={canCopy ? "button" : undefined}
          tabIndex={canCopy ? 0 : undefined}
          onClick={() => {
            if (copyValue) void handleCopy(copyValue);
          }}
          onKeyDown={(event) => {
            if (!canCopy || !copyValue) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void handleCopy(copyValue);
            }
          }}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            cursor: canCopy ? "pointer" : "default",
          }}
        >
          <Typography
            variant="caption"
            color={allowLan ? "primary.main" : "text.secondary"}
            sx={{ whiteSpace: "nowrap", flexShrink: 0, minWidth: 44 }}
          >
            Local IP
          </Typography>
          {endpoints.length > 1 ? (
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 0.75,
                minWidth: 0,
              }}
            >
              {endpoints.map((endpoint) => (
                <Typography
                  key={endpoint}
                  component="span"
                  variant="body2"
                  color="primary.main"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleCopy(endpoint);
                  }}
                  sx={{
                    fontFamily: "monospace",
                    fontVariantNumeric: "tabular-nums",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                    "&:hover": { textDecoration: "underline" },
                  }}
                >
                  {endpoint}
                </Typography>
              ))}
            </Box>
          ) : (
            <Typography
              variant="body2"
              color={allowLan ? "primary.main" : "text.primary"}
              sx={{
                fontFamily: "monospace",
                fontVariantNumeric: "tabular-nums",
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              {displayText}
            </Typography>
          )}
        </Box>
      </Tooltip>
    </Box>
  );
};
