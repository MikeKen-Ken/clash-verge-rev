import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  alpha,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
} from "@mui/material";
import type { CSSProperties, ReactNode } from "react";
import { useMatch, useNavigate, useResolvedPath } from "react-router";

import { useVerge } from "@/hooks/use-verge";

interface SortableProps {
  setNodeRef?: (element: HTMLElement | null) => void;
  attributes?: DraggableAttributes;
  listeners?: DraggableSyntheticListeners;
  style?: CSSProperties;
  isDragging?: boolean;
  disabled?: boolean;
}

interface Props {
  to: string;
  children: string;
  icon: ReactNode[];
  sortable?: SortableProps;
}
export const LayoutItem = (props: Props) => {
  const { to, children, icon, sortable } = props;
  const { verge } = useVerge();
  const { menu_icon } = verge ?? {};
  const navCollapsed = verge?.collapse_navbar ?? false;
  const resolved = useResolvedPath(to);
  const match = useMatch({ path: resolved.pathname, end: true });
  const navigate = useNavigate();

  const effectiveMenuIcon =
    navCollapsed && menu_icon === "disable" ? "monochrome" : menu_icon;

  const { setNodeRef, attributes, listeners, style, isDragging, disabled } =
    sortable ?? {};

  const draggable = Boolean(sortable) && !disabled;
  const dragHandleProps = draggable
    ? { ...(attributes ?? {}), ...(listeners ?? {}) }
    : undefined;

  const showMonochromeIcon =
    effectiveMenuIcon === "monochrome" || !effectiveMenuIcon;
  const showColorfulIcon = effectiveMenuIcon === "colorful";
  const navIcon = icon[1] ?? icon[0];
  const iconSx = {
    color: "text.primary",
    minWidth: 24,
    width: 24,
    m: 0,
    justifyContent: "center",
    cursor: draggable ? "grab" : "inherit",
  };

  return (
    <ListItem
      ref={setNodeRef}
      style={style}
      sx={[
        {
          display: "block",
          width: "100%",
          maxWidth: 250,
          mx: "auto",
          py: 0.5,
          px: 0,
        },
        isDragging ? { opacity: 0.78 } : {},
      ]}
    >
      <ListItemButton
        selected={!!match}
        {...(dragHandleProps ?? {})}
        sx={[
          {
            borderRadius: 2.5,
            position: "relative",
            display: "flex",
            width: "100%",
            minHeight: 44,
            boxSizing: "border-box",
            justifyContent: "center",
            alignItems: "center",
            gap: 1,
            m: 0,
            px: 0,
            py: 1,
            cursor: draggable ? "grab" : "pointer",
            transition: "background-color 160ms ease",
            "&:active": draggable ? { cursor: "grabbing" } : {},
            "& .MuiListItemText-root": {
              m: 0,
              flex: "0 0 auto",
              textAlign: "center",
            },
            "& .MuiListItemText-primary": {
              color: "text.primary",
              fontWeight: "700",
            },
          },
          ({ palette: { mode, primary } }) => {
            const bgcolor =
              mode === "light"
                ? alpha(primary.main, 0.15)
                : alpha(primary.main, 0.35);
            const color = mode === "light" ? "#1f1f1f" : "#ffffff";
            return {
              "&.Mui-selected": { bgcolor },
              "&.Mui-selected:hover": { bgcolor },
              "&.Mui-selected .MuiListItemText-primary": { color },
              "html[data-liquid-glass='1'] & .MuiListItemText-primary": {
                color: "var(--glass-text)",
              },
              "html[data-liquid-glass='1'] &.Mui-selected .MuiListItemText-primary":
                {
                  color: "var(--glass-text)",
                },
            };
          },
        ]}
        title={navCollapsed ? children : undefined}
        aria-label={navCollapsed ? children : undefined}
        onClick={() => navigate(to)}
      >
        {showMonochromeIcon && (
          <ListItemIcon sx={iconSx}>{navIcon}</ListItemIcon>
        )}
        {showColorfulIcon && <ListItemIcon sx={iconSx}>{navIcon}</ListItemIcon>}
        {!navCollapsed && <ListItemText primary={children} />}
      </ListItemButton>
    </ListItem>
  );
};
