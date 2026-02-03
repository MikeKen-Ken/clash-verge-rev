import { CheckCircleOutlineRounded, LabelOutlined } from "@mui/icons-material";
import {
  alpha,
  Box,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  styled,
  SxProps,
  Theme,
} from "@mui/material";
import { useLockFn } from "ahooks";
import { useCallback, useEffect, useReducer } from "react";

import { BaseLoading } from "@/components/base";
import delayManager, {
  getGroupDelayTimeout,
  DelayUpdate,
} from "@/services/delay";

interface Props {
  group: IProxyGroupItem;
  proxy: IProxyItem;
  selected: boolean;
  /** 仅当为 true 时显示「手动选择」图标（Selector/URLTest/Fallback 组且 profile 与 core 一致时） */
  showManualIcon?: boolean;
  showType?: boolean;
  /** 当该项是子分组时，展示「分组名 (该分组当前使用的节点)」 */
  itemDisplayName?: string;
  sx?: SxProps<Theme>;
  onClick?: (name: string) => void;
}

const Widget = styled(Box)(() => ({
  padding: "3px 6px",
  fontSize: 14,
  borderRadius: "4px",
}));

const TypeBox = styled("span")(({ theme }) => ({
  display: "inline-block",
  border: "1px solid #ccc",
  borderColor: alpha(theme.palette.text.secondary, 0.36),
  color: alpha(theme.palette.text.secondary, 0.42),
  borderRadius: 4,
  fontSize: 10,
  marginRight: "4px",
  padding: "0 2px",
  lineHeight: 1.25,
}));

