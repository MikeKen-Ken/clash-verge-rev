import { CheckCircleOutlineRounded, LabelOutlined } from "@mui/icons-material";
import { alpha, styled } from "@mui/material";
import { useLockFn } from "ahooks";
import { memo, useCallback, useEffect, useReducer } from "react";

import { BaseLoading } from "@/components/base";
import delayManager, {
  getGroupDelayTimeout,
  type DelayUpdate,
} from "@/services/delay";

export type ProxyItemGroupInfo = Pick<
  IProxyGroupItem,
  | "name"
  | "type"
  | "timeout"
  | "selectedTimeout"
  | "fixed"
>;

interface Props {
  group: ProxyItemGroupInfo;
  proxy: IProxyItem;
  selected: boolean;
  showManualIcon?: boolean;
  showType?: boolean;
  itemDisplayName?: string;
  onClick?: (name: string) => void;
}

const PRESET_NAMES = new Set([
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "PASS",
  "COMPATIBLE",
]);

function ProxyItemMiniInner(props: Props) {
  const {
    group,
    proxy,
    selected,
    showManualIcon = false,
    showType = true,
    itemDisplayName,
    onClick,
  } = props;

  const isPreset = PRESET_NAMES.has(proxy.name);
  const [delayState, setDelayState] = useReducer(
    (_: DelayUpdate, next: DelayUpdate) => next,
    { delay: -1, updatedAt: 0 },
  );
  const timeout = getGroupDelayTimeout(group, showManualIcon);
  const proxyName = proxy.name;
  const groupName = group.name;

  useEffect(() => {
    if (isPreset) return;
    delayManager.setListener(proxyName, groupName, setDelayState);
    return () => {
      delayManager.removeListener(proxyName, groupName);
    };
  }, [isPreset, proxyName, groupName]);

  const historyTime = proxy.history?.[proxy.history.length - 1]?.time;
  const historyDelay = proxy.history?.[proxy.history.length - 1]?.delay;

  const updateDelay = useCallback(() => {
    const cachedUpdate = delayManager.getDelayUpdate(proxyName, groupName);
    if (cachedUpdate) {
      setDelayState({ ...cachedUpdate });
      return;
    }

    const fallbackDelay = delayManager.getDelayFix(proxy, groupName);
    if (fallbackDelay === -1) {
      setDelayState({ delay: -1, updatedAt: 0 });
      return;
    }

    let updatedAt = 0;
    if (historyTime) {
      const parsed = Date.parse(historyTime);
      if (!Number.isNaN(parsed)) updatedAt = parsed;
    }

    setDelayState({ delay: fallbackDelay, updatedAt });
  }, [proxy, proxyName, groupName, historyTime, historyDelay]);

  useEffect(() => {
    updateDelay();
  }, [updateDelay]);

  const onDelay = useLockFn(async () => {
    setDelayState({ delay: -2, updatedAt: Date.now() });
    setDelayState(await delayManager.checkDelay(proxyName, groupName, timeout));
  });

  const delayValue = delayState.delay;
  const delayText =
    delayValue > 0 ? delayManager.formatDelay(delayValue, timeout) : "";
  const isSuccess =
    delayText !== "" &&
    delayText !== "T" &&
    delayText !== "E" &&
    delayText !== "-" &&
    delayText !== "testing";
  const showDelay = delayValue > 0;
  const groupType = group.type?.toLowerCase() ?? "";
  const label = itemDisplayName ?? proxyName;

  return (
    <CellButton
      type="button"
      data-selected={selected ? "1" : "0"}
      data-success={isSuccess ? "1" : "0"}
      data-has-delay={showDelay ? "1" : "0"}
      title={`${label}\n${proxy.now ?? ""}`}
      onClick={() => onClick?.(proxyName)}
    >
      <CellMain>
        <NameRow>
          {showManualIcon && groupType !== "fallback" && (
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
          <NameText>{label}</NameText>
        </NameRow>
        {showType && (
          <MetaRow>
            {proxy.now && !itemDisplayName && (
              <NowText>{proxy.now}</NowText>
            )}
            {!!proxy.provider && <TypeTag>{proxy.provider}</TypeTag>}
            <TypeTag>{proxy.type}</TypeTag>
            {proxy.udp && <TypeTag>UDP</TypeTag>}
            {proxy.xudp && <TypeTag>XUDP</TypeTag>}
            {proxy.tfo && <TypeTag>TFO</TypeTag>}
            {proxy.mptcp && <TypeTag>MPTCP</TypeTag>}
            {proxy.smux && <TypeTag>SMUX</TypeTag>}
          </MetaRow>
        )}
      </CellMain>
      <CellSide style={{ display: isPreset ? "none" : undefined }}>
        {delayValue === -2 && (
          <Widget>
            <BaseLoading />
          </Widget>
        )}
        {!proxy.provider && delayValue !== -2 && (
          <Widget
            className="the-check"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void onDelay();
            }}
          >
            Check
          </Widget>
        )}
        {delayValue >= 0 && (
          <Widget
            className="the-delay"
            data-tone={
              delayManager.formatDelayColor(delayValue, timeout) ===
              "error.main"
                ? "error"
                : "success"
            }
            onClick={(e) => {
              if (proxy.provider) return;
              e.preventDefault();
              e.stopPropagation();
              void onDelay();
            }}
          >
            {delayManager.formatDelay(delayValue, timeout)}
          </Widget>
        )}
        {proxy.type !== "Direct" &&
          delayValue !== -2 &&
          delayValue < 0 &&
          selected && (
            <CheckCircleOutlineRounded
              className="the-icon"
              sx={{ fontSize: 16, mr: 0.5, display: "block" }}
            />
          )}
      </CellSide>
      {showManualIcon && groupType.includes("fallback") && (
        <span className="the-pin" title="manual">
          📌
        </span>
      )}
    </CellButton>
  );
}

