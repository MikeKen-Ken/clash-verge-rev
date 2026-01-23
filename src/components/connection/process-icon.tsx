import { Box } from "@mui/material";
import { TerminalRounded } from "@mui/icons-material";
import { memo } from "react";
import { useProcessIconSync } from "@/hooks/use-process-icon";

interface Props {
  processPath?: string;
  size?: number;
}

/**
 * Component to display process icon
 * Falls back to a default terminal icon if no icon is available
 */
export const ProcessIcon = memo(({ processPath, size = 16 }: Props) => {
  const icon = useProcessIconSync(processPath);

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

ProcessIcon.displayName = "ProcessIcon";
