import { CheckCircleOutlineRounded, LabelOutlined } from "@mui/icons-material";
import { alpha, Box, ListItemButton, styled, Typography } from "@mui/material";
import { useLockFn } from "ahooks";
import { useCallback, useEffect, useReducer } from "react";
import { useTranslation } from "react-i18next";

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
  onClick?: (name: string) => void;
}

// 多列布局
export const ProxyItemMini = (props: Props) => {
  const {
    group,
    proxy,
    selected,
    showManualIcon = false,
    showType = true,
    onClick,
  } = props;

  const { t } = useTranslation();

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
  }, [isPreset, proxy.name, group.name]);

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
    <ListItemButton
      dense
      selected={selected}
      onClick={() => onClick?.(proxy.name)}
      sx={[
        {
          height: 56,
          borderRadius: 1.5,
          pl: 1.5,
          pr: 1,
          justifyContent: "space-between",
          alignItems: "center",
        },
        ({ palette: { mode, primary, success } }) => {
          const bgcolor = mode === "light" ? "#ffffff" : "#24252f";
          const showDelay = delayValue > 0;
          const selectColor = mode === "light" ? primary.main : primary.light;

          // 判断节点是否测试成功（不是 T 或 E）
          const delayText =
            delayValue > 0 ? delayManager.formatDelay(delayValue, timeout) : "";
          const isSuccess =
            delayText !== "T" &&
            delayText !== "E" &&
            delayText !== "-" &&
            delayText !== "testing" &&
            delayText !== "";

          // 成功的节点使用浅绿色背景
          const finalBgcolor = isSuccess ? alpha(success.main, 0.15) : bgcolor;

          return {
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
          };
        },
      ]}
    >
      <Box
        title={`${proxy.name}\n${proxy.now ?? ""}`}
        sx={{ overflow: "hidden" }}
      >
        <Typography
          variant="body2"
          component="div"
          color="text.primary"
          sx={{
            display: "flex",
            alignItems: "center",
            textOverflow: "ellipsis",
            wordBreak: "break-all",
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          {showManualIcon && group.type !== "Fallback" && (
            <LabelOutlined
              sx={{
                fontSize: 14,
                mr: 0.5,
                flexShrink: 0,
                color: "primary.main",
              }}
              titleAccess="manual"
            />
          )}
          {proxy.name}
        </Typography>

        {showType && (
          <Box
            sx={{
              display: "flex",
              flexWrap: "nowrap",
              flex: "none",
              marginTop: "4px",
            }}
          >
            {proxy.now && (
              <Typography
                variant="body2"
                component="div"
                color="text.secondary"
                sx={{
                  display: "block",
                  textOverflow: "ellipsis",
                  wordBreak: "break-all",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  marginRight: "8px",
                }}
              >
                {proxy.now}
              </Typography>
            )}
            {!!proxy.provider && (
              <TypeBox color="text.secondary" component="span">
                {proxy.provider}
              </TypeBox>
            )}
            <TypeBox color="text.secondary" component="span">
              {proxy.type}
            </TypeBox>
            {proxy.udp && (
              <TypeBox color="text.secondary" component="span">
                UDP
              </TypeBox>
            )}
            {proxy.xudp && (
              <TypeBox color="text.secondary" component="span">
                XUDP
              </TypeBox>
            )}
            {proxy.tfo && (
              <TypeBox color="text.secondary" component="span">
                TFO
              </TypeBox>
            )}
            {proxy.mptcp && (
              <TypeBox color="text.secondary" component="span">
                MPTCP
              </TypeBox>
            )}
            {proxy.smux && (
              <TypeBox color="text.secondary" component="span">
                SMUX
              </TypeBox>
            )}
          </Box>
        )}
      </Box>
      <Box
        sx={{ ml: 0.5, color: "primary.main", display: isPreset ? "none" : "" }}
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

        {delayValue >= 0 && (
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
        {proxy.type !== "Direct" &&
          delayValue !== -2 &&
          delayValue < 0 &&
          selected && (
            // 展示已选择的 icon
            <CheckCircleOutlineRounded
              className="the-icon"
              sx={{ fontSize: 16, mr: 0.5, display: "block" }}
            />
          )}
      </Box>
      {showManualIcon && group.type === "Fallback" && (
        <span className="the-pin" title="manual">
          📌
        </span>
      )}
    </ListItemButton>
  );
};

const Widget = styled(Box)(({ theme: { typography } }) => ({
  padding: "2px 4px",
  fontSize: 14,
  fontFamily: typography.fontFamily,
  borderRadius: "4px",
}));

const TypeBox = styled(Box, {
  shouldForwardProp: (prop) => prop !== "component",
})<{ component?: React.ElementType }>(({ theme: { typography } }) => ({
  display: "inline-block",
  border: "1px solid #ccc",
  borderColor: "text.secondary",
  color: "text.secondary",
  borderRadius: 4,
  fontSize: 10,
  fontFamily: typography.fontFamily,
  marginRight: "4px",
  marginTop: "auto",
  padding: "0 4px",
  lineHeight: 1.5,
}));