export const ProxyItem = (props: Props) => {
  const {
    group,
    proxy,
    selected,
    showManualIcon = false,
    showType = true,
    itemDisplayName,
    sx,
    onClick,
  } = props;

  // 诊断：打印图钉渲染条件
  if (showManualIcon || selected) {
    console.log("[ProxyItem] 渲染节点", {
      组名: group.name,
      组类型: group.type,
      节点名: proxy.name,
      selected,
      showManualIcon,
      "类型包含 fallback": group.type?.toLowerCase()?.includes("fallback"),
      "应该显示图钉": showManualIcon && group.type?.toLowerCase()?.includes("fallback"),
    });
  }

  const presetList = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"];
  const isPreset = presetList.includes(proxy.name);
  // -1/<=0 为不显示，-2 为 loading
  const [delayState, setDelayState] = useReducer(
    (_: DelayUpdate, next: DelayUpdate) => next,
    { delay: -1, updatedAt: 0 },
  );
  const timeout = getGroupDelayTimeout(group, showManualIcon);

  useEffect(() => {
    if (isPreset) return;
    delayManager.setListener(proxy.name, group.name, setDelayState);

    return () => {
      delayManager.removeListener(proxy.name, group.name);
    };
  }, [proxy.name, group.name, isPreset]);

  const updateDelay = useCallback(() => {
    if (!proxy) return;
    const cachedUpdate = delayManager.getDelayUpdate(proxy.name, group.name);
    if (cachedUpdate) {
      setDelayState({ ...cachedUpdate });
      return;
    }

    const fallbackDelay = delayManager.getDelayFix(proxy, group.name);
    if (fallbackDelay === -1) {
      setDelayState({ delay: -1, updatedAt: 0 });
      return;
    }

    let updatedAt = 0;
    const history = proxy.history;
    if (history && history.length > 0) {
      const lastRecord = history[history.length - 1];
      const parsed = Date.parse(lastRecord.time);
      if (!Number.isNaN(parsed)) {
        updatedAt = parsed;
      }
    }

    setDelayState({
      delay: fallbackDelay,
      updatedAt,
    });
  }, [proxy, group.name]);

  useEffect(() => {
    updateDelay();
  }, [updateDelay]);

  const onDelay = useLockFn(async () => {
    setDelayState({ delay: -2, updatedAt: Date.now() });
    setDelayState(
      await delayManager.checkDelay(proxy.name, group.name, timeout),
    );
  });

  const delayValue = delayState.delay;

  return (
    <ListItem sx={sx}>
      <ListItemButton
        dense
        selected={selected}
        onClick={() => onClick?.(proxy.name)}
        sx={[
          { borderRadius: 1, position: "relative" },
          ({ palette: { mode, primary, success } }) => {
            const bgcolor = mode === "light" ? "#ffffff" : "#24252f";
            const selectColor = mode === "light" ? primary.main : primary.light;
            const showDelay = delayValue > 0;

            // 判断节点是否测试成功（不是 T 或 E）
            const delayText =
              delayValue > 0
                ? delayManager.formatDelay(delayValue, timeout)
                : "";
            const isSuccess =
              delayText !== "T" &&
              delayText !== "E" &&
              delayText !== "-" &&
              delayText !== "testing" &&
              delayText !== "";

            // 成功的节点使用浅绿色背景
            const finalBgcolor = isSuccess
              ? alpha(success.main, 0.15)
              : bgcolor;

            return {
              // 手动选择时显示红色外框
              ...(showManualIcon && {
                border: "2px solid",
                borderColor: "error.main",
                boxShadow: `0 0 8px ${alpha("#f44336", 0.3)}`,
              }),
              "&:hover .the-check": { display: !showDelay ? "block" : "none" },
              "&:hover .the-delay": { display: showDelay ? "block" : "none" },
              "&:hover .the-icon": { display: "none" },
              "& .the-pin": {
                position: "absolute",
                fontSize: "12px",
                top: "-5px",
                right: "-5px",
              },
              "&.Mui-selected": {
                width: `calc(100% + 3px)`,
                marginLeft: `-3px`,
                borderLeft: `3px solid ${selectColor}`,
                bgcolor:
                  mode === "light"
                    ? alpha(primary.main, 0.15)
                    : alpha(primary.main, 0.35),
              },
              backgroundColor: finalBgcolor,
              marginBottom: "8px",
              height: "40px",
            };
          },
        ]}
      >
        <ListItemText
          title={itemDisplayName ?? proxy.name}
          secondary={
            <>
              <Box
                sx={{
                  display: "inline-flex",
                  alignItems: "center",
                  marginRight: "8px",
                  fontSize: "14px",
                  color: "text.primary",
                }}
              >
                {showManualIcon && group.type?.toLowerCase() !== "fallback" && (
                  <LabelOutlined
                    sx={{ fontSize: 14, mr: 0.5, color: "primary.main" }}
                    titleAccess="manual"
                  />
                )}
                {itemDisplayName ?? proxy.name}
                {showType && proxy.now && ` - ${proxy.now}`}
              </Box>
              {showType && !!proxy.provider && (
                <TypeBox>{proxy.provider}</TypeBox>
              )}
              {showType && <TypeBox>{proxy.type}</TypeBox>}
              {showType && proxy.udp && <TypeBox>UDP</TypeBox>}
              {showType && proxy.xudp && <TypeBox>XUDP</TypeBox>}
              {showType && proxy.tfo && <TypeBox>TFO</TypeBox>}
              {showType && proxy.mptcp && <TypeBox>MPTCP</TypeBox>}
              {showType && proxy.smux && <TypeBox>SMUX</TypeBox>}
            </>
          }
        />

        <ListItemIcon
          sx={{
            justifyContent: "flex-end",
            color: "primary.main",
            display: isPreset ? "none" : "",
          }}
        >
          {delayValue === -2 && (
            <Widget>
              <BaseLoading />
            </Widget>
          )}

          {!proxy.provider && delayValue !== -2 && (
            // provider 的节点不支持检测
            <Widget
              className="the-check"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDelay();
              }}
              sx={({ palette }) => ({
                display: "none", // hover 时显示
                ":hover": { bgcolor: alpha(palette.primary.main, 0.15) },
              })}
            >
              Check
            </Widget>
          )}

          {delayValue > 0 && (
            // 显示延迟
            <Widget
              className="the-delay"
              onClick={(e) => {
                if (proxy.provider) return;
                e.preventDefault();
                e.stopPropagation();
                onDelay();
              }}
              color={delayManager.formatDelayColor(delayValue, timeout)}
              sx={({ palette }) =>
                !proxy.provider
                  ? { ":hover": { bgcolor: alpha(palette.primary.main, 0.15) } }
                  : {}
              }
            >
              {delayManager.formatDelay(delayValue, timeout)}
            </Widget>
          )}

          {delayValue !== -2 && delayValue <= 0 && selected && (
            // 展示已选择的 icon
            <CheckCircleOutlineRounded
              className="the-icon"
              sx={{ fontSize: 16 }}
            />
          )}
        </ListItemIcon>
        {showManualIcon && group.type?.toLowerCase()?.includes("fallback") && (
          <span className="the-pin" title="manual">
            📌
          </span>
        )}
      </ListItemButton>
    </ListItem>
  );
};
