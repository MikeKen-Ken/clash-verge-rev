import { alpha, Box, Tooltip, Typography } from "@mui/material";
import { useLockFn } from "ahooks";

import { showNotice } from "@/services/notice-service";

interface Props {
  localIp?: string;
}

const cardSx = {
  ml: 0.5,
  px: 1,
  py: 0.5,
  borderRadius: 1,
  bgcolor: (theme: { palette: { divider: string } }) =>
    alpha(theme.palette.divider, 0.08),
  border: (theme: { palette: { divider: string } }) =>
    `1px solid ${alpha(theme.palette.divider, 0.2)}`,
  minWidth: 160,
};

export const ProxyPageIpInfo = ({ localIp }: Props) => {
  const handleCopy = useLockFn(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showNotice.success("shared.feedback.notifications.common.copySuccess");
    } catch (err) {
      showNotice.error("settings.sections.externalController.messages.copyFailed", err);
    }
  });

  const canCopy = Boolean(localIp);

  return (
    <Box sx={cardSx}>
      <Tooltip title={canCopy ? "点击复制本机 IP" : "本机 IP"}>
        <Box
          role={canCopy ? "button" : undefined}
          tabIndex={canCopy ? 0 : undefined}
          onClick={() => {
            if (localIp) void handleCopy(localIp);
          }}
          onKeyDown={(event) => {
            if (!canCopy) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (localIp) void handleCopy(localIp);
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
            color="text.secondary"
            sx={{ whiteSpace: "nowrap", flexShrink: 0, minWidth: 44 }}
          >
            本机 IP
          </Typography>
          <Typography
            variant="body2"
            color="text.primary"
            sx={{
              fontFamily: "monospace",
              fontVariantNumeric: "tabular-nums",
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {localIp ?? "—"}
          </Typography>
        </Box>
      </Tooltip>
    </Box>
  );
};
