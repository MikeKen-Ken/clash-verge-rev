import { Tooltip, type TooltipProps } from "@mui/material";
import { useState, type ReactNode } from "react";

export interface ToolbarControlTooltipProps {
  title: NonNullable<TooltipProps["title"]>;
  /** 下拉框或菜单是否展开 */
  panelOpen: boolean;
  children: ReactNode;
}

/**
 * 工具栏控件 Tooltip：受控 hover 与 panelOpen 互斥，避免遮挡 Select/Menu 首项。
 * MUI Tooltip 包裹 Select 时，portal 会导致 mouseLeave 不触发；半受控 open 亦不可靠。
 */
export function ToolbarControlTooltip({
  title,
  panelOpen,
  children,
}: ToolbarControlTooltipProps) {
  const [hover, setHover] = useState(false);

  return (
    <Tooltip
      title={title}
      placement="top"
      open={hover && !panelOpen}
      disableHoverListener
      disableFocusListener
      disableTouchListener
    >
      <span
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onMouseDown={() => setHover(false)}
        style={{ display: "inline-flex" }}
      >
        {children}
      </span>
    </Tooltip>
  );
}