function miniPropsEqual(prev: Props, next: Props) {
  const a = prev.proxy;
  const b = next.proxy;
  return (
    prev.selected === next.selected &&
    prev.showManualIcon === next.showManualIcon &&
    prev.showType === next.showType &&
    prev.itemDisplayName === next.itemDisplayName &&
    prev.group.name === next.group.name &&
    prev.group.type === next.group.type &&
    prev.group.timeout === next.group.timeout &&
    prev.group.selectedTimeout === next.group.selectedTimeout &&
    a.name === b.name &&
    a.type === b.type &&
    a.now === b.now &&
    a.provider === b.provider &&
    a.udp === b.udp &&
    a.xudp === b.xudp &&
    a.tfo === b.tfo &&
    a.mptcp === b.mptcp &&
    a.smux === b.smux
  );
}

export const ProxyItemMini = memo(ProxyItemMiniInner, miniPropsEqual);

const CellButton = styled("button")(({ theme }) => {
  const { mode, primary, success } = theme.palette;
  const bgcolor = mode === "light" ? "#ffffff" : "#24252f";
  const selectColor = mode === "light" ? primary.main : primary.light;
  return {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    height: 56,
    margin: 0,
    padding: "0 8px 0 12px",
    border: "none",
    borderRadius: 12,
    cursor: "pointer",
    textAlign: "left",
    color: "inherit",
    backgroundColor: bgcolor,
    "&[data-success='1']": {
      backgroundColor: alpha(success.main, 0.15),
    },
    "&[data-selected='1']": {
      width: "calc(100% + 3px)",
      marginLeft: "-3px",
      borderLeft: `3px solid ${selectColor}`,
      backgroundColor:
        mode === "light" ? alpha(primary.main, 0.15) : alpha(primary.main, 0.35),
    },
    "& .the-check": { display: "none" },
    "&[data-has-delay='0']:hover .the-check": { display: "block" },
    "&:hover .the-icon": { display: "none" },
    "& .the-pin": {
      position: "absolute",
      fontSize: "12px",
      top: "-5px",
      right: "-5px",
    },
  };
});

const CellMain = styled("div")({
  overflow: "hidden",
  minWidth: 0,
  flex: 1,
});

const NameRow = styled("div")({
  display: "flex",
  alignItems: "center",
});

const NameText = styled("span")(({ theme }) => ({
  ...theme.typography.body2,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
}));

const MetaRow = styled("div")({
  display: "flex",
  flexWrap: "nowrap",
  marginTop: 4,
});

const NowText = styled("span")(({ theme }) => ({
  ...theme.typography.body2,
  color: theme.palette.text.secondary,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  marginRight: 8,
}));

const CellSide = styled("div")(({ theme }) => ({
  marginLeft: 4,
  color: theme.palette.primary.main,
  flexShrink: 0,
}));

const Widget = styled("span")(({ theme }) => ({
  padding: "2px 4px",
  fontSize: 14,
  fontFamily: theme.typography.fontFamily,
  borderRadius: 4,
  "&[data-tone='error']": { color: theme.palette.error.main },
  "&[data-tone='success']": { color: theme.palette.success.main },
  "&:hover": { backgroundColor: alpha(theme.palette.primary.main, 0.15) },
}));

const TypeTag = styled("span")(({ theme }) => ({
  display: "inline-block",
  border: "1px solid",
  borderColor: alpha(theme.palette.text.secondary, 0.36),
  color: alpha(theme.palette.text.secondary, 0.72),
  borderRadius: 4,
  fontSize: 10,
  fontFamily: theme.typography.fontFamily,
  marginRight: 4,
  padding: "0 4px",
  lineHeight: 1.5,
}));
