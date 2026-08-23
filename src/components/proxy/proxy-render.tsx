import { InboxRounded } from "@mui/icons-material";
import { Box, Typography } from "@mui/material";
import { memo, useMemo } from "react";

import { ProxyGroupHeader } from "./proxy-group-header";
import { ProxyHead } from "./proxy-head";
import { ProxyItem } from "./proxy-item";
import { ProxyItemMini } from "./proxy-item-mini";
import type { HeadState } from "./use-head-state";
import type { IRenderItem } from "./use-render-list";

interface RenderProps {
  item: IRenderItem;
  indent: boolean;
  isChainMode?: boolean;
  onHeadState: (groupName: string, patch: Partial<HeadState>) => void;
  onChangeProxy: (
    group: IRenderItem["group"],
    proxy: IRenderItem["proxy"] & { name: string },
    options?: { isManualSelection?: boolean },
  ) => void;
  getSelectedForGroup?: (groupName: string) => string | undefined;
  getDisplayNowForGroup?: (
    group: {
      name: string;
      now?: string | null;
    },
    useNameAsLabel?: boolean,
  ) => string;
  getManualSelectionForGroup?: (groupName: string) => string | undefined;
}

const ProxyRenderInner = (props: RenderProps) => {
  const {
    indent,
    item,
    onHeadState,
    onChangeProxy,
    getSelectedForGroup,
    getDisplayNowForGroup,
    getManualSelectionForGroup,
  } = props;
  const { type, group, headState, proxy, proxyCol } = item;
  const groupInfo = useMemo(
    () => ({
      name: group.name,
      type: group.type,
      timeout: group.timeout,
      selectedTimeout: group.selectedTimeout,
      fixed: group.fixed,
    }),
    [group.name, group.type, group.timeout, group.selectedTimeout, group.fixed],
  );

  const proxyColItemsMemo = useMemo(() => {
    if (type !== 4 || !proxyCol) return null;

    const selectedName = getSelectedForGroup?.(group.name);
    const manualName = getManualSelectionForGroup?.(group.name);
    const fixedName = group.fixed;
    return proxyCol.map((proxyItem) => {
      const name = proxyItem?.name ?? "unknown";
      const displayNameRaw = getDisplayNowForGroup?.(
        { name, now: proxyItem?.now },
        true,
      );
      const itemDisplayName =
        displayNameRaw && displayNameRaw !== name ? displayNameRaw : undefined;
      return (
        <ProxyItemMini
          key={`${item.key}-${name}`}
          group={groupInfo}
          proxy={proxyItem!}
          itemDisplayName={itemDisplayName}
          selected={selectedName != null ? selectedName === name : false}
          showManualIcon={(fixedName ?? manualName) === name}
          showType={headState?.showType}
          onClick={() =>
            onChangeProxy(group, proxyItem!, {
              isManualSelection: (fixedName ?? manualName) === name,
            })
          }
        />
      );
    });
  }, [
    type,
    proxyCol,
    item.key,
    group,
    groupInfo,
    headState?.showType,
    onChangeProxy,
    getSelectedForGroup,
    getDisplayNowForGroup,
    getManualSelectionForGroup,
  ]);

  if (type === 0) {
    return (
      <ProxyGroupHeader
        item={item}
        onHeadState={onHeadState}
        getDisplayNowForGroup={getDisplayNowForGroup}
      />
    );
  }

  if (type === 1) {
    return (
      <ProxyHead
        sx={{ pl: 2, pr: 3, mt: indent ? 1 : 0.5, mb: 1 }}
        url={group.testUrl}
        groupName={group.name}
        headState={headState!}
        onHeadState={(p) => onHeadState(group.name, p)}
      />
    );
  }

  if (type === 2) {
    const selectedName = getSelectedForGroup?.(group.name);
    const manualName = getManualSelectionForGroup?.(group.name);
    const fixedName = group.fixed;
    const name = proxy?.name ?? "";
    const displayNameRaw = getDisplayNowForGroup?.(
      { name, now: proxy?.now },
      true,
    );
    const itemDisplayName =
      displayNameRaw && displayNameRaw !== name ? displayNameRaw : undefined;
    return (
      <ProxyItem
        group={group}
        proxy={proxy!}
        itemDisplayName={itemDisplayName}
        selected={selectedName != null ? selectedName === name : false}
        showManualIcon={(fixedName ?? manualName) === name}
        showType={headState?.showType}
        sx={{ py: 0, pl: 2 }}
        onClick={() =>
          onChangeProxy(group, proxy!, {
            isManualSelection: (fixedName ?? manualName) === name,
          })
        }
      />
    );
  }

  if (type === 3) {
    return (
      <Box
        sx={{
          py: 2,
          pl: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <InboxRounded sx={{ fontSize: "2.5em", color: "inherit" }} />
        <Typography sx={{ color: "inherit" }}>No Proxies</Typography>
      </Box>
    );
  }

  if (type === 4) {
    return (
      <Box
        sx={{
          height: 56,
          display: "grid",
          gap: 1,
          pl: 2,
          pr: 2,
          pb: 1,
          gridTemplateColumns: `repeat(${item.col! || 2}, 1fr)`,
        }}
      >
        {proxyColItemsMemo}
      </Box>
    );
  }

  return null;
};

export const ProxyRender = memo(ProxyRenderInner);
