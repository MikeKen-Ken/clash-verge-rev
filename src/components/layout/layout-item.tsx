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

  return (
    <ListItem
      ref={setNodeRef}
      style={style}
      sx={[
        { py: 0.5, maxWidth: 250, mx: "auto", padding: "4px 0px" },
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
            justifyContent: "center",
            marginLeft: 0,
            paddingLeft: 1,
            paddingRight: 1,
            marginRight: 0,
            cursor: draggable ? "grab" : "pointer",
            transition: "background-color 160ms ease, transform 160ms ease",
            "&:active": draggable ? { cursor: "grabbing" } : {},
            "&:hover": {
              transform: draggable ? undefined : "translateX(2px)",
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
            };
          },
        ]}
        title={navCollapsed ? children : undefined}
        aria-label={navCollapsed ? children : undefined}
        onClick={() => navigate(to)}
      >
        {(effectiveMenuIcon === "monochrome" || !effectiveMenuIcon) && (
          <ListItemIcon
            sx={{
              color: "text.primary",
              position: "absolute",
              left: "14px",
              marginLeft: "6px",
              cursor: draggable ? "grab" : "inherit",
            }}
          >
            {icon[0]}
          </ListItemIcon>
        )}
        {effectiveMenuIcon === "colorful" && (
          <ListItemIcon
            sx={{
              position: "absolute",
              left: "20px",
              cursor: draggable ? "grab" : "inherit",
            }}
          >
            {icon[1]}
          </ListItemIcon>
        )}
        <ListItemText
          sx={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: 0,
            textAlign: "center",
            pointerEvents: "none",
          }}
          primary={children}
        />
      </ListItemButton>
    </ListItem>
  );
};
