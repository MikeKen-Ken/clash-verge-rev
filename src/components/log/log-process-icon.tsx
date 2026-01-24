import { Box } from "@mui/material";
import { TerminalRounded } from "@mui/icons-material";
import { memo } from "react";
import { useProcessIconByNameSync } from "@/hooks/use-process-icon";

interface Props {
  processName?: string;
  size?: number;
}

/**
 * Component to display process icon in log items
 * Uses process name to fetch icon directly from running processes
 */
export const LogProcessIcon = memo(({ processName, size = 16 }: Props) => {
  const icon = useProcessIconByNameSync(processName);

  if (icon) {
    return (
      <Box
        component="img"
        src={icon}
        alt="process icon"
        sx={{
          width: size,
          height: size,
          flexShrink: 0,
          objectFit: "contain",
        }}
      />
    );
  }

  // 默认图标
  return (
    <TerminalRounded
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        opacity: 0.5,
      }}
    />
  );
});

LogProcessIcon.displayName = "LogProcessIcon";
