import {
  AccessTimeRounded,
  VisibilityRounded,
  VisibilityOffRounded,
  SortByAlphaRounded,
  SortRounded,
} from "@mui/icons-material";
import { Box, IconButton, SxProps } from "@mui/material";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import delayManager from "@/services/delay";

import type { ProxySortType } from "./use-filter-sort";
import type { HeadState } from "./use-head-state";

interface Props {
  sx?: SxProps;
  url?: string;
  groupName: string;
  headState: HeadState;
  onHeadState: (val: Partial<HeadState>) => void;
}

const defaultSx: SxProps = {};

export const ProxyHead = ({
  sx = defaultSx,
  url,
  groupName,
  headState,
  onHeadState,
}: Props) => {
  const { showType, sortType, testUrl } = headState;

  const { t } = useTranslation();

  useEffect(() => {
    // 仅使用代理组配置的 testUrl 或用户输入的 testUrl，不覆写配置文件
    delayManager.setUrl(groupName, testUrl?.trim() || url || "");
  }, [groupName, testUrl, url]);

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, ...sx }}>
      <IconButton
        size="small"
        color="inherit"
        title={
          [
            t("proxies.page.tooltips.sortDefault"),
            t("proxies.page.tooltips.sortDelay"),
            t("proxies.page.tooltips.sortName"),
          ][sortType]
        }
        onClick={() =>
          onHeadState({ sortType: ((sortType + 1) % 3) as ProxySortType })
        }
      >
        {sortType !== 1 && sortType !== 2 && <SortRounded />}
        {sortType === 1 && <AccessTimeRounded />}
        {sortType === 2 && <SortByAlphaRounded />}
      </IconButton>

      <IconButton
        size="small"
        color="inherit"
        title={
          showType
            ? t("proxies.page.tooltips.showBasic")
            : t("proxies.page.tooltips.showDetail")
        }
        onClick={() => onHeadState({ showType: !showType })}
      >
        {showType ? <VisibilityRounded /> : <VisibilityOffRounded />}
      </IconButton>
    </Box>
  );
};
