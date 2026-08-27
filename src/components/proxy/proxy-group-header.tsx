import {
  ExpandLessRounded,
  ExpandMoreRounded,
} from "@mui/icons-material";
import {
  alpha,
  Box,
  Chip,
  ListItemButton,
  ListItemText,
  Tooltip,
  styled,
} from "@mui/material";

import { useIconCache } from "@/hooks/use-icon-cache";
import { useVerge } from "@/hooks/use-verge";
import { useThemeMode } from "@/services/states";

import type { HeadState } from "./use-head-state";
import type { IRenderItem } from "./use-render-list";

interface Props {
  item: IRenderItem;
  onHeadState: (groupName: string, patch: Partial<HeadState>) => void;
  getDisplayNowForGroup?: (
    group: { name: string; now?: string | null },
    useNameAsLabel?: boolean,
  ) => string;
}

export const ProxyGroupHeader = ({
  item,
  onHeadState,
  getDisplayNowForGroup,
}: Props) => {
  const { group, headState } = item;
  const { verge } = useVerge();
  const enable_group_icon = verge?.enable_group_icon ?? true;
  const mode = useThemeMode();
  const isDark = mode !== "light";
  const itembackgroundcolor = isDark ? "#282A36" : "transparent";
  const iconCachePath = useIconCache({
    icon: group.icon,
    cacheKey: group.name.replaceAll(" ", ""),
    enabled: enable_group_icon,
  });
  const connectTimesLabel =
    typeof group.maxConnectTimes === "number" && group.maxConnectTimes > 0
      ? `${group.connectTimes ?? 0}/${group.maxConnectTimes}`
      : null;

  return (
    <ListItemButton
      dense
      className="proxy-group-header"
      style={{
        background: itembackgroundcolor,
        minHeight: 56,
        margin: "8px 8px",
        borderRadius: "8px",
      }}
      onClick={() => onHeadState(group.name, { open: !headState?.open })}
    >
      {enable_group_icon &&
        group.icon &&
        group.icon.trim().startsWith("http") && (
          <img
            src={iconCachePath === "" ? group.icon : iconCachePath}
            width="32px"
            style={{ marginRight: "12px", borderRadius: "6px" }}
            alt=""
          />
        )}
      {enable_group_icon &&
        group.icon &&
        group.icon.trim().startsWith("data") && (
          <img
            src={group.icon}
            width="32px"
            style={{ marginRight: "12px", borderRadius: "6px" }}
            alt=""
          />
        )}
      {enable_group_icon &&
        group.icon &&
        group.icon.trim().startsWith("<svg") && (
          <img
            src={`data:image/svg+xml;base64,${btoa(group.icon)}`}
            width="32px"
            alt=""
          />
        )}
      <ListItemText
        primary={
          <Box
            sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}
          >
            <StyledPrimary>{group.name}</StyledPrimary>
            {connectTimesLabel && (
              <Tooltip title="max-connect-times" arrow>
                <Chip
                  size="small"
                  label={connectTimesLabel}
                  sx={{
                    height: 20,
                    fontSize: 11,
                    flexShrink: 0,
                    backgroundColor: (theme) =>
                      alpha(theme.palette.info.main, 0.1),
                    color: (theme) => theme.palette.info.main,
                  }}
                />
              </Tooltip>
            )}
          </Box>
        }
        secondary={
          <Box
            sx={{
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
              pt: "2px",
            }}
          >
            <Box component="span" sx={{ marginTop: "2px" }}>
              <StyledTypeBox>{group.type}</StyledTypeBox>
              <StyledSubtitle>
                {getDisplayNowForGroup
                  ? getDisplayNowForGroup(group)
                  : (group.now ?? "")}
              </StyledSubtitle>
            </Box>
          </Box>
        }
        slotProps={{
          secondary: {
            component: "div",
            sx: { display: "flex", alignItems: "center", color: "#ccc" },
          },
        }}
      />
      <Box sx={{ display: "flex", alignItems: "center" }}>
        <Chip
          size="small"
          label={`${group.all.length}`}
          sx={{
            mr: 1,
            backgroundColor: (theme) => alpha(theme.palette.primary.main, 0.1),
            color: (theme) => theme.palette.primary.main,
          }}
        />
        {headState?.open ? <ExpandLessRounded /> : <ExpandMoreRounded />}
      </Box>
    </ListItemButton>
  );
};

const StyledPrimary = styled("span")`
  font-size: 16px;
  font-weight: 700;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
const StyledSubtitle = styled("span")`
  font-size: 13px;
  overflow: hidden;
  color: text.secondary;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const StyledTypeBox = styled(Box)(({ theme }) => ({
  display: "inline-block",
  border: "1px solid #ccc",
  borderColor: alpha(theme.palette.primary.main, 0.5),
  color: alpha(theme.palette.primary.main, 0.8),
  borderRadius: 4,
  fontSize: 10,
  padding: "0 4px",
  lineHeight: 1.5,
  marginRight: "8px",
}));
